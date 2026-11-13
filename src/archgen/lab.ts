// (archgen) The building lab (archlab.html): Muru's real lots (data/lab/lots-muru.json, captured from the street lab's
// town: scripts — see docs/design/ARCHGEN.md) through the generator, drawn alone with an orthographic camera at the
// play pitch. Fast to load (no world, no sims): for judging massing, materials and generation cost. Not the game's
// lighting: in-game checks come with the wire-in (AG6).
//   ?style=homes|timber|port|keep (default: by district)  ?yaw=deg  ?pitch=deg (60)  ?zoom=world units tall
//   ?at=x,y  ?detail=0..1 (0 phone … 1 PC)  ?night=0..1  ?msaa=0  ?ao=0..1 (screen-space occlusion's strength, 0 off)
//   ?aor=m (its radius)  ?oldlight=1 (the light before AG26)
// globalThis.archlab: { view(yaw, zoom, at), style(name), bench(runs) } for scripts.

import { urlFlags } from '../flags';
import lotsMuru from '../../data/lab/lots-muru.json';
import { ArchGen, PARTS_PER_LOT } from './archgen';
import { STYLES } from './styles';
import { archTextures } from './textures';
import aoWgsl from './ssao.wgsl?raw';
import gridLabWgsl from './gridlab.wgsl?raw';

const q = urlFlags();
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

