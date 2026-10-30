// WebGPU initialisation and capability detection.
// Policy (design doc §10): no fallbacks. If something we need is missing we
// throw an UnsupportedError with a human-readable reason and the UI shows it.

export class UnsupportedError extends Error {}

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  hasTimestamps: boolean;
  adapterInfo: string;
}

// The smallest per-stage storage-buffer count we design shaders against.
// 8 is the WebGPU core default, so every conformant device has it.
export const REQUIRED_STORAGE_BUFFERS_PER_STAGE = 8;

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new UnsupportedError(
      'This browser does not expose WebGPU. Try a recent Chrome, Edge, or Safari 26+, or Firefox 141+ on Windows.',
    );
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new UnsupportedError('WebGPU is present but no GPU adapter is available (it may be disabled or blocklisted).');
  }
  if (adapter.limits.maxStorageBuffersPerShaderStage < REQUIRED_STORAGE_BUFFERS_PER_STAGE) {
    throw new UnsupportedError(
      `GPU allows only ${adapter.limits.maxStorageBuffersPerShaderStage} storage buffers per shader stage; ${REQUIRED_STORAGE_BUFFERS_PER_STAGE} required.`,
    );
  }

  // Timestamp queries are optional instrumentation, not gameplay: request when present.
  const hasTimestamps = adapter.features.has('timestamp-query');
  const requiredFeatures: GPUFeatureName[] = hasTimestamps ? ['timestamp-query'] : [];

  // (the adapter's own buffer limits, not the defaults: a wider streamed window's mesh — ?win=, round 79 —
  // binds more than the default 128 MB where the GPU allows it; FieldMesh says so where it doesn't)
  // (round 115, tilecal: and its widest texture — the tile atlas grows to what the hardware holds, one texture's side its
  // bound: TileCache.grow)
  const requiredLimits = { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize, maxTextureDimension2D: adapter.limits.maxTextureDimension2D };
  const device = await adapter.requestDevice({ requiredFeatures, requiredLimits });

  device.lost.then((info) => {
    // ('destroyed' is only ever our own device.destroy(): the benchmark lets its device go before the next page —
    // bench v4 — and the fatal overlay showed "device lost" while the phone navigated)
    if (info.reason === 'destroyed') return;
    showFatal(`GPU device lost (${info.reason}): ${info.message}`);
  });
  device.addEventListener('uncapturederror', (ev) => {
    const e = (ev as GPUUncapturedErrorEvent).error;
    console.error(e);
    showFatal(`WebGPU error: ${e.message}`);
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new UnsupportedError('Could not create a WebGPU canvas context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const info = adapter.info;
  const adapterInfo = [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ') || 'unknown adapter';

  return { adapter, device, context, format, hasTimestamps, adapterInfo };
}

let fatalShown = false;
export function showFatal(message: string): void {
  console.error(message);
  if (fatalShown) return;
  fatalShown = true;
  const el = document.createElement('div');
  el.className = 'fatal';
  el.innerHTML = `<h1>Reclaimed can't run here</h1><p></p>`;
  el.querySelector('p')!.textContent = message;
  document.body.appendChild(el);
}
