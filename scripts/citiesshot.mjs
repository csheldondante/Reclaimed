// Cities (round 120, `cities`; BACKLOG STR30-STR36): the atlas level started at the settlement of each purpose nearest
// the start (?town=<id>), every system in play as deployed, shot by day and at night (the lights' pools), near and
// closer, to C:/Projects/shots88/cities/. Checks each town planned with its purpose, drawn, its lights and (a port's)
// its moored ships; the sailing ships drawn where they're near.
//   node scripts/citiesshot.mjs [--purposes port,mining,lumber,trading,farming,hold] [--size 412x915 --dpr 2.6] [--out c]
// Behaviour kind (shares the GPU).
import fs from 'node:fs';
import path from 'node:path';
import { run } from './lib/runner.mjs';

const OUT = 'C:/Projects/shots88/cities';
fs.mkdirSync(OUT, { recursive: true });

await run({ name: 'citiesshot', kind: 'behaviour', size: '1280x800' }, async (R) => {
  const purposes = R.opt('purposes', 'port,mining,lumber,trading,farming,hold').split(',');
  const out = R.opt('out', 'c');
  // the ids by purpose, nearest the start: from a first page (the records are the atlas's)
  const p0 = await R.level({ level: 'atlas' });
  const ids = await p0.evaluate((ps) => {
    const st = window.reclaimed.settlements;
    const at = window.reclaimed.camera.target;
    const w = st.toWorld([at[0], at[1]]);
    const o = {};
    for (const k of ps) o[k] = st.near(w, 1e9).find((x) => x.purpose?.kind === k && x.size !== 'camp')?.id ?? null;
    return o;
  }, purposes);
  await p0.close();
  R.log(`settlements by purpose: ${JSON.stringify(ids)}`);
  for (const k of purposes) {
    const id = ids[k];
    if (!id) {
      R.log(`no ${k} in this world`);
      continue;
    }
    const p = await R.level({ level: 'atlas', town: id, tod: '0.45', day: '100000' });
    await R.simSeconds(p, 15);
    const s = await p.evaluate((sid) => {
      const v = window.reclaimed.settlementsView();
      const plan = window.reclaimed.settlements.plan(sid);
      const rec = window.reclaimed.settlements.settlement(sid);
      const ships = window.reclaimed.shipsView?.();
      return {
        purpose: rec?.purpose?.kind,
        story: rec?.story?.events.map((e) => e.what).join('+'),
        people: rec?.people.map((x) => `${x.role} ${x.count}`).join(', '),
        view: v ? { ...v.stats } : null,
        plan: plan ? { ...plan.city.stats, works: !!plan.city.works } : null,
        ships: ships ? { ...ships.stats } : null,
      };
    }, id);
    R.check(`${k} ${id}: planned for its purpose and drawn`, s.purpose === k && !!s.view && s.view.pieces > 50 && !!s.plan, s);
    R.check(`${k} ${id}: its lights`, (s.plan?.lights ?? 0) > 0, s.plan && { lights: s.plan.lights, props: s.plan.props });
    if (k === 'port') R.check(`port ${id}: its piers and moored ships`, (s.plan?.piers ?? 0) > 0 && (s.plan?.berths ?? 0) > 0, s.plan);
    await p.screenshot({ path: path.join(OUT, `${out}-${k}-day.png`) });
    await p.evaluate(() => (window.reclaimed.camera.zoom *= 2.5));
    await R.sleep(2500);
    await p.screenshot({ path: path.join(OUT, `${out}-${k}-day-near.png`) });
    await p.evaluate(() => (window.reclaimed.core.dayNight.timeOfDay = 0.97));
    await R.simSeconds(p, 2);
    await R.sleep(1500);
    await p.screenshot({ path: path.join(OUT, `${out}-${k}-night-near.png`) });
    await p.evaluate(() => (window.reclaimed.camera.zoom /= 2.5));
    await R.sleep(2500);
    await p.screenshot({ path: path.join(OUT, `${out}-${k}-night.png`) });
    await p.close();
  }
});