function fatal(msg: string): never {
  const d = document.createElement('div');
  d.className = 'fatal';
  d.textContent = msg;
  document.body.appendChild(d);
  throw new Error(msg);
}

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
  const samples = num('msaa', 1) ? 4 : 1;

  // the lots, as citygen lays them out: records then counts [lots, landmarks, words, lot room]
  const hero = q.has('hero');
  const lots = hero ? heroStreet(Number(q.get('hero')) || 1) : new Uint32Array((lotsMuru as { lots: number[] }).lots);
  const n = lots.length / 24;
  const rec = device.createBuffer({ label: 'lab lot records', size: lots.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(rec, 0, lots);
  const cnt = device.createBuffer({ label: 'lab lot counts', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(cnt, 0, new Uint32Array([n, 0, 24, n]));
  const f = new Float32Array(lots.buffer);
  let zmin = Infinity;
  let cx = 0;
  let cy = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const z = f[i * 24 + 21];
    if (z !== 0) zmin = Math.min(zmin, z);
    if (lots[i * 24 + 17] === 1) {
      cx += f[i * 24 + 8];
      cy += f[i * 24 + 9];
      nb++;
    }
  }
  cx /= nb;
  cy /= nb;

  const depthFormat: GPUTextureFormat = 'depth24plus';
  // (?gridlab=1: the irregular grid alone, lots aside — the chunks round the camera, cells coloured by shape)
  const gridLab = q.get('gridlab') === '1';
  const GL_R = 4;
  const gen = new ArchGen(device, rec, cnt, { lots: n, ground: { zmin: zmin - 2 }, gridChunks: gridLab ? (GL_R * 2 + 1) ** 2 : 0 });
  gen.labDraw(format, depthFormat, samples);
  gen.windows = q.get('win') !== '0';
  const sname = q.get('style');
  gen.style = sname ? STYLES.findIndex((s) => s.name === sname) : -1;

  const remake = () => {
    const e = device.createCommandEncoder();
    gen.generate(e, 0, n);
    gen.compact(e);
    device.queue.submit([e.finish()]);
  };
  remake();
  // (the Synty plants, when the local conversion loads: the lots made again with them)
  archTextures(device).whenPlants(remake);

  // the camera: orthographic, yaw about z, pitch above the ground plane
  const cam = { yaw: num('yaw', hero ? -62 : 35), pitch: num('pitch', 60), zoom: num('zoom', hero ? 34 : 90), x: cx, y: cy + (hero ? 4 : 0), z: zmin + 4 };
  if (q.has('at')) {
    const [ax, ay] = q.get('at')!.split(',').map(Number);
    cam.x = ax;
    cam.y = ay;
  }
  const look = { detail: num('detail', 1), night: num('night', 0), oldLight: num('oldlight', 0), ao: num('ao', 1), aoR: num('aor', 2.5) };
  /** an orthographic view along fw (towards the eye) round t, hw × hh half extents */
  const ortho = (fw: number[], t: number[], hw: number, hh: number) => {
    const r = norm(cross([0, 0, 1], fw));
    const u = cross(fw, r);
    const D = 2000;
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
  const viewProj = (w: number, h: number) => {
    const yw = (cam.yaw * Math.PI) / 180;
    const pt = (cam.pitch * Math.PI) / 180;
    const fw = [Math.cos(pt) * Math.cos(yw), Math.cos(pt) * Math.sin(yw), Math.sin(pt)];
    const r = norm(cross([0, 0, 1], fw));
    const u = cross(fw, r);
    const hh = cam.zoom / 2;
    const hw = (hh * w) / h;
    const t = [cam.x, cam.y, cam.z];
    const D = 2000;
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
    return { m, fw, upp: cam.zoom / h };
  };

  let depth: GPUTexture | null = null;
  let msaa: GPUTexture | null = null;
  // screen-space occlusion (ssao.wgsl): the scene drawn into its own texture, its depth kept; the occlusion into aoT;
  // then the two composed onto the canvas
  let sceneT: GPUTexture | null = null;
  let aoT: GPUTexture | null = null;
  let aoGroup: GPUBindGroup | null = null;
  let compGroup: GPUBindGroup | null = null;
  const aoMod = device.createShaderModule({ label: 'arch lab ssao', code: aoWgsl.replaceAll('DEPTH_T', samples > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d') });
  const aoPipe = device.createRenderPipeline({ label: 'arch lab ssao', layout: 'auto', vertex: { module: aoMod, entryPoint: 'vsFull' }, fragment: { module: aoMod, entryPoint: 'fsAo', targets: [{ format: 'r8unorm' }] } });
  const compPipe = device.createRenderPipeline({ label: 'arch lab compose', layout: 'auto', vertex: { module: aoMod, entryPoint: 'vsFull' }, fragment: { module: aoMod, entryPoint: 'fsComp', targets: [{ format }] } });
  const aoU = device.createBuffer({ label: 'arch lab ssao params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const glMod = device.createShaderModule({ label: 'grid lab cells', code: gridLabWgsl });
  const glPipe = gridLab
    ? device.createRenderPipeline({
        label: 'grid lab cells',
        layout: 'auto',
        vertex: { module: glMod, entryPoint: 'vsCell' },
        fragment: { module: glMod, entryPoint: 'fsCell', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
        multisample: { count: samples },
      })
    : null;
  const glU = device.createBuffer({ label: 'grid lab view', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const glGroup = glPipe ? device.createBindGroup({ layout: glPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: glU } }, { binding: 1, resource: { buffer: gen.gridCells } }] }) : null;
  let glChunk = '';
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h && depth) return;
    canvas.width = w;
    canvas.height = h;
    depth?.destroy();
    msaa?.destroy();
    depth = device.createTexture({ size: [w, h], format: depthFormat, sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    sceneT?.destroy();
    aoT?.destroy();
    sceneT = device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    aoT = device.createTexture({ size: [w, h], format: 'r8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    aoGroup = device.createBindGroup({ layout: aoPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: depth.createView() }, { binding: 1, resource: { buffer: aoU } }] });
    compGroup = device.createBindGroup({ layout: compPipe.getBindGroupLayout(0), entries: [{ binding: 1, resource: { buffer: aoU } }, { binding: 2, resource: aoT.createView() }, { binding: 3, resource: sceneT.createView() }] });
    msaa = samples > 1 ? device.createTexture({ size: [w, h], format, sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT }) : null;
  };

  const t0 = performance.now();
  const frame = () => {
    resize();
    const { m, fw, upp } = viewProj(canvas.width, canvas.height);
    // (the sun from the camera's side, off to its left: the street faces lit, the sides in soft shade)
    // (the new light: Townscaper's side light, low — half the walls in view in the cool shade)
    const sy = ((cam.yaw - (look.oldLight ? 55 : 115)) * Math.PI) / 180;
    const sun = look.oldLight ? norm([Math.cos(sy) * 0.55, Math.sin(sy) * 0.55, 0.75]) : norm([Math.cos(sy) * 0.8, Math.sin(sy) * 0.8, 0.6]);
    // the sun's shadow map round the view (its half width the view's diagonal and some), not with the old light
    const half = cam.zoom * Math.max(1, canvas.width / canvas.height) * 0.9 + 20;
    const sunVP = look.oldLight ? undefined : ortho(sun, [cam.x, cam.y, cam.z], half, half);
    gen.setView(m, [...sun, 1.15 * (1 - look.night * 0.85)], [...fw, upp], (performance.now() - t0) / 1000, look.night, look.detail, look.oldLight, sunVP);
    const e = device.createCommandEncoder();
    if (sunVP && !gridLab) gen.drawLabShadow(e);
    if (gridLab) {
      // the chunks round the camera's (the lattice: b from y, a from x less half of b; chunks of 8)
      const b = cam.y / (5.4 * Math.sqrt(3) * 0.5);
      const a = cam.x / 5.4 - 0.5 * b;
      const cx = Math.floor(a / 8);
      const cy = Math.floor(b / 8);
      const key = cx + ',' + cy;
      if (key !== glChunk) {
        glChunk = key;
        gen.gridLab(e, cx - GL_R, cy - GL_R, GL_R * 2 + 1, GL_R * 2 + 1);
      }
      const gu = new Float32Array(20);
      gu.set(m, 0);
      gu[16] = cam.z - 4;
      device.queue.writeBuffer(glU, 0, gu);
    }
    const view = sceneT!.createView();
    const sky = look.night > 0.5 ? { r: 0.08, g: 0.1, b: 0.16, a: 1 } : { r: 0.8, g: 0.86, b: 0.9, a: 1 };
    const pass = e.beginRenderPass({
      colorAttachments: [{ view: msaa ? msaa.createView() : view, resolveTarget: msaa ? view : undefined, clearValue: sky, loadOp: 'clear', storeOp: msaa ? 'discard' : 'store' }],
      depthStencilAttachment: { view: depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    if (gridLab) {
      pass.setPipeline(glPipe!);
      pass.setBindGroup(0, glGroup!);
      pass.draw(6, (GL_R * 2 + 1) ** 2 * 320);
    } else gen.drawLab(pass);
    pass.end();
    // the occlusion, then the scene darkened by it onto the canvas
    const hh = cam.zoom / 2;
    device.queue.writeBuffer(aoU, 0, new Float32Array([(hh * canvas.width) / canvas.height, hh, canvas.width, canvas.height, look.aoR, look.ao, 2000, num('aodbg', 0)]));
    const ap = e.beginRenderPass({ colorAttachments: [{ view: aoT!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }] });
    if (look.ao > 0) {
      ap.setPipeline(aoPipe);
      ap.setBindGroup(0, aoGroup!);
      ap.draw(3);
    }
    ap.end();
    const cp = e.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    cp.setPipeline(compPipe);
    cp.setBindGroup(0, compGroup!);
    cp.draw(3);
    cp.end();
    device.queue.submit([e.finish()]);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // input: drag pans, right-drag (or two fingers) turns, wheel or pinch zooms
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
    if (ptrs.size >= 2 || ev.buttons === 2) {
      cam.yaw -= dx * 0.3;
      if (ptrs.size >= 2) cam.yaw += dx * 0.15;
    } else {
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
    cam.zoom = Math.min(400, Math.max(8, cam.zoom * Math.exp(ev.deltaY * 0.001)));
  }, { passive: false });

  // the panel
  const sel = document.getElementById('style') as HTMLSelectElement;
  sel.innerHTML = ['<option value="-1">by district</option>', ...STYLES.map((s, i) => `<option value="${i}">${s.name}</option>`)].join('');
  sel.value = String(gen.style);
  sel.onchange = () => {
    gen.style = Number(sel.value);
    remake();
  };
  const bindRange = (id: string, get: () => number, set: (v: number) => void) => {
    const el = document.getElementById(id) as HTMLInputElement;
    el.value = String(get());
    el.oninput = () => set(Number(el.value));
  };
  bindRange('detail', () => look.detail, (v) => (look.detail = v));
  bindRange('night', () => look.night, (v) => (look.night = v));
  bindRange('pitch', () => cam.pitch, (v) => (cam.pitch = v));
  const stats = document.getElementById('stats')!;

  /** the generation's cost: GPU time of make (every lot) and compact from timestamps, the median of runs */
  const qs = ts ? device.createQuerySet({ type: 'timestamp', count: 4 }) : null;
  const qb = device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const qr = device.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bench = async (runs = 20) => {
    if (!qs) {
      stats.textContent = `${n} lots · no timestamp-query on this device`;
      return null;
    }
    const gens: number[] = [];
    const comps: number[] = [];
    for (let r = 0; r < runs; r++) {
      const e = device.createCommandEncoder();
      gen.generate(e, 0, n, { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
      gen.compact(e, { querySet: qs, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 });
      e.resolveQuerySet(qs, 0, 4, qb, 0);
      e.copyBufferToBuffer(qb, 0, qr, 0, 32);
      device.queue.submit([e.finish()]);
      await qr.mapAsync(GPUMapMode.READ);
      const t = new BigInt64Array(qr.getMappedRange().slice(0));
      qr.unmap();
      gens.push(Number(t[1] - t[0]) / 1e6);
      comps.push(Number(t[3] - t[2]) / 1e6);
    }
    const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
    const res = { lots: n, slots: n * PARTS_PER_LOT, genMs: +med(gens).toFixed(4), compactMs: +med(comps).toFixed(4) };
    stats.textContent = `${n} lots · GPU make ${res.genMs} ms + compact ${res.compactMs} ms a town (median of ${runs})`;
    return res;
  };
  (document.getElementById('bench') as HTMLButtonElement).onclick = () => void bench();
  void bench(5);

  (globalThis as unknown as { archlab: unknown }).archlab = {
    view(yaw?: number, zoom?: number, at?: [number, number], pitch?: number) {
      if (yaw !== undefined) cam.yaw = yaw;
      if (zoom !== undefined) cam.zoom = zoom;
      if (at) [cam.x, cam.y] = at;
      if (pitch !== undefined) cam.pitch = pitch;
    },
    style(name: string) {
      gen.style = STYLES.findIndex((s) => s.name === name);
      sel.value = String(gen.style);
      remake();
    },
    look,
    bench,
    gen,
    device,
    centre: [cx, cy],
  };
}

/** (?hero=seed) a short street of irregular lots, like citygen's, to judge a few houses close up: lot records with
 *  their frontage (edge 0) on the street at y 0, their backs ragged */
function heroStreet(seed: number): Uint32Array {
  const widths = [13, 9.5, 11, 16, 10];
  const depths = [16, 14, 17, 18, 15];
  const storeys = [2, 2, 3, 2, 1];
  // (?kinds=1,3,1,2,1: a lot's kind — 1 a building, 2 a park, 3 a plaza)
  const kinds = (urlFlags().get('kinds') ?? '1').split(',').map(Number);
  const n = widths.length;
  const u = new Uint32Array(n * 24);
  const f = new Float32Array(u.buffer);
  let x = 0;
  const rnd = (k: number) => {
    const s = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < n; i++) {
    const w = widths[i];
    const d = depths[i];
    // (the street's edge a little off straight, the back ragged: an irregular lot)
    const q = [
      [x, (rnd(i * 4) - 0.5) * 0.8],
      [x + w, (rnd(i * 4 + 1) - 0.5) * 0.8],
      [x + w + (rnd(i * 4 + 2) - 0.5) * 3, d + (rnd(i * 4 + 3) - 0.5) * 3],
      [x + (rnd(i * 4 + 5) - 0.5) * 3, d - (rnd(i * 4 + 6) - 0.5) * 3],
    ];
    const o = i * 24;
    q.forEach(([px, py], k) => {
      f[o + k * 2] = px;
      f[o + k * 2 + 1] = py - (k < 2 ? 1.5 : 0);
      f[o + 8 + k * 2] = px;
      f[o + 9 + k * 2] = py;
    });
    u[o + 16] = 0;
    u[o + 17] = kinds[i % kinds.length];
    u[o + 18] = i * 3 + seed;
    u[o + 19] = storeys[i];
    f[o + 20] = storeys[i] * 3 + 0.95;
    f[o + 21] = -0.5;
    f[o + 22] = 0;
    u[o + 23] = (seed * 7919 + i * 104729) >>> 0;
    x += w + 0.4;
  }
  return u;
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
