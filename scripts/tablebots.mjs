// (card-table) The bots' table: node scripts/tablebots.mjs [--seeds 3] [--seasons 16]
// Runs test/unit/table-bots.test.ts alone in Node (no browser) and prints its report.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const file = path.join(os.tmpdir(), `tablebots-${process.pid}.txt`);
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const r = spawnSync('npx', ['vitest', 'run', '--project', 'unit', 'test/unit/table-bots.test.ts'], { shell: true, encoding: 'utf8', env: { ...process.env, TABLE_OUT: file, TABLE_SEEDS: arg('seeds', '1'), TABLE_SEASONS: arg('seasons', '16') } });
if (fs.existsSync(file)) {
  console.log(fs.readFileSync(file, 'utf8'));
  fs.rmSync(file);
} else console.log(r.stdout + r.stderr);
process.exit(r.status ?? 1);
