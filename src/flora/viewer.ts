// The flora viewer page (round 117; flora.html). The user, round 117 part 4: "If we are making generators for units
// and cities and plants just having a way to view that sounds great" → a viewer per generator: seed, a few
// parameters, turn and zoom. Here: a biome scene (the silver-birch wood with leaves falling, a tall-grass meadow in
// the wind, reeds on a bank, ivy and moss on a ruin, ferns in a cave's light) or one plant growing; wind, season,
// growth and density sliders; drag to turn, wheel or pinch to zoom. The plants are drawn with the game's own look
// and wind (floralook.wgsl); a link opens the same plants in the real atlas.
//
// Own small renderer (not the game's): a viewer must open fast on a phone without a world; what it shares with the
// game is the generators (src/flora) and the look (floralook.wgsl), which is what it exists to show.

import commonWgsl from '../shaders/common.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import floraLookWgsl from '../shaders/floralook.wgsl?raw';
import viewerWgsl from './viewer.wgsl?raw';
import { requestGpu, UnsupportedError } from '../gpu/device';
import { GLOBALS_BYTES } from '../sim/globals';
import { generate } from './generate';
import { BIOMES, buildScene, sceneWgsl, type Biome, type FloraScene } from './scene';
import { SPECIES, SPECIES_IDS, type RGB, type SpeciesId } from './species';
import { rng } from './rng';

type Mode = 'scene' | 'plant';

interface State {
  mode: Mode;
  biome: Biome;
  species: SpeciesId;
  seed: number;
  wind: number;
  season: number;
  growth: number;
  density: number;
}

const params = new URLSearchParams(location.search);
const state: State = {
  mode: (params.get('mode') as Mode) ?? 'scene',
  biome: (params.get('biome') as Biome) ?? 'birchwood',
  species: (params.get('species') as SpeciesId) ?? 'birch',
  seed: Number(params.get('seed') ?? 1),
  wind: Number(params.get('wind') ?? 0.35),
  season: Number(params.get('season') ?? 0.42),
  growth: Number(params.get('growth') ?? 1),
  density: Number(params.get('density') ?? 1),
};

