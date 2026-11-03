// (hallfall, INT16; a merge-gate check) No town's building falls by itself: for a few atlas towns and seeds, play 30 s
// with nothing done and count the buildings lost (settle/view.ts lost(): a building whose External claim was cut or
// found hanging free is let go to rubble). Nothing hit them, so the count must be 0. Before the fix a column the
// integrity check wrote into a sleeping chunk (the settlements' claims) was undone by the next tick's layersNext
// copy-back, and the hall of town s84 (town=1) fell within 5 s.
//   node scripts/hallcheck.mjs [--towns 1,s12] [--seeds 0] [--more 1] [--secs 30]
//     --towns  settlements to start at (1: the nearest town with a camp; else ids)
//     --seeds  atlas seeds (a.seed; 0: the default atlas)
//     --more   on each seed, this many more towns or cities (the nearest to the first after it), found in the page
import { run } from './lib/runner.mjs';

await run({ name: 'hallcheck', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const secs = Number(R.opt('secs', '30'));
  const seeds = R.opt('seeds', '0').split(',').filter(Boolean);
  const more = Number(R.opt('more', '1'));
  const towns0 = R.opt('towns', '1').split(',').filter(Boolean);
  const rows = [];
  const visit = async (seed, town) => {
    const params = { level: 'atlas', town, tod: '0.38', day: '100000' };
    if (seed !== '0') params['a.seed'] = seed;
    const p = await R.level(params);
    await R.simSeconds(p, secs);
    const r = await p.evaluate(() => {
      const api = window.reclaimed;
      const v = api.settlementsView?.();
      const ext = api.integrity?.()?.external;
      // (the towns nearest the one started at: from the settlement with the most claimed buildings shown)
      const st = v?.st;
      let home = null;
      for (const s of v?.shown?.values() ?? []) if (!home || s.claims.size > home.claims.size) home = s;
      const here = st && home ? st.near(home.seed.rec.at, 1e9).filter((x) => x.id !== home.seed.rec.id) : [];
      return {
        lost: v?.stats.lost ?? null,
        claimed: v?.stats.claimed ?? null,
        settlements: v?.stats.settlements ?? null,
        ext: ext ? { cut: ext.stats.cut, loose: ext.stats.loose, live: ext.stats.live } : null,
        others: here.filter((x) => x.size === 'town' || x.size === 'city').map((x) => x.id),
      };
    });
    await p.close();
    const row = { seed, town, ...r };
    delete row.others;
    rows.push(row);
    R.log(`seed ${seed} town ${town}: lost ${r.lost} of ${r.claimed} claimed (${r.settlements} settlements shown); registry ${JSON.stringify(r.ext)}`);
    R.check(`seed ${seed} town ${town}: no building lost in ${secs} s with nothing done`, r.lost === 0 && r.claimed > 0, row);
    return r.others;
  };
  for (const seed of seeds) {
    const seen = new Set();
    const queue = [...towns0];
    let extra = 0;
    while (queue.length) {
      const town = queue.shift();
      if (seen.has(town)) continue;
      seen.add(town);
      const others = await visit(seed, town);
      for (const o of others) {
        if (extra >= more) break;
        if (seen.has(o) || queue.includes(o)) continue;
        queue.push(o);
        extra++;
      }
    }
  }
  const lost = rows.reduce((a, r) => a + (r.lost ?? 0), 0);
  const claimed = rows.reduce((a, r) => a + (r.claimed ?? 0), 0);
  R.log(`all: ${lost} buildings lost of ${claimed} claimed over ${rows.length} towns`);
});
