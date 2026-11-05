// docs/MODULES.md, generated: every source file under src/ (tests left out), grouped by folder, with its line count,
// the first sentence of its header comment and its first exports. Folder notes and the guide at the top are kept here.
// (2026-11-04, the monolith split: agents read the map instead of opening files.)
//   node scripts/modules-map.mjs > docs/MODULES.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

/** the split classes: class file, its folder, what's where (listed when the folder exists) */
const SPLIT = [
  ['scenes/level.ts', 'scenes/level', 'LevelScene: `attach.ts` wires a level once (attach-tools, input-wiring, test-api, stream-setup); `frame.ts` is a frame of play; the tools, runs, fortress, valley, atlas controls, camera moves and labs beside them.'],
  ['scenes/streamer.ts', 'scenes/streamer', 'Streamer: `slide.ts` (follow the camera, the slide), `freeze.ts`, `generate.ts`, `write.ts`, `store.ts`, `jobs.ts`, `warp.ts`, `regions.ts`; `defs.ts` its flags, records and public types.'],
  ['game/integrity.ts', 'game/integrity', 'Integrity: `tick.ts` (update and the analysis pass), `rigid.ts`, `metal.ts`, `resting.ts`, `columns.ts`, `loose.ts`, `lattice.ts`, `window.ts`; `defs.ts`.'],
  ['render/renderer.ts', 'render/renderer', 'Renderer: `encode.ts` (a frame\'s draw), `mesh-draws.ts` (the field mesh\'s pipelines, made by the constructor), `gbuffer-shadow.ts`, `terrain-cache.ts`, `grid.ts`, `features.ts`; `defs.ts`.'],
  ['perf/bench.ts', 'perf/bench', 'The bench (?bench=1): bench.ts keeps the flow of a run, the heartbeat and the state of the Bench class; `pages.ts`, `pace.ts`, `ab.ts`, `sweeps.ts`, `regions.ts` its work; `defs`, `timestamps`, `pan-report`, `state`, `page`, `device`, `report` the free functions.'],
  ['atlas/atlas.ts', 'atlas/atlas', 'Atlas: the class keeps its state, build and small reads; `build.ts` (run: the GPU passes), `regions.ts`, `columns.ts`, `region-land.ts`, `window.ts`; `params.ts`, `tile-pacer.ts`, `defs.ts` re-exported by atlas.ts.'],
];

/** a line or two for a folder, ahead of its files */
const NOTES = {
  '.': 'Boot: WebGPU, the quality tier, the phone flags, and which scene runs.',
  agents: 'GPU agents (the crowd every unit and worker runs on): their kernels\' wrappers, jobs, build crews. Installed on a WorldCore by `install.ts`.',
  api: 'The engine\'s public APIs over a live world (the Sim facade `world.ts`, terrain, atlas map, cutaway, puck); game layers use these, not system internals.',
  'api/contracts': 'Interface contracts between tracks (world state, structures, settlement, flora, units ...): types only, no behaviour.',
  atlas: 'The atlas: the whole generated world map (coarse sim, GPU finish, far land, geysers), from which the streamed window\'s land comes.',
  fortress: 'Fortress mode: the fortress, its economy, pieces, claims, life (workers) and its UI bar; started on a level by scenes/level/fortress.ts.',
  game: 'Game rules over the world: powers, Nature, progress, levels, and Integrity (structures that break and fall).',
  'game/integrity': 'Integrity\'s internals, split out of game/integrity.ts: free functions over the Integrity instance (`ig`). Only integrity.ts and these modules call them.',
  gpu: 'WebGPU plumbing: device, pipelines and bind-group layouts, CPU timing stats.',
  physics: 'The physics voxels (one GPU solver), wake, shapes and meshes.',
  'perf/bench': 'The parts of the bench, split out of perf/bench.ts: the methods of the Bench class as functions over it (`bn`) and its top-level helpers by concern.',
  render: 'Drawing: the camera, the renderer (render-prep, the draw passes, shadows), the field mesh, tiles, the turn and the pick.',
  'render/renderer': 'The Renderer\'s internals, split out of render/renderer.ts: free functions over the renderer (`rd`). The constructor still builds most pipelines; `mesh-draws.ts` builds the field mesh\'s.',
  scenes: 'Scenes and the live world: WorldCore (one live world), the level and the menu, the streamer (the sliding window), the planner, the region pool and copier.',
  'scenes/level': 'LevelScene\'s internals, split out of scenes/level.ts: free functions over the scene (`scene`). Only level.ts and these modules call them.',
  'scenes/streamer': 'The Streamer\'s internals, split out of scenes/streamer.ts: free functions over the streamer (`S`). Its public API stays on the class.',
  settle: 'Settlements: towns and cities on the atlas, their plans, the view that draws them, ships.',
  shaders: 'WGSL. `common.wgsl` (+ layers, materials) is prepended to every kernel; flow/slope appended to kernels that declare them.',
  sim: 'GPU world buffers (the WorldGpu contracts), the systems\' wrappers, the fixed-step scheduler, Globals, particles, sleep, snapshots, static claims.',
  story: 'Stories: dialog play, hero runs, the atlas run.',
  ui: 'DOM UI: HUD, editor, panels, compass, bug report, perf overlay.',
  weather: 'Storms, day and night, the rivers\' wetness.',
  world: 'CPU world data: map generation, the column layout (chunks, intervals), materials, lattice, models, region records and store.',
};

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.(ts|wgsl)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) files.push(f);
  }
};
walk(SRC);

