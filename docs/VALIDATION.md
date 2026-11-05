# 本机实测记录（2026-11-05，Asia/Shanghai）

完整通过记录：[acceptance.json](../evidence/run-1793882593439/acceptance.json)，[状态、GPU 原始信息及进程交接](../evidence/run-1793882593439/events.jsonl)。此轮外壳 PID 67817，窗口 ID 1；三轮双向切换均验证这两个值未变。记录中的 UTC 时间加 8 小时即本地时间。

## 实际渲染设备

| 请求 | 网页真实 WebGL2 渲染器 | 交叉证据 |
|---|---|---|
| Intel `0000:00:02.0`, `8086:7d51`, i915 | `ANGLE (Intel, Mesa Intel(R) Graphics (ARL), OpenGL ES 3.2)` | GPU 进程 fdinfo 的 `drm-pdev: 0000:00:02.0`、非零 `drm-engine-render`；对应动态 DRM 节点 |
| NVIDIA `0000:02:00.0`, `10de:2204` | `ANGLE (NVIDIA, Vulkan 1.4.351 (NVIDIA NVIDIA GeForce RTX 3090 (0x00002204)), NVIDIA)` | Electron 枚举的 PCI ID；GPU 进程打开 NVIDIA 设备；`nvidia-smi` 记录同一 GPU 进程（首轮 PID 68228、41 MiB） |

测试页 WebGL2 真正编译着色器、持续绘制；最终启动探针和恢复标签都验证有效像素。NVIDIA 首个探针的上下文会丢失，程序在同一引擎重建探针，本轮每次均在第二个上下文成功；各次尝试均留在 probeAttempts 中。测试页通过 `readPixels` 读取非零颜色和 alpha=255。位图回读不是软件 WebGL；测试没有启用 SwiftShader 或关闭硬件加速。GPU 下标、renderD 编号在证据里只是运行时发现结果，不是选择代码中的常量。

## 已通过

- 统一外壳显示独立引擎的真实离屏网页画面；真实 HTTPS `https://example.com` 加载出 `Example Domain`，无证书绕过。
- 三轮 Intel → NVIDIA → Intel，共六次运行中切换；外壳进程和窗口保持不变。
- 两标签 URL、顺序、ID、当前标签恢复；新建/关闭、刷新、前进/后退。
- 外壳鼠标坐标缩放与滚轮转发；原生网页文本框中的键盘删除、中文 composition 提交链路。Intel 与 NVIDIA 均写入并读回“网页中文输入”。此测试使用合成的外壳事件，未人工操作 Fcitx/IBus 候选窗口。
- 持久化 Cookie；HttpOnly **session Cookie** 的本地服务端登录态，六次换卡后均确认 `/account` 仍认证成功；网页 JS 无法读取该登录 Cookie。
- 目标不可用的模拟预检查：显示原因，不中断原工作引擎。
- 故意以实际 Intel 引擎响应 NVIDIA 请求：真实 WebGL 检出不匹配，拒绝该目标，退出失败引擎并重建 Intel，保留标签和 HttpOnly 登录会话。见 [回退截图](../evidence/run-1793882593439/renderer-mismatch-fallback.png)。
- `SIGKILL` 仅杀 RenderHop 测试网页引擎，外壳仍响应；点击同一路径恢复后 Cookie、登录与标签可用。见 [引擎已退出](../evidence/run-1793882593439/engine-crashed-shell-alive.png) 和 [恢复](../evidence/run-1793882593439/recovered.png)。
- 页面没有 `require` 或 Node `process`；未关闭 Chromium sandbox、网页安全策略或证书验证。
- `npm test`：设备动态编号关联、软件渲染拒绝、PCI 冲突、DRM 活动证据、绘制错误、环境隔离和特权协议拒绝等回归通过。

整个应用正常关闭后，另启新外壳和新引擎、复用本轮专属测试 profile，持久 Cookie 与两个标签再次恢复。见 [重启验收](../evidence/run-1793882708019/acceptance.json) 的 `browser-restart-persistent-cookie-and-tabs`。session Cookie 仅属于一次外壳生命周期，不承诺整个应用退出后保持。

## 分辨率与资源采样

同一页画布 `800×360`；网页 viewport `1280×740`；外壳 `1280×900`，2 个标签。每项取稳定运行约 3 秒样本，原始进程统计在 acceptance.json 的 `performance` 与 `crossCheck`。

