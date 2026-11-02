// Geometric prepass for CC props: OBJ (+MTL, +colormap PNG) -> a solid voxel grid, palette-mapped.
//
//   node scripts/props/voxelise.mjs <manifest.json> <downloads folder> <out.json>
//
// The manifest lists { id, obj, size (longest side in cells, or "height" in cells), yaw (deg),
// credit } entries; `obj` paths are read as data only (the downloads live in an untrusted folder
// outside the repo; nothing there is executed). Output: one JSON with every prop as a voxel list at
// the prop grid's resolution (VOX per cell), each voxel a palette index into PROP_PALETTE
// (src/interiors/palette.ts mirrors it).
//
// Steps per model:
//   1. parse OBJ faces (v / vt), materials from MTL (Kd or map_Kd texture sampled at the UV);
//   2. decimate by resolution: the voxel grid itself is the decimation (VOX per cell);
//   3. surface voxelisation: every triangle sampled at < half a voxel; each voxel keeps the
//      area-weighted mean colour of the samples that hit it;
//   4. solid fill: voxels not reachable from outside (6-connected flood) are interior; dropped
//      (nothing draws them) except those touching the surface hull, which are kept as-is;
//   5. palette-map every surface colour to the nearest PROP_PALETTE entry (lightness and opponent colours, the colour
//      weighted), a little darker so the props sit in the Rain World mood.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { PROP_PALETTE, VOX } from './palette.mjs';

const [, , manifestPath, srcRoot, outPath] = process.argv;
if (!manifestPath || !srcRoot || !outPath) throw new Error('usage: voxelise.mjs <manifest.json> <downloads folder> <out.json>');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const root = path.resolve(srcRoot);

function readMtl(file) {
  const mats = {};
  if (!fs.existsSync(file)) return mats;
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'newmtl') mats[cur = t[1]] = { kd: [1, 1, 1], map: null };
    else if (t[0] === 'Kd' && cur) mats[cur].kd = [+t[1], +t[2], +t[3]];
    else if (t[0] === 'map_Kd' && cur) mats[cur].map = line.trim().slice(7).trim();
  }
  return mats;
}

const texCache = new Map();
function readTex(file) {
  if (!texCache.has(file)) texCache.set(file, PNG.sync.read(fs.readFileSync(file)));
  return texCache.get(file);
}

function parseObj(file) {
  const dir = path.dirname(file);
  const v = [], vt = [], tris = [];
  let mats = {}, mat = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') v.push([+t[1], +t[2], +t[3]]);
    else if (t[0] === 'vt') vt.push([+t[1], +t[2]]);
    else if (t[0] === 'mtllib') mats = readMtl(path.join(dir, t.slice(1).join(' ')));
    else if (t[0] === 'usemtl') mat = mats[t[1]] ?? { kd: [0.7, 0.7, 0.7], map: null };
    else if (t[0] === 'f') {
      const idx = t.slice(1).map((s) => {
        const [a, b] = s.split('/');
        const vi = +a < 0 ? v.length + +a : +a - 1;
        const ti = b ? (+b < 0 ? vt.length + +b : +b - 1) : -1;
        return [vi, ti];
      });
      for (let i = 1; i + 1 < idx.length; i++) tris.push({ p: [idx[0], idx[i], idx[i + 1]], mat });
    }
  }
  return { v, vt, tris, dir };
}

function colourAt(m, mat, dir, uv) {
  const kd = mat?.kd ?? [0.7, 0.7, 0.7];
  if (!mat?.map || !uv) return kd;
  const tex = readTex(path.join(dir, mat.map));
  const u = uv[0] - Math.floor(uv[0]), w = uv[1] - Math.floor(uv[1]);
  const x = Math.min(tex.width - 1, Math.floor(u * tex.width));
  const y = Math.min(tex.height - 1, Math.floor((1 - w) * tex.height));
  const o = (y * tex.width + x) * 4;
  return [tex.data[o] / 255 * kd[0], tex.data[o + 1] / 255 * kd[1], tex.data[o + 2] / 255 * kd[2]];
}

