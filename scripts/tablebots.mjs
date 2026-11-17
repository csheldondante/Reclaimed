// (card-table) The bots' table: node scripts/tablebots.mjs [--seeds 3] [--seasons 16] [--pack a.json,b.json] [--raiders 18] [--works] [--factory] [--cpc 1] [--measure]
// (--pack takes one file or several with commas: they are loaded together)
// (draft 10: --works turns the base game's works on and adds the solver and greedy turn players; --measure searches
// every season of every run as a whole turn — docs/design/TURN_PUZZLE.md)
// (draft 11: --factory plays the factory game — docs/design/FACTORY.md; --cpc sets the clicks a posted crew a season)
// Runs test/unit/table-bots.test.ts alone in Node (no browser) and prints its report.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const file = path.join(os.tmpdir(), `tablebots-${process.pid}.txt`);
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const env = { ...process.env, TABLE_OUT: file, TABLE_SEEDS: arg('seeds', '1'), TABLE_SEASONS: arg('seasons', '16') };
if (arg('pack', '')) env.TABLE_PACK = arg('pack', '');
if (arg('raiders', '')) env.TABLE_RAIDERS = arg('raiders', '');
if (flag('works')) env.TABLE_WORKS = '1';
if (flag('factory')) env.TABLE_FACTORY = '1';
if (arg('cpc', '')) env.TABLE_CPC = arg('cpc', '');
if (flag('measure')) env.TABLE_MEASURE = '1';
const r = spawnSync('npx', ['vitest', 'run', '--project', 'unit', 'test/unit/table-bots.test.ts'], { shell: true, encoding: 'utf8', env });
if (fs.existsSync(file)) {
  console.log(fs.readFileSync(file, 'utf8'));
  fs.rmSync(file);
} else console.log(r.stdout + r.stderr);
process.exit(r.status ?? 1);
