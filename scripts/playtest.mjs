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
  // a fight: raiders in a file 2.5 cells left of its way ahead; a swipe on the left whenever one's coming up on that side
  await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, -1], buttons: [false] }));
  await sleep(1500);
  await p.evaluate(() => {
    const s = window.reclaimed.play;
    const h = s.hero;
    const [x, y] = h.position();
    const a = h.heading();
    const [fx, fy] = [Math.cos(a), Math.sin(a)];
    window.__file = [];
    for (let i = 0; i < 6; i++) {
      const d = 30 + i * 14;
      const at = [x + fx * d - fy * 2.5, y + fy * d + fx * 2.5];
      window.__file.push(window.reclaimed.units.spawn('raider', at, 'f-raiders', { hostile: true, health: 4, sight: 6, speed: 2, role: 'raider' }));
    }
  });
  await sleep(300);
  const swipeIfComing = () =>
    p.evaluate(() => {
      const s = window.reclaimed.play;
      const h = s.hero;
      const cam = window.reclaimed.core.camera;
      const [x, y, z] = h.position();
      const a = h.heading();
      const [fx, fy] = [Math.cos(a), Math.sin(a)];
      const sp = h.speed();
      const coming = window.reclaimed.units.query([x, y], 20, { hostile: true }).some((u) => {
        const dx = u.at[0] - x;
        const dy = u.at[1] - y;
        const along = dx * fx + dy * fy;
        const side = -dx * fy + dy * fx;
        return side > 0 && side < 6 && along > 0 && along < sp * 0.5;
      });
      if (!coming) return false;
      const from = cam.project(x - fy * 2, y + fx * 2, z);
      const to = cam.project(x - fy * 2 + fx * 3, y + fx * 2 + fy * 3, z);
      const d = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
      s.controls.inject({ kind: 'flick', from, to, dir: [(to[0] - from[0]) / d, (to[1] - from[1]) / d], speed: 1500 });
      return true;
    });
  const health = () => p.evaluate(() => window.__file.reduce((a, id) => a + (window.reclaimed.units.get(id)?.health ?? 0), 0));
  const h0 = await health();
  let swipes = 0;
  let hits = 0;
  await gif('bike-fight.gif', 45, 50, async () => {
    if (await swipeIfComing()) swipes++;
    if ((await state()).status === 'HIT!') hits++;
  });
  const h1 = await health();
  R.check('the file of raiders is cut down (slash and ram)', h1 < h0, { before: h0, after: h1, swipes, hitFrames: hits });
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
