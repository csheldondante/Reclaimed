// Explicit bind-group-layout helpers. We use explicit layouts (not 'auto') so a
// shader can include shared WGSL snippets that declare bindings it does not use.

import { PAGE_ADDR, PAGE_CHECK, PAGE_MISS_BINDING, PAGE_MISS_MAX, PAGE_STORAGE_KERNELS, PAGE_TAB_BINDING, pageMiss, pageTab, pagesCode, usesPages } from './pages-mode';

/** 'tex' = sampled float texture (textureLoad), 'utex' = uint texture (textureLoad), 'stex' = write-only rgba32float storage texture
 *  ('stex8a' the same, rgba8unorm, a 2d-array),
 *  'depth' = depth texture, 'csampler' = comparison sampler (shadow lookups) */
export type BindKind = 'uniform' | 'read' | 'rw' | 'tex' | 'utex' | 'stex' | 'stex16' | 'stex8a' | 'depth' | 'csampler';
export type BindSpec = Record<number, BindKind>;

function layoutEntries(spec: BindSpec, visibility: GPUShaderStageFlags): GPUBindGroupLayoutEntry[] {
  return Object.entries(spec).map(([b, kind]): GPUBindGroupLayoutEntry => {
    if (kind === 'tex') return { binding: Number(b), visibility, texture: { sampleType: 'unfilterable-float' } };
    if (kind === 'utex') return { binding: Number(b), visibility, texture: { sampleType: 'uint' } };
    if (kind === 'stex') return { binding: Number(b), visibility, storageTexture: { access: 'write-only', format: 'rgba32float' } };
    if (kind === 'stex16') return { binding: Number(b), visibility, storageTexture: { access: 'write-only', format: 'rgba16float' } };
    // (round 94: a write-only rgba8unorm 2d-array — atlas/bake.ts's levels)
    if (kind === 'stex8a') return { binding: Number(b), visibility, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } };
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
  // (round 107, M1's ?pages=storage: a layout given the storage page table gets its buffer)
  if (pageTab.layouts.has(layout) && !(PAGE_TAB_BINDING in resources)) {
    if (!pageTab.buf) throw new Error(`${label}: ?pages=storage, but no world has made its page table`);
    resources = { ...resources, [PAGE_TAB_BINDING]: pageTab.buf };
  }
  // (round 107, ?pagecheck=1: a layout given the off-window counter gets its buffer)
  if (pageMiss.layouts.has(layout) && !(PAGE_MISS_BINDING in resources)) {
    if (!pageMiss.buf) throw new Error(`${label}: ?pagecheck=1, but no world has made its counter`);
    resources = { ...resources, [PAGE_MISS_BINDING]: pageMiss.buf };
  }
  return device.createBindGroup({
    label,
    layout,
    entries: Object.entries(resources).map(([b, r]) => ({
      binding: Number(b),
      resource: r instanceof GPUBuffer ? { buffer: r } : r,
    })),
  });
}

/**
 * (round 112, testspeed) The boot's pipelines, made all at once off the GPU process's main thread: inside a batch
 * (beginPipelineBatch … await endPipelineBatch — LevelScene.create round the level's making) makeCompute and
 * renderPipe ask for createComputePipelineAsync / createRenderPipelineAsync and fill the kernel in when it's ready;
 * endPipelineBatch resolves when every one is. Dawn compiles async pipelines on its worker threads in parallel, sync
 * ones one after another on the GPU process's main thread with the page waiting (the atlas boot's 114 compute + 15
 * render pipelines, DXC on D3D12: ~30 s there; 17 s for all of them async). Outside a batch — the menu, mid-game,
 * lazily — they're made synchronously as before. A kernel used before its batch ends throws (setPipeline(undefined)).
 */
const pendingPipes: Promise<unknown>[] = [];
let batchOpen = false;
/** from now on the pipelines asked for are made async, together */
export function beginPipelineBatch(): void {
  batchOpen = true;
}
/** the batch over: resolves when every pipeline asked for in it is ready; what's made from then on is made synchronously */
export async function endPipelineBatch(): Promise<void> {
  batchOpen = false;
  while (pendingPipes.length) await Promise.all(pendingPipes.splice(0));
}
/** A render pipeline handed to `set`: now, or in a batch when it's ready (before endPipelineBatch resolves). */
export function renderPipe(device: GPUDevice, desc: GPURenderPipelineDescriptor, set: (p: GPURenderPipeline) => void): void {
  if (batchOpen) pendingPipes.push(device.createRenderPipelineAsync(desc).then(set));
  else set(device.createRenderPipeline(desc));
}

/** Compile a WGSL module and surface compilation errors loudly (with line context). */
export function makeModule(device: GPUDevice, label: string, parts: string[], storagePages = false, check?: number): GPUShaderModule {
  // (round 107, pages: colPage the build's way — gpu/pages-mode.ts)
  const code = pagesCode(parts.join('\n'), storagePages, check);
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
  // (round 107, M1's ?pages=storage: the timed kernels with a storage slot free read the table from binding 61 — round 107: not 37, agents.wgsl navCost)
  const storage = PAGE_ADDR === 'storage' && PAGE_STORAGE_KERNELS.has(label) && Object.values(spec).filter((k) => k === 'read' || k === 'rw').length < 8;
  if (storage) spec = { ...spec, [PAGE_TAB_BINDING]: 'read' };
  // (round 107, ?pagecheck=1: the off-window counter on every kernel with a storage slot free)
  let check: number | undefined;
  if (PAGE_CHECK && !storage && usesPages(parts.join('\n'))) {
    if (Object.values(spec).filter((k) => k === 'read' || k === 'rw').length < 8 && pageMiss.labels.length < PAGE_MISS_MAX) {
      check = pageMiss.labels.push(label) - 1;
      spec = { ...spec, [PAGE_MISS_BINDING]: 'rw' };
    } else pageMiss.unchecked.add(label);
  }
  const layout = makeLayout(device, label, spec, GPUShaderStage.COMPUTE);
  if (check !== undefined) pageMiss.layouts.add(layout);
  if (storage) {
    pageTab.layouts.add(layout);
    pageTab.storageKernels.add(label);
  }
  const desc: GPUComputePipelineDescriptor = {
    label,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: makeModule(device, label, parts, storage, check), entryPoint },
  };
  if (batchOpen) {
    // (no pipeline till it's ready: setPipeline(undefined) throws — a kernel used before its batch ends is loud)
    const k = { pipeline: undefined as unknown as GPUComputePipeline, layout };
    pendingPipes.push(device.createComputePipelineAsync(desc).then((p) => (k.pipeline = p)));
    return k;
  }
  const pipeline = device.createComputePipeline(desc);
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
