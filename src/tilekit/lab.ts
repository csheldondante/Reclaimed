// (tilekit, docs/design/TILEKIT.md) The tile kit lab (tilekit.html): the real irregular grid (archgen's GPU grid lab,
// read back once — a lab-only readback), one block of rectangle booleans on it, its theme's modules generated on the
// CPU and drawn instanced, swept along the cells' edges, the control grid's wonk and sag, archlab's light, the sun's
// shadow map and ssao.wgsl. Orthographic camera at the play pitch.
//   ?theme=plaster|timber  ?sag=m  ?wonk=m  ?ao=0|1  ?yaw=deg ?pitch=deg ?zoom=m tall  ?at=x,y (the block's anchor)
//   ?rot=deg (the massing's turn)  ?shadow=0  ?bake=0 (no baked occlusion)  ?dbg=1 normals | 2 baked occlusion
// globalThis.tilekit: { view(yaw, zoom, pitch), theme(name), set({sag, wonk, ao}), caption(text), bench(frames), stats }

import { urlFlags } from '../flags';
import lotsMuru from '../../data/lab/lots-muru.json';
import { ArchGen } from '../archgen/archgen';
import aoWgsl from '../archgen/ssao.wgsl?raw';
import kitWgsl from './tilekit.wgsl?raw';
import { cellOwners, cellTops, valences, weldCells, type GridMesh, type Rect } from './grid';
import { buildKit, VF, type ModuleMesh } from './kit';
import { buildBlock, controlGrid, IF, type Block } from './block';
import { buildDistrict, planDistrict, planMesh } from './district';
import { THEMES, type Theme } from './theme';

const q = urlFlags();
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

function fatal(msg: string): never {
  const d = document.createElement('div');
  d.className = 'fatal';
  d.textContent = msg;
  document.body.appendChild(d);
  throw new Error(msg);
}

/** the block's massing in its own frame (metres; the anchor at 0, 0): a main range, a back wing at one end, a corner
 *  tower, a one-storey annex */
const MASSING: Rect[] = [
  { x: 0, y: 0, w: 11.5, d: 5.8, rot: 0, storeys: 3 },
  { x: -3.4, y: 5.4, w: 4.6, d: 6.5, rot: 0, storeys: 2 },
  { x: 4.9, y: -1.4, w: 3.0, d: 3.0, rot: 0, storeys: 4 },
  { x: 7.6, y: 2.6, w: 3.4, d: 4.4, rot: 0, storeys: 1 },
];

