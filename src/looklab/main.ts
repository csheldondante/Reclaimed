// (looklab) The look lab (looklab.html): a 640 × 640 patch of the real world round the start town (local/look/patch.json,
// captured by /?…&lookcapture=1 — src/perf/lookcapture.ts) drawn by a throwaway renderer of its own, to find the
// look first: painted ground (Raygeas Stylized Terrain Textures, local/look/tex — the user's own pack, never
// committed), Synty trees (local/synty), the generated buildings (archgen from the captured lot records), water, a
// static sun shadow map, a grade. One zoom from the close (Dota-like) view to the whole patch.
//   ?zoom=px-a-cell  ?yaw=deg  ?pitch=deg  ?sun=deg  ?tex=0  ?trees=0  ?houses=0
// The lab's frame is the town's grid frame (world − origin), the frame of the lot records.

import lookWgsl from './look.wgsl?raw';
import { ArchGen } from '../archgen/archgen';
import { archTextures } from '../archgen/textures';
import { ROW_H } from '../world/lattice';
import { urlFlags } from '../flags';

const q = urlFlags();
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function fatal(msg: string): never {
  const d = document.createElement('div');
  d.className = 'fatal';
  d.textContent = msg;
  document.body.appendChild(d);
  throw new Error(msg);
}

type V3 = [number, number, number];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** an orthographic view: looking along −fw (fw towards the eye) at t, half sizes hw × hh, depth ±D */
function ortho(fw: V3, t: number[], hw: number, hh: number, D: number): Float32Array {
  const r = norm(cross([0, 0, 1], fw));
  const up = cross(fw, r);
  const m = new Float32Array(16);
  const row = (i: number, v: number[], s: number, c: number) => {
    m[i] = v[0] * s;
    m[4 + i] = v[1] * s;
    m[8 + i] = v[2] * s;
    m[12 + i] = c;
  };
  row(0, r, 1 / hw, -dot(r, t) / hw);
  row(1, up, 1 / hh, -dot(up, t) / hh);
  row(2, fw, -1 / (2 * D), 0.5 + dot(fw, t) / (2 * D));
  row(3, [0, 0, 0], 0, 1);
  return m;
}

const unb64 = (s: string) => {
  const b = atob(s);
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u.buffer;
};

// the ground's layers (the Raygeas sets, in this order: look.wgsl NL, flatCol)
const LAYERS = ['Grass_1', 'Grass_2', 'Mud_1', 'Mud_3', 'Rock_1', 'Tile_1', 'Sand_1', 'Snow_1'] as const;
const L = { grass: 0, flowers: 1, dirt: 2, mudgrass: 3, rock: 4, cobble: 5, sand: 6, snow: 7 };

interface Patch {
  sea: number;
  patch: { x0: number; y0: number; w: number; h: number; ground: string; water: string; top: string; veg: string };
  townGrid: { origin: [number, number]; box: { x0: number; y0: number; w: number; h: number }; roads: string; heights: string };
  lots: { n: number; counts: string; records: string };
}

