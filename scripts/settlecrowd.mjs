// (round 128o, DA-A6) A generated settlement's people as the one crowd (settle/crowd.ts over town/life.ts): the atlas
// level started at the user's start town without the fortress (so the settlement in view comes to life, not pinned),
// `seconds` of play at `speed`: the people's phases, the loads moved, storeys built; a raid from its camp shelters the
// people (they go home and in) and ends. Fails unless loads moved (hauls in, or a builder's loads into a house) and no
// fatal overlay / page error.
//   node scripts/settlecrowd.mjs [--seconds 90] [--speed 8] [--town 1]
import { run, sleep } from './lib/runner.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const seconds = Number(opt('seconds', 90));
const speed = Number(opt('speed', 8));
const town = opt('town', '1');
const LINK = `?skipmenu=1&level=atlas&town=${town}&fresh=1&q=low&speed=${speed}`;

await run({ name: 'settlecrowd', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const page = await R.page();
  await page.goto(`${R.url}/${LINK}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.settlements?.life || document.querySelector('.fatal'), { timeout: 180000, polling: 500 });
  await R.fatal(page);
  const sample = () =>
    page.evaluate(() => {
      const R = window.reclaimed;
      const life = R.settlements.life;
      if (!life) return null;
      const phases = {};
      const people = life.life ? life.life.units() : life.ids.filter((id) => R.units.get(id)?.role !== 'guard');
      for (const id of people) {
        const p = life.life ? (life.life.phaseOf(id) ?? '-') : (R.units.recs.get(id)?.work?.phase ?? '-');
        phases[p] = (phases[p] ?? 0) + 1;
      }
      const stores = Object.fromEntries(Object.entries(life.rec.stores).map(([k, v]) => [k, Math.round(v.stock)]));
      return { id: life.rec.id, t: Math.round(life.t), people: people.length, guards: life.ids.length - people.length, raiders: life.raiders.length, phases, trips: life.trips, blocks: life.blocks, houses: life.houses, moved: life.moved, stores, raid: life.raid ? Math.round(life.raid.t) : null, reach: R.settlements.reachStats?.get(life.rec.id) ?? null };
    });
  const first = await sample();
  console.log('start', JSON.stringify(first));
  let last = first;
  const t0 = Date.now();
  // (until `seconds` of the settlement's own time, 5 wall minutes at most)
  while (last && last.t < seconds && (Date.now() - t0) / 1000 < 300) {
    await sleep(5000);
    await R.fatal(page);
    last = await sample();
    console.log(JSON.stringify(last));
    if (!last) break;
  }
  // (a raid: the people go home and in, then it ends)
  const raided = await page.evaluate(() => window.reclaimed.settlements.raid());
  await sleep(4000);
  const during = await sample();
  console.log('raid', raided, JSON.stringify(during?.phases));
  if (!last) R.fail('the settlement went out of play');
  else {
    const hauled = last.moved.quarried + last.moved.felled + (last.stores.grain ?? 0) - (first.stores.grain ?? 0);
    if (!(last.trips > 0 || hauled > 0)) R.fail(`nothing moved in ${seconds} sim s: ${JSON.stringify(last)}`);
    if (raided && during && !Object.keys(during.phases).every((p) => p === 'shelter' || p === 'inside')) R.fail(`not everyone went home in the raid: ${JSON.stringify(during.phases)}`);
  }
  await R.fatal(page);
});
