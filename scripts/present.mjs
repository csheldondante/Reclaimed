// (round 124, `presentation`; BACKLOG PRE1) The region presentation prototypes, headless: each scene's variants as
// stills at one parked spot (repeatable A/B), GIFs of the scripted route riding in and out, and with --cost the frame
// cost of each treatment toggled on and off on the phone proxy (A/B/A/B windows: a tiler's passes can't be timed one
// by one — the user's rule).
//   node scripts/present.mjs --scene forest [--out C:/Projects/shots88/presentation] [--gifs] [--frames 40] [--every 250]
//   node scripts/present.mjs --scene forest --cost [--window 4] [--rounds 3]
//   node scripts/present.mjs --scene canyon [--gifs]      (B: the hero lab's canyon)
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const COST = process.argv.includes('--cost');
const sceneArg = (() => {
  const i = process.argv.indexOf('--scene');
  return i >= 0 ? process.argv[i + 1] : 'forest';
})();

const LEVELS = {
  forest: { level: 'atlas', at: '13728,4768', play: 'lich', present: 'forest' },
  canyon: { level: 'herolab', station: 'canyon', present: 'canyon' },
  cliff: { level: 'herolab', station: 'cliff', hero: 'lich', present: 'cliff' },
  throne: { level: 'atlas', town: '1', play: 'lich', present: 'throne' },
};

