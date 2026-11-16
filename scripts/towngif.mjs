// phone-idle: the start town alive — a short GIF of the atlas town close up (people walking, wagons, the river), its
// first and last frames as PNGs, and how many pixels moved between frames. The check after a change to what the town
// encodes at rest: nothing frozen.
//   node scripts/towngif.mjs [--out perf-reports/town] [--zoom 7] [--frames 24] [--every 250] [--season]
//   --season  a houses card started and Next season pressed first: the time-lapse building
import fs from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, ROOT } from './lib/runner.mjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'towngif', kind: 'behaviour' }, async (R) => {
  const out = path.resolve(ROOT, R.opt('out', 'perf-reports/town'));
  const p = await R.level({ level: 'atlas', town: 1, fresh: 1 });
  // FIXED-CITY (BACKLOG PI-20): the run's start town.
  await p.waitForFunction(() => window.season?.town != null, { timeout: 240000, polling: 250 });
  // (the first frames' stall on this desktop — BACKLOG PI-9 — may have put the watchdog's overlay up: taken down, as
  // scripts/census.mjs does; any other fatal fails)
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal && /the GPU never finished/.test(fatal)) await p.evaluate(() => document.querySelector('.fatal')?.remove());
  else await R.fatal(p);
  await R.sleep(Number(R.opt('settle', 20)) * 1000);
  if (R.flag('season')) {
    const ok = await p.evaluate(() => {
      const S = window.season;
      S.grant({ labor: 10, might: 4, materials: 20, magic: 4, intel: 4 });
      let i = S.hand.findIndex((o, k) => o.card.id === 'houses' && !S.started.has(k));
      if (i < 0) i = S.offer('houses');
      if (!S.canStart(i).ok) return false;
      S.start(i);
      void S.next();
      return true;
    });
    R.check('a houses card started, Next season pressed', ok);
    await R.sleep(1500);
  }
  // (close up, the card sheet out of the way: the map alone)
  await p.evaluate((zoom) => {
    document.getElementById('ui').style.visibility = 'hidden';
    if (zoom > 0) window.reclaimed.camera.zoom = zoom;
  }, Number(R.opt('zoom', R.flag('season') ? 0 : 7)));
  await R.sleep(1500);
  const n = Number(R.opt('frames', 24));
  const every = Number(R.opt('every', 250));
  const enc = GIFEncoder();
  let prev = null;
  let first = null;
  const moved = [];
  for (let k = 0; k < n; k++) {
    const buf = Buffer.from(await p.screenshot({ type: 'png' }));
    const png = PNG.sync.read(buf);
    if (k === 0) {
      first = png;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(`${out}-first.png`, buf);
    }
    if (k === n - 1) fs.writeFileSync(`${out}-last.png`, buf);
    if (prev) {
      let d = 0;
      for (let i = 0; i < png.data.length; i += 4) if (Math.abs(png.data[i] - prev.data[i]) + Math.abs(png.data[i + 1] - prev.data[i + 1]) + Math.abs(png.data[i + 2] - prev.data[i + 2]) > 40) d++;
      moved.push(d);
    }
    prev = png;
    const pal = quantize(png.data, 256);
    enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
    await R.sleep(every);
  }
  enc.finish();
  fs.writeFileSync(`${out}.gif`, enc.bytes());
  let total = 0;
  for (let i = 0; i < prev.data.length; i += 4) if (Math.abs(prev.data[i] - first.data[i]) + Math.abs(prev.data[i + 1] - first.data[i + 1]) + Math.abs(prev.data[i + 2] - first.data[i + 2]) > 40) total++;
  const live = await p.evaluate(async () => {
    const lt = window.living;
    const l = lt ? [...lt.live.values()][0] : null;
    const head = l?.living?.counters ? await l.living.counters() : null;
    return { towns: lt ? lt.live.size : 0, head: head ? Array.from(head.slice(0, 48)) : null };
  });
  R.log(`pixels moved between frames (of ${prev.width * prev.height}): min ${Math.min(...moved)}, median ${[...moved].sort((a, b) => a - b)[moved.length >> 1]}, max ${Math.max(...moved)}; first to last ${total}`);
  R.log(`living towns ${live.towns}; state head ${JSON.stringify(live.head)}`);
  R.check('something moves in every frame (people, water): nothing frozen', Math.min(...moved) > 20, { moved });
  R.log(`saved ${out}.gif, ${out}-first.png, ${out}-last.png`);
});
