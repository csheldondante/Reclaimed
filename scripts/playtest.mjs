// Round 117 (play): the play sandbox in the browser, as a player drives it, every system in play (the atlas level as
// deployed, 1x speed). The thumbs scripted through the real controls (Controls.script for the stick and buttons,
// Controls.inject for gestures), so the same path a finger takes.
//   hoverbike  ride up-screen 4 s with boost: distance, top speed; raiders spawned ahead; swipes beside the bike as
//              it passes them: damage dealt; a GIF of the ride
//   lich       switched to: raiders round it; a tap on one floats it; a slam; a GIF
//
//   node scripts/playtest.mjs [--gif-dir C:/Projects/shots88/play] [--size 412x915] [--dpr 1] [--settle 30000]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'playtest', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const dir = R.opt('gif-dir', 'C:/Projects/shots88/play');
  fs.mkdirSync(dir, { recursive: true });
  const settle = Number(R.opt('settle', 30000));
  const p = await R.level({ level: 'atlas', play: 'hoverbike' });
  await p.waitForFunction(() => window.reclaimed?.play?.hero, { timeout: 120000, polling: 250 });
  R.log(`sandbox up; settling ${settle / 1000} s (a first load's terrain)`);
  await sleep(settle);
  await R.fatal(p);
  const gif = async (name, frames, every, during) => {
    const enc = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      if (during) await during(i);
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 128);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
      await sleep(every);
    }
    enc.finish();
    const f = path.join(dir, name);
    fs.writeFileSync(f, enc.bytes());
    R.log(`saved ${f}`);
  };
  const state = () =>
    p.evaluate(() => {
      const s = window.reclaimed.play;
      const h = s.hero;
      return { at: h.position(), speed: h.speed(), status: h.status(), hp: h.health, role: h.role, air: h.b?.air ?? 0, fps: window.reclaimed.perf?.fps ?? null };
    });
  await p.screenshot({ path: path.join(dir, 'bike-start.png') });
  const s0 = await state();
  R.log(`start ${JSON.stringify(s0)}`);
  // ride: the stick up the screen, boost held
  await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, -1], buttons: [true] }));
  let top = 0;
  await gif('bike-ride.gif', 30, 70, async () => {
    const s = await state();
    top = Math.max(top, s.speed);
  });
  const s1 = await state();
  const moved = Math.hypot(s1.at[0] - s0.at[0], s1.at[1] - s0.at[1]);
  R.check('the bike rides (moved > 25 cells)', moved > 25, { moved: +moved.toFixed(1), top: +top.toFixed(1), status: s1.status });
  R.check('it gets up to speed (> 15 cells/s)', top > 15, { top });
  await p.screenshot({ path: path.join(dir, 'bike-ride.png') });
  // raiders ahead, and swipes beside the bike as it passes
  await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, -1], buttons: [false] }));
  await p.evaluate(() => window.reclaimed.play.spawn());
  await sleep(500);
  const swipe = () =>
    p.evaluate(() => {
      const s = window.reclaimed.play;
      const h = s.hero;
      const cam = window.reclaimed.core.camera;
      const [x, y, z] = h.position();
      const a = h.heading();
      // (its left: a swipe starting 2 cells to the left, flicked forward)
      const from = cam.project(x - Math.sin(a) * 2, y + Math.cos(a) * 2, z);
      const to = cam.project(x - Math.sin(a) * 2 + Math.cos(a) * 3, y + Math.cos(a) * 2 + Math.sin(a) * 3, z);
      const d = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
      s.controls.inject({ kind: 'flick', from, to, dir: [(to[0] - from[0]) / d, (to[1] - from[1]) / d], speed: 1500 });
    });
  const health = () => p.evaluate(() => window.reclaimed.units.query(window.reclaimed.play.hero.position().slice(0, 2), 80, { hostile: true, dead: true }).reduce((a, u) => a + u.health, 0));
  const h0 = await health();
  await gif('bike-fight.gif', 30, 80, async (i) => {
    if (i % 4 === 0) await swipe();
  });
  const h1 = await health();
  R.check('the raiders are hurt (by the ram or the slash)', h1 < h0, { before: h0, after: h1 });
  const told = await p.evaluate(() => window.reclaimed.play.hero.told);
  R.log(`last slash: ${told}`);
  await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, 0], buttons: [false] }));
  // the lich
  await p.evaluate(() => window.reclaimed.play.choose('lich'));
  await sleep(1500);
  await p.evaluate(() => window.reclaimed.play.spawn());
  await sleep(2500);
  const l0 = await state();
  R.check('the lich is up', l0.role === 'lich', l0);
  const tapRaider = () =>
    p.evaluate(() => {
      const s = window.reclaimed.play;
      const [x, y] = s.hero.position();
      const u = window.reclaimed.units.query([x, y], 30, { hostile: true })[0];
      if (!u) return null;
      const sc = window.reclaimed.core.camera.project(u.at[0], u.at[1], u.at[2] + 0.64);
      s.controls.inject({ kind: 'tap', at: sc });
      return u.id;
    });
  let floated = null;
  let slammed = 0;
  await gif('lich.gif', 40, 80, async (i) => {
    if (i === 4) floated = await tapRaider();
    if (i === 14 || i === 28) {
      await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, 0], buttons: [true, false] }));
      slammed++;
    } else await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, 0], buttons: [false, false] }));
  });
  const held = await p.evaluate(() => window.reclaimed.play.hero.held?.() ?? []);
  R.log(`floated ${floated}; held now ${JSON.stringify(held)}; slams ${slammed}`);
  R.check('a tap on a raider floated it', floated !== null, { floated });
  await p.screenshot({ path: path.join(dir, 'lich.png') });
  await p.evaluate(() => (window.reclaimed.play.controls.script = null));
});
