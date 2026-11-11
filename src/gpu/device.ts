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

/** The adapter and device the game asks for, from any `GPU` (the page's navigator.gpu, or Dawn's in Node: test/gpu) —
 *  no canvas. initGpu adds the canvas, the fatal overlay's handlers. */
export async function requestGpu(gpu: GPU | undefined): Promise<Omit<Gpu, 'context' | 'format'>> {
  if (!gpu) {
    throw new UnsupportedError(
      'This browser does not expose WebGPU. Try a recent Chrome, Edge, or Safari 26+, or Firefox 141+ on Windows.',
    );
  }
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
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
  const info = adapter.info;
  const adapterInfo = [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ') || 'unknown adapter';
  return { adapter, device, hasTimestamps, adapterInfo };
}

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  const { adapter, device, hasTimestamps, adapterInfo } = await requestGpu('gpu' in navigator ? navigator.gpu : undefined);

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

  return { adapter, device, context, format, hasTimestamps, adapterInfo };
}

/**
 * A visible, non-blocking warning: a capacity limit hit by legitimate play (e.g. the agents' field pool full),
 * not a fault. Play continues; the caller still reports the failure through its own contract (orderFailed).
 * One banner per distinct message, dismissed by a tap.
 */
const warned = new Set<string>();
export function showWarning(message: string): void {
  console.warn(message);
  if (typeof document === 'undefined' || warned.has(message)) return;
  warned.add(message);
  const el = document.createElement('div');
  el.className = 'warning-banner';
  el.style.cssText =
    'position:fixed;left:8px;right:8px;top:8px;z-index:9999;padding:8px 12px;border-radius:6px;' +
    'background:#7a4a00;color:#fff;font:13px system-ui,sans-serif;box-shadow:0 2px 8px #0008;cursor:pointer';
  el.textContent = message;
  el.title = 'Tap to dismiss';
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
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
