import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { discoverDevices, GpuDevice, launchEnvironment, validateRenderer } from './devices';
import { TabsState, normalizeAddress, allowedURL } from './protocol';

const root = resolve(__dirname, '../..');
const selfTest = process.argv.includes('--self-test');
const runId = Date.now();
const data = resolve(process.env.RENDERHOP_DATA_DIR || join(root, '.renderhop', selfTest ? `test-${runId}` : 'default'));
mkdirSync(data, { recursive: true });
app.setPath('userData', join(data, 'shell'));
app.setPath('sessionData', join(data, 'shell'));
app.enableSandbox();
app.commandLine.appendSwitch('ozone-platform', 'wayland');
if (!app.requestSingleInstanceLock()) app.exit(0);
const evidence = join(root, 'evidence', selfTest ? `run-${runId}` : 'latest');
mkdirSync(evidence, { recursive: true });
function log(event: string, detail: unknown) { appendFileSync(join(evidence, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, detail }) + '\n'); }
let win: BrowserWindow;
let engine: ChildProcess | undefined;
let devices: GpuDevice[] = [];
let requested: GpuDevice | undefined, verified: any = null;
let phase = '检测设备', error = '', switching = false, closing = false;
let probeURL = '', previous: GpuDevice | undefined;
let tabs: TabsState = { tabs: [], activeId: '' };
let expectedExit = false, frames = 0, lastFrameAt = 0;
const checks: Record<string, any> = {};
// Session cookies stay in the owning shell's memory across engine restarts.
// Persistent cookies/localStorage remain in the Chromium web profile.
let sessionCookies: unknown[] = [];
let cookieOwner: ChildProcess | undefined;
interface LibraryEntry { url: string; title: string; at: number }
let library: { bookmarks: LibraryEntry[]; history: LibraryEntry[] } = { bookmarks: [], history: [] };
let findResult: any = null;
const historyURLByTab = new Map<string, string>();
try { const saved = JSON.parse(readFileSync(join(data, 'library.json'), 'utf8')); if (Array.isArray(saved.bookmarks) && Array.isArray(saved.history)) library = saved; } catch {}
function saveLibrary() { const target = join(data, 'library.json'); writeFileSync(target + '.tmp', JSON.stringify(library), { mode: 0o600 }); renameSync(target + '.tmp', target); }
function refreshDevices(force = false) {
  const next = discoverDevices();
  for (const address of Object.keys(checks)) {
    const changed = JSON.stringify(next.find(d => d.pciAddress === address)) !== JSON.stringify(devices.find(d => d.pciAddress === address));
    if (changed || force && address !== verified?.pciAddress) delete checks[address];
  }
  devices = next;
  return devices;
}
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
function save() {
  const target = join(data, 'tabs.json');
  writeFileSync(target + '.tmp', JSON.stringify(tabs, null, 2)); renameSync(target + '.tmp', target);
}
function emit() {
  if (!win?.isDestroyed()) win.webContents.send('state', { devices, requested, verified, phase, error, switching, tabs, checks, pid: engine?.pid, frames, lastFrameAt, probeURL, library, findResult });
}
function status(value: string) { phase = value; log('phase', { phase, requested: requested?.pciAddress }); emit(); }
function send(m: object) { if (!engine?.connected) throw Error('网页引擎未运行'); engine.send(m); }
function request(type: string, extra: object = {}): Promise<any> {
  const requestId = crypto.randomUUID();
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { pending.delete(requestId); rej(Error(`${type} 响应超时`)); }, 12000);
    pending.set(requestId, { resolve: res, reject: rej, timer });
    try { send({ type, requestId, ...extra }); } catch (e) { clearTimeout(timer); pending.delete(requestId); rej(e); }
  });
}
async function stopEngine() {
  const child = engine;
  if (!child) return;
  expectedExit = true;
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(Error('旧引擎未正常退出；为保护资料，未启动第二个写入者。请重试停止。')), 18000);
    child.once('exit', () => { clearTimeout(timer); res(); });
    if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); res(); }
    else if (child.connected) child.send({ type: 'stop' });
    else { clearTimeout(timer); rej(Error('引擎 IPC 已断开，等待进程退出后重试')); }
  });
  if (engine === child) engine = undefined;
  if (cookieOwner === child) cookieOwner = undefined;
}
async function launch(device: GpuDevice, testRendererDevice?: GpuDevice) {
  if (engine) throw Error('旧引擎仍存在，拒绝并行打开资料');
  const env = launchEnvironment(testRendererDevice || device);
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { RENDERHOP_PROFILE: join(data, 'web-profile'), RENDERHOP_PROBE: probeURL, RENDERHOP_SELF_TEST: selfTest ? '1' : '0' });
  expectedExit = false;
  const child = spawn(process.execPath, [join(__dirname, 'engine.js')], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  engine = child;
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', b => appendFileSync(join(evidence, `engine-${device.vendorId}.log`), b));
  log('engine-start', { pid: child.pid, device, testRendererDevice, selectors: Object.fromEntries(Object.entries(env).filter(([k]) => /DRI_PRIME|__NV|__GLX|RENDERHOP_ANGLE|RENDERHOP_OZONE|VK_DRIVER_FILES/.test(k))) });
  let ready = false;
  return await new Promise<any>((res, rej) => {
    const timer = setTimeout(() => rej(Error('目标引擎启动或 WebGL2 探测超时')), 30000);
    child.once('error', e => { clearTimeout(timer); rej(e); });
    child.on('exit', (code, signal) => {
      log('engine-exit', { pid: child.pid, code, signal, expectedExit });
      if (engine === child) engine = undefined;
      if (cookieOwner === child) cookieOwner = undefined;
      if (!ready) { clearTimeout(timer); rej(Error(`引擎退出 code=${code} signal=${signal}`)); }
      if (!expectedExit && !closing) { verified = null; phase = '引擎已退出，可点击恢复'; error = `引擎异常退出 (${code ?? signal})`; switching = false; emit(); }
    });
    child.on('message', (m: any) => {
      if (engine !== child) return;
      if (m.requestId && pending.has(m.requestId)) {
        const p = pending.get(m.requestId)!; clearTimeout(p.timer); pending.delete(m.requestId);
        m.type === 'command-error' ? p.reject(Error(m.message)) : p.resolve(m.value ?? m);
      }
      switch (m.type) {
        case 'ready': ready = true; clearTimeout(timer); log('render-report', m.report); res(m.report); break;
        case 'tabs': {
          tabs = { tabs: m.tabs, activeId: m.activeId };
          let changed = false;
          for (const tab of tabs.tabs) {
            if (!tab.url || tab.url === 'about:blank' || tab.loading) continue;
            const entry = library.history.find(e => e.url === tab.url);
            if (historyURLByTab.get(tab.id) !== tab.url || !entry) {
              library.history = [{ url: tab.url, title: tab.title || tab.url, at: Date.now() }, ...library.history.filter(e => e.url !== tab.url)].slice(0, 500); changed = true;
            } else if (entry && tab.title && entry.title !== tab.title) { entry.title = tab.title; changed = true; }
            historyURLByTab.set(tab.id, tab.url);
          }
          if (changed) saveLibrary(); save(); emit(); break;
        }
        case 'find-result': findResult = m.result; emit(); break;
        case 'session-cookies': if (cookieOwner === child) sessionCookies = m.cookies; break;
        case 'frame': frames++; lastFrameAt = Date.now(); if (!win.isDestroyed()) win.webContents.send('frame', m); break;
        case 'fatal':
          error = m.message; verified = null; log('engine-fatal', m);
          if (!ready) { clearTimeout(timer); rej(Error(m.message)); }
          else { phase = '引擎故障，可点击恢复'; emit(); } break;
        case 'page-error': case 'command-error': error = m.message; log(m.type, m); emit(); break;
      }
    });
  });
}
async function switchGPU(address: string, options: { simulatedUnavailable?: boolean; simulatedWrongRenderer?: boolean } = {}): Promise<boolean> {
  if (switching) throw Error('正在切换，请等待');
  switching = true; error = '';
  const old = previous;
  const oldEngine = engine;
  let oldStopped = false;
  let handoffCookies = structuredClone(sessionCookies);
  const restore = structuredClone(tabs);
  try {
    status('检测设备'); refreshDevices();
    requested = devices.find(d => d.pciAddress === address);
    status('检查目标 GPU 可用性');
    if (!requested?.available || options.simulatedUnavailable) throw Error(options.simulatedUnavailable ? '模拟设备失联：目标驱动不可访问' : requested?.reason || '目标 PCI 设备已移除');
    const target = requested;
    status('保存标签信息'); save();
    status('正常停止旧网页引擎'); await stopEngine(); oldStopped = true; verified = null;
    handoffCookies = structuredClone(sessionCookies);
    status('启动目标引擎');
    const testRendererDevice = selfTest && options.simulatedWrongRenderer ? devices.find(d => d.vendorId !== target.vendorId && d.available) : undefined;
    const report = await launch(target, testRendererDevice);
    status('验证真实渲染设备');
    const result = validateRenderer(target, report);
    if (!Array.isArray(report.pixel) || report.pixel[3] !== 255 || !report.pixel.slice(0, 3).some((v: number) => v > 0)) throw Error('WebGL2 未取得成功绘制的像素证据');
    checks[target.pciAddress] = { ...result, testedAt: new Date().toISOString() };
    if (!result.ok) throw Error(result.reason + ': ' + result.actual);
    if (devices.filter(d => d.vendorId === target.vendorId).length > 1) throw Error('发现多块同厂商 GPU，首版不能充分证明具体 PCI 设备');
    status('恢复标签');
    await request('restore', { state: restore, sessionCookies: handoffCookies });
    cookieOwner = engine;
    verified = { ...result, report, pciAddress: target.pciAddress, compositorDegraded: report.featureStatus.gpu_compositing !== 'enabled' };
    previous = target;
    status(verified.compositorDegraded ? 'WebGL 已验证 · 引擎合成降级' : 'WebGL 已验证');
    return true;
  } catch (e) {
    error = String(e); log('switch-failed', { requested, error });
    if (requested) checks[requested.pciAddress] = { ok: false, reason: error };
    // A preflight failure leaves the working engine untouched.
    if (!oldStopped && engine === oldEngine && engine && verified && old) { phase = '目标不可用，保留原引擎'; return false; }
    verified = null;
    try {
      await stopEngine();
      if (old && discoverDevices().some(d => d.pciAddress === old.pciAddress && d.available)) {
        status('目标失败，恢复上一可用设备');
        const report = await launch(old), result = validateRenderer(old, report);
        if (!result.ok) throw Error(result.reason);
        await request('restore', { state: restore, sessionCookies: handoffCookies });
        cookieOwner = engine; sessionCookies = handoffCookies;
        verified = { ...result, report, pciAddress: old.pciAddress, compositorDegraded: report.featureStatus.gpu_compositing !== 'enabled' }; previous = old;
        phase = '已回退到上一设备；请求未成功';
      } else phase = '无法启动网页引擎，请检查设备后恢复';
    } catch (fallback) { error += `；回退失败: ${fallback}`; phase = '引擎未恢复，请检查日志'; }
    return false;
  } finally { switching = false; emit(); }
}

