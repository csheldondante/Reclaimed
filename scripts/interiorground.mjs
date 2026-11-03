// (interiors) What fills a building's footprint in the world: at each tile of the town hall the terrain's top (the world
// API's heightAt) against the building's floors and roof, and the external registry's losses — with ?interior=0 (the
// game as places has it: no interior) or =1. Says whether ground stands inside the building (dug into a hill and not
// cut out) or the building's claim came loose (rubble).
//   node scripts/interiorground.mjs [--town 1] [--interior 0]
import { run } from './lib/runner.mjs';

await run({ name: 'interiorground', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const town = R.opt('town', '1');
  const interior = R.opt('interior', '0');
  const p = await R.level({ level: 'atlas', town, interior: '1', enter: '-1', tod: '0.38', day: '100000' });
  await p.waitForFunction(() => !!window.reclaimed.interior?.active, { timeout: 120000, polling: 250 });
  if (interior === '0') await p.evaluate(() => (window.reclaimed.interior.active.draw.on = false));
  for (const t of [5, 40]) {
    await R.simSeconds(p, t === 5 ? 5 : 35);
    const r = await p.evaluate(() => {
      const it = window.reclaimed.interior.active;
      const api = window.reclaimed;
      const ext = api.integrity?.()?.external;
      const view = api.settlementsView();
      const tiles = [];
      for (const st of it.plan.storeys)
        for (const q of st.tiles) {
          if (tiles.some((x) => x.q === q)) continue;
          const c = it.plan.corners.get(q);
          const m = [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4];
          const storeys = it.plan.storeys.filter((s) => s.tiles.includes(q)).length;
          const mats = it.plan.storeys.filter((s) => s.tiles.includes(q)).map((s) => {
            const w = it.toWindow(m, s.z + 1.4);
            return api.worldApi().terrain?.materialAt(w[0], w[1], w[2]) ?? '?';
          });
          const w0 = it.toWindow(m, it.plan.base);
          tiles.push({ q, storeys, floor0: +w0[2].toFixed(2), top: +(api.worldApi().terrain?.heightAt(w0[0], w0[1]) ?? NaN).toFixed(2), mats: mats.join('/') });
        }
      return { tiles, ext: ext ? { ...ext.stats } : null, view: { ...view.stats } };
    });
    R.log(`t+${t}s (interior draw ${interior === '0' ? 'off' : 'on'}): registry ${JSON.stringify(r.ext)}; view ${JSON.stringify(r.view)}`);
    for (const x of r.tiles) R.log(`  tile ${x.q}: storeys ${x.storeys}, floor ${x.floor0} (window z), the open sky's floor ${x.top}; what's at each storey's middle: ${x.mats}`);
  }
});
