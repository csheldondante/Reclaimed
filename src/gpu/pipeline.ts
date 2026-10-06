// Explicit bind-group-layout helpers. We use explicit layouts (not 'auto') so a
// shader can include shared WGSL snippets that declare bindings it does not use.

export type BindKind = 'uniform' | 'read' | 'rw';
export type BindSpec = Record<number, BindKind>;

function layoutEntries(spec: BindSpec, visibility: GPUShaderStageFlags): GPUBindGroupLayoutEntry[] {
  return Object.entries(spec).map(([b, kind]) => ({
    binding: Number(b),
    visibility,
    buffer: {
      type: kind === 'uniform' ? 'uniform' : kind === 'read' ? 'read-only-storage' : 'storage',
    },
  }));
}

export function makeLayout(device: GPUDevice, label: string, spec: BindSpec, visibility: GPUShaderStageFlags) {
  return device.createBindGroupLayout({ label, entries: layoutEntries(spec, visibility) });
}

export function makeBindGroup(
  device: GPUDevice,
  label: string,
  layout: GPUBindGroupLayout,
  buffers: Record<number, GPUBuffer>,
): GPUBindGroup {
  return device.createBindGroup({
    label,
    layout,
    entries: Object.entries(buffers).map(([b, buffer]) => ({ binding: Number(b), resource: { buffer } })),
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
