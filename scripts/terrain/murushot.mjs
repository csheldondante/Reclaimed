// Terrain rivers, step 1: a still of the loop's town (Muru) — the default world before and after a change (the smoke
// check that the default world is unchanged), or with --params "a.rivers2=1" what the flag does to the streamed level.
//   node scripts/terrain/murushot.mjs --out local/terrain1/muru-base.png [--params "a.rivers2=1"] [--wait 25000]
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-muru', kind: 'behaviour', size: '1000x800' }, async (R) => {
  const extra = Object.fromEntries((R.opt('params', '') || '').split('&').filter(Boolean).map((kv) => kv.split('=')));
  const p = await R.level({ level: 'atlas', town: '1', loop: '1', fresh: '1', tod: '0.35', ...extra });
  await sleep(Number(R.opt('wait', '25000')));
  const info = await p.evaluate(() => {
    const r = window.reclaimed;
    const a = r?.atlas;
    return { origin: r?.stream ? [...r.stream.origin] : null, nodes: a?.riverStats?.nodes ?? null, walk: a?.walkStats ?? null, sites: a?.settlement?.sites?.length ?? null };
  });
  R.log(JSON.stringify(info));
  await p.evaluate(() => {
    const ui = document.getElementById('ui');
    if (ui) ui.style.visibility = 'hidden';
  });
  await p.screenshot({ path: R.opt('out', 'local/terrain1/muru.png') });
});
