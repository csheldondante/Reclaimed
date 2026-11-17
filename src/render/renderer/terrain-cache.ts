// The terrain cache: the field mesh drawn once to a cached G-buffer and reused while the camera holds still (or
// refreshed). API: terrainCacheMode, tcPrepare, tcPipesMake, encodeTerrainCache.
import { archTextures } from '../../archgen/textures';
import { makeBindGroup, makeLayout, makeModule } from '../../gpu/pipeline';
import tcacheWgsl from '../../shaders/tcache.wgsl?raw';
import { type Camera } from '../camera';
import { drawGrid, gridLive } from './grid';
import { CAM_BYTES, PICK_FORMAT, DEPTH_FORMAT, TC_MARGIN, SKIP, cutOn } from './defs';
import { Renderer } from '../renderer';

/**
 * (perfopt, ?tcache=N) Whether the terrain's cached layer is used this frame: 'reuse' (the camera, in camData,
 * moved by whole pixels of it — snapped — within its margin, nothing else about it changed), 'refresh' (drawn
 * again this frame: every Nth, after a slide, a turn, a zoom, a new size, or the margin used up), or false (off,
 * the cutaway on, the free camera). Writes the composite's uniform (the shift, the depth's change).
 */
export function terrainCacheMode(rd: Renderer, cam: Camera): 'reuse' | 'refresh' | false {
  const N = Renderer.opts.tcache | 0;
  // (its pipelines asked for at the first frame it's on, compiled off the main thread; till then it's off)
  if (N > 0 && !rd.tcPipes) void tcPipesMake(rd);
  if (N <= 0 || !Renderer.opts.defer || !rd.meshPipes || !rd.tcPipes || !rd.meshPipe || SKIP.has('mesh') || cam.fly || cutOn(cam)) return false;
  const f = new Float32Array(rd.camData);
  const W = rd.depth!.width;
  const H = rd.depth!.height;
  const T = rd.tc;
  const M = TC_MARGIN;
  let shift: [number, number] = [0, 0];
  let dz = 0;
  let mode: 'reuse' | 'refresh' = 'refresh';
  if (T && T.w === W && T.h === H && T.slides === rd.fieldMesh.slides && rd.frameNo - T.frame < N && T.band === rd.band && [0, 1, 2, 4, 5, 6, 8, 9, 10].every((i) => f[i] === T.m[i])) {
    const sx = Math.round(((f[12] - T.m[12]) * W) / 2);
    const sy = Math.round((-(f[13] - T.m[13]) * H) / 2);
    if (Math.abs(sx) < M && Math.abs(sy) < M) {
      // (snapped: the camera moved by whole pixels of the layer — everything this frame draws with it)
      f[12] = T.m[12] + (sx * 2) / W;
      f[13] = T.m[13] - (sy * 2) / H;
      shift = [sx, sy];
      dz = f[14] - T.m[14];
      mode = 'reuse';
    }
  }
  if (mode === 'refresh') tcPrepare(rd, W, H, f);
  rd.tcStats[mode]++;
  rd.device.queue.writeBuffer(rd.tc!.uni, 0, new Float32Array([shift[0], shift[1], dz, M]));
  return mode;
}

