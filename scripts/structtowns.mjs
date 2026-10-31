// The settlements on the structures contract in the game (round 119, STR15): the atlas level started at a settlement of
// each size (?town=<id>), every system in play; checks the town planned, drawn (pieces) and its buildings claimed
// (External), no fatal; screenshots at the start's zoom and closer to C:/Projects/shots88/structures/.
//   node scripts/structtowns.mjs [--sizes city,town,village,hamlet] [--size 412x915 --dpr 2.6] [--out towns]
import fs from 'node:fs';
import path from 'node:path';
import { run } from './lib/runner.mjs';

const OUT = 'C:/Projects/shots88/structures';
fs.mkdirSync(OUT, { recursive: true });

await run({ name: 'structtowns', kind: 'behaviour', size: '1280x800' }, async (R) => {
  const sizes = R.opt('sizes', 'city,town,village,hamlet').split(',');
  const out = R.opt('out', 'towns');
  // the ids by size: from a first page (the records are the atlas's, the same every page)
  const p0 = await R.level({ level: 'atlas', town: '1' });
  const ids = await p0.evaluate((sz) => {
    const st = window.reclaimed.settlements;
    const at = window.reclaimed.camera.target;
    const w = st.toWorld([at[0], at[1]]);
    const o = {};
    for (const s of sz) o[s] = st.near(w, 1e9).find((x) => x.size === s)?.id ?? null;
    return o;
  }, sizes);
  await p0.close();
  R.log(`settlements by size: ${JSON.stringify(ids)}`);
  for (const size of sizes) {
    const id = ids[size];
    if (!id) {
      R.log(`no ${size} in this world`);
      continue;
    }
    const p = await R.level({ level: 'atlas', town: id });
    await R.simSeconds(p, 20);
    const s = await p.evaluate((sid) => {
      const v = window.reclaimed.settlementsView();
      const plan = window.reclaimed.settlements.plan(sid);
      const kinds = {};
      for (const b of plan?.city.buildings ?? []) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
      return { view: v ? { ...v.stats } : null, kinds, fields: plan?.city.tiles.use.filter((u) => u === 'field').length ?? 0, records: plan?.rec.buildings.length ?? 0 };
    }, id);
    R.check(`${size} ${id}: planned and drawn`, !!s.view && s.view.pieces > 50 && Object.keys(s.kinds).length > 0, s);
    R.check(`${size} ${id}: its buildings hold columns`, !!s.view && s.view.claimed > 0, s.view && { claimed: s.view.claimed, columns: s.view.columns });
    await p.screenshot({ path: path.join(OUT, `${out}-${size}-0.png`) });
    await p.evaluate(() => (window.reclaimed.camera.zoom *= 3));
    await R.sleep(2500);
    await p.screenshot({ path: path.join(OUT, `${out}-${size}-1.png`) });
    await p.close();
  }
});
