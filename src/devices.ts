import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface GpuDevice {
  pciAddress: string;
  vendorId: string;
  deviceId: string;
  name: string;
  driver: string | null;
  renderNode: string | null;
  renderNodeAccessible: boolean;
  /** Preliminary driver/node check only. A successful WebGL probe is still required. */
  available: boolean;
  reason: string;
}
export interface RendererReport {
  webgl2: boolean;
  vendor?: string | null;
  renderer?: string | null;
  gpuInfo?: unknown;
  processDevices?: Array<{ pid: number; fds: Array<{ path: string; info: string }> }>;
  pixel?: number[];
  error?: string | null;
}
export interface ValidationResult { ok: boolean; reason: string; actual: string }
export interface DiscoveryOptions { sysRoot?: string; devRoot?: string; lspci?: boolean }

function read(path: string): string | null {
  try { return readFileSync(path, 'utf8').trim(); } catch { return null; }
}
function entries(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}
function linkBase(path: string): string | null {
  try { return basename(realpathSync(path)); } catch { return null; }
}
function readableWritable(path: string): boolean {
  try { accessSync(path, constants.R_OK | constants.W_OK); return true; } catch { return false; }
}
function displayName(address: string, fallback: string, enabled: boolean): string {
  if (!enabled) return fallback;
  try {
    const line = execFileSync('lspci', ['-D', '-s', address, '-nn'], { encoding: 'utf8', timeout: 1500 }).trim();
    return line.replace(/^[^ ]+\s+[^:]+:\s*/, '') || fallback;
  } catch { return fallback; }
}

/** Discover PCI display devices and associate render nodes through sysfs device links. */
export function discoverDevices(options: DiscoveryOptions = {}): GpuDevice[] {
  const sys = options.sysRoot || '/sys';
  const dev = options.devRoot || '/dev';
  const pciRoot = join(sys, 'bus/pci/devices');
  const drmRoot = join(sys, 'class/drm');
  const renderByPci = new Map<string, string>();
  for (const entry of entries(drmRoot).filter(e => /^renderD\d+$/.test(e))) {
    const pci = linkBase(join(drmRoot, entry, 'device'));
    if (pci && /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(pci)) {
      renderByPci.set(pci.toLowerCase(), join(dev, 'dri', entry));
    }
  }
  const result: GpuDevice[] = [];
  for (const address of entries(pciRoot).sort()) {
    if (!/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(address)) continue;
    const path = join(pciRoot, address);
    const gpuClass = read(join(path, 'class'));
    if (!gpuClass || (parseInt(gpuClass, 16) >> 16) !== 3) continue;
    const vendorId = read(join(path, 'vendor'))?.replace(/^0x/i, '').toLowerCase();
    const deviceId = read(join(path, 'device'))?.replace(/^0x/i, '').toLowerCase();
    if (!vendorId || !deviceId) continue;
    const pciAddress = address.toLowerCase();
    const driver = linkBase(join(path, 'driver'));
    const renderNode = renderByPci.get(pciAddress) || null;
    const renderNodeAccessible = !!renderNode && readableWritable(renderNode);
    const supported = vendorId === '8086' || vendorId === '10de';
    const reasons = [!supported && '首版仅支持 Intel 和 NVIDIA', !driver && '未绑定内核驱动', !renderNode && '未发现 DRM render 节点', renderNode && !existsSync(renderNode) && 'render 节点不可见', renderNode && existsSync(renderNode) && !renderNodeAccessible && 'render 节点不可读写'].filter(Boolean);
    result.push({ pciAddress, vendorId, deviceId, name: displayName(pciAddress, `${vendorId}:${deviceId}`, options.lspci !== false && !options.sysRoot), driver, renderNode, renderNodeAccessible, available: reasons.length === 0, reason: reasons.length ? reasons.join('；') : '驱动和节点已发现，尚需 WebGL 渲染验证' });
  }
  return result;
}