| 模式（3 轮范围） | 外壳收到帧率 | 网页报告 FPS | 引擎 CPU 合计 | 外壳 CPU 合计 | 显存/图形内存 |
|---|---:|---:|---:|---:|---|
| Intel | 23.3–24.3 | 约 26（截图时约 24） | 28–30% | 20–24% | GPU DRM client 系统内存首轮约 188 MiB，属于共享内存，不是独立显存 |
| RTX 3090 | 约 24.0 | 约 26（截图时约 24） | 46–47% | 21–25% | 引擎 GPU 进程 41 MiB；整卡约 66 MiB / 24576 MiB |

CPU 100% 表示占满一个逻辑 CPU 核，以累计 CPU 秒除以墙钟时间计算，不是整机 CPU 百分比。背景任务、页面复杂度、窗口大小和电源状态都会改变结果；未把结果当成广泛性能承诺。

JPEG 90 编码约 3.7–4.3 ms/帧，压缩帧约 2.0–2.1 MB/s（未计 base64 的额外约 1/3 及 IPC 开销）。原始 32 位画面在这个分辨率和 24 FPS 下约 91 MB/s，还需要 GPU 回读与额外拷贝。较早 PNG 路线仅约 8–10 FPS，见 [PNG 采样记录](../evidence/run-1793881290909/acceptance.json)。JPEG 改善后达到本版 24 FPS 目标，但仍是有损且有 CPU 成本的传输，远未等同共享纹理或零拷贝；大型 WebGL、高清视频与高分辨率场景尚未性能验收。

## 失败路线及限制

- PRIME + Wayland + ANGLE OpenGL 请求 NVIDIA 时，真实上下文仍是 Intel，已判失败：[原始记录](../evidence/run-1793880961266/events.jsonl)。
- 原生 Wayland + ANGLE Vulkan：Chromium 日志明确报告 `ozone-platform=wayland is not compatible with Vulkan`，随后 GPU 进程故障：[最小引擎日志](../evidence/run-1793881052585/engine-10de.log)。已验证替代为隐藏引擎 XWayland + Vulkan，外壳仍原生 Wayland。
- 可重复失败路线：按该次 `events.jsonl` 的 engine-start 环境，只启动 `dist/src/engine.js`，设置独立 `RENDERHOP_PROFILE`、`RENDERHOP_PROBE` 指向应用本地页，`RENDERHOP_ANGLE=vulkan`、`RENDERHOP_OZONE=wayland` 及 NVIDIA ICD；不要使用常规网页 profile 或删除锁。需要主外壳已运行本地服务器。成功配置由代码自动使用，无需手动设置这些环境变量。
- Electron basic/complete 都返回未初始化 GL 默认元数据（`gl=none,angle=none`）且将 NVIDIA 标 active，即使活 WebGL/DRM 证明确为 Intel；程序保留并准确说明这个矛盾。
- WebGPU API 存在，但两种模式 `requestAdapter()` 都返回 null，因此标记不可用。未为了 WebGPU 打开不安全开关。
- 外壳合成 GPU 不属于网页 GPU 成功判据。视频解码只取得 Electron feature status，尚未播放测试视频并测定实际解码器。
- 未做物理热插拔；测试只是逻辑目标不可用、错误 renderer 与强制引擎退出。没有对内核/KWin 崩溃做恢复承诺。
- 未使用外部真实账号、Ultra-Water 或私人浏览资料。没有改动其他项目、驱动、全局环境或运行中的任务。

截图：[Intel](../evidence/run-1793882593439/round-1-8086.png)、[RTX 3090 与中文/登录](../evidence/run-1793882593439/round-1-10de.png)、[真实 HTTPS 网页](../evidence/run-1793882593439/real-https-example.png)。

## Chrome 常用界面与最终输入补验

新版采用浅色标签栏、圆角地址栏、星标与三点菜单；书签、历史面板、真实 Chromium 页内查找和缩放已通过完整回归（chrome-bookmarks-history-find-zoom）。书签、历史和导航资料均只保存于 RenderHop 自己的数据目录。最终 [键盘补验](../evidence/run-1793882547647/acceptance.json) 在两块显卡都确认网页收到普通 keydown、文本不重复、Enter 正确换行。

NVIDIA 网页 WebGL 确认为 RTX3090，但引擎合成报告 disabled_software / WebGL enabled_readback。界面明确黄色显示“WebGL 已验证 · 引擎合成降级”，不把硬件 WebGL 证明扩大为整条合成链加速。Intel 引擎 compositor 为 enabled。早期成功记录的首探针并未成功读像素，真实证据来自后续标签；最终版本已通过独立上下文重建使启动探针也严格满足非零像素验证。
