# 架构与真实 GPU 选择

```text
原生 Wayland 外壳 Electron instance（独立 shell profile）
  管理设备 / 标签快照 / 状态机 / 引擎生命周期 / 内存中的会话 Cookie
  受限 preload → 本地界面 <img> + 输入通道
              │ 私有 Node child_process IPC；带画面 ACK，最多一帧在途
              ▼
独立 Electron browser instance（唯一 web-profile 写入者）
  Intel: PCI DRI_PRIME + Wayland + ANGLE OpenGL
  NVIDIA: NVIDIA Vulkan ICD + PRIME + XWayland + ANGLE Vulkan
  GPU 进程 → 硬件 WebGL2 → 离屏画面 → CPU readback
  NativeImage → JPEG 90 → IPC → 固定外壳窗口
```

多个 BrowserWindow 或 partition 不能独立选择 GPU。这里的网页引擎是 `spawn(process.execPath, [engine.js])` 创建的**独立 Electron browser 进程树**，其驱动选择环境在它初始化 Chromium 之前设置。引擎内各标签共享这一进程树与同一 GPU 选择。跨进程不尝试嵌入 WebContents；外壳只显示位图与转发输入。

`src/devices.ts` 从 sysfs 的 PCI class/vendor/device/driver 发现硬件，通过 `/sys/class/drm/*/device` 实际 symlink 将 render 节点关联到 PCI 地址。节点编号和 GPU 数组下标不参与选择逻辑。Intel 的 `DRI_PRIME=pci-...` 使用实际 PCI 地址；NVIDIA 只在子进程设置 offload 环境并从本机已装 manifest 发现 NVIDIA Vulkan ICD。首版限制同厂商一块设备，避免把“厂商匹配”误说成任意具体设备可选。

状态流程：检测 → 预检 → 保存完整标签快照 → 正常退出旧引擎并等待 `exit` → 启动新引擎 → 本地 WebGL2 绘制/读像素/查真实 renderer → 恢复 Cookie 和标签 → 等完整恢复 ACK → 提交成功状态。恢复期间不发布不完整标签列表，也不接收新的标签修改操作。目标失败时，未停止旧引擎则保持原引擎；已经停止则正常清理失败引擎、恢复上一可用设备。旧进程未退出时拒绝启动第二个写入者，不删除 Chromium 锁。

外壳和引擎分别取得自己的单实例锁。持久 Cookie/storage 由旧引擎 flush 后通过同一 profile 交接。session Cookie 在外壳内存中持有，仅接收当前已接管引擎的更新；失败目标不能覆盖原 Cookie 快照。外壳崩溃时 IPC 断开触发引擎正常退出，重启仍由 profile 锁防止重叠。

验证并非修改按钮文字：本地真实 WebGL2 上下文必须报告目标厂商、成功绘制并读取像素，且不能包含 SwiftShader/llvmpipe 等软件渲染标识。结合 Electron GPU 信息、GPU 进程 DRM `drm-pdev` 与非零 render 引擎时间、NVIDIA 进程/显存记录进行交叉检查。本机 Electron 的 basic/complete GPU 信息都出现 `gl=none,angle=none` 并默认把 NVIDIA 标为 active，即使真实 WebGL 是 Intel。因此保留这个矛盾，Intel 必须另有同一 GPU 进程的正确 PCI 与实际 render 计时证据才能通过；不以这份默认枚举覆盖活 WebGL 上下文。没有充分交叉证据时失败。

网页渲染、外壳合成、视频解码是三件事。验证结果说明网页 WebGL；外壳运行在桌面默认图形配置，视频只报告能力，均不冒充已验证网页设备。GPU 回读会消耗 CPU，不意味着 WebGL 在软件执行。

安全边界：双方启用 Chromium sandbox、contextIsolation、webSecurity；远程页面不启用 Node、无 preload。管理界面只载入本地 shell 文件，禁止导航和新窗口；preload 仅提供命令、状态、帧三类固定接口，主进程校验发送者和参数。网页只允许 HTTP(S)/about:blank 导航，新窗口转为标签；不忽略 TLS 错误、不放宽证书或网页安全策略。没有远程调试端口。集成测试只有测试模式下可用的固定本地测试动作，没有任意 JS/命令执行接口暴露给管理界面。

依据：[Electron GPU 离屏位图](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)、[输入与 insertText](https://www.electronjs.org/docs/latest/api/web-contents)、[Mesa PCI 设备选择](https://docs.mesa3d.org/envvars.html)、[NVIDIA PRIME](https://download.nvidia.com/XFree86/Linux-x86_64/495.44/README/primerenderoffload.html)、[Chromium GPUInfo 字段](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/gpu/config/gpu_info.h)。最终是否有效由此仓库在本机的运行证据判断。

本机 NVIDIA 首个离屏窗口的 WebGL context 会在合成初始化时丢失，因而执行最多三次独立上下文探测，保留每次失败，最终必须读到有效像素才通过。实测第二个上下文成功。NVIDIA 的 WebGL 为硬件渲染，但引擎 compositor 报告 disabled_software / webgl enabled_readback，界面明确标记合成降级；Intel compositor 为 enabled。不能把离屏接口有 GPU 能力当成每个合成阶段都已硬件加速的证据。
