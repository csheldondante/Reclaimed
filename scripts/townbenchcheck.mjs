// (round 128h) The town pan phone bench (?townbench=1, src/perf/townbench.ts) run headless at the phone's size, as the
// user runs it on the phone: every row must slide the window (slides > 0) and write grid rows (gridWrites > 0) â€” the
// Pixel 9a's report had 0 of both on every row, so the bench never tested the slide path.
//   node scripts/townbenchcheck.mjs [--zooms 2.6,1.3] [--secs 6]
import { run } from './lib/runner.mjs';

await run({ name: 'townbenchcheck', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const zooms = R.opt('zooms', '');
  const secs = R.opt('secs', '6');
  // (--speed 1 --expect-fail: a pan too slow to slide the window — the report must fail loudly)
  const speed = R.opt('speed', '');
  const expectFail = R.opt('expect-fail', '') !== '';
  const extra = { tutorial: '0', townbench: '1', benchsecs: secs };
  if (zooms) extra.benchzooms = zooms;
  if (speed) extra.benchspeed = speed;
  const p = await R.level({ level: 'atlas', town: '1', ...extra });
  await p.waitForFunction(() => window.townBenchReport || document.querySelector('.fatal'), { timeout: 600000, polling: 1000 });
  await R.fatal(p);
  const rep = JSON.parse(await p.evaluate(() => window.townBenchReport));
  for (const r of rep.rows) console.log(JSON.stringify({ zoom: r.zoom, slides: r.slides, gridWrites: r.gridWrites, uploads: r.uploads, pops: r.pops, onScreen: r.townOnScreen, legs: r.legs, travel: r.travel, busy: r.busy, settleMs: r.settleMs, p95: r.frameMs?.p95, fail: r.fail }));
  console.log('ok', rep.ok, 'failures', JSON.stringify(rep.failures ?? null));
  console.log('panel', JSON.stringify(await p.evaluate(() => document.getElementById('bench-panel')?.innerText.slice(0, 600))));
  if (expectFail) {
    const red = await p.evaluate(() => [...document.querySelectorAll('#bench-panel div')].filter((d) => d.style.color && /^FAILED/.test(d.textContent)).map((d) => d.textContent));
    R.check('a row with no slides fails loudly: red in the panel, ok false and the reason in the JSON', !rep.ok && rep.failures.some((f) => /no slides/.test(f)) && red.some((t) => /no slides/.test(t)), JSON.stringify({ ok: rep.ok, failures: rep.failures, red }));
    return;
  }
  for (const r of rep.rows) {
    R.check(`zoom ${r.zoom}: the window slid`, r.slides > 0, `${r.slides} slides`);
    R.check(`zoom ${r.zoom}: the slides wrote grid rows`, r.gridWrites > 0, `${r.gridWrites} grid rows`);
    R.check(`zoom ${r.zoom}: the town stayed on screen`, r.townOnScreen >= 0.9, `${r.townOnScreen}`);
  }
});
