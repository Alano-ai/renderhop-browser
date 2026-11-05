import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDevices, launchEnvironment, validateRenderer } from '../src/devices';

test('maps a dynamic DRM render node through its PCI device and detects missing device nodes', () => {
  const root = mkdtempSync(join(tmpdir(), 'renderhop-devices-'));
  try {
    const sys = join(root, 'sys'), dev = join(root, 'dev');
    const pci = join(sys, 'bus/pci/devices/0000:02:00.0');
    mkdirSync(pci, { recursive: true });
    mkdirSync(join(sys, 'class/drm/renderD237'), { recursive: true });
    mkdirSync(join(sys, 'drivers/nvidia'), { recursive: true });
    writeFileSync(join(pci, 'class'), '0x030000');
    writeFileSync(join(pci, 'vendor'), '0x10de');
    writeFileSync(join(pci, 'device'), '0x2204');
    symlinkSync(join(sys, 'drivers/nvidia'), join(pci, 'driver'));
    symlinkSync(pci, join(sys, 'class/drm/renderD237/device'));
    const [gpu] = discoverDevices({ sysRoot: sys, devRoot: dev });
    assert.equal(gpu.pciAddress, '0000:02:00.0');
    assert.equal(gpu.renderNode, join(dev, 'dri/renderD237'));
    assert.equal(gpu.available, false);
    mkdirSync(join(dev, 'dri'), { recursive: true });
    writeFileSync(join(dev, 'dri/renderD237'), '');
    assert.equal(discoverDevices({ sysRoot: sys, devRoot: dev })[0].available, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects software, wrong vendor and contradictory active PCI device', () => {
  const gpu = { pciAddress: '0000:02:00.0', vendorId: '10de', deviceId: '2204', name: 'RTX 3090', driver: 'nvidia', renderNode: '/dev/dri/example', renderNodeAccessible: true, available: true, reason: '' };
  assert.equal(validateRenderer(gpu, { webgl2: true, vendor: 'Google', renderer: 'SwiftShader' }).ok, false);
  assert.equal(validateRenderer(gpu, { webgl2: true, vendor: 'Intel', renderer: 'Intel Graphics' }).ok, false);
  assert.equal(validateRenderer(gpu, { webgl2: true, vendor: 'NVIDIA', renderer: 'RTX 3090', gpuInfo: { gpuDevice: [{ active: true, vendorId: 0x8086, deviceId: 0x7d51 }] } }).ok, false);
  assert.equal(validateRenderer(gpu, { webgl2: true, vendor: 'NVIDIA', renderer: 'RTX 3090', gpuInfo: { gpuDevice: [{ active: true, vendorId: 0x10de, deviceId: 0x2204 }] } }).ok, true);
  assert.equal(launchEnvironment(gpu, { DRI_PRIME: '1' }).DRI_PRIME, undefined);
});

const nvidia = { pciAddress: '0000:02:00.0', vendorId: '10de', deviceId: '2204', name: 'RTX 3090', driver: 'nvidia', renderNode: '/dev/dri/example', renderNodeAccessible: true, available: true, reason: '' };
const conflictingInfo = { gpuDevice: [{ active: true, vendorId: 0x8086, deviceId: 0x7d51 }] };
const probe = { webgl2: true, vendor: 'NVIDIA', renderer: 'GeForce RTX 3090', gpuInfo: conflictingInfo };

function drm(info: string) {
  return [{ pid: 101, fds: [{ path: '/dev/dri/example', info }] }];
}

test('accepts target PCI render activity as corroboration when Electron active metadata conflicts', () => {
  const result = validateRenderer(nvidia, { ...probe, processDevices: drm('drm-pdev:\t0000:02:00.0\ndrm-engine-graphics:\t481 ns\n') });
  assert.equal(result.ok, true);
  assert.match(result.reason, /元数据不一致/);
  assert.match(result.actual, /RTX 3090/);
});

test('zero render activity or activity belonging to another PCI device cannot override a conflict', () => {
  const zero = validateRenderer(nvidia, { ...probe, processDevices: drm('drm-pdev:\t0000:02:00.0\ndrm-engine-graphics:\t0 ns\n') });
  const wrongPci = validateRenderer(nvidia, { ...probe, processDevices: drm('drm-pdev:\t0000:00:02.0\ndrm-engine-render:\t481 ns\n') });
  assert.equal(zero.ok, false);
  assert.equal(wrongPci.ok, false);
  assert.match(zero.reason, /缺少对应 DRM 渲染证据/);
});

test('a failed shader draw is rejected even with otherwise matching hardware evidence', () => {
  const result = validateRenderer(nvidia, { ...probe, error: 'fragment shader compilation failed', processDevices: drm('drm-pdev:\t0000:02:00.0\ndrm-engine-render:\t481 ns\n') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /fragment shader compilation failed/);
});

test('child GPU selectors replace inherited values without mutating the parent environment', () => {
  const parent = { DRI_PRIME: 'stale', __NV_PRIME_RENDER_OFFLOAD: 'old', __GLX_VENDOR_LIBRARY_NAME: 'old', __VK_LAYER_NV_optimus: 'old', VK_DRIVER_FILES: '/old/icd.json', VK_ICD_FILENAMES: '/old/legacy.json', MESA_VK_DEVICE_SELECT: 'old', RENDERHOP_ANGLE: 'old', RENDERHOP_OZONE: 'old', KEEP_ME: 'yes' };
  const original = { ...parent };
  const child = launchEnvironment(nvidia, parent);
  assert.deepEqual(parent, original);
  assert.equal(child.KEEP_ME, 'yes');
  assert.equal(child.DRI_PRIME, undefined);
  assert.equal(child.MESA_VK_DEVICE_SELECT, undefined);
  assert.equal(child.VK_ICD_FILENAMES, undefined);
  assert.notEqual(child.VK_DRIVER_FILES, '/old/icd.json');
  assert.equal(child.__NV_PRIME_RENDER_OFFLOAD, '1');
  assert.equal(child.__GLX_VENDOR_LIBRARY_NAME, 'nvidia');
  assert.equal(child.__VK_LAYER_NV_optimus, 'NVIDIA_only');
  assert.equal(child.RENDERHOP_ANGLE, 'vulkan');
  assert.equal(child.RENDERHOP_OZONE, 'x11');
  const intel = launchEnvironment({ ...nvidia, pciAddress: '0000:00:02.0', vendorId: '8086' }, parent);
  assert.equal(intel.DRI_PRIME, 'pci-0000_00_02_0');
  assert.equal(intel.__NV_PRIME_RENDER_OFFLOAD, undefined);
  assert.equal(intel.__GLX_VENDOR_LIBRARY_NAME, undefined);
  assert.equal(intel.__VK_LAYER_NV_optimus, undefined);
  assert.equal(intel.VK_DRIVER_FILES, undefined);
  assert.equal(intel.RENDERHOP_ANGLE, undefined);
  assert.equal(intel.RENDERHOP_OZONE, undefined);
});
