'use strict';

(() => {
  const canvas = document.getElementById('canvas');
  const graphics = document.getElementById('graphics');
  const input = document.getElementById('input');
  const scroll = document.getElementById('scroll');
  const cookieStatus = document.getElementById('cookie-status');
  const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
  const state = { webgl2: !!gl, vendor: null, renderer: null, version: null, fps: 0, resolution: [canvas.width, canvas.height], pixel: null, error: null };
  let frames = 0;
  let last = performance.now();
  let lastRead = -1000;
  let webgpu = { supported: false, reason: '尚未检测' };

  async function inspectWebGPU() {
    if (!navigator.gpu) return { supported: false, reason: '当前上下文没有 WebGPU API' };
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { supported: false, reason: '未取得 WebGPU adapter' };
      const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
      return { supported: true, adapter: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null, features: Array.from(adapter.features || []) };
    } catch (error) { return { supported: false, reason: String(error) }; }
  }
  inspectWebGPU().then(result => { webgpu = result; }).catch(error => { webgpu = { supported: false, reason: String(error) }; });

  if (gl) {
    try {
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      state.vendor = debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null;
      state.renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
      state.version = gl.getParameter(gl.VERSION);
      const shader = (type, source) => {
        const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es\n in vec2 p; out vec2 uv; void main(){ uv=p*.5+.5; gl_Position=vec4(p,0.,1.); }`));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es\n precision highp float; in vec2 uv; uniform float t; out vec4 color; void main(){ vec2 q=uv-.5; float wave=.5+.5*sin(20.*length(q)-t*2.); color=vec4(.08+.15*wave, .2+.5*uv.x, .35+.45*uv.y+.1*wave, 1.); }`));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'p'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const time = gl.getUniformLocation(program, 't');
      function draw(now) {
        gl.viewport(0, 0, canvas.width, canvas.height); gl.uniform1f(time, now / 1000); gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (now - lastRead >= 500) {
          const pixel = new Uint8Array(4); gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          state.pixel = Array.from(pixel); lastRead = now;
          const code = gl.getError(); if (code !== gl.NO_ERROR) state.error = `WebGL 错误 0x${code.toString(16)}`;
        }
        frames++;
        if (now - last >= 1000) { state.fps = Math.round(frames * 1000 / (now - last)); frames = 0; last = now; show(); }
        requestAnimationFrame(draw);
      }
      requestAnimationFrame(draw);
    } catch (error) { state.error = String(error); }
  } else state.error = '无法创建 WebGL2 上下文';

  function show() {
    graphics.textContent = `WebGL2：${state.webgl2 ? '可用' : '不可用'}\n实际渲染器：${state.renderer || '不可读取'}\n供应商：${state.vendor || '不可读取'}\n版本：${state.version || '未知'}\n画布：${state.resolution.join(' × ')}；帧率：${state.fps} FPS\n像素采样：${state.pixel ? state.pixel.join(', ') : '尚无'}\nWebGPU：${webgpu.supported ? '可用' : webgpu.reason}${state.error ? `\n错误：${state.error}` : ''}`;
  }
  show();
  window.renderhopProbe = async () => ({ ...state, webgpu: await inspectWebGPU() });

  let clicks = 0, inputs = 0, compositions = 0, wheels = 0;
  function showInput() { document.getElementById('input-status').textContent = `鼠标点击：${clicks}；输入事件：${inputs}；组合输入：${compositions}`; }
  document.addEventListener('click', () => { clicks++; showInput(); });
  input.addEventListener('input', () => { inputs++; showInput(); });
  input.addEventListener('compositionend', () => { compositions++; showInput(); });
  function showWheel() { document.getElementById('wheel-status').textContent = `滚轮事件：${wheels}；滚动位置：${scroll.scrollTop}`; }
  scroll.addEventListener('wheel', () => { wheels++; showWheel(); }, { passive: true });
  scroll.addEventListener('scroll', showWheel, { passive: true });
  function showCookie() { cookieStatus.textContent = `Cookie：${document.cookie.includes('renderhop_probe=') ? document.cookie.split('; ').find(s => s.startsWith('renderhop_probe=')) : '尚未设置'}`; }
  document.getElementById('cookie-set').addEventListener('click', () => { document.cookie = 'renderhop_probe=present; Max-Age=2592000; Path=/; SameSite=Lax'; showCookie(); });
  showCookie();
  async function showLogin() {
    try { const account = await (await fetch('/account')).json(); document.getElementById('login-status').textContent = `本地测试账号：${account.loggedIn ? '已登录（HttpOnly 会话 Cookie）' : '未登录'}`; }
    catch (error) { document.getElementById('login-status').textContent = String(error); }
  }
  document.getElementById('login-set').addEventListener('click', async () => { await fetch('/login', { method: 'POST' }); await showLogin(); });
  showLogin();
})();
