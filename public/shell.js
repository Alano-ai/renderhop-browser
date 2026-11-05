'use strict';
const $ = id => document.getElementById(id);
const api = window.renderhop;
let state, composing = false, lastComposition = '', lastCompositionAt = 0;
let imageBusy = false;
let frameSize = { width: 1100, height: 650 };
let panelKind = 'bookmarks';
async function command(m) { const r = await api.command(m); if (r?.error) { $('error').textContent = r.error; $('error').style.display = 'block'; } return r; }
api.onState(s => {
  state = s;
  $('phase').textContent = s.phase;
  $('phase').style.color = s.verified?.compositorDegraded ? '#986300' : '#196548';
  $('error').textContent = s.error; $('error').style.display = s.error ? 'block' : 'none';
  const actual = s.verified?.report.renderer || '';
  $('detail').textContent = `请求：${s.requested ? s.requested.vendorId === '8086' ? 'Intel' : 'NVIDIA' : '无'} ｜ 实际：${actual.includes('RTX 3090') ? 'RTX 3090 · Vulkan' : actual.includes('Intel') ? 'Intel · Mesa OpenGL' : '尚未验证'}`;
  $('detail').title = `请求：${s.requested?.name || '无'}\n实际：${s.verified?.actual || '尚未验证'}\n${s.verified?.reason || ''}`;
  $('overlay').textContent = s.phase + (s.error ? '\n' + s.error : '');
  $('overlay').style.display = s.switching || !s.verified ? 'flex' : 'none';
  const selected = s.requested?.pciAddress;
  $('gpu').replaceChildren(...s.devices.map(d => {
    const option = document.createElement('option'); option.value = d.pciAddress;
    const check = s.checks[d.pciAddress];
    option.textContent = `${d.vendorId === '8086' ? 'Intel' : d.vendorId === '10de' ? 'NVIDIA' : d.name} ${d.pciAddress} · ${check?.ok && d.available ? 'WebGL 验证通过' : check && !check.ok ? '验证失败' : d.available ? '驱动就绪 / 待验证' : '仅检测到硬件'}`;
    option.title = d.name + ' · ' + d.reason; option.selected = selected === d.pciAddress;
    return option;
  }));
  $('gpu').disabled = s.switching;
  const active = s.tabs.tabs.find(t => t.id === s.tabs.activeId);
  const bookmarked = s.library?.bookmarks.some(b => b.url === active?.url);
  $('bookmark').textContent = bookmarked ? '★' : '☆'; $('bookmark').classList.toggle('active', !!bookmarked);
  $('bookmark').title = bookmarked ? '移除书签 · Ctrl+D' : '收藏当前页面 · Ctrl+D';
  $('zoom-reset').textContent = Math.round((active?.zoomFactor || 1) * 100) + '%';
  $('find-result').textContent = s.findResult ? `${s.findResult.activeMatchOrdinal}/${s.findResult.matches}` : '';
  if ($('panel').open) renderPanel();
  if (document.activeElement !== $('address')) $('address').value = active?.url || '';
  $('back').disabled = !active?.canGoBack || s.switching;
  $('forward').disabled = !active?.canGoForward || s.switching;
  $('tabs').replaceChildren(...s.tabs.tabs.map(t => {
    const div = document.createElement('div'); div.className = 'tab' + (t.id === s.tabs.activeId ? ' active' : '');
    const name = document.createElement('button'); name.className = 'name'; name.textContent = (t.loading ? '◌ ' : '') + (t.title || '新标签'); name.title = t.url;
    name.onclick = () => command({ type: 'activate', id: t.id });
    const close = document.createElement('button'); close.textContent = '×'; close.title = '关闭标签'; close.onclick = () => command({ type: 'close', id: t.id });
    div.append(name, close); return div;
  }));
  const add = document.createElement('button'); add.textContent = '+'; add.title = '新标签 Ctrl+T'; add.onclick = () => command({ type: 'new' }); $('tabs').append(add);
  $('report').textContent = JSON.stringify({ requested: s.requested, verified: s.verified, devices: s.devices, checks: s.checks, phase: s.phase, error: s.error, transport: 'GPU readback → JPEG quality 90 IPC → shell image; 24 FPS cap; no zero-copy', webEnginePid: s.pid }, null, 2);
});
api.onFrame(async f => {
  if (imageBusy) { command({ type: 'ack' }); return; }
  imageBusy = true;
  frameSize = f.size;
  const img = $('frame');
  try { img.src = 'data:image/jpeg;base64,' + f.data; await img.decode(); } catch {}
  imageBusy = false;
  command({ type: 'ack' });
});
$('toolbar').onsubmit = e => { e.preventDefault(); command({ type: 'navigate', url: $('address').value }); $('input').focus({ preventScroll: true }); };
for (const id of ['back', 'forward', 'reload', 'discover', 'recover']) $(id).onclick = () => command({ type: id });
$('gpu').onchange = () => command({ type: 'switch', address: $('gpu').value });
$('info').onclick = () => $('diagnostics').showModal(); $('close-info').onclick = () => $('diagnostics').close();
function closeMenu() { $('chrome-menu').hidden = true; $('menu').setAttribute('aria-expanded', 'false'); }
$('menu').onclick = () => { const open = $('chrome-menu').hidden; $('chrome-menu').hidden = !open; $('menu').setAttribute('aria-expanded', String(open)); };
document.addEventListener('click', e => { if (!$('menu').contains(e.target) && !$('chrome-menu').contains(e.target)) closeMenu(); });
function openFind() { closeMenu(); $('findbar').hidden = false; $('find-text').focus(); $('find-text').select(); }
function closeFind() { $('findbar').hidden = true; command({ type: 'find-stop' }); ime.focus({ preventScroll: true }); }
function find(next = false, forward = true) { command({ type: 'find', text: $('find-text').value, next, forward }); }
$('find-text').oninput = () => find(); $('find-next').onclick = () => find(true); $('find-prev').onclick = () => find(true, false); $('find-close').onclick = closeFind;
$('find-text').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); find(true, !e.shiftKey); } };
for (const event of ['mousedown', 'mouseup', 'mousemove', 'wheel']) $('findbar').addEventListener(event, e => e.stopPropagation());
$('bookmark').onclick = () => command({ type: 'bookmark' });
function renderPanel() {
  const query = $('panel-search').value.toLowerCase();
  const entries = (state?.library?.[panelKind] || []).filter(e => (e.title + ' ' + e.url).toLowerCase().includes(query));
  const list = $('panel-list'); list.replaceChildren();
  if (panelKind === 'history' && state?.library?.history.length) { const clear = document.createElement('button'); clear.textContent = '清空浏览历史'; clear.onclick = () => command({ type: 'history-clear' }); list.append(clear); }
  if (!entries.length) { const p = document.createElement('p'); p.textContent = query ? '没有匹配的页面' : '还没有记录'; list.append(p); }
  for (const entry of entries) {
    const row = document.createElement('div'); row.className = 'library-row';
    const open = document.createElement('button'); open.className = 'library-open'; open.dataset.url = entry.url;
    const title = document.createElement('strong'); title.textContent = entry.title || entry.url;
    const sub = document.createElement('small'); sub.textContent = entry.url; open.append(title, sub);
    open.onclick = () => { $('panel').close(); command({ type: 'navigate', url: entry.url }); }; row.append(open);
    if (panelKind === 'bookmarks') { const remove = document.createElement('button'); remove.textContent = '删除'; remove.onclick = () => command({ type: 'bookmark-remove', url: entry.url }); row.append(remove); }
    list.append(row);
  }
}
function openPanel(kind) { closeMenu(); panelKind = kind; $('panel-title').textContent = kind === 'bookmarks' ? '书签' : '历史记录'; $('panel-search').value = ''; renderPanel(); if (!$('panel').open) $('panel').showModal(); $('panel-search').focus(); }
$('panel-close').onclick = () => $('panel').close(); $('panel-search').oninput = renderPanel;
for (const item of document.querySelectorAll('[data-action]')) item.onclick = () => { const action = item.dataset.action; closeMenu(); if (action === 'bookmarks' || action === 'history') openPanel(action); else if (action === 'find') openFind(); else command({ type: action }); };
$('zoom-in').onclick = () => command({ type: 'zoom', delta: 1 }); $('zoom-out').onclick = () => command({ type: 'zoom', delta: -1 }); $('zoom-reset').onclick = () => command({ type: 'zoom', reset: true });
function modifiers(e) { return [e.shiftKey && 'shift', e.ctrlKey && 'control', e.altKey && 'alt', e.metaKey && 'meta', (e.buttons & 1) && 'leftButtonDown', (e.buttons & 2) && 'rightButtonDown', (e.buttons & 4) && 'middleButtonDown'].filter(Boolean); }
const viewport = $('viewport'), ime = $('input');
function point(e) { const r = viewport.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * frameSize.width / r.width), y: Math.round((e.clientY - r.top) * frameSize.height / r.height) }; }
function mouse(e, type) {
  if (!state?.verified || state.switching) return;
  command({ type: 'input', event: { type, ...point(e), button: ['left', 'middle', 'right'][e.button] || 'left', clickCount: Math.max(1, Math.min(3, e.detail || 1)), modifiers: modifiers(e) } });
}
viewport.addEventListener('mousedown', e => {
  e.preventDefault(); const r = viewport.getBoundingClientRect(); ime.style.left = Math.min(r.width - 3, e.clientX - r.left) + 'px'; ime.style.top = Math.min(r.height - 24, e.clientY - r.top) + 'px';
  ime.focus({ preventScroll: true }); mouse(e, 'mouseDown');
});
viewport.addEventListener('mouseup', e => mouse(e, 'mouseUp'));
viewport.addEventListener('mousemove', e => mouse(e, 'mouseMove'));
viewport.addEventListener('contextmenu', e => e.preventDefault());
viewport.addEventListener('wheel', e => { e.preventDefault(); command({ type: 'input', event: { type: 'mouseWheel', ...point(e), deltaX: -e.deltaX, deltaY: -e.deltaY, modifiers: modifiers(e) } }); }, { passive: false });
ime.addEventListener('compositionstart', () => { composing = true; });
ime.addEventListener('compositionend', e => { composing = false; lastComposition = e.data; lastCompositionAt = performance.now(); if (e.data) command({ type: 'text', text: e.data }); ime.value = ''; });
ime.addEventListener('input', e => {
  if (composing || e.isComposing) return;
  const text = ime.value;
  if (text && !(text === lastComposition && performance.now() - lastCompositionAt < 80)) command({ type: 'text', text });
  ime.value = '';
});
function shortcut(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { if (!$('findbar').hidden) { closeFind(); return true; } closeMenu(); }
  if (ctrl && e.key.toLowerCase() === 'd') { command({ type: 'bookmark' }); return true; }
  if (ctrl && e.key.toLowerCase() === 'h') { openPanel('history'); return true; }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'o') { openPanel('bookmarks'); return true; }
  if (ctrl && e.key.toLowerCase() === 'f') { openFind(); return true; }
  if (ctrl && ['+', '=', '-', '0'].includes(e.key)) { command({ type: 'zoom', delta: e.key === '-' ? -1 : 1, reset: e.key === '0' }); return true; }
  if (ctrl && e.key.toLowerCase() === 'l') { $('address').focus(); $('address').select(); return true; }
  if (ctrl && e.key.toLowerCase() === 't') { command({ type: 'new' }); return true; }
  if (ctrl && e.key.toLowerCase() === 'w') { command({ type: 'close', id: state?.tabs.activeId }); return true; }
  if (ctrl && e.key.toLowerCase() === 'r' || e.key === 'F5') { command({ type: 'reload' }); return true; }
  if (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { command({ type: e.key === 'ArrowLeft' ? 'back' : 'forward' }); return true; }
  if (ctrl && e.key === 'Tab') { const ts = state?.tabs.tabs || []; const i = ts.findIndex(t => t.id === state.tabs.activeId); if (ts.length) command({ type: 'activate', id: ts[(i + (e.shiftKey ? ts.length - 1 : 1)) % ts.length].id }); return true; }
  return false;
}
function keyCode(e) { return ({ ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space' })[e.key] || (/^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : e.key); }
document.addEventListener('keydown', e => {
  if (composing || e.isComposing || e.keyCode === 229) return;
  if (shortcut(e)) { e.preventDefault(); return; }
  if (document.activeElement !== ime) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const edits = { c: 'copy', v: 'paste', x: 'cut', a: 'selectAll', z: e.shiftKey ? 'redo' : 'undo' };
  if (ctrl && edits[e.key.toLowerCase()]) { e.preventDefault(); command({ type: 'edit', action: edits[e.key.toLowerCase()] }); return; }
  // Printable/IME characters use insertText; navigation and shortcuts use native input events.
  if (e.key.length === 1 && !ctrl && !e.altKey) { command({ type: 'input', event: { type: 'keyDown', keyCode: keyCode(e), modifiers: modifiers(e) } }); return; }
  e.preventDefault();
  command({ type: 'input', event: { type: 'keyDown', keyCode: keyCode(e), modifiers: modifiers(e) } });
  if (e.key === 'Enter') command({ type: 'input', event: { type: 'char', keyCode: '\r', modifiers: modifiers(e) } });
});
ime.addEventListener('keyup', e => { if (!composing && !e.isComposing && e.keyCode !== 229) command({ type: 'input', event: { type: 'keyUp', keyCode: keyCode(e), modifiers: modifiers(e) } }); });
const resize = () => command({ type: 'resize', width: viewport.clientWidth, height: viewport.clientHeight });
new ResizeObserver(resize).observe(viewport);
setInterval(() => { if (state?.verified && !state.switching) resize(); }, 2000);
