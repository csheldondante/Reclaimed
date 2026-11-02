// Interiors (branch `interiors`): the atlas level at a town (?town=1: the nearest town; --town s12), every system in
// play as deployed, its hall planned inside and entered from the street (?interior=1&enter=<s>). Shots: the street,
// the walk in (a GIF), every storey inside, by day and at dusk; the plan's stats. To C:/Projects/shots88/interiors/.
//   node scripts/interiorshot.mjs [--town 1] [--tod 0.38,0.74] [--size 412x915] [--gif 1] [--out a]
import fs from 'node:fs';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const OUT = 'C:/Projects/shots88/interiors';
fs.mkdirSync(OUT, { recursive: true });

await run({ name: 'interiorshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const town = R.opt('town', '1');
  const tods = R.opt('tod', '0.38').split(',');
  const out = R.opt('out', 'a');
  const wantGif = R.opt('gif', '1') === '1';
  const extra = Object.fromEntries((R.opt('params', '') || '').split('&').filter(Boolean).map((kv) => kv.split('=')));
  for (const tod of tods) {
    const p = await R.level({ level: 'atlas', town, interior: '1', tod, day: '100000', ...extra });
    // (the land in, the town planned and shown, the hall planned)
    await p.waitForFunction(() => !!window.reclaimed.interior?.active, { timeout: 120000, polling: 250 });
    await R.simSeconds(p, 6);
    const st = await p.evaluate(() => {
      const it = window.reclaimed.interior;
      return { stats: it.stats, settlement: it.active.settlement, building: it.active.building, storeys: it.active.plan.storeys.map((s) => ({ rooms: s.rooms.map((r) => r.purpose).join('/'), props: s.props.length, spots: s.spots.length, lights: s.lights.length, stairs: s.stairs.length })) };
    });
    R.log(`tod ${tod}: ${st.settlement} b${st.building} ${JSON.stringify(st.stats)}`);
    for (const [i, s] of st.storeys.entries()) R.log(`  storey ${i}: ${JSON.stringify(s)}`);
    await p.screenshot({ path: `${OUT}/${out}-street-${tod}.png` });
    // the walk in, as a GIF (every 120 ms over 3 s)
    await p.evaluate(() => window.reclaimed.interior.enter());
    if (wantGif) {
      const frames = [];
      for (let k = 0; k < 26; k++) {
        frames.push(await p.screenshot());
        await sleep(110);
      }
      const gif = GIFEncoder();
      for (const f of frames) {
        const img = PNG.sync.read(Buffer.from(f));
        const pal = quantize(img.data, 256);
        gif.writeFrame(applyPalette(img.data, pal), img.width, img.height, { palette: pal, delay: 110 });
      }
      gif.finish();
      fs.writeFileSync(`${OUT}/${out}-enter-${tod}.gif`, gif.bytes());
    }
    await sleep(3200);
    const n = st.storeys.length;
    for (let s = 0; s < n; s++) {
      await p.evaluate((k) => window.reclaimed.interior.setStorey(k), s);
      // (time for the camera to frame it, and on the ground floor for the people to talk)
      await sleep(s === 0 ? 5000 : 1500);
      await p.screenshot({ path: `${OUT}/${out}-storey${s}-${tod}.png` });
    }
    const ps = await p.evaluate(() => window.reclaimed.interiorPeople?.stats);
    R.log(`  people: ${JSON.stringify(ps)}`);
    await p.evaluate(() => window.reclaimed.interior.setStorey(0));
    await R.fatal(p);
    await p.close();
  }
});
