// (round 114, `worldstore`) What a region is made of, as source files: the land generator's version is a hash of them
// (vite.config.ts → __GEN_HASH__ → world/region-record.ts genVersion). A saved region made by any other generator is
// never loaded: it's dropped and the region made again from the seed. No hand-bumped number to forget (round 100's
// GEN_VERSION stayed 1 through lava, bedrock depth, caves, rivers, meteors…: old records loaded beside new land).
//
// The files: the value imports reachable from the generator's entries (the atlas — its kernels, rivers, ways, stamps,
// finish —, streamgen's noise land, and the two stamp hooks: the settlements and a run's stage), each read with its
// `?raw` WGSL and JSON data. The walk stops at BOUNDARY: the engine's plumbing and the simulation (the GPU wrappers,
// the sims, the tuning panel, the weather, the GM's prose, the units), which a region's generation calls into but
// whose content doesn't decide what land is made. Type-only imports are erased and don't count. Render and UI files
// aren't reachable, so they never invalidate a save.
//
//   node scripts/lib/gen-sources.mjs          // the files and the hash
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const GEN_ENTRIES = ['src/atlas/atlas.ts', 'src/world/streamgen.ts', 'src/settle/settlements.ts', 'src/story/stage-land.ts'];
export const GEN_BOUNDARY = ['src/gpu/', 'src/sim/', 'src/tune/', 'src/weather/', 'src/grids/', 'src/gm/', 'src/units/', 'src/render/', 'src/ui/', 'src/scenes/'];

// value imports only: `import type` / `export type` lines are erased by the compiler
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;

function resolve(from, spec) {
  if (!spec.startsWith('.')) return null;
  const p = path.resolve(path.dirname(from), spec.replace(/\?raw$/, ''));
  for (const c of [p, `${p}.ts`]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  throw new Error(`gen-sources: ${path.relative(process.cwd(), from)} imports ${spec}, not found`);
}

/** the generator's files, repo-relative with forward slashes, sorted */
export function genSources(root) {
  const seen = new Set();
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  const visit = (f, entry) => {
    const r = rel(f);
    if (seen.has(r)) return;
    if (!entry && GEN_BOUNDARY.some((b) => r.startsWith(b))) return;
    seen.add(r);
    if (!f.endsWith('.ts')) return;
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(IMPORT)) {
      const to = resolve(f, m[1] || m[2]);
      if (to) visit(to, false);
    }
  };
  for (const e of GEN_ENTRIES) visit(path.resolve(root, e), true);
  return [...seen].sort();
}

/** the generator's version: 16 hex digits of a SHA-1 over each file's path and its text (line ends normalised: a
 *  Windows checkout and the Pages build's agree) */
export function genHash(root, files = genSources(root)) {
  const h = crypto.createHash('sha1');
  for (const f of files) h.update(f).update('\0').update(fs.readFileSync(path.resolve(root, f), 'utf8').replace(/\r\n/g, '\n')).update('\0');
  return h.digest('hex').slice(0, 16);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const files = genSources(root);
  for (const f of files) console.log(f);
  console.log(`${files.length} files, gen ${genHash(root, files)}`);
}