function headerOf(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const out = [];
  if (/^\s*\/\*/.test(lines[i] ?? '')) {
    for (; i < lines.length; i++) {
      out.push(lines[i].replace(/^\s*\/\*\*?|\*\/\s*$|^\s*\*\s?/g, ''));
      if (/\*\//.test(lines[i])) break;
    }
  } else for (; i < lines.length && /^\s*\/\//.test(lines[i]); i++) out.push(lines[i].replace(/^\s*\/\/\s?/, ''));
  let t = out.join(' ').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,}?[.;])(\s|$)/);
  if (m) t = m[1];
  if (t.length > 110) t = t.slice(0, 107).replace(/\s+\S*$/, '') + ' …';
  return t;
}
function exportsOf(text) {
  const names = [];
  for (const m of text.matchAll(/^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function\*?|const|let|interface|type|enum)\s+([\w$]+)/gm)) names.push(m[1]);
  for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm))
    for (const n of m[1].split(',')) {
      const k = n.trim().split(/\s+as\s+/).pop();
      if (k) names.push(k);
    }
  return [...new Set(names)];
}

const byDir = new Map();
for (const f of files) {
  const rel = path.relative(SRC, f).split(path.sep).join('/');
  const dir = path.posix.dirname(rel);
  if (!byDir.has(dir)) byDir.set(dir, []);
  byDir.get(dir).push(rel);
}

const out = [];
out.push('# Modules — a map of src/', '');
out.push('Read this instead of opening files to find where something lives: every source file under `src/` (tests left out),');
out.push('grouped by folder, with its line count, the first sentence of its header comment, and its first exports (`+N`');
out.push('more). Generated: `node scripts/modules-map.mjs > docs/MODULES.md` — rerun it when files are added, split or renamed.', '');
const split = SPLIT.filter(([, dir]) => fs.existsSync(path.join(SRC, dir)));
if (split.length) {
  out.push('**The split classes** (docs/ARCHITECTURE.md "Source layout"): the class file keeps the state, the lifecycle and the');
  out.push('public API; the folder beside it holds what the class does, as free functions over the instance — its internals,');
  out.push('called only by the class file and the folder. From outside, use the class.', '');
  for (const [file, dir, what] of split) out.push(`- \`${file}\` + \`${dir}/\` — ${what}`);
  out.push('');
}
for (const [dir, list] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(`## ${dir === '.' ? 'src/' : `src/${dir}/`}`, '');
  if (NOTES[dir]) out.push(NOTES[dir], '');
  for (const rel of list) {
    const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
    const n = text.split('\n').length;
    const h = headerOf(text) || '(no header comment)';
    const ex = rel.endsWith('.ts') ? exportsOf(text) : [];
    const shown = ex.slice(0, 4).map((e) => `\`${e}\``).join(', ') + (ex.length > 4 ? ` +${ex.length - 4}` : '');
    out.push(`- \`${path.posix.basename(rel)}\` (${n}) — ${h}${shown ? ` API: ${shown}.` : ''}`);
  }
  out.push('');
}
process.stdout.write(out.join('\n'));
