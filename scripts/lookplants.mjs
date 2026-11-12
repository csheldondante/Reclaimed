// (looklab) The Synty POLYGON Nature Pack's leafy trees (leaf cards on a trunk: Generic, Birch, Pine, Willow) for the
// look lab, from the user's own Unity package into local/look (gitignored — licensed assets never go in the public
// repo). Run: node scripts/lookplants.mjs   (extracts the package into local/look/_nature on first run)
//   trees.bin  'TREE', n, 0, 0; per tree: first vertex, vertex count, height (f32 bits), 0; then each vertex: position
//              xyz (metres, z up), normal xyz, uv, texture layer, leaf occlusion (0 trunk), tint rgb, the leaf card's centre xyz and the vertex's place on it xy  (18 f32)
//   trees_<layer>.png  the textures, in layer order (TEX below)
// Leaves get "blob" normals: each leaf vertex's normal bent out from its crown's centre (an ellipsoid round the
// leaves), so a crown lights as one soft mass, not card by card — the stylized-tree trick.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFbx, fbxMeshes } from './fbx.mjs';

const pkg = join(process.env.APPDATA ?? '', 'Unity/Asset Store-5.x/Synty Studios/3D ModelsVegetationTrees/POLYGON - Nature Pack - Art by Synty.unitypackage');
const out = 'local/look';
const tmp = join(out, '_nature');
mkdirSync(tmp, { recursive: true });
if (!existsSync(join(tmp, '.done'))) {
  execFileSync('tar', ['-xz', '-C', tmp], { input: readFileSync(pkg), maxBuffer: 1 << 30 });
  writeFileSync(join(tmp, '.done'), '');
}
const byPath = new Map();
for (const d of readdirSync(tmp)) {
  const p = join(tmp, d, 'pathname');
  if (existsSync(p)) byPath.set(readFileSync(p, 'utf8').split('\n')[0].trim(), join(tmp, d, 'asset'));
}
const T = 'Assets/Synty/PolygonNature/Textures/';
const TEX = [`${T}Leaves/Leaves_Generic_01.png`, `${T}Leaves/Leaves_Pine_01.png`, `${T}Leaves/Leaves_Willow_01.png`, `${T}Leaves/Birch_Trunk_01.png`, `${T}PolygonNature_01.png`];
// the trees: their leaf texture, its tint (the materials' _ColorTint), their trunk's texture
const GEN = { leaf: 0, tint: [0.83, 0.79, 0.48], trunk: 4 };
const BIRCH = { leaf: 0, tint: [0.83, 0.79, 0.48], trunk: 3 };
const PINE = { leaf: 1, tint: [1, 1, 1], trunk: 4 };
const WILLOW = { leaf: 2, tint: [0.45, 0.49, 0.19], trunk: 4 };
const TREES = [
  ['SM_Tree_Generic_01', GEN],
  ['SM_Tree_Birch_01', BIRCH],
  ['SM_Tree_Birch_02', BIRCH],
  ['SM_Tree_Birch_03', BIRCH],
  ['SM_Tree_Birch_04', BIRCH],
  ['SM_Tree_Birch_Small_01', BIRCH],
  ['SM_Tree_Pine_01', PINE],
  ['SM_Tree_Pine_02', PINE],
  ['SM_Tree_Pine_Small_01', PINE],
  ['SM_Tree_Pine_Large_01', PINE],
  ['SM_Tree_Willow_Medium_01', WILLOW],
];
const find = (name) => [...byPath.keys()].find((p) => p.endsWith(`/${name}.fbx`) && p.includes('/Models/'));
const verts = [];
const heads = [];
for (const [name, look] of TREES) {
  const p = find(name);
  if (!p) throw new Error(`lookplants: no ${name}`);
  const m = fbxMeshes(parseFbx(readFileSync(byPath.get(p))));
  // y up, centimetres → z up, metres
  const vs = [];
  for (const t of m.tris) {
    const leaf = /lea/i.test(m.matNames[t.m]);
    for (const c of t.c) vs.push({ p: [c.p[0] / 100, -c.p[2] / 100, c.p[1] / 100], n: [c.n[0], -c.n[2], c.n[1]], uv: [c.uv[0], 1 - c.uv[1]], leaf, col: c.col, cen: [0, 0, 0], off: [0, 0] });
  }
  // the leaf cards: a triangle with the next one sharing two corners is one quad card; each vertex keeps its card's
  // centre and its place on the card (2D, in the card's plane), so the vertex stage can turn the card to the camera
  const same = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-5;
  for (let t = 0; t < vs.length; t += 3) {
    if (!vs[t].leaf) continue;
    let tris = [t];
    if (t + 3 < vs.length && vs[t + 3].leaf) {
      let shared = 0;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (same(vs[t + a].p, vs[t + 3 + b].p)) shared++;
      if (shared >= 2) tris = [t, t + 3];
    }
    const idx = tris.flatMap((s0) => [s0, s0 + 1, s0 + 2]);
    const uniq = [];
    for (const i of idx) if (!uniq.some((j) => same(vs[j].p, vs[i].p))) uniq.push(i);
    const cen = [0, 1, 2].map((a) => uniq.reduce((s1, i) => s1 + vs[i].p[a], 0) / uniq.length);
    const e = vs[t + 1].p.map((x, a) => x - vs[t].p[a]);
    const f = vs[t + 2].p.map((x, a) => x - vs[t].p[a]);
    const nn = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
    const ln = Math.hypot(...nn) || 1;
    const N = nn.map((x) => x / ln);
    const le = Math.hypot(...e) || 1;
    const ax = e.map((x) => x / le);
    const ay = [N[1] * ax[2] - N[2] * ax[1], N[2] * ax[0] - N[0] * ax[2], N[0] * ax[1] - N[1] * ax[0]];
    for (const i of idx) {
      const d = vs[i].p.map((x, a) => x - cen[a]);
      vs[i].cen = cen;
      vs[i].off = [d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2], d[0] * ay[0] + d[1] * ay[1] + d[2] * ay[2]];
    }
    if (tris.length === 2) t += 3;
  }
  // (the crown's clumps: unused since the leaves keep Synty's own normals and occlusion; kept for the clump radius)
  const lv = vs.filter((v) => v.leaf);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of lv) for (let a = 0; a < 3; a++) (lo[a] = Math.min(lo[a], v.p[a])), (hi[a] = Math.max(hi[a], v.p[a]));
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const K = Math.max(1, Math.min(7, Math.round(size / 1.6)));
  let C = Array.from({ length: K }, (_, k) => lv[Math.floor(((k + 0.5) / K) * lv.length)].p.slice());
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  for (let it = 0; it < 12; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (const v of lv) {
      let best = 0;
      for (let k = 1; k < K; k++) if (d2(v.p, C[k]) < d2(v.p, C[best])) best = k;
      acc[best][0] += v.p[0];
      acc[best][1] += v.p[1];
      acc[best][2] += v.p[2];
      acc[best][3]++;
    }
    C = C.map((c, k) => (acc[k][3] ? [acc[k][0] / acc[k][3], acc[k][1] / acc[k][3], acc[k][2] / acc[k][3]] : c));
  }
  const R = C.map(() => 0);
  for (const v of lv) {
    let best = 0;
    for (let k = 1; k < K; k++) if (d2(v.p, C[k]) < d2(v.p, C[best])) best = k;
    R[best] = Math.max(R[best], Math.sqrt(d2(v.p, C[best])));
  }
  let height = 0;
  const first = verts.length / 18;
  for (const v of vs) {
    height = Math.max(height, v.p[2]);
    let n = v.n;
    let leafAo = 0;
    if (v.leaf) {
      // Synty's own: the cards as modelled (bent, layered), their normals as authored, the vertex colour's blue the
      // baked occlusion (it rises towards the crown's foot: corr. −0.99 with height) — lower layers darker
      // (the user: "deeper leaves should be even darker": a curve, the deepest near black-green)
      leafAo = Math.max(0.08, Math.pow(1 - Math.min(v.col[2], 0.95), 2.2));
    }
    verts.push(...v.p, ...n, ...v.uv, v.leaf ? look.leaf : look.trunk, leafAo, ...(v.leaf ? look.tint : [1, 1, 1]), ...v.cen, ...v.off);
  }
  const count = verts.length / 18 - first;
  heads.push(first, count, new Uint32Array(new Float32Array([height]).buffer)[0], 0);
  console.log(name.padEnd(26), count, 'vertices', height.toFixed(1), 'm');
}
const head = new Uint32Array([0x45455254, TREES.length, 0, 0, ...heads]);
const buf = Buffer.concat([Buffer.from(head.buffer), Buffer.from(new Float32Array(verts).buffer)]);
writeFileSync(join(out, 'trees.bin'), buf);
TEX.forEach((t, i) => {
  if (!byPath.has(t)) throw new Error(`lookplants: no ${t}`);
  copyFileSync(byPath.get(t), join(out, `trees_${i}.png`));
});
console.log(`${TREES.length} trees, ${verts.length / 18} vertices, ${(buf.length / 1024).toFixed(0)} KB → ${out}`);