await run({ name: `present-${sceneArg}`, kind: COST ? 'timing' : 'behaviour', size: '412x915', dpr: COST ? 2.6 : 1, echo: true }, async (R) => {
  const arg = (k, d) => {
    const i = R.argv.indexOf(`--${k}`);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const out = arg('out', 'C:/Projects/shots88/presentation');
  fs.mkdirSync(out, { recursive: true });
  const nFrames = Number(arg('frames', 40));
  const every = Number(arg('every', 250));
  const params = { ...LEVELS[sceneArg], perf: COST ? '1' : '0', pfold: '1', ...JSON.parse(arg('params', '{}')) };
  const p = await R.level(params);
  await p.waitForFunction(() => window.reclaimed?.present || document.querySelector('.fatal'), { timeout: 180000, polling: 250 });
  await R.fatal(p);
  // (the first load after a server start is slow: the land and the trees settle)
  await sleep(Number(arg('settle', 25)) * 1000);
  await R.fatal(p);
  const st = await p.evaluate(() => window.reclaimed.present.state());
  R.log(`scene ${sceneArg}: region ${JSON.stringify(st.region)} hero ${st.hero.map((x) => x.toFixed(1))}`);
  const pick = (o) => p.evaluate((o) => window.reclaimed.present.pick(o), o);
  const park = (w) => p.evaluate((w) => window.reclaimed.present.park(w), w);
  const shot = async (name) => {
    await p.screenshot({ path: path.join(out, `${sceneArg}-${name}.png`) });
    R.log(`shot ${sceneArg}-${name}.png ${JSON.stringify(await p.evaluate(() => { const s = window.reclaimed.present.state(); return { hero: s.screen.map(Math.round), w: +s.w.toFixed(2), zoom: +s.zoom.toFixed(1), el: +s.elevation.toFixed(1), label: s.label, present: s.present }; }))}`);
  };
  async function gif(file, n = nFrames) {
    const enc = GIFEncoder();
    for (let i = 0; i < n; i++) {
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
      await sleep(every);
    }
    enc.finish();
    fs.writeFileSync(file, enc.bytes());
    R.log(`gif ${path.basename(file)}`);
  }
  const frames = async (ms) =>
    p.evaluate(
      (ms) =>
        new Promise((res) => {
          const d = [];
          let last = performance.now();
          const t0 = last;
          const f = (t) => {
            d.push(t - last);
            last = t;
            if (t - t0 < ms) requestAnimationFrame(f);
            else res(d);
          };
          requestAnimationFrame(f);
        }),
      ms,
    );
  const stat = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return { n: s.length, p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], mean: s.reduce((x, y) => x + y, 0) / s.length };
  };

  if (sceneArg === 'throne') {
    const P = 'window.reclaimed.present';
    await shot('0-street');
    for (const e of arg('entries', 'iris|fade|zoom|cut').split('|')) {
      await pick({ entry: e });
      await p.evaluate(`${P}.leaveHall(); ${P}.mode.hold = 'out'; ${P}.mode.w = 0; ${P}.room.shown = 0`);
      await sleep(1500);
      await p.evaluate(`${P}.enterHall()`);
      if (R.argv.includes('--gifs') && e === 'iris') await gif(path.join(out, 'throne-enter-iris.gif'), 24);
      else {
        await sleep(700);
        await shot(`1-${e}-mid`);
        await sleep(2500);
      }
      await shot(`2-${e}-in`);
    }
    // a petition: the stub opportunity panel
    const spots = await p.evaluate(`${P}.room.petitionerSpots`);
    R.log(`petitioners ${JSON.stringify(spots)}`);
    if (spots.length) {
      await p.mouse.click(spots[0].x, spots[0].y);
      await sleep(800);
      await shot('3-petition');
    }
    return;
  }
  if (sceneArg === 'forest') {
    const VIS = arg('vis', 'rig|none|dither|cutaway|stipple|dither+stipple|cutaway+stipple').split('|');
    if (COST) {
      // each treatment against the baseline at the parked spot, in, alternated
      const windowS = Number(arg('window', 4)) * 1000;
      const rounds = Number(arg('rounds', 3));
      await pick({ visibility: 'none', light: 'none' });
      await park(1);
      await sleep(3000);
      const rows = [];
      for (const v of arg('variants', 'rig|dither|cutaway|stipple|dither+stipple|light').split('|')) {
        const B = v === 'light' ? { visibility: 'none', light: 'light' } : { visibility: v, light: 'none' };
        const A0 = [];
        const B0 = [];
        for (let r = 0; r < rounds; r++) {
          await pick({ visibility: 'none', light: 'none' });
          await park(1);
          await sleep(600);
          A0.push(...(await frames(windowS)));
          await pick(B);
          await park(1);
          await sleep(600);
          B0.push(...(await frames(windowS)));
        }
        const a = stat(A0);
        const b = stat(B0);
        rows.push({ variant: v, off: a, on: b, dMean: b.mean - a.mean, dP50: b.p50 - a.p50 });
        R.log(`${v.padEnd(16)} off p50 ${a.p50.toFixed(2)} mean ${a.mean.toFixed(2)} · on p50 ${b.p50.toFixed(2)} mean ${b.mean.toFixed(2)} · Δmean ${(b.mean - a.mean).toFixed(2)} ms`);
      }
      // the overworld out of the region (the profile's weight 0) against the experiments off altogether is the
      // driveprofile's job (scripts/driveprofile.mjs against places)
      fs.writeFileSync(path.join(out, 'forest-cost.json'), JSON.stringify(rows, null, 1));
      return;
    }
    if (R.argv.includes('--scales')) {
      // (round 124, the user on scale) the scale variants, stills at the parked spot and rides, under one visibility
      R.log(`stand ${JSON.stringify(st.stand)}`);
      const vis = arg('scalevis', 'stipple');
      for (const sc of arg('scaleset', 'game|true|trees|stumps').split('|')) {
        await pick({ scale: sc, visibility: vis, light: 'light', transition: 'zoom' });
        await park(1);
        await sleep(3000);
        await shot(`3-scale-${sc}`);
      }
      if (R.argv.includes('--gifs'))
        for (const sc of arg('scalerides', 'game|true|stumps').split('|')) {
          await pick({ scale: sc, visibility: vis, light: 'light', transition: 'zoom' });
          await p.evaluate(() => window.reclaimed.present.ride());
          await sleep(1500);
          await gif(path.join(out, `forest-scale-${sc}.gif`));
        }
      return;
    }
    // stills: the overworld, then each visibility variant under the canopy (light off, then on)
    await pick({ visibility: 'rig', light: 'none' });
    await park(0);
    await sleep(3500);
    await shot('0-overworld');
    for (const v of VIS) {
      await pick({ visibility: v, light: 'none' });
      await park(1);
      await sleep(3000);
      await shot(`1-${v.replace(/\+/g, '_')}`);
    }
    for (const v of arg('lightvis', 'none|dither+stipple').split('|')) {
      await pick({ visibility: v, light: 'light' });
      await park(1);
      await sleep(3000);
      await shot(`2-light-${v.replace(/\+/g, '_')}`);
    }
    if (R.argv.includes('--gifs')) {
      // rides: the route from its start (outside), in under the birches and out, per transition
      for (const [v, t] of arg('rides', 'rig:zoom|dither:zoomDither|stipple+cutaway:crossfade').split('|').map((s) => s.split(':'))) {
        await pick({ visibility: v, light: v === 'rig' ? 'none' : 'light', transition: t });
        await p.evaluate(() => window.reclaimed.present.ride());
        await sleep(1500);
        if (R.argv.includes('--trace')) {
          for (let i = 0; i < 20; i++) {
            const s = await p.evaluate(() => { const s = window.reclaimed.present.state(); const r = s.region.centre; return { h: s.hero.map((x) => +x.toFixed(1)), d: +Math.hypot(s.hero[0] - r[0], s.hero[1] - r[1]).toFixed(1), w: +s.w.toFixed(2), zoom: +s.zoom.toFixed(1) }; });
            R.log(`trace ${JSON.stringify(s)}`);
            await sleep(1000);
          }
          continue;
        }
        await gif(path.join(out, `forest-ride-${v.replace(/\+/g, '_')}-${t}.gif`));
      }
    }
  } else {
    const CAMS = arg('cams', sceneArg === 'canyon' ? 'overworld|steep|route|steep+route' : 'overworld|profile|down').split('|');
    const steer = [];
    for (const c of CAMS) {
      await pick({ camera: c });
      // (the ride from the station's start: the same route each variant)
      await p.evaluate((st) => window.reclaimed.lab.go(st), sceneArg);
      // (C: the climb proxy from the face's foot; B: the ride)
      if (sceneArg === 'cliff') await p.evaluate(() => window.reclaimed.present.climb());
      await sleep(Number(arg('ridein', sceneArg === 'cliff' ? 10 : 6)) * 1000);
      await shot(c.replace(/\+/g, '_'));
      if (R.argv.includes('--gifs')) await gif(path.join(out, `${sceneArg}-${c.replace(/\+/g, '_')}.gif`));
      if (sceneArg === 'canyon') {
        // the steering check: a thumb holding the stick one way on the screen while the view does what it does — up
        // (the way ahead, if the view faces the route), then right; the view's turn a frame and the hero's heading
        for (const [name, dir, secs] of [['up', [0, -1], 8], ['right', [1, 0], 4]]) {
          await p.evaluate((st) => window.reclaimed.lab.go(st), sceneArg);
          await sleep(1500);
          await p.evaluate((d) => window.reclaimed.present.holdStick(d), dir);
          const tr = await p.evaluate(
            (secs) =>
              new Promise((res) => {
                const P = window.reclaimed.present;
                const out = [];
                const t0 = performance.now();
                const f = () => {
                  const s = P.state();
                  out.push({ t: performance.now() - t0, az: s.azimuth, h: s.hero });
                  if (performance.now() - t0 < secs * 1000) requestAnimationFrame(f);
                  else res(out);
                };
                requestAnimationFrame(f);
              }),
            secs,
          );
          await p.evaluate(() => window.reclaimed.present.holdStick(null));
          const wrap = (a) => ((a + 540) % 360) - 180;
          let azMax = 0;
          let azTot = 0;
          let headTot = 0;
          let dist = 0;
          let lastHead = null;
          for (let i = 1; i < tr.length; i++) {
            const d = Math.abs(wrap(tr[i].az - tr[i - 1].az));
            // (deg/s: the headless frame rate varies)
            // (over a tenth of a second back: two frames' timestamps can be nearly equal)
            let j = i;
            while (j > 0 && tr[i].t - tr[j].t < 100) j--;
            if (tr[i].t - tr[j].t >= 100) azMax = Math.max(azMax, Math.abs(wrap(tr[i].az - tr[j].az)) / ((tr[i].t - tr[j].t) / 1000));
            azTot += d;
            const dx = tr[i].h[0] - tr[i - 1].h[0];
            const dy = tr[i].h[1] - tr[i - 1].h[1];
            const l = Math.hypot(dx, dy);
            if (l < 20) dist += l;
            if (l > 0.05 && l < 20) {
              const hd = (Math.atan2(dy, dx) * 180) / Math.PI;
              if (lastHead !== null) headTot += Math.abs(wrap(hd - lastHead));
              lastHead = hd;
            }
          }
          const row = { cam: c, hold: name, secs, azMaxDegPerS: +azMax.toFixed(0), frames: tr.length, azTurned: +azTot.toFixed(0), headingTurned: +headTot.toFixed(0), cells: +dist.toFixed(0) };
          steer.push(row);
          R.log(`steer ${JSON.stringify(row)}`);
        }
      }
    }
    if (steer.length) fs.writeFileSync(path.join(out, `${sceneArg}-steer.json`), JSON.stringify(steer, null, 1));
  }
  await R.fatal(p);
});
