// Explicit bind-group-layout helpers. We use explicit layouts (not 'auto') so a
// shader can include shared WGSL snippets that declare bindings it does not use.

/** 'tex' = sampled float texture (textureLoad), 'stex' = write-only rgba32float storage texture,
 *  'depth' = depth texture, 'csampler' = comparison sampler (shadow lookups) */
export type BindKind = 'uniform' | 'read' | 'rw' | 'tex' | 'stex' | 'depth' | 'csampler';
export type BindSpec = Record<number, BindKind>;

function layoutEntries(spec: BindSpec, visibility: GPUShaderStageFlags): GPUBindGroupLayoutEntry[] {
  return Object.entries(spec).map(([b, kind]): GPUBindGroupLayoutEntry => {
    if (kind === 'tex') return { binding: Number(b), visibility, texture: { sampleType: 'unfilterable-float' } };
    if (kind === 'stex') return { binding: Number(b), visibility, storageTexture: { access: 'write-only', format: 'rgba32float' } };
    if (kind === 'depth') return { binding: Number(b), visibility, texture: { sampleType: 'depth' } };
    if (kind === 'csampler') return { binding: Number(b), visibility, sampler: { type: 'comparison' } };
    return {
      binding: Number(b),
      visibility,
      buffer: { type: kind === 'uniform' ? 'uniform' : kind === 'read' ? 'read-only-storage' : 'storage' },
    };
  });
}

/** `stages` narrows single bindings' visibility (a stage has at most 8 storage buffers). */
export function makeLayout(device: GPUDevice, label: string, spec: BindSpec, visibility: GPUShaderStageFlags, stages: Record<number, GPUShaderStageFlags> = {}) {
  const entries = layoutEntries(spec, visibility).map((e) => (e.binding in stages ? { ...e, visibility: stages[e.binding] } : e));
  return device.createBindGroupLayout({ label, entries });
}

export function makeBindGroup(
  device: GPUDevice,
  label: string,
  layout: GPUBindGroupLayout,
  resources: Record<number, GPUBuffer | GPUBufferBinding | GPUTextureView | GPUSampler>,
): GPUBindGroup {
  return device.createBindGroup({
    label,
    layout,
    entries: Object.entries(resources).map(([b, r]) => ({
      binding: Number(b),
      resource: r instanceof GPUBuffer ? { buffer: r } : r,
    })),
  });
}

/** Compile a WGSL module and surface compilation errors loudly (with line context). */
export function makeModule(device: GPUDevice, label: string, parts: string[]): GPUShaderModule {
  const code = parts.join('\n');
  const module = device.createShaderModule({ label, code });
  module.getCompilationInfo().then((info) => {
    const errs = info.messages.filter((m) => m.type === 'error');
    if (errs.length) {
      const lines = code.split('\n');
      const msg = errs
        .map((e) => `${label}:${e.lineNum}:${e.linePos} ${e.message}\n  > ${lines[e.lineNum - 1]?.trim() ?? ''}`)
        .join('\n');
      console.error(msg);
    }
  });
  return module;
}

export interface ComputeKernel {
  pipeline: GPUComputePipeline;
  layout: GPUBindGroupLayout;
}

export function makeCompute(
  device: GPUDevice,
  label: string,
  parts: string[],
  spec: BindSpec,
  entryPoint = 'main',
): ComputeKernel {
  const layout = makeLayout(device, label, spec, GPUShaderStage.COMPUTE);
  const pipeline = device.createComputePipeline({
    label,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: makeModule(device, label, parts), entryPoint },
  });
  return { pipeline, layout };
}

/**
 * For readbacks of buffers owned by a world: when the scene is disposed while
 * a map is in flight, the buffer is destroyed and mapAsync rejects with an
 * AbortError. That is expected teardown; anything else is a real error.
 */
export function ignoreTeardown(e: unknown): void {
  if (e instanceof DOMException && e.name === 'AbortError') return;
  throw e;
}

/** makeCompute, compiled off the main thread (createComputePipelineAsync): compile many at once with Promise.all */
export async function makeComputeAsync(
  device: GPUDevice,
  label: string,
  module: GPUShaderModule,
  spec: BindSpec,
  entryPoint = 'main',
): Promise<ComputeKernel> {
  const layout = makeLayout(device, label, spec, GPUShaderStage.COMPUTE);
  const pipeline = await device.createComputePipelineAsync({
    label,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint },
  });
  return { pipeline, layout };
}