async function main() {
  if (!navigator.gpu) fatal('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) fatal('No WebGPU adapter.');
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => fatal(`GPU error: ${(e as GPUUncapturedErrorEvent).error.message}`));

  const res = await fetch('/local/look/patch.json');
  if (!res.ok) fatal('No local/look/patch.json: capture one with /?skipmenu=1&level=atlas&town=1&fresh=1&citygen=fields&arch=1&lookcapture=1 and copy it from perf-reports/.');
  const P = (await res.json()) as Patch;
  const { x0, y0, w: W, h: H } = P.patch;
  const ground = new Float32Array(unb64(P.patch.ground));
  const water = new Float32Array(unb64(P.patch.water));
  const top = new Uint8Array(unb64(P.patch.top));
  const veg = new Float32Array(unb64(P.patch.veg));
  const [ox, oy] = P.townGrid.origin;
  const box = P.townGrid.box;
  const roads = new Uint32Array(unb64(P.townGrid.roads));
  const theights = new Float32Array(unb64(P.townGrid.heights));

  // ---- the ground mesh: a vertex a cell (the hex lattice's centres), the town's ground and roads over the atlas's
  const N = W * H;
  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const pz = new Float32Array(N);
  const isRoad = new Uint8Array(N);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const gy = y0 + j;
      px[k] = x0 + i + 0.5 + 0.5 * (gy & 1) - ox;
      py[k] = (gy + 0.5) * ROW_H - oy;
      pz[k] = ground[k];
      const bi = x0 + i - box.x0;
      const bj = gy - box.y0;
      if (bi >= 0 && bj >= 0 && bi < box.w && bj < box.h) {
        const r = roads[bj * box.w + bi];
        const th = theights[bj * box.w + bi];
        if (Number.isFinite(th) && th > 0) pz[k] = th;
        if (r !== 0 && (r & 0x80000000) === 0) isRoad[k] = 1;
      }
    }
  }
  const at = (i: number, j: number) => Math.min(H - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i));
  // the cells' steps softened (two passes over gentle ground; a step over 1.6 m is a cliff and stays)
  for (let pass = 0; pass < 2; pass++) {
    const sm = pz.slice();
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        let s = pz[k] * 2;
        let c = 2;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
          const z = pz[at(i + di, j + dj)];
          if (Math.abs(z - pz[k]) < 1.6) {
            s += z;
            c++;
          }
        }
        sm[k] = s / c;
      }
    }
    pz.set(sm);
  }
  // normals from the neighbours' heights (central differences across the lattice)
  const nrm = new Float32Array(N * 3);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const dx = (pz[at(i + 1, j)] - pz[at(i - 1, j)]) / 2;
      const dy = (pz[at(i, j + 1)] - pz[at(i, j - 1)]) / (2 * ROW_H);
      const n = norm([-dx, -dy, 1]);
      nrm.set(n, k * 3);
    }
  }
  // the layers' weights a cell: from its top material, its plants, its slope, the roads
  const wts = new Float32Array(N * 8);
  const hash = (i: number, j: number) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let k = 0; k < N; k++) {
    const i = k % W;
    const j = (k / W) | 0;
    const o = k * 8;
    const m = top[k];
    const v = veg[k];
    const slope = 1 - nrm[k * 3 + 2];
    if (isRoad[k]) wts[o + L.cobble] = 1;
    else if (m === 1 || m === 23 || m === 30 || m === 38) wts[o + L.rock] = 1;
    else if (m === 3) wts[o + L.sand] = 1;
    else if (m === 25 || m === 27) wts[o + L.snow] = 1;
    else if (m === 11) wts[o + L.cobble] = 1;
    else if (m === 22) wts[o + L.dirt] = 1;
    else if (v > 0.55) {
      // flowers in soft patches
      const f = Math.sin(i * 0.11 + Math.sin(j * 0.07) * 2) * Math.sin(j * 0.09 + i * 0.03) > 0.55 ? 1 : 0;
      wts[o + (f ? L.flowers : L.grass)] = 1;
    } else if (v > 0.15) wts[o + L.mudgrass] = 1;
    else wts[o + L.dirt] = 1;
    // steep ground shows its rock
    const r = Math.min(1, Math.max(0, (slope - 0.18) / 0.2));
    if (r > 0 && !isRoad[k]) {
      for (let c = 0; c < 8; c++) wts[o + c] *= 1 - r;
      wts[o + L.rock] += r;
    }
    void hash;
  }
  // roads get a dirt shoulder: the cells round a road, part dirt
  for (let k = 0; k < N; k++) {
    if (isRoad[k]) continue;
    const i = k % W;
    const j = (k / W) | 0;
    let near = 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) if (isRoad[at(i + di, j + dj)]) near++;
    if (near) {
      const o = k * 8;
      const s = Math.min(1, near * 0.3);
      for (let c = 0; c < 8; c++) wts[o + c] *= 1 - s;
      wts[o + L.dirt] += s;
    }
  }
  // softened: each cell's weights with its neighbours' (edges that don't follow the cells)
  const soft = new Float32Array(N * 8);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const ks = [k, at(i + 1, j), at(i - 1, j), at(i, j + 1), at(i, j - 1)];
      for (let c = 0; c < 8; c++) {
        let s = wts[k * 8 + c] * 2;
        for (let t = 1; t < 5; t++) s += wts[ks[t] * 8 + c];
        soft[k * 8 + c] = s / 6;
      }
    }
  }
  // the vertex buffer: position, normal, weights (8 × u8 in 2 words), water depth
  // the water's level: the surface where there's water, carried two cells out under the dry ground (so the shore is
  // where the level meets the ground, not the cells' edge); far from water, under the ground
  const level = new Float32Array(N);
  for (let k = 0; k < N; k++) level[k] = water[k] > 0.01 ? pz[k] + water[k] : -1e9;
  for (let pass = 0; pass < 3; pass++) {
    const nx = level.slice();
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (water[k] > 0.01) continue;
        let m = -1e9;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) m = Math.max(m, level[at(i + di, j + dj)]);
        nx[k] = m;
      }
    }
    level.set(nx);
  }
  for (let k = 0; k < N; k++) if (level[k] < -1e8) level[k] = pz[k] - 5;
  const STRIDE = 10;
  const vb = new ArrayBuffer(N * STRIDE * 4);
  const vf = new Float32Array(vb);
  const vu = new Uint32Array(vb);
  for (let k = 0; k < N; k++) {
    const o = k * STRIDE;
    vf[o] = px[k];
    vf[o + 1] = py[k];
    vf[o + 2] = pz[k];
    vf[o + 3] = nrm[k * 3];
    vf[o + 4] = nrm[k * 3 + 1];
    vf[o + 5] = nrm[k * 3 + 2];
    const b = (c: number) => Math.round(Math.min(1, soft[k * 8 + c]) * 255);
    vu[o + 6] = b(0) | (b(1) << 8) | (b(2) << 16) | (b(3) << 24);
    vu[o + 7] = (b(4) | (b(5) << 8) | (b(6) << 16) | (b(7) << 24)) >>> 0;
    vf[o + 8] = water[k];
    vf[o + 9] = level[k];
  }
  // triangles between each row and the next (odd rows sit half a cell right), wound counter-clockwise
  const idx = new Uint32Array((W - 1) * (H - 1) * 6);
  let ni = 0;
  const tri = (a: number, b: number, c: number) => {
    const cr = (px[b] - px[a]) * (py[c] - py[a]) - (py[b] - py[a]) * (px[c] - px[a]);
    if (cr >= 0) idx.set([a, b, c], ni);
    else idx.set([a, c, b], ni);
    ni += 3;
  };
  for (let j = 0; j < H - 1; j++) {
    const odd = ((y0 + j) & 1) === 1;
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i;
      const b = a + 1;
      if (!odd) {
        const c = (j + 1) * W + i;
        tri(a, b, c);
        if (i > 0) tri(a, c, c - 1);
      } else {
        const c = (j + 1) * W + i + 1;
        tri(a, b, c);
        tri(a, c, c - 1);
      }
    }
  }
  const gvb = device.createBuffer({ size: vb.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(gvb, 0, vb);
  const gib = device.createBuffer({ size: ni * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(gib, 0, idx, 0, ni);

  // ---- the lots: buildings from archgen, and where trees may not go
  const recs = new Uint32Array(unb64(P.lots.records));
  const recf = new Float32Array(recs.buffer);
  const nLots = P.lots.n;
  const lotMask = new Uint8Array(N);
  for (let l = 0; l < nLots; l++) {
    const kind = recs[l * 24 + 17];
    if (kind === 0 || kind === 5) continue;
    const qx = [0, 1, 2, 3].map((c) => recf[l * 24 + c * 2] + ox);
    const qy = [0, 1, 2, 3].map((c) => recf[l * 24 + c * 2 + 1] + oy);
    const j0 = Math.floor(Math.min(...qy) / ROW_H) - y0 - 1;
    const j1 = Math.ceil(Math.max(...qy) / ROW_H) - y0 + 1;
    const i0 = Math.floor(Math.min(...qx)) - x0 - 1;
    const i1 = Math.ceil(Math.max(...qx)) - x0 + 1;
    for (let j = Math.max(0, j0); j <= Math.min(H - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(W - 1, i1); i++) {
        const k = j * W + i;
        const x = px[k] + ox;
        const y = py[k] + oy;
        let inside = true;
        for (let c = 0; c < 4; c++) {
          const d = (c + 1) % 4;
          if ((qx[d] - qx[c]) * (y - qy[c]) - (qy[d] - qy[c]) * (x - qx[c]) < 0) inside = false;
        }
        if (inside) lotMask[k] = 1;
      }
    }
  }
  const rec = device.createBuffer({ size: recs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(rec, 0, recs);
  const cnt = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(cnt, 0, new Uint32Array(unb64(P.lots.counts)));

  // ---- textures: the painted sets (colour sRGB; normal xy, height, roughness)
  const TS = 1024;
  const levels = Math.floor(Math.log2(TS)) + 1;
  const mkArr = (label: string, format: GPUTextureFormat) =>
    device.createTexture({ label, size: [TS, TS, LAYERS.length], format, mipLevelCount: levels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  const texC = mkArr('look colour', 'rgba8unorm-srgb');
  const texN = mkArr('look normal', 'rgba8unorm');
  await Promise.all(
    LAYERS.flatMap((name, layer) =>
      ([[texC, `${name}_c.jpg`], [texN, `${name}_n.png`]] as const).map(async ([tex, file]) => {
        const r = await fetch(`/local/look/tex/${file}`);
        if (!r.ok) fatal(`No local/look/tex/${file} (the Raygeas pack, packed locally)`);
        const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex, origin: [0, 0, layer] }, [TS, TS]);
        bmp.close();
      }),
    ),
  );
  mips(device, texC, levels, 'rgba8unorm-srgb');
  mips(device, texN, levels, 'rgba8unorm');

  // ---- the Synty Nature pack's leafy trees (local/look: scripts/lookplants.mjs)
  const treesRes = await fetch('/local/look/trees.bin');
  if (!treesRes.ok) fatal('No local/look/trees.bin (run node scripts/lookplants.mjs)');
  const pb = await treesRes.arrayBuffer();
  const ph = new Uint32Array(pb);
  const nMesh = ph[1];
  const meshes = Array.from({ length: nMesh }, (_, m) => ({ first: ph[4 + m * 4], count: ph[5 + m * 4], h: new Float32Array(pb, (6 + m * 4) * 4, 1)[0] }));
  const tvb = device.createBuffer({ size: pb.byteLength - (4 + nMesh * 4) * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(tvb, 0, pb, (4 + nMesh * 4) * 4);
  const TT = 1024;
  const tLevels = 11;
  const treeTex = device.createTexture({ size: [TT, TT, 5], format: 'rgba8unorm-srgb', mipLevelCount: tLevels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  await Promise.all(
    [0, 1, 2, 3, 4].map(async (i) => {
      const r = await fetch(`/local/look/trees_${i}.png`);
      const bmp = await createImageBitmap(await r.blob(), { resizeWidth: TT, resizeHeight: TT, resizeQuality: 'high', colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      device.queue.copyExternalImageToTexture({ source: bmp }, { texture: treeTex, origin: [0, 0, i] }, [TT, TT]);
      bmp.close();
    }),
  );
  mips(device, treeTex, tLevels, 'rgba8unorm-srgb');
  // which tree where (lookplants.mjs order): broadleaf (Generic, Birch) in the lowlands, pines up high, willows by water
  const BROAD = [0, 1, 2, 3, 4];
  const SMALL = [5, 8];
  const PINES = [6, 7, 9];
  const WILLOW = [10];
  const perMesh: number[][] = meshes.map(() => []);
  const nearWater = (i: number, j: number) => {
    for (const [di, dj] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) if (water[at(i + di, j + dj)] > 0.01) return true;
    return false;
  };
  for (let k = 0; k < N; k++) {
    if (isRoad[k] || lotMask[k] || water[k] > 0.01) continue;
    const m = top[k];
    if (m !== 2 && m !== 14) continue;
    const v = veg[k];
    const i = k % W;
    const j = (k / W) | 0;
    const r = hash(i, j);
    const r2 = hash(i + 0.5, j + 7.3);
    const slope = 1 - nrm[k * 3 + 2];
    if (slope > 0.3) continue;
    const clump = Math.sin(i * 0.05 + Math.sin(j * 0.04) * 3) + Math.sin(j * 0.061 - i * 0.02);
    let set: number[] | null = null;
    if (v > 0.9 && r < 0.035 + Math.max(0, clump) * 0.06) set = pz[k] > P.sea + 40 ? PINES : nearWater(i, j) ? WILLOW : r2 < 0.3 ? PINES : BROAD;
    else if (v > 0.5 && r < 0.006) set = SMALL;
    if (!set) continue;
    const mesh = set[Math.floor(r2 * set.length)];
    const jx = (hash(i + 3.1, j) - 0.5) * 0.8;
    const jy = (hash(i, j + 5.7) - 0.5) * 0.8;
    const sc = 1.25 + hash(i + 9.2, j) * 0.5;
    perMesh[mesh].push(px[k] + jx, py[k] + jy, pz[k] - 0.1, r2 * Math.PI * 2, sc, hash(i, j + 2.2), meshes[mesh].h, 0);
  }
  const instAll = perMesh.flat();
  const inst = device.createBuffer({ size: Math.max(32, instAll.length * 4), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(inst, 0, new Float32Array(instAll));
  const instRanges: { first: number; count: number }[] = [];
  let acc = 0;
  for (const l of perMesh) {
    instRanges.push({ first: acc, count: l.length / 8 });
    acc += l.length / 8;
  }

  // ---- pipelines
  const canvas = $<HTMLCanvasElement>('view');
  const ctx = canvas.getContext('webgpu')!;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
  const sceneFormat: GPUTextureFormat = 'rgba8unorm';
  const depthFormat: GPUTextureFormat = 'depth24plus';
  const samples = 4;
  const split = lookWgsl.indexOf('// ---- the grade');
  const mod = device.createShaderModule({ label: 'look', code: lookWgsl.slice(0, split) });
  const postMod = device.createShaderModule({ label: 'look post', code: lookWgsl.slice(split) });
  const ub = device.createBuffer({ size: 64 * 2 + 16 * 5, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const SHADOW = 4096;
  const shadowTex = device.createTexture({ size: [SHADOW, SHADOW], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const group = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: ub } },
      { binding: 1, resource: texC.createView({ dimension: '2d-array' }) },
      { binding: 2, resource: texN.createView({ dimension: '2d-array' }) },
      { binding: 3, resource: device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8 }) },
      { binding: 4, resource: shadowTex.createView() },
      { binding: 5, resource: device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' }) },
      { binding: 7, resource: treeTex.createView({ dimension: '2d-array' }) },
    ],
  });
  const groundVB: GPUVertexBufferLayout = {
    arrayStride: STRIDE * 4,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'uint32x2' },
      { shaderLocation: 3, offset: 32, format: 'float32' },
    ],
  };
  const groundPosVB: GPUVertexBufferLayout = { arrayStride: STRIDE * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] };
  const waterVB: GPUVertexBufferLayout = { arrayStride: STRIDE * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 3, offset: 32, format: 'float32' }, { shaderLocation: 4, offset: 36, format: 'float32' }] };
  const treeVerts: GPUVertexBufferLayout = {
    arrayStride: 72,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x2' },
      { shaderLocation: 3, offset: 32, format: 'float32x2' },
      { shaderLocation: 4, offset: 40, format: 'float32x3' },
      { shaderLocation: 7, offset: 52, format: 'float32x3' },
      { shaderLocation: 8, offset: 64, format: 'float32x2' },
    ],
  };
  const treeInst: GPUVertexBufferLayout = { arrayStride: 32, stepMode: 'instance', attributes: [{ shaderLocation: 5, offset: 0, format: 'float32x4' }, { shaderLocation: 6, offset: 16, format: 'float32x4' }] };
  const treeVB: GPUVertexBufferLayout[] = [treeVerts, treeInst];
  const treeShadowVB: GPUVertexBufferLayout[] = [{ arrayStride: 72, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x2' }] }, treeInst];
  const ds = (write = true): GPUDepthStencilState => ({ format: depthFormat, depthWriteEnabled: write, depthCompare: 'less' });
  const ms = { count: samples };
  const groundPipe = device.createRenderPipeline({ label: 'ground', layout, vertex: { module: mod, entryPoint: 'vsGround', buffers: [groundVB] }, fragment: { module: mod, entryPoint: 'fsGround', targets: [{ format: sceneFormat }] }, primitive: { cullMode: 'none' }, depthStencil: ds(), multisample: ms });
  const treePipe = device.createRenderPipeline({ label: 'trees', layout, vertex: { module: mod, entryPoint: 'vsTree', buffers: treeVB }, fragment: { module: mod, entryPoint: 'fsTree', targets: [{ format: sceneFormat }] }, primitive: { cullMode: 'none' }, depthStencil: ds(), multisample: ms });
  const blend: GPUBlendState = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
  const waterPipe = device.createRenderPipeline({ label: 'water', layout, vertex: { module: mod, entryPoint: 'vsWater', buffers: [waterVB] }, fragment: { module: mod, entryPoint: 'fsWater', targets: [{ format: sceneFormat, blend }] }, primitive: { cullMode: 'none' }, depthStencil: ds(false), multisample: ms });
  const sds: GPUDepthStencilState = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' };
  const shadowL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
    ],
  });
  const shadowLayout = device.createPipelineLayout({ bindGroupLayouts: [shadowL] });
  const shadowGroup = device.createBindGroup({ layout: shadowL, entries: [{ binding: 0, resource: { buffer: ub } }, { binding: 3, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }) }, { binding: 7, resource: treeTex.createView({ dimension: '2d-array' }) }] });
  const groundShadowPipe = device.createRenderPipeline({ label: 'ground shadow', layout: shadowLayout, vertex: { module: mod, entryPoint: 'vsGroundShadow', buffers: [groundPosVB] }, primitive: { cullMode: 'none' }, depthStencil: sds });
  const treeShadowPipe = device.createRenderPipeline({ label: 'tree shadow', layout: shadowLayout, vertex: { module: mod, entryPoint: 'vsTreeShadow', buffers: treeShadowVB }, fragment: { module: mod, entryPoint: 'fsTreeShadow', targets: [] }, primitive: { cullMode: 'none' }, depthStencil: sds });
  const postU = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const postPipe = device.createRenderPipeline({ label: 'post', layout: 'auto', vertex: { module: postMod, entryPoint: 'vsPost' }, fragment: { module: postMod, entryPoint: 'fsPost', targets: [{ format: canvasFormat }] } });

  // ---- the buildings
  let zmin = Infinity;
  for (let l = 0; l < nLots; l++) if (recf[l * 24 + 21] !== 0) zmin = Math.min(zmin, recf[l * 24 + 21]);
  const gen = new ArchGen(device, rec, cnt, { lots: nLots });
  gen.labDraw(sceneFormat, depthFormat, samples);
  gen.windows = true;
  const remake = () => {
    const e = device.createCommandEncoder();
    gen.generate(e, 0, nLots);
    gen.compact(e);
    device.queue.submit([e.finish()]);
  };
  remake();
  archTextures(device).whenPlants(remake);

  // ---- the camera and the controls
  const cx = box.w / 2;
  const cy = (box.h / 2) * ROW_H;
  let czAt = pz[at(Math.round(box.x0 - x0 + box.w / 2), Math.round(box.y0 - y0 + box.h / 2))];
  if (!Number.isFinite(czAt)) czAt = zmin;
  const cam = { x: cx, y: cy, z: czAt, yaw: num('yaw', 225), pitch: num('pitch', 60), sun: num('sun', 150), ppc: num('zoom', 4) };
  const look = { tex: q.get('tex') !== '0', trees: q.get('trees') !== '0', houses: q.get('houses') !== '0', grade: true, shadow: true, dbg: num('dbg', 0), exposure: num('exposure', 1.0), sunK: num('sunk', 1.3), amb: num('amb', 0.9) };
  const ZMIN = 0.6;
  const ZMAX = 64;
  const zoomEl = $<HTMLInputElement>('zoom');
  const toSlider = (ppc: number) => Math.log(ppc / ZMIN) / Math.log(ZMAX / ZMIN);
  zoomEl.value = String(toSlider(cam.ppc));
  zoomEl.oninput = () => (cam.ppc = ZMIN * Math.pow(ZMAX / ZMIN, Number(zoomEl.value)));
  for (const k of ['yaw', 'pitch', 'sun'] as const) {
    const el = $<HTMLInputElement>(k);
    el.value = String(cam[k]);
    el.oninput = () => {
      cam[k] = Number(el.value);
      if (k === 'sun') shadowDirty = true;
    };
  }
  for (const k of ['exposure', 'sunK', 'amb'] as const) {
    const el = $<HTMLInputElement>(k);
    el.value = String(look[k]);
    el.oninput = () => (look[k] = Number(el.value));
  }
  for (const k of ['tex', 'trees', 'houses', 'grade', 'shadow'] as const) {
    const el = $<HTMLInputElement>(k);
    el.checked = look[k];
    el.onchange = () => {
      look[k] = el.checked;
      if (k === 'trees') shadowDirty = true;
    };
  }
  // drag to pan, wheel / pinch to zoom
  const pts = new Map<number, [number, number]>();
  let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
  });
  canvas.addEventListener('pointerup', (e) => {
    pts.delete(e.pointerId);
    pinch = 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      const [a2, b2] = [...pts.values()];
      const d0 = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const d1 = Math.hypot(a2[0] - b2[0], a2[1] - b2[1]);
      if (pinch && d0 > 0) cam.ppc = Math.min(ZMAX, Math.max(ZMIN, (cam.ppc * d1) / d0));
      pinch = 1;
      zoomEl.value = String(toSlider(cam.ppc));
      return;
    }
    const dx = ((e.clientX - p[0]) * dpr) / cam.ppc;
    const dy = ((e.clientY - p[1]) * dpr) / cam.ppc;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const yw = (cam.yaw * Math.PI) / 180;
    const sp = Math.sin((cam.pitch * Math.PI) / 180);
    // the screen's right on the ground (−sin, cos), its up away from the eye (−cos, −sin) / sin(pitch)
    cam.x += dx * Math.sin(yw) - (dy / sp) * Math.cos(yw);
    cam.y += -dx * Math.cos(yw) - (dy / sp) * Math.sin(yw);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.ppc = Math.min(ZMAX, Math.max(ZMIN, cam.ppc * Math.exp(-e.deltaY * 0.0015)));
    zoomEl.value = String(toSlider(cam.ppc));
  }, { passive: false });

  let shadowDirty = true;
  const sunDir = (): V3 => {
    const a = (cam.sun * Math.PI) / 180;
    return norm([Math.cos(a) * 0.62, Math.sin(a) * 0.62, 0.62]);
  };
  // the patch's frame (for the shadow map: the whole patch, once)
  const pcx = (px[0] + px[N - 1]) / 2;
  const pcy = (py[0] + py[N - 1]) / 2;
  let pzmin = Infinity;
  let pzmax = -Infinity;
  for (let k = 0; k < N; k++) {
    pzmin = Math.min(pzmin, pz[k]);
    pzmax = Math.max(pzmax, pz[k]);
  }
  const pcz = (pzmin + pzmax) / 2;
  const half = Math.hypot(W, H * ROW_H) / 2 + 10;

  let depth: GPUTexture | null = null;
  let msaa: GPUTexture | null = null;
  let scene: GPUTexture | null = null;
  let postGroup: GPUBindGroup | null = null;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h && depth) return;
    canvas.width = w;
    canvas.height = h;
    depth?.destroy();
    msaa?.destroy();
    scene?.destroy();
    depth = device.createTexture({ size: [w, h], format: depthFormat, sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    msaa = device.createTexture({ size: [w, h], format: sceneFormat, sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    scene = device.createTexture({ size: [w, h], format: sceneFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    postGroup = device.createBindGroup({ layout: postPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: scene.createView() }, { binding: 1, resource: { buffer: postU } }] });
  };

  const stats = $<HTMLDivElement>('stats');
  const t0 = performance.now();
  let last = t0;
  const dts: number[] = [];
  const frame = () => {
    resize();
    const now = performance.now();
    dts.push(now - last);
    last = now;
    if (dts.length > 60) dts.shift();
    const w = canvas.width;
    const h = canvas.height;
    const yw = (cam.yaw * Math.PI) / 180;
    const pt = (cam.pitch * Math.PI) / 180;
    const fw: V3 = [Math.cos(pt) * Math.cos(yw), Math.cos(pt) * Math.sin(yw), Math.sin(pt)];
    const hh = h / cam.ppc / 2;
    const hw = w / cam.ppc / 2;
    const vp = ortho(fw, [cam.x, cam.y, cam.z], hw, hh, 2000);
    const sun = sunDir();
    const svp = ortho(sun, [pcx, pcy, pcz], half, half, 1500);
    const time = (now - t0) / 1000;
    const u = new Float32Array(16 * 2 + 20);
    u.set(vp, 0);
    u.set(svp, 16);
    u.set([...sun, look.sunK], 32);
    u.set([...fw, 1 / cam.ppc], 36);
    u.set([time, look.tex ? 1 : 0, look.shadow ? 1 : 0, look.grade ? 1 : 0], 40);
    u.set([5, 0.22, look.exposure, look.amb], 44);
    u.set([look.dbg, 0, 0, 0], 48);
    device.queue.writeBuffer(ub, 0, u);
    device.queue.writeBuffer(postU, 0, new Float32Array([look.grade ? 1 : 0, time, w, h]));
    gen.setView(vp, [...sun, 1.15], [...fw, 1 / cam.ppc], time, 0, 1);
    const e = device.createCommandEncoder();
    if (shadowDirty) {
      shadowDirty = false;
      const sp = e.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: shadowTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      sp.setBindGroup(0, shadowGroup);
      sp.setPipeline(groundShadowPipe);
      sp.setVertexBuffer(0, gvb);
      sp.setIndexBuffer(gib, 'uint32');
      sp.drawIndexed(ni);
      if (look.trees) {
        sp.setPipeline(treeShadowPipe);
        sp.setVertexBuffer(0, tvb);
        sp.setVertexBuffer(1, inst);
        meshes.forEach((m, k) => instRanges[k].count && sp.draw(m.count, instRanges[k].count, m.first, instRanges[k].first));
      }
      sp.end();
    }
    const p = e.beginRenderPass({
      colorAttachments: [{ view: msaa!.createView(), resolveTarget: scene!.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0.12, g: 0.14, b: 0.15, a: 1 } }],
      depthStencilAttachment: { view: depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    p.setBindGroup(0, group);
    p.setPipeline(groundPipe);
    p.setVertexBuffer(0, gvb);
    p.setIndexBuffer(gib, 'uint32');
    p.drawIndexed(ni);
    if (look.trees) {
      p.setPipeline(treePipe);
      p.setVertexBuffer(0, tvb);
      p.setVertexBuffer(1, inst);
      meshes.forEach((m, k) => instRanges[k].count && p.draw(m.count, instRanges[k].count, m.first, instRanges[k].first));
    }
    if (look.houses) gen.drawLab(p);
    p.setBindGroup(0, group);
    p.setPipeline(waterPipe);
    p.setVertexBuffer(0, gvb);
    p.setIndexBuffer(gib, 'uint32');
    p.drawIndexed(ni);
    p.end();
    const pp = e.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pp.setPipeline(postPipe);
    pp.setBindGroup(0, postGroup!);
    pp.draw(3);
    pp.end();
    device.queue.submit([e.finish()]);
    const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
    stats.textContent = `${avg.toFixed(1)} ms · ${cam.ppc.toFixed(1)} px a cell · ${acc} trees · ${nLots} lots`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (globalThis as { looklab?: unknown }).looklab = {
    cam,
    look,
    set(o: Partial<typeof cam>) {
      Object.assign(cam, o);
      zoomEl.value = String(toSlider(cam.ppc));
      if (o.sun !== undefined) shadowDirty = true;
    },
  };
}

/** each layer's mips, a box filter from the level above */
function mips(device: GPUDevice, tex: GPUTexture, levels: number, format: GPUTextureFormat): void {
  const code = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
struct O { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> O {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: O; o.p = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2<f32>(p.x, 1.0 - p.y); return o;
}
@fragment fn fs(in: O) -> @location(0) vec4<f32> { return textureSampleLevel(src, s, in.uv, 0.0); }`;
  const m = device.createShaderModule({ code });
  const pipe = device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format }] } });
  const smp = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const e = device.createCommandEncoder();
  for (let layer = 0; layer < tex.depthOrArrayLayers; layer++) {
    for (let lv = 1; lv < levels; lv++) {
      const view = (level: number) => tex.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: level, mipLevelCount: 1 });
      const g = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: view(lv - 1) }, { binding: 1, resource: smp }] });
      const p = e.beginRenderPass({ colorAttachments: [{ view: view(lv), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      p.setPipeline(pipe);
      p.setBindGroup(0, g);
      p.draw(3);
      p.end();
    }
  }
  device.queue.submit([e.finish()]);
}

void main();