/** Apply GPU selection only to the independent browser process, never globally. */
export function launchEnvironment(device: GpuDevice, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  // Drop inherited selectors so an earlier process does not override this request.
  delete env.DRI_PRIME;
  delete env.__NV_PRIME_RENDER_OFFLOAD;
  delete env.__GLX_VENDOR_LIBRARY_NAME;
  delete env.__VK_LAYER_NV_optimus;
  delete env.MESA_VK_DEVICE_SELECT;
  delete env.VK_DRIVER_FILES;
  delete env.VK_ICD_FILENAMES;
  delete env.RENDERHOP_ANGLE;
  delete env.RENDERHOP_OZONE;
  if (device.vendorId === '8086') {
    env.DRI_PRIME = `pci-${device.pciAddress.replace(/[:.]/g, '_')}`;
  } else if (device.vendorId === '10de') {
    env.__NV_PRIME_RENDER_OFFLOAD = '1';
    env.__GLX_VENDOR_LIBRARY_NAME = 'nvidia';
    env.__VK_LAYER_NV_optimus = 'NVIDIA_only';
    env.RENDERHOP_ANGLE = 'vulkan';
    env.RENDERHOP_OZONE = 'x11';
    // Select the installed NVIDIA ICD, not an ordinal adapter. This machine has one NVIDIA GPU.
    const manifest = entries('/usr/share/vulkan/icd.d').find(name => /nvidia.*\.json$/.test(name));
    if (manifest) env.VK_DRIVER_FILES = join('/usr/share/vulkan/icd.d', manifest);
  }
  return env;
}

function hexId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString(16).padStart(4, '0');
  if (typeof value !== 'string') return null;
  const match = value.match(/^(?:0x)?([0-9a-f]{1,8})$/i);
  return match ? match[1].toLowerCase().padStart(4, '0') : null;
}

/** Check the actual WebGL renderer, and cross-check Chromium's active device when available. */
export function validateRenderer(device: GpuDevice, report: RendererReport): ValidationResult {
  const actual = [report.vendor, report.renderer].filter(Boolean).join(' / ') || '未知';
  const fail = (reason: string): ValidationResult => ({ ok: false, reason, actual });
  if (!report.webgl2) return fail('WebGL2 不可用');
  if (report.error) return fail('WebGL 测试绘制失败: ' + report.error);
  if (!report.renderer || !report.vendor) return fail('无法读取未屏蔽的 WebGL 渲染器信息');
  if (/swiftshader|llvmpipe|softpipe|software rasterizer|software rendering/i.test(actual)) return fail('WebGL 使用软件渲染');
  const expected = device.vendorId === '8086' ? /intel/i : device.vendorId === '10de' ? /nvidia|geforce|quadro|rtx/i : null;
  if (!expected || !expected.test(actual)) return fail('WebGL 渲染器与请求的显卡厂商不一致');
  const info = report.gpuInfo as { gpuDevice?: Array<Record<string, unknown>> } | undefined;
  const drmProof = report.processDevices?.some(p => p.fds.some(fd =>
    fd.info.includes(`drm-pdev:\t${device.pciAddress}`) &&
    /drm-engine-(?:render|graphics):\s*[1-9]\d*\s*ns/.test(fd.info)));
  const active = Array.isArray(info?.gpuDevice) ? info.gpuDevice.filter(d => d.active === true) : [];
  if (active.length) {
    const matches = active.some(d => hexId(d.vendorId) === device.vendorId && hexId(d.deviceId) === device.deviceId);
    if (!matches && !drmProof) return fail('Chromium 活动 GPU 的 PCI 标识与请求不一致，且缺少对应 DRM 渲染证据');
    if (!matches && drmProof) return { ok: true, reason: 'WebGL 及 GPU 进程 drm-pdev/渲染计时匹配；Electron 活动设备元数据不一致，详见原始记录', actual };
  }
  if (!active.length && !drmProof) return fail('只有 WebGL 厂商信息，缺少实际 PCI 设备交叉证据');
  return { ok: true, reason: drmProof ? 'WebGL 和 GPU 进程 DRM PCI/渲染计时匹配' : active.length ? 'WebGL 渲染器及 Chromium 活动 GPU 匹配' : 'WebGL 厂商匹配；Chromium 未报告可交叉核对的活动 PCI 标识', actual };
}
