// Cities (round 120): one settlement's view shot for a comparison — the same town, zoom and time of day on any build
// (--server: another worktree's), optionally its structures skipped (?skip=structures) or the camera on its purpose's
// works (--works: a mine's headframe, a port's piers). Prints what the plan has there.
//   node scripts/citiesprobe.mjs --town s96 [--tod 0.45] [--zoom 2.5] [--works] [--extra "&skip=structures"] --out name
import fs from 'node:fs';
import path from 'node:path';
import { run } from './lib/runner.mjs';

const OUT = 'C:/Projects/shots88/cities/probe';
fs.mkdirSync(OUT, { recursive: true });

await run({ name: 'citiesprobe', kind: 'behaviour', size: '1280x800', urlIsServer: true }, async (R) => {
  const town = R.opt('town', 's84');
  const tod = R.opt('tod', '0.45');
  const zoom = Number(R.opt('zoom', 2.5));
  const extra = Object.fromEntries(new URLSearchParams(R.opt('extra', '')));
  const p = await R.level({ level: 'atlas', town, tod, day: '100000', ...extra });
  await R.simSeconds(p, 15);
  const info = await p.evaluate((sid, works) => {
    const st = window.reclaimed.settlements;
    const plan = st?.plan?.(sid);
    const seed = st?.seeds?.find((s) => s.rec.id === sid);
    let at = null;
    if (plan?.city?.works && seed) {
      const ROW_H = Math.sqrt(3) / 2;
      const w = [plan.city.works.at[0] + seed.box.x0, plan.city.works.at[1] + seed.box.y0 * ROW_H];
      at = st.toWindow(w);
      if (works) {
        window.reclaimed.camera.target[0] = at[0];
        window.reclaimed.camera.target[1] = at[1];
      }
    }
    let quarry = null;
    if (plan?.quarry && seed) {
      const ROW_H = Math.sqrt(3) / 2;
      quarry = { kind: plan.quarry.kind, window: st.toWindow([plan.quarry.at[0] + seed.box.x0, plan.quarry.at[1] + seed.box.y0 * ROW_H]) };
      if (window.location.search.includes('probeq=1')) {
        window.reclaimed.camera.target[0] = quarry.window[0];
        window.reclaimed.camera.target[1] = quarry.window[1];
      }
    }
    return { quarry, purpose: plan ? st.settlement(sid)?.purpose?.kind : null, works: plan?.city?.works ?? null, worksWindow: at, megas: plan?.city?.megas?.map((m) => m.kind), props: plan?.city?.props?.reduce((o, x) => ((o[x.kind] = (o[x.kind] ?? 0) + 1), o), {}), linear: plan?.city?.linear?.map((f) => f.kind) };
  }, town, R.argv.includes('--works'));
  R.log(JSON.stringify(info));
  await p.evaluate((z) => (window.reclaimed.camera.zoom *= z), zoom);
  await R.sleep(3000);
  await p.screenshot({ path: path.join(OUT, `${R.opt('out', town)}.png`) });
  R.check(`shot ${town}`, true, info);
  await p.close();
});