function nearestPalette(c) {
  // darker (the Rain World mood), then the nearest by lightness and by the opponent colours apart, the colour weighted
  // over the lightness so a teal cloth stays teal rather than turning a grey of its lightness
  const d = c.map((x) => x * 0.82);
  const opp = (q) => [0.3 * q[0] + 0.59 * q[1] + 0.11 * q[2], q[0] - q[1], (q[0] + q[1]) / 2 - q[2]];
  const a = opp(d);
  let best = 0, bd = 1e9;
  for (let i = 0; i < PROP_PALETTE.length; i++) {
    const b = opp(PROP_PALETTE[i].rgb);
    const e = (a[0] - b[0]) ** 2 + 2.5 * ((a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
    if (e < bd) { bd = e; best = i; }
  }
  return best;
}

function voxelise(entry) {
  const obj = parseObj(path.resolve(root, entry.obj));
  // OBJ is y-up and right-handed: (x, y, z) → world (x, -z, y), z up. Kenney's models face +z (world -y); turned a
  // quarter so every prop's front faces +x (the plan's yaw 0), plus the entry's own yaw for odd ones.
  const yaw = (((entry.yaw ?? 0) + 90) * Math.PI) / 180, cy = Math.cos(yaw), sy = Math.sin(yaw);
  const P = obj.v.map(([x, y, z]) => [x * cy + z * sy, x * sy - z * cy, y]);
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const p of P) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const scale = entry.height != null ? entry.height / ext[2] : entry.size / Math.max(ext[0], ext[1], ext[2]);
  const res = VOX * scale; // voxels per model unit
  const dims = ext.map((e) => Math.max(1, Math.ceil(e * res - 1e-6)));
  const [nx, ny, nz] = dims;
  const acc = new Float32Array(nx * ny * nz * 4);
  const vid = (x, y, z) => (z * ny + y) * nx + x;
  const toV = (p) => [(p[0] - lo[0]) * res, (p[1] - lo[1]) * res, (p[2] - lo[2]) * res];
  for (const t of obj.tris) {
    const a = toV(P[t.p[0][0]]), b = toV(P[t.p[1][0]]), c = toV(P[t.p[2][0]]);
    const ua = obj.vt[t.p[0][1]], ub = obj.vt[t.p[1][1]], uc = obj.vt[t.p[2][1]];
    const len = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const n = Math.max(1, Math.ceil(Math.max(len(a, b), len(b, c), len(c, a)) * 2.5));
    // triangle area weight (in voxel units) shared over its samples
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const area = 0.5 * Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
    const wgt = Math.max(1e-4, area) / ((n + 1) * (n + 2) / 2);
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, w = j / n, s = 1 - u - w;
      const p = [a[0] * s + b[0] * u + c[0] * w, a[1] * s + b[1] * u + c[1] * w, a[2] * s + b[2] * u + c[2] * w];
      const uv = ua && ub && uc ? [ua[0] * s + ub[0] * u + uc[0] * w, ua[1] * s + ub[1] * u + uc[1] * w] : null;
      const x = Math.min(nx - 1, Math.max(0, Math.floor(p[0])));
      const y = Math.min(ny - 1, Math.max(0, Math.floor(p[1])));
      const z = Math.min(nz - 1, Math.max(0, Math.floor(p[2])));
      const col = colourAt(null, t.mat, obj.dir, uv);
      const o = vid(x, y, z) * 4;
      acc[o] += col[0] * wgt; acc[o + 1] += col[1] * wgt; acc[o + 2] += col[2] * wgt; acc[o + 3] += wgt;
    }
  }
  // solid fill: flood the outside; anything neither surface nor outside is interior (not drawn)
  const N = nx * ny * nz, outside = new Uint8Array(N), stack = [];
  const push = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
    const i = vid(x, y, z);
    if (outside[i] || acc[i * 4 + 3] > 0) return;
    outside[i] = 1; stack.push(x, y, z);
  };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) { push(0, y, z); push(nx - 1, y, z); }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { push(x, 0, z); push(x, ny - 1, z); }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { push(x, y, 0); push(x, y, nz - 1); }
  while (stack.length) {
    const z = stack.pop(), y = stack.pop(), x = stack.pop();
    push(x + 1, y, z); push(x - 1, y, z); push(x, y + 1, z); push(x, y - 1, z); push(x, y, z + 1); push(x, y, z - 1);
  }
  const vox = [];
  let interior = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = vid(x, y, z), o = i * 4;
    if (acc[o + 3] > 0) {
      const c = [acc[o] / acc[o + 3], acc[o + 1] / acc[o + 3], acc[o + 2] / acc[o + 3]];
      vox.push(x, y, z, nearestPalette(c));
    } else if (!outside[i]) interior++;
  }
  return { id: entry.id, dims, vox, tris: obj.tris.length, interior, credit: entry.credit };
}

const out = { vox: VOX, palette: PROP_PALETTE, props: [] };
for (const e of manifest.props) {
  const r = voxelise(e);
  out.props.push({ id: r.id, dims: r.dims, vox: r.vox, credit: r.credit });
  console.log(`${r.id.padEnd(16)} ${r.tris} tris -> ${r.dims.join('x')} grid, ${r.vox.length / 4} surface voxels (${r.interior} interior dropped)`);
}
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
