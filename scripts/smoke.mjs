// Round 117 (testkit): the smoke test — the pyramid's first browser step (docs/TESTING.md), after `npm test` passes and
// before the integration scripts. The real game, built and served as the runner does (scripts/lib/runner.mjs: the GPU
// lease, the build server, the kept Chrome and its shader cache), booted once a level, each from the warmed world saved
// for this build (sim/snapshot.ts: the warmup run and saved the first time, put back after — the level's own boot
// otherwise): it loads (boot mark 'level-ready'), no fatal overlay, no page error or console error, its sim runs
// (a second of ticks, every system as the deployed page runs it, 1x). A first failure finder, not a judge of looks or
// frame time: those are the integration tier's (tilegate.mjs, driveprofile.mjs).
//
//   node scripts/smoke.mjs                        atlas: the deployed game, every system (~35 s once the GPU is leased)
//   node scripts/smoke.mjs --levels atlas,playground,valley,rocklab   (~25-50 s a level more, on a shared GPU)
//   node scripts/smoke.mjs --nosnap               each level's own warmup (slower; what a first visit runs)
import { run } from './lib/runner.mjs';

const t0 = Date.now();
await run({ name: 'smoke', kind: 'behaviour', strictConsole: true }, async (R) => {
  const levels = R.opt('levels', 'atlas').split(',');
  for (const level of levels) {
    const t = Date.now();
    // (a page a level: round 117 saw the fourth level booted in one tab lose its device — BACKLOG TK7)
    const page = await R.level({ level }, { snapshot: !R.flag('nosnap') });
    await R.ticks(page, 60, 60000);
    const state = await page.evaluate(() => ({ tick: window.reclaimed?.core?.globals?.tick ?? -1, fatal: !!document.querySelector('.fatal') }));
    R.check(`${level}: loaded, no fatal, its sim running`, state.tick > 0 && !state.fatal, { ...state, s: +((Date.now() - t) / 1000).toFixed(1) });
    await page.close();
  }
  R.log(`smoke: ${levels.length} levels in ${((Date.now() - t0) / 1000).toFixed(1)} s (from start, the GPU's wait included)`);
});
