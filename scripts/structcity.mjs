// The structures track's city on real terrain (BACKLOG STR9): the atlas level with ?city=<system>, every system in play
// as the deployed page runs. Checks the city planned, drawn and claimed (External columns), the sim running, no fatal;
// screenshots to C:/Projects/shots88/structures/.
//   node scripts/structcity.mjs [--city irregular] [--extra "cstyle=bastion&cr=60"] [--out city] [--size 412x915 --dpr 2.6]
import fs from 'node:fs';
import path from 'node:path';
import { run } from './lib/runner.mjs';

const OUT = 'C:/Projects/shots88/structures';
fs.mkdirSync(OUT, { recursive: true });

await run({ name: 'structcity', kind: 'behaviour', size: '1280x800' }, async (R) => {
  const city = R.opt('city', 'irregular');
  const extra = Object.fromEntries(new URLSearchParams(R.opt('extra', '')));
  const out = R.opt('out', `city-${city}`);
  const p = await R.level({ level: 'atlas', city, ...extra });
  // (the first load after a build: the land comes in over a while)
  await R.simSeconds(p, 20);
  const s = await p.evaluate(() => {
    const c = window.reclaimed.city();
    return c ? { ...c.stats, live: window.reclaimed.integrity()?.external?.stats ?? null, spec: c.spec } : null;
  });
  R.check('the city is there', !!s && s.pieces > 100, s);
  R.check('its buildings hold their columns (External)', !!s && s.claimed > 0, s && { claimed: s.claimed, columns: s.columns });
  await p.screenshot({ path: path.join(OUT, `${out}-0.png`) });
  // closer and turned: the camera's zoom (the level's camera API), then again from the other side
  // (zoom: screen pixels per cell — up is closer)
  await p.evaluate(() => (window.reclaimed.camera.zoom *= 3));
  await R.sleep(2500);
  await p.screenshot({ path: path.join(OUT, `${out}-1.png`) });
  await p.evaluate(() => (window.reclaimed.camera.zoom *= 2));
  await R.sleep(2500);
  await p.screenshot({ path: path.join(OUT, `${out}-2.png`) });
  R.log(`shots: ${OUT}/${out}-0.png, -1.png, -2.png`);
});