async function main() {
  if (!navigator.gpu) fatal('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) fatal('No WebGPU adapter.');
  const ts = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: ts ? ['timestamp-query'] : [] });
  device.addEventListener('uncapturederror', (e) => fatal(`GPU error: ${(e as GPUUncapturedErrorEvent).error.message}`));
  device.lost.then((i) => i.reason !== 'destroyed' && fatal(`GPU device lost: ${i.message}`));

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const ctx = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const samples = 4;

  // ---- the grid: archgen's grid lab round the block, read back once ----
  const lots = new Uint32Array((lotsMuru as { lots: number[] }).lots);
  const n = lots.length / 24;
  const f = new Float32Array(lots.buffer);
  let cx = 0;
  let cy = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    if (lots[i * 24 + 17] === 1) {
      cx += f[i * 24 + 8];
      cy += f[i * 24 + 9];
      nb++;
    }
  }
  const anchor: [number, number] = q.has('at') ? (q.get('at')!.split(',').map(Number) as [number, number]) : [cx / nb, cy / nb];
  const rec = device.createBuffer({ size: lots.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(rec, 0, lots);
  const cnt = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(cnt, 0, new Uint32Array([n, 0, 24, n]));
  const GR = 1;
  const gen = new ArchGen(device, rec, cnt, { lots: n, gridChunks: (GR * 2 + 1) ** 2 });
  const lb = anchor[1] / (5.4 * Math.sqrt(3) * 0.5);
  const la = anchor[0] / 5.4 - 0.5 * lb;
  const chx = Math.floor(la / 8);
  const chy = Math.floor(lb / 8);
  {
    const e = device.createCommandEncoder();
    gen.gridLab(e, chx - GR, chy - GR, GR * 2 + 1, GR * 2 + 1);
    device.queue.submit([e.finish()]);
  }
  const rb = device.createBuffer({ size: gen.gridCells.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  {
    const e = device.createCommandEncoder();
    e.copyBufferToBuffer(gen.gridCells, 0, rb, 0, gen.gridCells.size);
    device.queue.submit([e.finish()]);
  }
  await rb.mapAsync(GPUMapMode.READ);
  const words = new Uint32Array(rb.getMappedRange().slice(0));
  rb.unmap();
  const cap = (words.length - 4) / 10;
  const ncells = Math.min(words[0], cap);
  if (words[0] > cap) fatal(`tilekit: the grid lab wrote ${words[0]} cells, room for ${cap}`);
  const mesh: GridMesh = weldCells(new Float32Array(words.buffer, 16, ncells * 10), ncells);
  const vh = valences(mesh);

  // the massing, turned and placed at the anchor
  const rot = (num('rot', 0) * Math.PI) / 180;
  const rects: Rect[] = MASSING.map((r) => ({ ...r, x: anchor[0] + r.x * Math.cos(rot) - r.y * Math.sin(rot), y: anchor[1] + r.x * Math.sin(rot) + r.y * Math.cos(rot), rot: r.rot + rot }));
  const tops = cellTops(mesh, rects);
  const owners = cellOwners(mesh, rects, tops);

  // ---- pipelines ----
  const depthFormat: GPUTextureFormat = 'depth24plus';
  const mod = device.createShaderModule({ label: 'tilekit', code: kitWgsl });
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const vbuf: GPUVertexBufferLayout = {
    arrayStride: VF * 4,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x4' },
      { shaderLocation: 1, offset: 16, format: 'float32x4' },
      { shaderLocation: 2, offset: 32, format: 'float32x4' },
    ],
  };
  // (cull off: panels are single-sided sheets and the sweep's handedness is one for all; normals are explicit)
  const pipe = device.createRenderPipeline({
    label: 'tilekit',
    layout,
    vertex: { module: mod, entryPoint: 'vsMain', buffers: [vbuf] },
    fragment: { module: mod, entryPoint: 'fsMain', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    multisample: { count: samples },
  });
  const SHADOW = 2048;
  const shadowPipe = device.createRenderPipeline({
    label: 'tilekit shadow',
    layout,
    vertex: { module: mod, entryPoint: 'vsShadow', buffers: [vbuf] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.0 },
  });
  const shadowMap = device.createTexture({ size: [SHADOW, SHADOW], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const noShadow = device.createTexture({ size: [1, 1], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING });
  const cmp = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
  const viewU = device.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const sunU = device.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const aoMod = device.createShaderModule({ label: 'tilekit ssao', code: aoWgsl.replaceAll('DEPTH_T', 'texture_depth_multisampled_2d') });
  const aoPipe = device.createRenderPipeline({ label: 'tilekit ssao', layout: 'auto', vertex: { module: aoMod, entryPoint: 'vsFull' }, fragment: { module: aoMod, entryPoint: 'fsAo', targets: [{ format: 'r8unorm' }] } });
  const compPipe = device.createRenderPipeline({ label: 'tilekit compose', layout: 'auto', vertex: { module: aoMod, entryPoint: 'vsFull' }, fragment: { module: aoMod, entryPoint: 'fsComp', targets: [{ format }] } });
  const aoU = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // ---- the kit and the block (remade on a theme or dial change) ----
  const look = {
    theme: Math.max(0, THEMES.findIndex((t) => t.name === q.get('theme'))), sag: num('sag', -1), wonk: num('wonk', -1), ao: num('ao', 1), aoR: num('aor', 2.0), shadow: num('shadow', 1), bake: num('bake', 1), dbg: num('dbg', 0), sunTurn: num('sunturn', 55), sunUp: num('sunup', 37),
    // (step 2) ?mode=district|block (step 1's block), ?roof=strip|field, ?lod=0|1|2 (-1 by zoom), ?straight=0..1,
    // ?setback=m, ?radius=m (the district's lots), ?seed=n, ?plan=1 (the strips, top-down, no houses)
    mode: q.get('mode') ?? 'district', roof: (q.get('roof') ?? 'strip') as 'strip' | 'field', lod: num('lod', 0), straight: num('straight', 0), setback: num('setback', -1), radius: num('radius', 24), seed: num('seed', 1), plan: num('plan', 0),
  };
  const kits = new Map<string, ModuleMesh[]>();
  let kitMs = 0;
  const lodNow = () => (look.lod >= 0 ? look.lod : cam.zoom < 22 ? 0 : cam.zoom < 70 ? 1 : 2);
  const kitOf = (i: number, lod: number) => {
    let k = kits.get(i + ':' + lod);
    if (!k) {
      const t0 = performance.now();
      k = buildKit(THEMES[i], true, lod);
      kitMs = performance.now() - t0;
      kits.set(i + ':' + lod, k);
    }
    return k;
  };
  interface Scene {
    vb: GPUBuffer;
    ib: GPUBuffer;
    ctl: GPUBuffer;
    draws: { first: number; count: number; firstInst: number; insts: number; name: string }[];
    world: { first: number; count: number };
    group: GPUBindGroup;
    shadowGroup: GPUBindGroup;
    block: { inst: Map<string, number[]>; world: number[]; ctl: Block['ctl']; centre: [number, number] };
    theme: Theme;
    lod: number;
    info: Record<string, unknown>;
    counts: { modules: number; moduleVerts: Record<string, number>; instances: number; vertices: number; worldVerts: number };
  }
  let scene: Scene | null = null;
  let buildMs = 0;
  /** where the district's features stand (the shots aim at them) */
  const where: { arches: { x: number; y: number; along: number; blocked: number }[]; turrets: [number, number][] } = { arches: [], turrets: [] };
  const centroidOf = (c: number): [number, number] => {
    let x = 0;
    let y = 0;
    for (let k = 0; k < 4; k++) {
      x += mesh.xy[mesh.cells[c * 4 + k] * 2] / 4;
      y += mesh.xy[mesh.cells[c * 4 + k] * 2 + 1] / 4;
    }
    return [x, y];
  };
  const remake = () => {
    const t = THEMES[look.theme];
    const sag = look.sag >= 0 ? look.sag : t.warp.sag;
    const wonk = look.wonk >= 0 ? look.wonk : t.warp.wonk;
    const t0 = performance.now();
    let block: Scene['block'];
    let info: Record<string, unknown>;
    if (look.mode === 'block') {
      const b = buildBlock(mesh, tops, t, { street: [Math.cos((cam.yaw * Math.PI) / 180), Math.sin((cam.yaw * Math.PI) / 180)], sag, wonk, groundR: 26, owners });
      block = b;
      info = { ...b.stats, joints: { convex: b.walls.joints[0], straight: b.walls.joints[1], concave: b.walls.joints[2] }, pinches: b.walls.pinches };
    } else {
      const plan = planDistrict(mesh, t, { anchor, radius: look.radius, seed: look.seed, plotCells: 18, alleyOdds: 0.45 });
      if (look.plan) {
        block = { inst: new Map(), world: planMesh(mesh, plan, anchor, look.radius + 10), ctl: controlGrid(mesh, plan.tops, anchor, 10, t, { street: [1, 0], sag: 0, wonk: 0, groundR: 0 }, []), centre: anchor };
        info = { plots: plan.plots, strips: plan.strips.length, sizes: plan.strips.map((s, i) => `${s.a}x${s.b}${plan.role[i][0]}`).join(' ') };
      } else {
        const d = buildDistrict(mesh, t, plan, { roof: look.roof, straighten: look.straight, sag, wonk, groundR: look.radius + 14, setback: look.setback >= 0 ? look.setback : undefined });
        block = d;
        where.arches = plan.arches.map((a) => {
          const [x, y] = centroidOf(a.c);
          // the alley's direction: across the cell from its edge k + 1 to k + 3
          const p = (k: number) => [mesh.xy[mesh.cells[a.c * 4 + (k % 4)] * 2], mesh.xy[mesh.cells[a.c * 4 + (k % 4)] * 2 + 1]];
          // (the passage runs from the middle of edge k + 3 to the middle of edge k + 1; edges k and k + 2 are the houses')
          const m3 = [(p(a.k + 3)[0] + p(a.k + 4)[0]) / 2, (p(a.k + 3)[1] + p(a.k + 4)[1]) / 2];
          const m1 = [(p(a.k + 1)[0] + p(a.k + 2)[0]) / 2, (p(a.k + 1)[1] + p(a.k + 2)[1]) / 2];
          const along = (Math.atan2(m1[1] - m3[1], m1[0] - m3[0]) * 180) / Math.PI;
          // which end of the alley is open (fewest built cells on the camera's side within 14 m): the view from there
          const blocked = (deg: number) => {
            let n = 0;
            for (let s = 2; s <= 14; s += 1.5) {
              const qx = x + Math.cos((deg * Math.PI) / 180) * s;
              const qy = y + Math.sin((deg * Math.PI) / 180) * s;
              let best = -1;
              let bd = Infinity;
              for (let c = 0; c < mesh.nc; c++) {
                const [cx2, cy2] = centroidOf(c);
                const dd = (cx2 - qx) ** 2 + (cy2 - qy) ** 2;
                if (dd < bd) {
                  bd = dd;
                  best = c;
                }
              }
              n += plan.tops[best];
            }
            return n;
          };
          return { x, y, along: blocked(along) <= blocked(along + 180) ? along : along + 180, blocked: Math.min(blocked(along), blocked(along + 180)) };
        });
        where.turrets = d.turrets;
        info = { ...d.stats, roofRule: +d.roofRule.toFixed(4) };
      }
    }
    buildMs = performance.now() - t0;
    const lod = lodNow();
    const kit = kitOf(look.theme, lod);
    const verts: number[] = [];
    const insts: number[] = new Array(IF).fill(0);
    const draws: Scene['draws'] = [];
    const moduleVerts: Record<string, number> = {};
    let instances = 0;
    let vertices = 0;
    for (const mm of kit) {
      moduleVerts[mm.name] = mm.verts.length / VF;
      const list = block.inst.get(mm.name);
      const first = verts.length / VF;
      for (const x of mm.verts) verts.push(x);
      if (!list?.length || !mm.verts.length) continue;
      const k = list.length / IF;
      draws.push({ first, count: mm.verts.length / VF, firstInst: insts.length / IF, insts: k, name: mm.name });
      for (const x of list) insts.push(x);
      instances += k;
      vertices += k * (mm.verts.length / VF);
    }
    for (const name of block.inst.keys()) if (!kit.some((mm) => mm.name === name)) throw new Error(`tilekit: no module '${name}' in theme ${t.name}`);
    const wfirst = verts.length / VF;
    for (const x of block.world) verts.push(x);
    const wcount = block.world.length / VF;
    const vb = device.createBuffer({ size: verts.length * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vb, 0, new Float32Array(verts));
    const ib = device.createBuffer({ size: insts.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(ib, 0, new Float32Array(insts));
    const ctl = device.createBuffer({ size: block.ctl.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(ctl, 0, block.ctl.data);
    const groupOf = (u: GPUBuffer, map: GPUTexture) =>
      device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: u } },
          { binding: 1, resource: { buffer: ib } },
          { binding: 2, resource: { buffer: ctl } },
          { binding: 3, resource: map.createView() },
          { binding: 4, resource: cmp },
        ],
      });
    scene?.vb.destroy();
    scene?.ib.destroy();
    scene?.ctl.destroy();
    scene = {
      vb, ib, ctl, draws, world: { first: wfirst, count: wcount }, group: groupOf(viewU, shadowMap), shadowGroup: groupOf(sunU, noShadow), block, theme: t, lod, info,
      counts: { modules: kit.length, moduleVerts, instances, vertices, worldVerts: wcount },
    };
    showStats();
  };

  // ---- the camera ----
  const cam = { yaw: num('yaw', -60), pitch: num('pitch', 50), zoom: num('zoom', 40), x: anchor[0], y: anchor[1], z: 4 };
  const D = 2000;
  const ortho = (fw: number[], t: number[], hw: number, hh: number) => {
    const r = norm(cross([0, 0, 1], fw));
    const u = cross(fw, r);
    const m = new Float32Array(16);
    const row = (i: number, v: number[], s: number, c: number) => {
      m[i] = v[0] * s;
      m[4 + i] = v[1] * s;
      m[8 + i] = v[2] * s;
      m[12 + i] = c;
    };
    row(0, r, 1 / hw, -dot(r, t) / hw);
    row(1, u, 1 / hh, -dot(u, t) / hh);
    row(2, fw, -1 / (2 * D), 0.5 + dot(fw, t) / (2 * D));
    row(3, [0, 0, 0], 0, 1);
    return m;
  };

  let depth: GPUTexture | null = null;
  let msaa: GPUTexture | null = null;
  let sceneT: GPUTexture | null = null;
  let aoT: GPUTexture | null = null;
  let aoGroup: GPUBindGroup | null = null;
  let compGroup: GPUBindGroup | null = null;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h && depth) return;
    canvas.width = w;
    canvas.height = h;
    for (const t of [depth, msaa, sceneT, aoT]) t?.destroy();
    depth = device.createTexture({ size: [w, h], format: depthFormat, sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    msaa = device.createTexture({ size: [w, h], format, sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    sceneT = device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    aoT = device.createTexture({ size: [w, h], format: 'r8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    aoGroup = device.createBindGroup({ layout: aoPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: depth.createView() }, { binding: 1, resource: { buffer: aoU } }] });
    compGroup = device.createBindGroup({ layout: compPipe.getBindGroupLayout(0), entries: [{ binding: 1, resource: { buffer: aoU } }, { binding: 2, resource: aoT.createView() }, { binding: 3, resource: sceneT.createView() }] });
  };

  const qs = ts ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
  const encodeFrame = (timed: boolean) => {
    resize();
    const sc = scene!;
    const W = canvas.width;
    const H = canvas.height;
    const yw = (cam.yaw * Math.PI) / 180;
    const pt = (cam.pitch * Math.PI) / 180;
    const fw = [Math.cos(pt) * Math.cos(yw), Math.cos(pt) * Math.sin(yw), Math.sin(pt)];
    const hh = cam.zoom / 2;
    const hw = (hh * W) / H;
    const t = [cam.x, cam.y, cam.z];
    const vp = ortho(fw, t, hw, hh);
    // the sun: archlab's Townscaper side light turned towards the camera (?sunturn=deg from the view, default 55; archlab
    // uses 115, which leaves the faces towards the camera in shade), ?sunup=deg (37)
    const sy = ((cam.yaw - look.sunTurn) * Math.PI) / 180;
    const su = (look.sunUp * Math.PI) / 180;
    const sun = norm([Math.cos(sy) * Math.cos(su), Math.sin(sy) * Math.cos(su), Math.sin(su)]);
    const half = look.mode === 'block' ? 30 : 48;
    const sunVP = ortho(sun, [sc.block.centre[0], sc.block.centre[1], 4], half, half);
    const c = sc.block.ctl;
    const u = new Float32Array(52);
    u.set(vp, 0);
    u.set(sunVP, 16);
    u.set([...sun, 1.15], 32);
    u.set([...c.origin, 1], 36);
    u.set([...c.step, 0], 40);
    u.set([...c.dims, 0], 44);
    u.set([look.shadow, look.bake, 0, look.dbg], 48);
    device.queue.writeBuffer(viewU, 0, u);
    const us = u.slice();
    us.set(sunVP, 0);
    device.queue.writeBuffer(sunU, 0, us);
    device.queue.writeBuffer(aoU, 0, new Float32Array([hw, hh, W, H, look.aoR, look.ao, D, 0]));
    const e = device.createCommandEncoder();
    const drawAll = (p: GPURenderPassEncoder) => {
      p.setVertexBuffer(0, sc.vb);
      for (const d of sc.draws) p.draw(d.count, d.insts, d.first, d.firstInst);
      p.draw(sc.world.count, 1, sc.world.first, 0);
    };
    const sp = e.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: { view: shadowMap.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      timestampWrites: timed && qs ? { querySet: qs, beginningOfPassWriteIndex: 0 } : undefined,
    });
    if (look.shadow) {
      sp.setPipeline(shadowPipe);
      sp.setBindGroup(0, sc.shadowGroup);
      drawAll(sp);
    }
    sp.end();
    const view = sceneT!.createView();
    const pass = e.beginRenderPass({
      colorAttachments: [{ view: msaa!.createView(), resolveTarget: view, clearValue: { r: 0.8, g: 0.86, b: 0.9, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, sc.group);
    drawAll(pass);
    pass.end();
    const ap = e.beginRenderPass({ colorAttachments: [{ view: aoT!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }] });
    if (look.ao > 0) {
      ap.setPipeline(aoPipe);
      ap.setBindGroup(0, aoGroup!);
      ap.draw(3);
    }
    ap.end();
    const cp = e.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      timestampWrites: timed && qs ? { querySet: qs, endOfPassWriteIndex: 1 } : undefined,
    });
    cp.setPipeline(compPipe);
    cp.setBindGroup(0, compGroup!);
    cp.draw(3);
    cp.end();
    return e;
  };

  let running = true;
  const frame = () => {
    if (!running) return;
    device.queue.submit([encodeFrame(false).finish()]);
    requestAnimationFrame(frame);
  };

  /** the GPU time of a whole frame (shadow, scene, occlusion, compose): timestamps, the median of frames */
  const qb = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const qr = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bench = async (frames = 30) => {
    if (!qs) return { frames: 0, note: 'no timestamp-query' };
    running = false;
    const ms: number[] = [];
    for (let i = 0; i < frames; i++) {
      const e = encodeFrame(true);
      e.resolveQuerySet(qs, 0, 2, qb, 0);
      e.copyBufferToBuffer(qb, 0, qr, 0, 16);
      device.queue.submit([e.finish()]);
      await qr.mapAsync(GPUMapMode.READ);
      const t = new BigInt64Array(qr.getMappedRange().slice(0));
      qr.unmap();
      ms.push(Number(t[1] - t[0]) / 1e6);
    }
    running = true;
    requestAnimationFrame(frame);
    ms.sort((a, b) => a - b);
    const r = { frames, medianMs: +ms[ms.length >> 1].toFixed(3), p90Ms: +ms[Math.floor(ms.length * 0.9)].toFixed(3), w: canvas.width, h: canvas.height, msaa: samples };
    stats.textContent += `\nGPU frame ${r.medianMs} ms (median of ${frames}, ${r.w}×${r.h} MSAA ${samples})`;
    return r;
  };

  // ---- the panel ----
  const stats = document.getElementById('stats')!;
  const statsOf = () => {
    const sc = scene!;
    return {
      theme: sc.theme.name,
      mode: look.mode,
      roof: look.roof,
      lod: sc.lod,
      gridCells: mesh.nc,
      gridVerts: mesh.nv,
      valence: Object.fromEntries([...vh.entries()].sort((a, b) => a[0] - b[0])),
      block: sc.info,
      modules: sc.counts.modules,
      moduleVerts: sc.counts.moduleVerts,
      instances: sc.counts.instances,
      instancedVertices: sc.counts.vertices,
      /** instanced vertices a module (its vertices × its instances) */
      perModule: Object.fromEntries(sc.draws.map((d) => [d.name, d.count * d.insts])),
      worldVertices: sc.counts.worldVerts,
      kitBuildMs: +kitMs.toFixed(1),
      buildMs: +buildMs.toFixed(1),
      draws: sc.draws.length + 1,
    };
  };
  const showStats = () => {
    const s = statsOf();
    stats.textContent = `${s.theme} · ${s.mode} · roof ${s.roof} · lod ${s.lod}\n${JSON.stringify(s.block)}\n${s.instances} instances, ${s.instancedVertices} + ${s.worldVertices} vertices, build ${s.buildMs} ms`;
  };
  const sel = document.getElementById('theme') as HTMLSelectElement;
  sel.innerHTML = THEMES.map((t, i) => `<option value="${i}">${t.name}</option>`).join('');
  sel.value = String(look.theme);
  sel.onchange = () => {
    look.theme = Number(sel.value);
    remake();
  };
  const bindRange = (id: string, get: () => number, set: (v: number) => void) => {
    const el = document.getElementById(id) as HTMLInputElement;
    el.value = String(get());
    el.oninput = () => set(Number(el.value));
  };
  bindRange('sag', () => Math.max(0, look.sag), (v) => ((look.sag = v), remake()));
  bindRange('wonk', () => (look.wonk >= 0 ? look.wonk : THEMES[look.theme].warp.wonk), (v) => ((look.wonk = v), remake()));
  const aoBox = document.getElementById('ao') as HTMLInputElement;
  aoBox.checked = look.ao > 0;
  aoBox.onchange = () => (look.ao = aoBox.checked ? 1 : 0);
  (document.getElementById('bench') as HTMLButtonElement).onclick = () => void bench();
  const capEl = document.getElementById('cap')!;

  // input: drag pans, right-drag turns, wheel zooms
  const ptrs = new Map<number, { x: number; y: number }>();
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  });
  canvas.addEventListener('pointerup', (ev) => ptrs.delete(ev.pointerId));
  canvas.addEventListener('pointercancel', (ev) => ptrs.delete(ev.pointerId));
  canvas.addEventListener('pointermove', (ev) => {
    const p = ptrs.get(ev.pointerId);
    if (!p) return;
    const dx = ev.clientX - p.x;
    const dy = ev.clientY - p.y;
    if (ptrs.size >= 2 || ev.buttons === 2) cam.yaw -= dx * 0.3;
    else {
      const s = cam.zoom / canvas.clientHeight;
      const yw = (cam.yaw * Math.PI) / 180;
      const r = [-Math.sin(yw), Math.cos(yw)];
      const fwd = [-Math.cos(yw), -Math.sin(yw)];
      const k = 1 / Math.sin((cam.pitch * Math.PI) / 180);
      cam.x -= (r[0] * dx - fwd[0] * dy * k) * s;
      cam.y -= (r[1] * dx - fwd[1] * dy * k) * s;
    }
    p.x = ev.clientX;
    p.y = ev.clientY;
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    cam.zoom = Math.min(200, Math.max(4, cam.zoom * Math.exp(ev.deltaY * 0.001)));
  }, { passive: false });

  remake();
  requestAnimationFrame(frame);

  (globalThis as unknown as { tilekit: unknown }).tilekit = {
    view(yaw?: number, zoom?: number, pitch?: number, at?: [number, number, number]) {
      if (yaw !== undefined) cam.yaw = yaw;
      if (zoom !== undefined) cam.zoom = zoom;
      if (pitch !== undefined) cam.pitch = pitch;
      if (at) [cam.x, cam.y, cam.z] = at;
    },
    theme(name: string) {
      look.theme = THEMES.findIndex((t) => t.name === name);
      sel.value = String(look.theme);
      remake();
    },
    set(o: Partial<typeof look>) {
      Object.assign(look, o);
      if (['sag', 'wonk', 'mode', 'roof', 'lod', 'straight', 'setback', 'radius', 'seed', 'plan'].some((k) => k in o)) remake();
    },
    caption(text: string) {
      capEl.textContent = text;
      capEl.style.display = text ? 'block' : 'none';
    },
    bench,
    stats: statsOf,
    where,
    /** the welded grid as plain arrays (scripts/tilekit-dump.mjs writes it as the unit tests' fixture) */
    grid() {
      return { anchor, xy: [...mesh.xy].map((v) => Math.round(v * 1000) / 1000), cells: [...mesh.cells], lot: [...(mesh.lot ?? [])], cls: [...(mesh.cls ?? [])] };
    },
    anchor,
    cam,
    look,
  };
}

function cross(a: number[], b: number[]) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: number[], b: number[]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm(a: number[]) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
}

void main();
