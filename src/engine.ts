import { app, BrowserWindow, session } from 'electron';
import { Tab, TabsState, allowedURL } from './protocol';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

const profile = process.env.RENDERHOP_PROFILE!;
app.setPath('userData', profile);
app.setPath('sessionData', profile);
if (!app.requestSingleInstanceLock()) app.exit(73);
app.enableSandbox();
app.commandLine.appendSwitch('ozone-platform', process.env.RENDERHOP_OZONE || 'wayland');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', process.env.RENDERHOP_ANGLE || 'gl');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const windows = new Map<string, BrowserWindow>();
let activeId = '', width = 1100, height = 650, quitting = false, framePending = false;
let frameCount = 0, frameBytes = 0;
let encodeMs = 0;
let restoring = false;
const desiredURLs = new Map<string, string>();
const send = (m: object) => { if (process.connected) process.send?.(m); };
function preferences() { return { offscreen: { useSharedTexture: false }, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false }; }
function state(): TabsState {
  return { activeId, tabs: [...windows].map(([id, w]) => ({ id, url: w.webContents.getURL() || desiredURLs.get(id) || 'about:blank', title: w.webContents.getTitle(), canGoBack: w.webContents.navigationHistory.canGoBack(), canGoForward: w.webContents.navigationHistory.canGoForward(), loading: w.webContents.isLoading(), zoomFactor: w.webContents.getZoomFactor() })) };
}
function publish() { if (!quitting && !restoring) send({ type: 'tabs', ...state() }); }
function active() { return windows.get(activeId); }
function activate(id: string) {
  if (!windows.has(id)) return;
  activeId = id;
  for (const [key, w] of windows) {
    if (key === id) { w.webContents.startPainting(); w.focus(); w.webContents.focus(); w.webContents.invalidate(); }
    else w.webContents.stopPainting();
  }
  framePending = false;
  publish();
}
async function createTab(tab: Tab) {
  const url = allowedURL(tab.url);
  desiredURLs.set(tab.id, url);
  const win = new BrowserWindow({ width, height, show: false, frame: false, webPreferences: preferences() });
  windows.set(tab.id, win);
  win.webContents.setFrameRate(24);
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { const id = crypto.randomUUID(); void createTab({ id, url: allowedURL(url) }).then(() => activate(id)); } catch {}
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { try { allowedURL(url); } catch { e.preventDefault(); } });
  win.webContents.on('will-redirect', (e, url) => { try { allowedURL(url); } catch { e.preventDefault(); } });
  win.webContents.on('will-prevent-unload', e => { if (quitting) e.preventDefault(); });
  for (const event of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated'] as const) win.webContents.on(event as any, publish);
  win.webContents.on('did-fail-load', (_e, code, description, url, main) => { if (main && code !== -3) send({ type: 'page-error', message: `${url}: ${description} (${code})` }); });
  win.webContents.on('render-process-gone', (_e, details) => { send({ type: 'fatal', message: `网页进程异常退出: ${details.reason}` }); });
  win.webContents.on('found-in-page', (_e, result) => { if (tab.id === activeId) send({ type: 'find-result', result }); });
  win.webContents.on('paint', (_event, _dirty, image) => {
    if (tab.id !== activeId || framePending || !process.connected || image.isEmpty()) return;
    framePending = true;
    const encodeStart = performance.now();
    const data = image.toJPEG(90);
    encodeMs += performance.now() - encodeStart;
    frameCount++; frameBytes += data.length;
    send({ type: 'frame', mime: 'image/jpeg', data: data.toString('base64'), size: image.getSize(), at: Date.now() });
  });
  if (activeId !== tab.id) win.webContents.stopPainting();
  const loaded = win.loadURL(url).catch(() => {});
  await Promise.race([loaded, new Promise(r => setTimeout(r, 8000))]);
  if (Number.isFinite(tab.zoomFactor)) win.webContents.setZoomFactor(Math.min(3, Math.max(.25, tab.zoomFactor!)));
  publish();
}
async function stop() {
  if (quitting) return;
  quitting = true;
  send({ type: 'session-cookies', cookies: (await session.defaultSession.cookies.get({})).filter(c => c.session) });
  // Stop navigation before flushing; no second instance is started until this process exits.
  for (const w of windows.values()) w.webContents.stop();
  await session.defaultSession.cookies.flushStore();
  session.defaultSession.flushStorageData();
  app.quit();
}
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.cookies.on('changed', async () => {
    if (!quitting && !restoring) send({ type: 'session-cookies', cookies: (await session.defaultSession.cookies.get({})).filter(c => c.session) });
  });
  session.defaultSession.on('will-download', (e) => e.preventDefault());
  app.on('child-process-gone', (_event, details) => { if (details.type === 'GPU' && !quitting) send({ type: 'fatal', message: `GPU 进程退出: ${details.reason}` }); });
  let probe: BrowserWindow | undefined, report: any;
  const probeAttempts: unknown[] = [];
  // On this driver the first offscreen context can be lost while Chromium chooses
  // its readback compositor. Recreate a context, as for an actual restored tab.
  for (let context = 0; context < 3; context++) {
    probe = new BrowserWindow({ width: 960, height: 600, show: false, frame: false, webPreferences: preferences() });
    probe.webContents.setFrameRate(24);
    probe.webContents.on('paint', () => {});
    await probe.loadURL(process.env.RENDERHOP_PROBE!);
    probe.webContents.startPainting(); probe.focus(); probe.webContents.focus();
    await new Promise(r => setTimeout(r, 1000));
    report = await probe.webContents.executeJavaScript('window.renderhopProbe()');
    probeAttempts.push(structuredClone(report));
    if (report.webgl2 && !report.error && report.pixel?.[3] === 255) break;
    probe.destroy(); probe = undefined;
  }
  report.probeAttempts = probeAttempts;
  report.gpuInfo = await app.getGPUInfo('basic');
  report.gpuInfoComplete = await app.getGPUInfo('complete');
  report.featureStatus = app.getGPUFeatureStatus();
  report.metrics = app.getAppMetrics();
  report.processDevices = app.getAppMetrics().filter(m => m.type === 'GPU').map(m => {
    const fds: unknown[] = [];
    try { for (const fd of readdirSync(`/proc/${m.pid}/fd`)) try {
      const path = readlinkSync(`/proc/${m.pid}/fd/${fd}`);
      if (path.startsWith('/dev/dri') || path.startsWith('/dev/nvidia')) fds.push({ fd, path, info: readFileSync(`/proc/${m.pid}/fdinfo/${fd}`, 'utf8') });
    } catch {} } catch {}
    return { pid: m.pid, fds };
  });
  probe?.destroy();
  send({ type: 'ready', report, pid: process.pid });
}).catch(error => { send({ type: 'fatal', message: String(error) }); void stop(); });
async function handleMessage(m: any) {
  try {
    if (!m || typeof m !== 'object') return;
    const w = active();
    switch (m.type) {
      case 'restore':
        restoring = true;
        for (const cookie of m.sessionCookies || []) {
          const { name, value, path, secure, httpOnly, sameSite, domain, hostOnly } = cookie;
          await session.defaultSession.cookies.set({ url: `${secure ? 'https' : 'http'}://${String(domain).replace(/^\./, '')}${path || '/'}`, name, value, path, secure, httpOnly, sameSite, ...(hostOnly ? {} : { domain }) });
        }
        await Promise.all((m.state as TabsState).tabs.map(tab => createTab(tab)));
        restoring = false;
        activate(m.state.activeId);
        send({ type: 'restored', requestId: m.requestId, value: state() }); break;
      case 'new': { const id = crypto.randomUUID(); await createTab({ id, url: allowedURL(m.url) }); activate(id); break; }
      case 'activate': activate(m.id); break;
      case 'close': {
        const target = windows.get(m.id); windows.delete(m.id); target?.destroy();
        if (!windows.size) { const id = crypto.randomUUID(); await createTab({ id, url: process.env.RENDERHOP_PROBE! }); }
        activate(windows.has(activeId) ? activeId : windows.keys().next().value!); break;
      }
      case 'navigate': await w?.loadURL(allowedURL(m.url)).catch(() => {}); break;
      case 'back': if (w?.webContents.navigationHistory.canGoBack()) w.webContents.navigationHistory.goBack(); break;
      case 'forward': if (w?.webContents.navigationHistory.canGoForward()) w.webContents.navigationHistory.goForward(); break;
      case 'reload': w?.webContents.reload(); break;
      case 'find': if (typeof m.text === 'string' && m.text.length < 1000 && m.text) w?.webContents.findInPage(m.text, { forward: m.forward !== false, findNext: !m.next }); break;
      case 'find-stop': w?.webContents.stopFindInPage('clearSelection'); break;
      case 'zoom': if (w) { const factor = m.reset ? 1 : w.webContents.getZoomFactor() + (m.delta > 0 ? .1 : -.1); w.webContents.setZoomFactor(Math.min(3, Math.max(.25, factor))); publish(); } break;
      case 'resize':
        width = Math.max(320, Math.min(2560, Math.round(m.width))); height = Math.max(240, Math.min(1600, Math.round(m.height)));
        if (!Number.isFinite(width) || !Number.isFinite(height)) break;
        for (const win of windows.values()) win.setContentSize(width, height); break;
      case 'ack': framePending = false; break;
      case 'text': if (typeof m.text === 'string' && m.text.length < 100000) await w?.webContents.insertText(m.text); break;
      case 'input':
        if (['mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel', 'keyDown', 'keyUp'].includes(m.event?.type) || m.event?.type === 'char' && m.event.keyCode === '\r') {
          w?.focus(); w?.webContents.focus(); w?.webContents.sendInputEvent(m.event);
        } break;
      case 'edit': if (['copy', 'paste', 'cut', 'selectAll', 'undo', 'redo'].includes(m.action)) (w?.webContents as any)[m.action](); break;
      case 'stop': await stop(); break;
      case 'metrics': send({ type: 'metrics', requestId: m.requestId, metrics: app.getAppMetrics(), frameCount, frameBytes, encodeMs, viewport: [width, height], transport: 'GPU bitmap readback → JPEG quality 90 → IPC' }); break;
      case 'test':
        if (process.env.RENDERHOP_SELF_TEST !== '1' || !w?.webContents.getURL().startsWith(process.env.RENDERHOP_PROBE!.replace('/probe.html', '/'))) break;
        // Test-only, fixed expressions: no arbitrary evaluation IPC exposed by the UI.
        const expressions: Record<string, string> = {
          inspect: `({url:location.href,cookie:document.cookie,text:document.querySelector('#input').value,inputStatus:document.querySelector('#input-status').textContent,wheel:document.querySelector('#wheel-status').textContent,scroll:document.querySelector('#scroll').scrollTop,probe:await window.renderhopProbe(),rects:Object.fromEntries(['input','scroll','cookie-set'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [id,{x:r.x,y:r.y,width:r.width,height:r.height}]})),security:{require:typeof require,node:typeof process}})`,
          focus: `document.querySelector('#input').focus()`,
          cookie: `document.querySelector('#cookie-set').click()`,
          login: `(await fetch('/login', {method:'POST'})).json()`,
          account: `(await fetch('/account')).json()`,
          keyboardSetup: `(window.renderhopKeys=[],document.getElementById('input').value='',document.getElementById('input').addEventListener('keydown',e=>window.renderhopKeys.push(e.key)),document.getElementById('input').focus(),true)`,
          keyboardResult: `({text:document.getElementById('input').value,keys:window.renderhopKeys})`,
        };
        if (expressions[m.action]) send({ type: 'test-result', requestId: m.requestId, value: await w.webContents.executeJavaScript(`(async()=>{return ${expressions[m.action]}})()`) });
        break;
    }
  } catch (error) { send({ type: 'command-error', requestId: m?.requestId, message: String(error) }); }
}
// insertText is asynchronous: preserve ordering before subsequent raw key/Enter events.
let inputQueue = Promise.resolve();
process.on('message', (m: any) => {
  if (['input', 'text', 'edit'].includes(m?.type)) inputQueue = inputQueue.then(() => { if (!quitting) return handleMessage(m); });
  else void handleMessage(m);
});
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
app.on('window-all-closed', () => { /* probe and tab replacement must not quit the browser instance */ });