async function command(m: any) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') throw Error('无效命令');
  if (m.type === 'ack') { if (engine?.connected) send({ type: 'ack' }); return; }
  if (m.type === 'discover') { refreshDevices(true); emit(); return; }
  if (m.type === 'switch') return switchGPU(String(m.address));
  if (m.type === 'recover') { const current = refreshDevices(); return switchGPU(current.find(d => d.pciAddress === previous?.pciAddress && d.available)?.pciAddress || current.find(d => d.available)?.pciAddress || ''); }
  if (m.type === 'bookmark') {
    const active = tabs.tabs.find(t => t.id === tabs.activeId);
    if (active) { const url = allowedURL(active.url), exists = library.bookmarks.some(e => e.url === url); library.bookmarks = exists ? library.bookmarks.filter(e => e.url !== url) : [...library.bookmarks, { url, title: active.title || url, at: Date.now() }]; saveLibrary(); emit(); } return;
  }
  if (m.type === 'bookmark-remove' && typeof m.url === 'string') { library.bookmarks = library.bookmarks.filter(e => e.url !== m.url); saveLibrary(); emit(); return; }
  if (m.type === 'history-clear') { library.history = []; saveLibrary(); emit(); return; }
  if (switching) return;
  switch (m.type) {
    case 'navigate': send({ type: 'navigate', url: normalizeAddress(m.url) }); break;
    case 'new': send({ type: 'new', url: probeURL }); break;
    case 'activate': case 'close': if (tabs.tabs.some(t => t.id === m.id)) send({ type: m.type, id: m.id }); break;
    case 'back': case 'forward': case 'reload': send({ type: m.type }); break;
    case 'find': if (typeof m.text === 'string' && m.text.length < 1000) { if (m.text) send({ type: 'find', text: m.text, next: !!m.next, forward: m.forward !== false }); else { findResult = null; send({ type: 'find-stop' }); emit(); } } break;
    case 'find-stop': findResult = null; send({ type: 'find-stop' }); emit(); break;
    case 'zoom': send({ type: 'zoom', delta: m.delta > 0 ? 1 : -1, reset: m.reset === true }); break;
    case 'resize': if (engine?.connected && Number.isFinite(m.width) && Number.isFinite(m.height)) send({ type: 'resize', width: m.width, height: m.height }); break;
    case 'text': if (typeof m.text === 'string' && m.text.length < 100000) send({ type: 'text', text: m.text }); break;
    case 'edit': if (['copy', 'paste', 'cut', 'selectAll', 'undo', 'redo'].includes(m.action)) send(m); break;
    case 'input': {
      const e = m.event;
      if (!e || !['mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel', 'keyDown', 'keyUp'].includes(e.type) && !(e.type === 'char' && e.keyCode === '\r')) break;
      const clean: any = { type: e.type };
      if (Array.isArray(e.modifiers)) clean.modifiers = e.modifiers.filter((x: unknown) => ['shift', 'control', 'alt', 'meta', 'leftButtonDown', 'middleButtonDown', 'rightButtonDown'].includes(String(x)));
      for (const key of ['x', 'y', 'deltaX', 'deltaY', 'clickCount']) if (Number.isFinite(e[key])) clean[key] = Math.max(-10000, Math.min(10000, Math.round(e[key])));
      if (['left', 'middle', 'right'].includes(e.button)) clean.button = e.button;
      if (typeof e.keyCode === 'string' && e.keyCode.length < 40) clean.keyCode = e.keyCode;
      send({ type: 'input', event: clean }); break;
    }
  }
}
app.whenReady().then(async () => {
  const server = createServer((req, res) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (path === '/login' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'renderhop_login=local-fixture; HttpOnly; SameSite=Lax; Path=/');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ loggedIn: true, user: 'local-fixture' })); return;
    }
    if (path === '/account') {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ loggedIn: /(?:^|;\s*)renderhop_login=local-fixture(?:;|$)/.test(req.headers.cookie || ''), user: 'local-fixture' })); return;
    }
    const file = path === '/probe.js' ? 'probe.js' : ['/probe.html', '/second.html', '/'].includes(path) ? 'probe.html' : null;
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; object-src 'none'");
    res.end(readFileSync(join(root, 'public', file)));
  });
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(selfTest ? 17838 : 17837, '127.0.0.1', res); });
  probeURL = `http://127.0.0.1:${selfTest ? 17838 : 17837}/probe.html`;
  try { const saved = JSON.parse(readFileSync(join(data, 'tabs.json'), 'utf8')); if (saved.tabs?.length && typeof saved.activeId === 'string') tabs = saved; } catch {}
  if (!tabs.tabs.length) { const id = crypto.randomUUID(); tabs = { tabs: [{ id, url: probeURL }], activeId: id }; }
  win = new BrowserWindow({ width: 1280, height: 900, minWidth: 800, minHeight: 560, title: 'RenderHop · 跃显浏览器', webPreferences: { preload: join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  ipcMain.handle('command', async (e, m) => {
    if (e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) throw Error('禁止访问');
    try { return await command(m); } catch (error) { log('shell-command-error', String(error)); return { error: String(error) }; }
  });
  await win.loadFile(join(root, 'public', 'shell.html'));
  devices = discoverDevices(); emit();
  log('environment', { kernel: execFileSync('uname', ['-a'], { encoding: 'utf8' }).trim(), versions: process.versions, devices });
  const initial = devices.find(d => d.vendorId === '8086' && d.available) || devices.find(d => d.available);
  if (initial) await switchGPU(initial.pciAddress);
  else { error = '未发现可访问的 GPU 驱动节点。请从真实桌面终端启动。'; status('无可用设备'); }
  setInterval(() => {
    const before = JSON.stringify(devices); refreshDevices();
    if (JSON.stringify(devices) !== before) { log('devices-changed', devices); emit(); }
    if (!switching && verified && !devices.some(d => d.pciAddress === verified.pciAddress && d.available)) {
      error = '活动显卡失联，请点击恢复或选择其他设备'; verified = null; status('设备失联');
    }
  }, 5000).unref();
  win.on('close', e => {
    if (!closing) { e.preventDefault(); closing = true; save(); void stopEngine().then(() => app.quit()).catch(err => { closing = false; error = String(err); emit(); }); }
  });
  if (selfTest) {
    const { runIntegration } = await import('./self-test.js');
    try {
      await runIntegration({ win, devices, switchGPU, command, request, send, evidence, getState: () => ({ tabs, verified, phase, error, engine, frames, library, findResult }), probeURL });
      log('integration', { passed: true });
    } catch (e) { log('integration', { passed: false, error: String(e), stack: (e as Error).stack }); console.error(e); process.exitCode = 1; }
    closing = true; await stopEngine(); app.exit(Number(process.exitCode) || 0);
  }
}).catch(e => { log('startup-fatal', String(e)); console.error(e); app.exit(1); });
app.on('window-all-closed', () => { if (!engine) app.quit(); });