/** (perfopt, tcache) the layer's textures, camera, groups and pipelines for a refresh at W x H, the camera f */
export function tcPrepare(rd: Renderer, W: number, H: number, f: Float32Array): void {
  const dev = rd.device;
  const M = TC_MARGIN;
  const LW = W + 2 * M;
  const LH = H + 2 * M;
  const tcPipes = rd.tcPipes!;
  let T = rd.tc;
  if (!T || T.tex.color.width !== LW || T.tex.color.height !== LH || T.band !== rd.band) {
    if (T) for (const t of Object.values(T.tex)) t.destroy();
    const RT = GPUTextureUsage.RENDER_ATTACHMENT;
    const RB = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const mk = (label: string, format: GPUTextureFormat, usage: number) => dev.createTexture({ label, size: [LW, LH], format, usage });
    const tex = {
      g0: mk('tcache-g0', 'rgba32uint', RB),
      g1: mk('tcache-g1', 'rg32uint', RB),
      gd: mk('tcache-gdepth', DEPTH_FORMAT, RT),
      color: mk('tcache-color', rd.colorFormat, RB),
      pick: mk('tcache-pick', PICK_FORMAT, RB),
      depth: mk('tcache-depth', 'r32float', RB),
    };
    rd.profiler.trackMemory('tcache', LW * LH * (16 + 8 + 4 + 4 + 8 + 4));
    const camB = T?.cam ?? dev.createBuffer({ label: 'tcache camera', size: CAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const uni = T?.uni ?? dev.createBuffer({ label: 'tcache uniform', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const srcs = [{ mesh: rd.fieldMesh, chunks: rd.world.chunks, layers: rd.world.layers }];
    if (rd.band) srcs.push({ mesh: rd.band.mesh, chunks: rd.band.chunks, layers: rd.band.layers });
    const g0v = tex.g0.createView();
    const g1v = tex.g1.createView();
    T = {
      tex,
      cam: camB,
      uni,
      gGroups: srcs.map((s) => rd.meshGroupOf!(camB, rd.shadowViews, s)),
      rGroups: srcs.map((s) =>
        dev.createBindGroup({ label: 'tcache-resolve', layout: rd.meshResolveLayout!, entries: [...rd.meshEntries(s, camB), { binding: 40, resource: g0v }, { binding: 41, resource: g1v }] }),
      ),
      comp: makeBindGroup(dev, 'tcache', tcPipes.compLayout, { 0: tex.color.createView(), 1: tex.pick.createView(), 2: tex.depth.createView(), 3: uni }),
      band: rd.band,
      m: new Float32Array(16),
      frame: 0,
      w: W,
      h: H,
      slides: 0,
    };
    rd.tc = T;
  }
  T.m = f.slice(0, 16);
  T.frame = rd.frameNo;
  T.w = W;
  T.h = H;
  T.slides = rd.fieldMesh.slides;
  // the layer's camera: the frame's, its clip x and y scaled so the screen sits inside it, a margin round
  const c = new Float32Array(rd.camData.slice(0));
  for (const i of [0, 4, 8, 12]) c[i] *= W / LW;
  for (const i of [1, 5, 9, 13]) c[i] *= H / LH;
  dev.queue.writeBuffer(T.cam, 0, c);
}

export function tcPipesMake(rd: Renderer): Promise<void> {
  if (rd.tcPipesBusy) return rd.tcPipesBusy;
  const dev = rd.device;
  rd.tcPipesBusy = (async () => {
    const compLayout = makeLayout(dev, 'tcache', { 0: 'tex', 1: 'utex', 2: 'tex', 3: 'uniform' }, GPUShaderStage.FRAGMENT);
    const module = makeModule(dev, 'tcache', [tcacheWgsl]);
    const [comp, resolve] = await Promise.all([
      dev.createRenderPipelineAsync({
        label: 'tcache-composite',
        layout: dev.createPipelineLayout({ bindGroupLayouts: [compLayout] }),
        vertex: { module, entryPoint: 'vsComp' },
        fragment: { module, entryPoint: 'fsComp', targets: [{ format: rd.colorFormat }, { format: PICK_FORMAT }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'always' },
      }),
      dev.createRenderPipelineAsync({
        label: 'tcache-resolve',
        layout: dev.createPipelineLayout({ bindGroupLayouts: [rd.meshResolveLayout!, archTextures(dev).layout] }),
        vertex: { module: rd.meshModule!, entryPoint: 'vsFull' },
        fragment: { module: rd.meshModule!, entryPoint: 'fsMeshResolveC', targets: [{ format: rd.colorFormat }, { format: PICK_FORMAT }, { format: 'r32float' }] },
        primitive: { topology: 'triangle-list' },
      }),
    ]);
    rd.tcPipes = { compLayout, comp, resolve };
  })();
  return rd.tcPipesBusy;
}

/** (perfopt, tcache) The terrain into its layer: the G-buffer of the chunks near the view, then the resolve. */
export function encodeTerrainCache(rd: Renderer, enc: GPUCommandEncoder): void {
  const T = rd.tc!;
  const P = rd.meshPipes!;
  const g = enc.beginRenderPass({
    label: 'tcache-g',
    colorAttachments: [
      { view: T.tex.g0.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      { view: T.tex.g1.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
    ],
    depthStencilAttachment: { view: T.tex.gd.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    timestampWrites: rd.profiler.timestamps('tcache-g'),
  });
  g.setPipeline(Renderer.opts.cull ? P.gBack : P.g);
  g.setBindGroup(0, T.gGroups[0]);
  rd.fieldMesh.drawNear(g);
  if (rd.band && !SKIP.has('band') && T.gGroups[1]) {
    g.setBindGroup(0, T.gGroups[1]);
    rd.band.mesh.drawNear(g);
  }
  if (gridLive(rd)) {
    g.setPipeline(rd.gridPipes!.g);
    g.setBindGroup(0, T.gGroups[0]);
    drawGrid(rd, g, rd.gridNear);
  }
  g.end();
  const r = enc.beginRenderPass({
    label: 'tcache-resolve',
    colorAttachments: [
      { view: T.tex.color.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      { view: T.tex.pick.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      { view: T.tex.depth.createView(), clearValue: { r: 1, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
    ],
    timestampWrites: rd.profiler.timestamps('tcache-r'),
  });
  r.setPipeline(rd.tcPipes!.resolve);
  r.setBindGroup(1, archTextures(rd.device).group);
  r.setBindGroup(0, T.rGroups[0]);
  r.draw(3);
  if (rd.band && !SKIP.has('band') && T.rGroups[1]) {
    r.setBindGroup(0, T.rGroups[1]);
    r.draw(3);
  }
  r.end();
}
