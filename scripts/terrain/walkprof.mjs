// Terrain rivers, step 2: the rivers' CPU build (terrain/walks.ts walkRivers) on a real atlas's input in Node — its
// time by part, without a browser (the input from scripts/terrain/walkdump.mjs). Bundles walks.ts with rolldown first.
//   node scripts/terrain/walkprof.mjs [--in local/terrain2/walkin] [--runs 3] [--prof]   (--prof: node --cpu-prof)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const dir = opt('in', 'local/terrain2/walkin');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walkprof-'));
const out = path.join(tmp, 'walks.mjs');
const bin = path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'rolldown.cmd' : 'rolldown');
// (--src: another walks.ts — e.g. a git show of an older one placed beside it — for before/after on the same input)
const b = spawnSync(`"${bin}"`, [opt('src', 'src/terrain/walks.ts'), '--format', 'esm', '-o', `"${out}"`], { shell: true, encoding: 'utf8' });
if (b.status !== 0) throw new Error(`rolldown: ${b.stderr || b.stdout}`);
const { walkRivers } = await import(pathToFileURL(out).href);
const meta = JSON.parse(fs.readFileSync(`${dir}/meta.json`, 'utf8'));
const rd = (f, T) => {
  const buf = fs.readFileSync(`${dir}/${f}`);
  return new T(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};
const inp = { ...meta, G: rd('G.f32', Float32Array), coast: rd('coast.f32', Float32Array), water: rd('water.u8', Uint8Array), tier: rd('tier.u8', Uint8Array), landform: rd('landform.i32', Int32Array) };
const runs = Number(opt('runs', '3'));
for (let r = 0; r < runs; r++) {
  const t = performance.now();
  const rv = walkRivers(inp);
  const ms = performance.now() - t;
  const fnv = (a) => {
    const by = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    let h = 0x811c9dc5;
    for (let i = 0; i < by.length; i++) h = Math.imul(h ^ by[i], 0x01000193) >>> 0;
    return h.toString(16);
  };
  console.log(JSON.stringify({ run: r, ms: Math.round(ms), nodes: rv.count, lava: rv.lava, hash: fnv(rv.nodes), stats: rv.stats }));
}
fs.rmSync(tmp, { recursive: true, force: true });
