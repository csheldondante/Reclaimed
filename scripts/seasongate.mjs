// (round 128r, Track A "Next season") The season's gate: scripts/lab/season.mjs on the `town` recipe twice — each
// season's showcase played, and each skipped at once — and the end states compared. Skipping must give the same world:
// the ledger, the history, the plan (every structure's levels and wear), the blocks standing and the structures flooded
// exactly; the GPU's fields by probes, within a tolerance (the sims run on while a showcase plays). Exits non-zero on a
// difference.
//   node scripts/seasongate.mjs [--seasons 3] [--out .testcache/seasongate]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const seasons = Number(opt('seasons', 3));
const out = opt('out', '.testcache/seasongate');
fs.mkdirSync(out, { recursive: true });

function run(mode) {
  const r = spawnSync(process.execPath, ['scripts/lab.mjs', 'run', 'scripts/lab/season.mjs', '--reload', '--out', path.join(out, mode), '--args', JSON.stringify({ mode, seasons, shots: mode === 'play' })], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const text = r.stdout + r.stderr;
  fs.writeFileSync(path.join(out, `${mode}.log`), text);
  if (r.status !== 0) throw new Error(`season.mjs (${mode}) failed: see ${path.join(out, `${mode}.log`)}`);
  const at = text.indexOf('result ');
  const body = text.slice(at + 7);
  // (the result's JSON object, up to its matching brace)
  let depth = 0;
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  return JSON.parse(body.slice(0, end));
}

const play = run('play');
const skip = run('skip');
const exact = ['summaries', 'flooded', 'floods', 'ledger', 'history', 'structures', 'standing'];
const diffs = [];
for (const k of exact) if (JSON.stringify(play[k]) !== JSON.stringify(skip[k])) diffs.push(`${k} differs`);
// (water depths within 0.1 of a cell; plants present or not per probe)
play.probes.water.forEach((w, i) => Math.abs(w - skip.probes.water[i]) > 0.1 && diffs.push(`water probe ${i}: ${w} played, ${skip.probes.water[i]} skipped`));
play.probes.perSeason.forEach((ws, k) => ws.forEach((w, i) => Math.abs(w - skip.probes.perSeason[k][i]) > 0.1 && diffs.push(`season ${k + 1} water probe ${i}: ${w} played, ${skip.probes.perSeason[k][i]} skipped`)));
if (!(play.probes.perSeason[0][0] > 0.3)) diffs.push(`no water stands over the flood's seed after season 1 (${play.probes.perSeason[0][0]})`);
if (JSON.stringify(play.probes.plants) !== JSON.stringify(skip.probes.plants)) diffs.push(`plants: ${play.probes.plants} played, ${skip.probes.plants} skipped`);
const report = { seasons, same: diffs.length === 0, diffs, water: play.probes.perSeason, summaries: play.summaries, worn: play.structures.filter((s) => s.wear).length, standing: play.standing.length, setupMs: [play.setupMs, skip.setupMs], rows: play.rows.map((r) => ({ phase: r.phase, iv50: r.iv50, iv95: r.iv95, gpu50: r.gpu50, resolveMs: r.resolveMs })) };
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ report, play, skip }, null, 1));
console.log(JSON.stringify(report, null, 1));
if (diffs.length) process.exit(1);
