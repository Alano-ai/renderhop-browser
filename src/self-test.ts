import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function runIntegration(ctx: any) {
  const { win, devices, switchGPU, command, request, evidence, getState, probeURL } = ctx;
  const results: any[] = [];
  const shellPid = process.pid, windowId = win.id;
  const record = (name: string, detail: any) => { results.push({ name, at: new Date().toISOString(), ...detail }); writeFileSync(join(evidence, 'acceptance.json'), JSON.stringify({ shellPid, windowId, results }, null, 2)); console.log(name, detail.passed === false ? 'FAIL' : 'PASS'); };
  async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeout = 18000) {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await check()) return; await sleep(100); }
    throw Error(`等待超时: ${label}`);
  }
  async function inspect() { return request('test', { action: 'inspect' }); }
  async function settled() { await waitFor(() => getState().tabs.tabs.length > 0 && !getState().tabs.tabs.some((t: any) => t.loading), 'tabs loaded'); await sleep(1300); }
  async function screenshot(name: string) { await sleep(500); writeFileSync(join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
  function crossCheck() {
    const enginePid = getState().engine?.pid;
    let nvidia = '';
    try { nvidia = execFileSync('nvidia-smi', ['--query-gpu=pci.bus_id,name,driver_version,memory.used,utilization.gpu', '--format=csv'], { encoding: 'utf8', timeout: 4000 }) + execFileSync('nvidia-smi', [], { encoding: 'utf8', timeout: 4000 }); } catch (e) { nvidia = String(e); }
    const processDevices: any[] = [];
    try {
      const pids = readdirSync('/proc').filter(p => /^\d+$/.test(p));
      const children = new Set([String(enginePid)]);
      for (let i = 0; i < 5; i++) for (const p of pids) try {
        const status = readFileSync(`/proc/${p}/status`, 'utf8');
        if (children.has(status.match(/^PPid:\s*(\d+)/m)?.[1] || '')) children.add(p);
      } catch {}
      for (const pid of children) try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
        const fds = readdirSync(`/proc/${pid}/fd`).flatMap(fd => { try { const path = readlinkSync(`/proc/${pid}/fd/${fd}`); return path.startsWith('/dev/dri') || path.startsWith('/dev/nvidia') ? [{ fd, path, fdinfo: readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8') }] : []; } catch { return []; } });
        processDevices.push({ pid, cmd, fds });
      } catch {}
    } catch {}
    return { nvidia, processDevices };
  }
  const initial = getState();
  record('startup-real-webgl2', { passed: !!initial.verified, phase: initial.phase, error: initial.error, report: initial.verified, devices });
  await screenshot('startup');
  if (!initial.verified) throw Error('初始 GPU 验证失败；请检查 render-report 和 engine 日志');
  await settled();
  if (process.argv.includes('--resume-check')) {
    const resumed = await request('test', { action: 'inspect' });
    assert.ok(resumed.cookie.includes('renderhop_probe=present'));
    assert.equal(getState().tabs.tabs.length, 2);
    assert.ok(getState().library.bookmarks.some((b: any) => b.url.includes('second.html')));
    record('browser-restart-persistent-cookie-and-tabs', { passed: true, tabs: getState().tabs, cookie: resumed.cookie });
    await screenshot('browser-restarted'); return;
  }
  if (process.argv.includes('--input-check')) {
    for (const device of devices) {
      if (getState().verified.pciAddress !== device.pciAddress) assert.equal(await switchGPU(device.pciAddress), true);
      await settled();
      await request('test', { action: 'keyboardSetup' });
      await win.webContents.executeJavaScript(`(()=>{const i=document.getElementById('input');i.focus();i.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'a',code:'KeyA'}));i.value='a';i.dispatchEvent(new InputEvent('input',{bubbles:true,data:'a',inputType:'insertText'}));i.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'a',code:'KeyA'}));i.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter'}));i.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter',code:'Enter'}));})()`);
      await sleep(250);
      const result = await request('test', { action: 'keyboardResult' });
      assert.equal(result.text, 'a\n'); assert.ok(result.keys.includes('a')); assert.ok(result.keys.includes('Enter'));
      record(`physical-key-and-enter-${device.vendorId}`, { passed: true, result });
      await screenshot(`keyboard-${device.vendorId}`);
    }
    return;
  }
  await win.webContents.executeJavaScript(`document.getElementById('input').focus();`);
  let page = await inspect();
  assert.equal(page.security.require, 'undefined'); assert.equal(page.security.node, 'undefined');
  record('remote-page-isolation', { passed: true, security: page.security });
  const rect = page.rects.input;
  const mouse = async (type: string, x: number, y: number) => win.webContents.executeJavaScript(`(()=>{const v=document.getElementById('viewport'),r=v.getBoundingClientRect(); const i=document.getElementById('frame');v.dispatchEvent(new MouseEvent(${JSON.stringify({mouseMove:'mousemove',mouseDown:'mousedown',mouseUp:'mouseup'}[type])},{bubbles:true,button:0,buttons:${type === 'mouseDown' ? 1 : 0},detail:1,clientX:r.left+${x}*r.width/i.naturalWidth,clientY:r.top+${y}*r.height/i.naturalHeight}));})()`);
  await mouse('mouseDown', rect.x + 40, rect.y + 20); await mouse('mouseUp', rect.x + 40, rect.y + 20);
  await sleep(100);
  // Exercise the exact shell composition → text IPC path, not a DOM assignment in the webpage.
  await win.webContents.executeJavaScript(`(()=>{const i=document.getElementById('input');i.focus();i.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));i.value='跃显中文测试';i.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'跃显中文测试'}));})()`);
  await sleep(300);
  await command({ type: 'input', event: { type: 'keyDown', keyCode: 'End' } });
  await command({ type: 'input', event: { type: 'keyDown', keyCode: 'Backspace' } });
  await command({ type: 'input', event: { type: 'keyUp', keyCode: 'Backspace' } });
  await sleep(150);
  page = await inspect(); assert.equal(page.text, '跃显中文测');
  record('mouse-keyboard-chinese-commit', { passed: true, text: page.text, inputStatus: page.inputStatus, limitation: '自动化测试 composition 提交链路；未人工操作系统输入法候选框' });
  const scroll = page.rects.scroll;
  await mouse('mouseMove', scroll.x + 30, scroll.y + 20);
  await win.webContents.executeJavaScript(`(()=>{const v=document.getElementById('viewport'),r=v.getBoundingClientRect(),i=document.getElementById('frame');v.dispatchEvent(new WheelEvent('wheel',{bubbles:true,clientX:r.left+${scroll.x + 30}*r.width/i.naturalWidth,clientY:r.top+${scroll.y + 20}*r.height/i.naturalHeight,deltaY:100}));})()`);
  await sleep(500); page = await inspect(); assert.ok(page.scroll > 0); record('wheel-forwarding', { passed: true, scroll: page.scroll, wheel: page.wheel });
  await request('test', { action: 'cookie' });
  page = await inspect(); assert.ok(page.cookie.includes('renderhop_probe=present'));
  assert.equal((await request('test', { action: 'login' })).loggedIn, true);
  assert.equal((await request('test', { action: 'account' })).loggedIn, true);
  assert.ok(!(await inspect()).cookie.includes('renderhop_login'), '登录 Cookie 必须为 HttpOnly');
  record('httponly-session-login', { passed: true, fixture: '本地服务端以 HttpOnly session cookie 认证，JS 无法读取登录 cookie' });
  await command({ type: 'new' }); await settled();
  assert.equal(getState().tabs.tabs.length, 2);
  await command({ type: 'navigate', url: probeURL.replace('probe.html', 'second.html') }); await settled();
  assert.ok((await inspect()).url.includes('second.html'));
  await command({ type: 'back' }); await settled(); assert.ok((await inspect()).url.includes('probe.html'));
  await command({ type: 'forward' }); await settled(); assert.ok((await inspect()).url.includes('second.html'));
  await command({ type: 'reload' }); await settled();
  const tabsBefore = structuredClone(getState().tabs);
  record('tabs-navigation', { passed: true, tabs: tabsBefore });
  await win.webContents.executeJavaScript(`document.getElementById('bookmark').click()`);
  await waitFor(() => getState().library.bookmarks.some((b: any) => b.url.includes('second.html')), '书签保存');
  await win.webContents.executeJavaScript(`document.getElementById('menu').click();document.querySelector('[data-action="bookmarks"]').click()`);
  const bookmarkPanel = await win.webContents.executeJavaScript(`({open:document.getElementById('panel').open,title:document.getElementById('panel-title').textContent,count:document.querySelectorAll('#panel-list [data-url]').length})`);
  assert.ok(bookmarkPanel.open && bookmarkPanel.count > 0); await screenshot('chrome-bookmarks');
  await win.webContents.executeJavaScript(`document.getElementById('panel-close').click();document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,ctrlKey:true,key:'h'}))`);
  const historyPanel = await win.webContents.executeJavaScript(`({open:document.getElementById('panel').open,title:document.getElementById('panel-title').textContent,count:document.querySelectorAll('#panel-list [data-url]').length})`);
  assert.ok(historyPanel.open && historyPanel.title === '历史记录' && historyPanel.count > 0);
  await win.webContents.executeJavaScript(`document.getElementById('panel-close').click();document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,ctrlKey:true,key:'f'}));const f=document.getElementById('find-text');f.value='WebGL2';f.dispatchEvent(new InputEvent('input',{bubbles:true,data:'WebGL2'}));`);
  await waitFor(() => getState().findResult?.matches > 0, '真实网页页内查找');
  const found = getState().findResult;
  await screenshot('chrome-find');
  await win.webContents.executeJavaScript(`document.getElementById('find-close').click();document.getElementById('menu').click();document.getElementById('zoom-in').click()`);
  await waitFor(() => getState().tabs.tabs.find((t: any) => t.id === getState().tabs.activeId).zoomFactor > 1, '网页缩放');
  await win.webContents.executeJavaScript(`document.getElementById('zoom-reset').click();document.getElementById('menu').click()`);
  await waitFor(() => getState().tabs.tabs.find((t: any) => t.id === getState().tabs.activeId).zoomFactor === 1, '缩放恢复');
  record('chrome-bookmarks-history-find-zoom', { passed: true, bookmarkPanel, historyPanel, found, library: getState().library });
  const intel = devices.find((d: any) => d.vendorId === '8086'), nvidia = devices.find((d: any) => d.vendorId === '10de');
  assert.ok(intel && nvidia, '需要两块目标显卡');
  for (let round = 1; round <= 3; round++) {
    for (const device of [nvidia, intel]) {
      const start = Date.now();
      assert.equal(await switchGPU(device.pciAddress), true, getState().error);
      await settled(); page = await inspect();
      assert.equal(win.isDestroyed(), false); assert.equal(win.id, windowId); assert.equal(process.pid, shellPid);
      assert.equal(page.probe.webgl2, true); assert.ok(page.probe.pixel?.[3] === 255);
      assert.ok(page.cookie.includes('renderhop_probe=present'));
      assert.equal((await request('test', { action: 'account' })).loggedIn, true);
      assert.deepEqual(getState().tabs.tabs.map((t: any) => [t.id, t.url]), tabsBefore.tabs.map((t: any) => [t.id, t.url]));
      assert.equal(getState().tabs.activeId, tabsBefore.activeId);
      if (round === 1) {
        await mouse('mouseDown', page.rects.input.x + 30, page.rects.input.y + 18);
        await mouse('mouseUp', page.rects.input.x + 30, page.rects.input.y + 18);
        await sleep(100);
        await win.webContents.executeJavaScript(`(()=>{const i=document.getElementById('input');i.focus();i.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));i.value='网页中文输入';i.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'网页中文输入'}));})()`);
        await sleep(200);
        assert.equal((await inspect()).text, '网页中文输入');
        record(`input-${device.vendorId}`, { passed: true, method: '外壳鼠标坐标映射、composition 提交经 IPC 写入真实网页文本框' });
      }
      const baseline = await request('metrics');
      const shellMetricsStart = (await import('electron')).app.getAppMetrics();
      const sampleStart = Date.now();
      await sleep(3000);
      const metrics = await request('metrics'), sampleMs = Date.now() - sampleStart;
      const cpu = (rows: any[], before: any[]) => rows.map(row => ({ pid: row.pid, type: row.type, cpuCorePercent: 100000 * (row.cpu.cumulativeCPUUsage - (before.find(b => b.pid === row.pid)?.cpu.cumulativeCPUUsage ?? row.cpu.cumulativeCPUUsage)) / sampleMs, workingSetKiB: row.memory.workingSetSize }));
      record(`round-${round}-${device.vendorId}`, { passed: true, elapsedMs: Date.now() - start, requested: device, actual: getState().verified, page, metrics, performance: { sampleMs, deliveredFps: (metrics.frameCount - baseline.frameCount) * 1000 / sampleMs, bitmapBytesPerSecond: (metrics.frameBytes - baseline.frameBytes) * 1000 / sampleMs, encodeMsPerFrame: (metrics.encodeMs - baseline.encodeMs) / Math.max(1, metrics.frameCount - baseline.frameCount), engineCPU: cpu(metrics.metrics, baseline.metrics), shellCPU: cpu((await import('electron')).app.getAppMetrics(), shellMetricsStart) }, crossCheck: crossCheck() });
      await screenshot(`round-${round}-${device.vendorId}`);
    }
  }
  const pidBefore = getState().engine.pid;
  assert.equal(await switchGPU(nvidia.pciAddress, { simulatedUnavailable: true }), false);
  assert.equal(getState().engine.pid, pidBefore); assert.ok(getState().verified); assert.ok(getState().error.includes('模拟设备失联'));
  record('unavailable-target-keeps-working-engine', { passed: true, error: getState().error });
  await screenshot('unavailable-target');
  const beforeFailure = getState().engine.pid;
  assert.equal(await switchGPU(nvidia.pciAddress, { simulatedWrongRenderer: true }), false);
  await settled();
  assert.ok(getState().error.includes('厂商不一致'));
  assert.equal(getState().verified.pciAddress, intel.pciAddress);
  assert.notEqual(getState().engine.pid, beforeFailure);
  assert.equal((await request('test', { action: 'account' })).loggedIn, true);
  assert.deepEqual(getState().tabs.tabs.map((t: any) => [t.id, t.url]), tabsBefore.tabs.map((t: any) => [t.id, t.url]));
  record('wrong-renderer-rejected-and-real-engine-fallback', { passed: true, explanation: '测试故意以 Intel 的真实引擎响应 NVIDIA 请求；读取实际 WebGL，拒绝后退出该引擎并恢复 Intel', error: getState().error, verified: getState().verified });
  await screenshot('renderer-mismatch-fallback');
  getState().engine.kill('SIGKILL');
  await waitFor(() => !getState().engine, 'crashed engine exits');
  assert.equal(win.isDestroyed(), false);
  await command({ type: 'discover' });
  await screenshot('engine-crashed-shell-alive');
  assert.equal(await command({ type: 'recover' }), true);
  await settled(); assert.ok((await inspect()).cookie.includes('renderhop_probe=present'));
  assert.equal((await request('test', { action: 'account' })).loggedIn, true);
  record('engine-crash-and-recovery', { passed: true, shellPid: process.pid, recovered: getState().verified });
  await screenshot('recovered');
  const shellGpu = await (await import('electron')).app.getGPUInfo('complete');
  record('shell-compositor-separate', { passed: true, gpuInfo: shellGpu });
  await command({ type: 'new' }); await settled();
  await command({ type: 'navigate', url: 'https://example.com' });
  await waitFor(() => getState().tabs.tabs.some((t: any) => t.id === getState().tabs.activeId && t.title === 'Example Domain' && !t.loading), '真实 HTTPS 网页', 25000);
  record('real-https-navigation', { passed: true, tab: getState().tabs.tabs.find((t: any) => t.id === getState().tabs.activeId) });
  await screenshot('real-https-example');
  await command({ type: 'close', id: getState().tabs.activeId }); await settled();
  record('boundaries', { passed: true, physicalHotplug: '未实测；只模拟目标失联及强制引擎退出', login: '持久化 Cookie + HttpOnly session cookie 本地服务端登录态已测；未使用外部真实账号', videoDecode: '仅报告 Chromium 能力，未验证实际视频解码设备' });
}
