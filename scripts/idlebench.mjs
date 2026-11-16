// phone-idle (2026-11-15): the idle phone bench (src/perf/idlebench.ts, ?idlebench=1) run headless: that it completes,
// writes its report and shows its table. The desktop's numbers are a proxy; the phone's run is the judge.
//   node scripts/idlebench.mjs [--settle 12] [--win 1] [--only living,ind64] [--out perf-reports/idlebench.json] [--shot perf-reports/idlebench.png]
// A timing check (the GPU alone) unless --kind behaviour.
import fs from 'node:fs';
import path from 'node:path';
import { run, ROOT } from './lib/runner.mjs';

await run({ name: 'idlebench', kind: 'timing' }, async (R) => {
  const out = path.resolve(ROOT, R.opt('out', 'perf-reports/idlebench.json'));
  const params = { level: 'atlas', town: 1, fresh: 1, idlebench: 1, benchsettle: R.opt('settle', 12), benchwin: R.opt('win', 1) };
  if (R.opt('only', '')) params.benchonly = R.opt('only', '');
  const p = await R.level(params);
  R.log(`page: ${await p.evaluate(() => location.href)}`);
  const t0 = Date.now();
  await p.waitForFunction(() => window.idleBenchReport, { timeout: 8 * 60 * 1000, polling: 500 });
  const r = JSON.parse(await p.evaluate(() => window.idleBenchReport));
  const wall = (Date.now() - t0) / 1000;
  const card = await p.$eval('#bench-panel', (e) => e.innerText).catch(() => '(no panel)');
  console.log(card);
  R.check('the bench wrote its report', r.kind === 'reclaimed-idlebench' && r.rows.length > 0, { rows: r.rows.length, wallS: +wall.toFixed(0), notes: r.notes });
  R.check('the idle frame was measured', r.idle.frames > 30 && r.idle.doneMs !== null, r.idle);
  R.check('its census counted the frame', !!r.census && r.census.frames > 30 && r.census.total.renderPasses > 0, r.census ? { frames: r.census.frames, indirect: r.census.total.indirect, modelMs: r.modelMs } : null);
  R.check('every toggle measured both sides', r.rows.every((x) => x.on.frames > 5 && x.off.frames > 5), r.rows.filter((x) => !(x.on.frames > 5 && x.off.frames > 5)).map((x) => x.name));
  R.check('under three minutes after the level is ready (the phone’s budget)', wall < 180 || !!R.opt('only', ''), { wallS: +wall.toFixed(0) });
  // (the probes do what they say: counted by the census while on — checked on a short window of each)
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r, null, 1));
  R.log(`written ${out}`);
  if (R.opt('shot', '')) await p.screenshot({ path: path.resolve(ROOT, R.opt('shot', '')) });
});