function fail(msg: string): never {
  const d = document.createElement('div');
  d.className = 'fatal';
  d.textContent = msg;
  document.body.appendChild(d);
  throw new Error(msg);
}

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  // WebGPU clip z 0..1
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (far * near) / (near - far), 0]);
}
function lookAt(eye: number[], at: number[], up: number[]): Float32Array {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
  const nrm = (a: number[]) => {
    const l = Math.hypot(...a) || 1;
    return a.map((v) => v / l);
  };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = nrm(sub(eye, at));
  const x = nrm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

async function main() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  let gpu;
  try {
    gpu = await requestGpu(navigator.gpu);
  } catch (e) {
    fail(e instanceof UnsupportedError ? e.message : String(e));
  }
  const device = gpu.device;
  device.addEventListener('uncapturederror', (ev) => fail(`WebGPU error: ${(ev as GPUUncapturedErrorEvent).error.message}`));
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  const globals = device.createBuffer({ size: GLOBALS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const gData = new ArrayBuffer(GLOBALS_BYTES);
  const viewBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const LEAVES = 360;
  const leafBuf = device.createBuffer({ size: LEAVES * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const leafData = new Float32Array(LEAVES * 8);

  let depth: GPUTexture | null = null;
  let scene: FloraScene;
  let pipes: { plant: GPURenderPipeline; ground: GPURenderPipeline; leaf: GPURenderPipeline } | null = null;
  let group: GPUBindGroup;
  let groundGroup: GPUBindGroup;
  let leafGroup: GPUBindGroup;
  let vbuf: GPUBuffer;
  let ibuf: GPUBuffer;
  let instBuf: GPUBuffer;
  let draws: { first: number; count: number; base: number; inst0: number; ninst: number }[] = [];
  let stats = '';

  const statsEl = document.getElementById('stats')!;

  function rebuild() {
    const t0 = performance.now();
    if (state.mode === 'scene') {
      scene = buildScene(state.biome, state.seed, { density: state.density });
    } else {
      const mesh = generate(state.species, state.seed, { growth: state.growth });
      const inst = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 0]);
      scene = { kinds: [{ species: state.species, mesh }], instances: inst, ranges: [{ first: 0, count: 1 }], ground: SPECIES[state.species].form === 'tree' ? 1 : 0, crowns: SPECIES[state.species].form === 'tree' ? [{ x: 0, y: 0, z: mesh.height * 0.7, r: mesh.radius * 0.7, species: state.species }] : [], radius: 12 };
    }
    const genMs = performance.now() - t0;
    // one vertex and one index buffer for all kinds
    let nv = 0;
    let ni = 0;
    for (const k of scene.kinds) {
      nv += k.mesh.verts.length / 4;
      ni += k.mesh.index.length;
    }
    const V = new Float32Array(nv * 4);
    const I = new Uint32Array(ni);
    draws = [];
    let bv = 0;
    let bi = 0;
    let tris = 0;
    scene.kinds.forEach((k, i) => {
      V.set(k.mesh.verts, bv * 4);
      I.set(k.mesh.index, bi);
      const r = scene.ranges[i];
      draws.push({ first: bi, count: k.mesh.index.length, base: bv, inst0: r.first, ninst: r.count });
      tris += (k.mesh.index.length / 3) * r.count;
      bv += k.mesh.verts.length / 4;
      bi += k.mesh.index.length;
    });
    vbuf?.destroy();
    ibuf?.destroy();
    instBuf?.destroy();
    vbuf = device.createBuffer({ size: Math.max(16, V.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vbuf, 0, V);
    ibuf = device.createBuffer({ size: Math.max(16, I.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(ibuf, 0, I);
    instBuf = device.createBuffer({ size: Math.max(64, scene.instances.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(instBuf, 0, scene.instances);
    // the shaders carry the kinds' colours as constants: remade with the scene (cheap: a few kinds)
    const code = [commonWgsl, materialsWgsl, sceneWgsl(scene.kinds), floraLookWgsl, viewerWgsl].join('\n');
    const module = device.createShaderModule({ label: 'flora viewer', code });
    void module.getCompilationInfo().then((info) => {
      const errs = info.messages.filter((m) => m.type === 'error');
      if (errs.length) fail(errs.map((e) => `viewer.wgsl:${e.lineNum}:${e.linePos} ${e.message}`).join('\n'));
    });
    const ds: GPUDepthStencilState = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
    const plant = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsPlant', buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }] },
      fragment: { module, entryPoint: 'fsPlant', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: ds,
    });
    const ground = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsGround' },
      fragment: { module, entryPoint: 'fsGround', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: ds,
    });
    const leaf = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsLeaf' },
      fragment: { module, entryPoint: 'fsLeaf', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: ds,
    });
    pipes = { plant, ground, leaf };
    group = device.createBindGroup({ layout: plant.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: globals } }, { binding: 1, resource: { buffer: viewBuf } }, { binding: 3, resource: { buffer: instBuf } }] });
    groundGroup = device.createBindGroup({ layout: ground.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: globals } }, { binding: 1, resource: { buffer: viewBuf } }] });
    leafGroup = device.createBindGroup({ layout: leaf.getBindGroupLayout(0), entries: [{ binding: 1, resource: { buffer: viewBuf } }, { binding: 4, resource: { buffer: leafBuf } }] });
    const plants = scene.ranges.reduce((a, r) => a + r.count, 0);
    stats = `${plants} plants · ${scene.kinds.length} meshes · ${(tris / 1000).toFixed(1)}k triangles · generated in ${genMs.toFixed(0)} ms`;
    if (state.mode === 'plant') {
      const m = scene.kinds[0].mesh;
      stats = `${SPECIES[state.species].name} · seed ${state.seed} · ${m.tris} triangles · ${m.height.toFixed(1)} cells tall · ${genMs.toFixed(1)} ms`;
    }
    statsEl.textContent = stats;
    resetLeaves();
    // the camera: close for one plant, through the wood for a scene
    if (state.mode === 'plant') {
      cam.at = [0, 0, scene.kinds[0].mesh.height * 0.45];
      cam.dist = Math.max(4, scene.kinds[0].mesh.height * 1.9);
    } else if (!cam.userMoved) {
      cam.at = [0, 0, 3];
      cam.dist = 34;
    }
  }

  // ---- falling leaves: from the crowns, carried by the wind, settling, lifted again in a gust ----
  const lr = rng(77);
  const leafCol = (sp: SpeciesId): RGB => {
    const c = SPECIES[sp].colours;
    const s = state.season;
    const fall = s > 0.35 && s < 0.85;
    const pick = lr();
    if (fall || pick < 0.55) return c.autumn.map((v) => v * (0.75 + 0.35 * lr())) as RGB;
    return c.leafLight.map((v) => v * (0.8 + 0.3 * lr())) as RGB;
  };
  function spawnLeaf(i: number, onGround = false) {
    const cs = scene.crowns;
    const o = i * 8;
    if (!cs.length) {
      leafData[o + 2] = -100;
      leafData[o + 7] = 0;
      return;
    }
    const c = cs[Math.floor(lr() * cs.length)];
    const a = lr() * Math.PI * 2;
    const d = Math.sqrt(lr()) * c.r;
    leafData[o] = c.x + Math.cos(a) * d;
    leafData[o + 1] = c.y + Math.sin(a) * d;
    leafData[o + 2] = onGround ? 0.03 : c.z + (lr() - 0.5) * c.r;
    leafData[o + 3] = lr() * 6.28;
    const col = leafCol(c.species);
    leafData[o + 4] = col[0];
    leafData[o + 5] = col[1];
    leafData[o + 6] = col[2];
    leafData[o + 7] = 0.13 + 0.07 * lr();
    vel[i * 3] = 0;
    vel[i * 3 + 1] = 0;
    vel[i * 3 + 2] = 0;
    rest[i] = onGround ? 4 + lr() * 10 : 0;
  }
  const vel = new Float32Array(LEAVES * 3);
  const rest = new Float32Array(LEAVES);
  function resetLeaves() {
    for (let i = 0; i < LEAVES; i++) {
      spawnLeaf(i, lr() < 0.5);
      // scattered through the fall at the start
      if (rest[i] === 0) leafData[i * 8 + 2] *= lr();
    }
  }

  // ---- wind: sway.wgsl's spring on the CPU (lean toward the wind, held while it blows, a slow springy return) ----
  const lean = [0, 0];
  const lv = [0, 0];
  let time = 0;
  function windAt(t: number): [number, number] {
    // a prevailing wind with gusts rolling through
    const gust = 0.6 + 0.4 * Math.sin(t * 0.37) * Math.sin(t * 0.13 + 1) + 0.25 * Math.max(0, Math.sin(t * 0.9));
    const ws = state.wind * 9 * gust;
    const a = 0.6 + 0.25 * Math.sin(t * 0.05);
    return [Math.cos(a) * ws, Math.sin(a) * ws];
  }

  // ---- camera: orbit (drag), zoom (wheel, pinch) ----
  const cam = { yaw: -0.9, pitch: 0.5, dist: 34, at: [0, 0, 3] as number[], userMoved: false };
  const ptrs = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  canvas.addEventListener('pointerup', (e) => {
    ptrs.delete(e.pointerId);
    pinch = 0;
  });
  canvas.addEventListener('pointercancel', (e) => ptrs.delete(e.pointerId));
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX;
      p.y = e.clientY;
      const [c, d] = [...ptrs.values()];
      const d1 = Math.hypot(c.x - d.x, c.y - d.y);
      if (pinch) cam.dist = Math.min(160, Math.max(2, cam.dist * (d0 / d1)));
      pinch = d1;
    } else {
      cam.yaw -= (e.clientX - p.x) * 0.008;
      cam.pitch = Math.min(1.45, Math.max(0.02, cam.pitch + (e.clientY - p.y) * 0.006));
      p.x = e.clientX;
      p.y = e.clientY;
    }
    cam.userMoved = true;
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      cam.dist = Math.min(160, Math.max(2, cam.dist * Math.exp(e.deltaY * 0.001)));
      cam.userMoved = true;
    },
    { passive: false },
  );

  // ---- UI ----
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const modeSel = $<HTMLSelectElement>('mode');
  const biomeSel = $<HTMLSelectElement>('biome');
  const spSel = $<HTMLSelectElement>('species');
  for (const b of BIOMES) biomeSel.add(new Option(b.name, b.id));
  for (const id of SPECIES_IDS) spSel.add(new Option(SPECIES[id].name, id));
  modeSel.value = state.mode;
  biomeSel.value = state.biome;
  spSel.value = state.species;
  const seedIn = $<HTMLInputElement>('seed');
  seedIn.value = String(state.seed);
  const sliders: [keyof State, string][] = [
    ['wind', 'wind'],
    ['season', 'season'],
    ['growth', 'growth'],
    ['density', 'density'],
  ];
  const showModes = () => {
    $('row-biome').style.display = state.mode === 'scene' ? '' : 'none';
    $('row-species').style.display = state.mode === 'plant' ? '' : 'none';
    $('row-growth').style.display = state.mode === 'plant' ? '' : 'none';
    $('row-density').style.display = state.mode === 'scene' ? '' : 'none';
  };
  const atlasLink = $<HTMLAnchorElement>('atlas');
  const syncUrl = () => {
    const q = new URLSearchParams({ mode: state.mode, biome: state.biome, species: state.species, seed: String(state.seed), wind: state.wind.toFixed(2), season: state.season.toFixed(2), growth: state.growth.toFixed(2), density: state.density.toFixed(2) });
    history.replaceState(null, '', `?${q}`);
    atlasLink.href = `./?skipmenu=1&level=atlas&tutorial=0&flora=1`;
  };
  modeSel.onchange = () => {
    state.mode = modeSel.value as Mode;
    cam.userMoved = false;
    showModes();
    rebuild();
    syncUrl();
  };
  biomeSel.onchange = () => {
    state.biome = biomeSel.value as Biome;
    rebuild();
    syncUrl();
  };
  spSel.onchange = () => {
    state.species = spSel.value as SpeciesId;
    rebuild();
    syncUrl();
  };
  seedIn.onchange = () => {
    state.seed = Math.max(0, Math.floor(Number(seedIn.value) || 0));
    rebuild();
    syncUrl();
  };
  $<HTMLButtonElement>('reseed').onclick = () => {
    state.seed = Math.floor(Math.random() * 10000);
    seedIn.value = String(state.seed);
    rebuild();
    syncUrl();
  };
  let growing = false;
  $<HTMLButtonElement>('grow').onclick = () => {
    state.mode = 'plant';
    modeSel.value = 'plant';
    showModes();
    growing = true;
    state.growth = 0.05;
  };
  for (const [k, id] of sliders) {
    const el = $<HTMLInputElement>(id);
    el.value = String(state[k]);
    el.oninput = () => {
      (state as unknown as Record<string, number>)[k] = Number(el.value);
      if (k === 'growth' || k === 'density') rebuild();
      if (k === 'season') resetLeaves();
      syncUrl();
    };
  }
  showModes();
  syncUrl();
  rebuild();

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    depth?.destroy();
    depth = device.createTexture({ size: [canvas.width, canvas.height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  let last = performance.now();
  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    // growing: the grow button runs the growth slider up over ~6 s, the L-system re-made as it goes
    if (growing) {
      state.growth = Math.min(1, state.growth + dt / 6);
      ($<HTMLInputElement>('growth')).value = String(state.growth);
      rebuild();
      if (state.growth >= 1) growing = false;
    }
    // the sway spring (sway.wgsl's constants)
    const w = windAt(time);
    const ws = Math.hypot(w[0], w[1]);
    const aim = [(w[0] / Math.max(ws, 1e-3)) * Math.min(2.6, ws / 6) * 0.3, (w[1] / Math.max(ws, 1e-3)) * Math.min(2.6, ws / 6) * 0.3];
    const pushing = (aim[0] - lean[0]) * aim[0] + (aim[1] - lean[1]) * aim[1] > 0 && Math.hypot(...aim) > Math.hypot(...lean) * 0.9;
    const k = pushing ? 7 : 1.6;
    const damp = pushing ? 4.2 : 1.1;
    for (let i = 0; i < 2; i++) {
      lv[i] += ((aim[i] - lean[i]) * k - lv[i] * damp) * dt;
      lean[i] += lv[i] * dt;
    }
    // leaves: fall, flutter, drift with the wind; rest on the ground; a gust lifts some
    for (let i = 0; i < LEAVES; i++) {
      const o = i * 8;
      if (leafData[o + 7] === 0) continue;
      if (rest[i] > 0) {
        rest[i] -= dt;
        if (ws > 5 && lr() < (ws - 5) * 0.004) {
          rest[i] = 0;
          vel[i * 3 + 2] = 1.5 + lr() * 1.5;
        } else {
          if (rest[i] <= 0) spawnLeaf(i);
          continue;
        }
      }
      const vx = vel[i * 3];
      const vy = vel[i * 3 + 1];
      // drag toward the wind, a slow fall, a flutter across it
      vel[i * 3] += ((w[0] * 0.5 - vx) * 1.2 + Math.sin(time * 5 + i) * 2) * dt;
      vel[i * 3 + 1] += ((w[1] * 0.5 - vy) * 1.2 + Math.cos(time * 4.3 + i * 1.7) * 2) * dt;
      vel[i * 3 + 2] += (-0.9 - vel[i * 3 + 2] * 2.2) * dt;
      leafData[o] += vel[i * 3] * dt;
      leafData[o + 1] += vel[i * 3 + 1] * dt;
      leafData[o + 2] += vel[i * 3 + 2] * dt;
      leafData[o + 3] += dt * (3 + (i % 5));
      if (leafData[o + 2] <= 0.03) {
        leafData[o + 2] = 0.03;
        rest[i] = 6 + lr() * 14;
      }
      if (Math.hypot(leafData[o], leafData[o + 1]) > scene.radius * 1.4) spawnLeaf(i);
    }
    device.queue.writeBuffer(leafBuf, 0, leafData);
    // globals: the time and the season (common.wgsl G.time, G.rules.w)
    const gf = new Float32Array(gData);
    gf[8] = time;
    gf[275] = state.season;
    device.queue.writeBuffer(globals, 0, gData);
    const aspect = canvas.width / canvas.height;
    const cp = Math.cos(cam.pitch);
    const eye = [cam.at[0] + Math.cos(cam.yaw) * cp * cam.dist, cam.at[1] + Math.sin(cam.yaw) * cp * cam.dist, cam.at[2] + Math.sin(cam.pitch) * cam.dist];
    const vp = mul4(perspective(0.75, aspect, 0.2, 900), lookAt(eye, cam.at, [0, 0, 1]));
    const vd = new Float32Array(64);
    vd.set(vp, 0);
    vd.set([eye[0], eye[1], eye[2], 1], 16);
    vd.set([lean[0], lean[1], time, scene.ground], 20);
    vd.set([0.45, -0.35, 0.82, 180], 24);
    device.queue.writeBuffer(viewBuf, 0, vd);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0.72, g: 0.8, b: 0.86, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    if (pipes) {
      pass.setPipeline(pipes.ground);
      pass.setBindGroup(0, groundGroup);
      pass.draw(6);
      pass.setPipeline(pipes.plant);
      pass.setBindGroup(0, group);
      pass.setVertexBuffer(0, vbuf);
      pass.setIndexBuffer(ibuf, 'uint32');
      for (const d of draws) if (d.ninst > 0) pass.drawIndexed(d.count, d.ninst, d.first, d.base, d.inst0);
      pass.setPipeline(pipes.leaf);
      pass.setBindGroup(0, leafGroup);
      pass.draw(6, LEAVES);
    }
    pass.end();
    device.queue.submit([enc.finish()]);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (window as unknown as { floraViewer: unknown }).floraViewer = { state, rebuild, cam, stats: () => stats };
}

void main();
