// The engine's dispatch counts a tick, by scene (physics10-one, PO9): the playground under ?solver=engine, a station's
// button pressed, then `Engine.counts` (direct and indirect dispatches of the last tick encoded) sampled every 50 ms
// for some seconds: each distinct count with how often it was seen, and the count once everything is asleep.
// Reads: none of the GPU (the counts are the host's own tally of what it encoded).
//   node scripts/enginecounts.mjs [--seconds 8]
import { run, sleep } from './lib/runner.mjs';

const SCENES = [
  ['pile', 'drop a stack'],
  ['pile', 'pour rubble into the pit'],
  ['pile', 'the chain (A onto B onto C)'],
  ['break', 'stone from three heights'],
  ['break', 'brick wall pushed over'],
  ['slide', 'undercut the mesa'],
];

await run({ name: 'enginecounts', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const i = R.argv.indexOf('--seconds');
  const seconds = i >= 0 ? Number(R.argv[i + 1]) : 8;
  const page = await R.page();
  await page.goto(R.url + '/?skipmenu=1&level=playground&tutorial=0&q=low&fresh=1&solver=engine', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await sleep(5000);
  for (const [station, press] of SCENES) {
    await page.evaluate(
      (station, press) => {
        const s = window.reclaimed.scene;
        s.stationsBar.pick(s.level.stations.findIndex((x) => x.id === station));
        const reset = [...document.querySelectorAll('.stations button')].find((x) => x.textContent.includes('reset'));
        reset?.click();
        const b = [...document.querySelectorAll('.stations button')].find((x) => x.textContent === press);
        if (!b) throw new Error('no station button "' + press + '"');
        b.click();
      },
      station,
      press,
    );
    const seen = new Map();
    for (let t = 0; t < seconds * 20; t++) {
      const c = await page.evaluate(() => {
        const e = window.reclaimed.scene.engine.engine;
        return e.counts.direct + ' direct + ' + e.counts.indirect + ' indirect';
      });
      seen.set(c, (seen.get(c) ?? 0) + 1);
      await sleep(50);
    }
    await sleep(6000);
    const end = await page.evaluate(() => {
      const e = window.reclaimed.scene.engine.engine;
      return { counts: e.counts.direct + ' direct + ' + e.counts.indirect + ' indirect', awake: e.awakeSeen, rows: e.rows };
    });
    const list = [...seen].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join('; ');
    R.log(`${station} / ${press}: ${list} | at the end: ${end.counts}, ${end.awake} awake of ${end.rows} rows`);
    await R.fatal(page);
  }
});
