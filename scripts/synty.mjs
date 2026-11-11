// (archgen) Converts the Synty POLYGON Nature Pack's plants (src/archgen/plants.json) from the user's own Unity package
// into local/synty (gitignored — licensed assets never go in this public repo; the user: "You can use Synty trees as
// long as we don't commit to a public repo"):
//   plants.bin   'PLNT', n, 0, 0; per mesh first vertex, vertex count, 0, 0; then each vertex: position xyz (metres,
//                z up), normal xyz, uv (8 f32)
//   palette.png  the pack's colour atlas (the meshes' uvs point into it)
// Run: node scripts/synty.mjs [path to "POLYGON - Nature Pack - Art by Synty.unitypackage"]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFbx, fbxMeshes } from './fbx.mjs';

const pkg = process.argv[2] ?? join(process.env.APPDATA ?? '', 'Unity/Asset Store-5.x/Synty Studios/3D ModelsVegetationTrees/POLYGON - Nature Pack - Art by Synty.unitypackage');
const out = 'local/synty';
const tmp = join(out, '_pkg');
mkdirSync(tmp, { recursive: true });
if (!existsSync(join(tmp, '.done'))) {
  // (through stdin: GNU tar reads a drive letter's colon as a host)
  execFileSync('tar', ['-xz', '-C', tmp], { input: readFileSync(pkg), maxBuffer: 1 << 30 });
  writeFileSync(join(tmp, '.done'), '');
}
const byPath = new Map();
for (const d of readdirSync(tmp)) {
  const p = join(tmp, d, 'pathname');
  if (existsSync(p)) byPath.set(readFileSync(p, 'utf8').split('\n')[0].trim(), join(tmp, d, 'asset'));
}
const { plants } = JSON.parse(readFileSync('src/archgen/plants.json', 'utf8'));
const CLS = [1008, 1896];
const verts = [];
const heads = [];
for (const pl of plants) {
  const f = byPath.get(`Assets/Synty/PolygonNature/Models/${pl.name}.fbx`);
  if (!f) throw new Error(`synty: no ${pl.name}`);
  const m = fbxMeshes(parseFbx(readFileSync(f)));
  const first = verts.length / 8;
  // y up, centimetres → z up, metres: (x, y, z) → (x, −z, y); uv's v flipped (the image's top row first)
  for (const t of m.tris) for (const c of t.c) verts.push(c.p[0] / 100, -c.p[2] / 100, c.p[1] / 100, c.n[0], -c.n[2], c.n[1], c.uv[0], 1 - c.uv[1]);
  const count = verts.length / 8 - first;
  if (count > CLS[pl.cls]) throw new Error(`synty: ${pl.name} has ${count} vertices, class ${pl.cls} holds ${CLS[pl.cls]}`);
  heads.push(first, count, 0, 0);
  console.log(pl.name.padEnd(26), count);
}
const head = new Uint32Array([0x544e4c50, plants.length, 0, 0, ...heads]);
const body = new Float32Array(verts);
const buf = Buffer.concat([Buffer.from(head.buffer), Buffer.from(body.buffer)]);
writeFileSync(join(out, 'plants.bin'), buf);
const pal = byPath.get('Assets/Synty/PolygonNature/Textures/PolygonNature_01.png');
copyFileSync(pal, join(out, 'palette.png'));
console.log(`${plants.length} plants, ${verts.length / 8} vertices, ${(buf.length / 1024).toFixed(0)} KB → ${out}`);
