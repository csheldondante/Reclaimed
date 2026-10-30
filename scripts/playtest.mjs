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
  // (round 118) the bike starts on hills: the ground round it rises and falls
  const relief = await p.evaluate(() => {
    const t = window.reclaimed.play.d.api.terrain;
    const [x, y] = window.reclaimed.play.hero.position();
    let lo = Infinity;
    let hi = -Infinity;
    for (let r = 3; r <= 15; r += 3)
      for (let k = 0; k < 12; k++) {
        const z = t.heightAt(x + Math.cos(k * 0.52) * r, y + Math.sin(k * 0.52) * r);
        if (z === null) continue;
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
    return +(hi - lo).toFixed(1);
  });
  R.check('the bike starts on hills (more than 3 cells of rise and fall within 15)', relief > 3, { relief });
  // ride: the stick up the screen, boost held
  await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, -1], buttons: [true] }));
  let top = 0;
  await gif('bike-hills.gif', 30, 70, async () => {
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
  // the hook: a tap on the ground ahead and to the left while riding swings the bike round it
  await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, -1], buttons: [false] }));
  await sleep(1500);
  const way = () => p.evaluate(() => {
    const b = window.reclaimed.play.hero.b;
    return Math.atan2(b.vy, b.vx);
  });
  R.log(`before the hook: ${JSON.stringify(await state())}`);
  const w0 = await way();
  let swung = 0;
  let maxTurn = 0;
  await gif('bike-hook.gif', 30, 50, async (i) => {
    if (i === 2)
      await p.evaluate(() => {
        const s = window.reclaimed.play;
        const h = s.hero;
        const [x, y, z] = h.position();
        const a = h.heading();
        const [fx, fy] = [Math.cos(a), Math.sin(a)];
        const sc = window.reclaimed.core.camera.project(x + fx * 4 - fy * 6, y + fy * 4 + fx * 6, z);
        s.controls.inject({ kind: 'tap', at: sc });
      });
    if ((await state()).status === 'SWING') swung++;
    const w = await way();
    maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(w - w0), Math.cos(w - w0))));
    if (R.flag('debug-hook')) R.log(JSON.stringify(await p.evaluate(() => { const h = window.reclaimed.play.hero; return { hook: h.hook, at: h.position().map((v) => +v.toFixed(1)), v: [+h.b.vx.toFixed(1), +h.b.vy.toFixed(1)], st: h.status() }; })));
  });
  R.check('a tap on the ground swings the bike round it (its way turns > 90 deg)', swung > 0 && maxTurn > 1.57, { swungFrames: swung, maxTurn: +maxTurn.toFixed(2) });
  await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, 0], buttons: [false] }));
  // (round 118) the hook: a foe on the line, dragged, then reeled in by a swipe back toward the bike (the bike brought
  // to a stop first, the foe put down beside it, so it's within the hook's reach when tapped)
  await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, 0], buttons: [false] }));
  await sleep(2500);
  const onLine = await p.evaluate(() => {
    const s = window.reclaimed.play;
    const h = s.hero;
    const [x, y, z] = h.position();
    const a = h.heading();
    const at = [x + Math.cos(a) * 6 - Math.sin(a) * 4, y + Math.sin(a) * 6 + Math.cos(a) * 4];
    window.__hooked = window.reclaimed.units.spawn('raider', at, 'f-raiders', { hostile: true, health: 12, sight: 4, speed: 1, role: 'raider' });
    return window.__hooked;
  });
  await sleep(700);
  const tapUnit = (id) =>
    p.evaluate((id) => {
      const s = window.reclaimed.play;
      const u = window.reclaimed.units.get(id);
      if (!u) return false;
      s.controls.inject({ kind: 'tap', at: window.reclaimed.core.camera.project(u.at[0], u.at[1], u.at[2] + 0.8) });
      return true;
    }, id);
  await tapUnit(onLine);
  await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, -1], buttons: [false] }));
  let lineFrames = 0;
  await gif('bike-drag.gif', 30, 50, async (i) => {
    if ((await state()).status === 'ON THE LINE') lineFrames++;
    if (i === 24)
      await p.evaluate((id) => {
        // (a swipe from the foe back toward the bike: reel it in)
        const s = window.reclaimed.play;
        const cam = window.reclaimed.core.camera;
        const u = window.reclaimed.units.get(id);
        const [x, y, z] = s.hero.position();
        if (!u) return;
        const from = cam.project(u.at[0], u.at[1], u.at[2]);
        const to = cam.project(x, y, z);
        const d = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
        s.controls.inject({ kind: 'flick', from, to, dir: [(to[0] - from[0]) / d, (to[1] - from[1]) / d], speed: 1500 });
      }, onLine);
  });
  R.check('a tapped foe is dragged on the line', lineFrames > 5, { lineFrames });
  // (round 118) a rival rider: tapped, the bike is reeled up alongside it
  await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, 0], buttons: [false] }));
  await p.evaluate(() => window.reclaimed.play.rival());
  await sleep(2500);
  await p.evaluate(() => {
    const s = window.reclaimed.play;
    const r = s.rivals[s.rivals.length - 1].vehicle();
    s.controls.inject({ kind: 'tap', at: window.reclaimed.core.camera.project(r.at[0], r.at[1], r.at[2] + 0.6) });
  });
  let alongside = 0;
  let nearest = Infinity;
  await gif('bike-alongside.gif', 40, 50, async () => {
    const st = await state();
    if (st.status === 'ALONGSIDE') alongside++;
    const d = await p.evaluate(() => {
      const s = window.reclaimed.play;
      const r = s.rivals[s.rivals.length - 1].vehicle();
      const [x, y] = s.hero.position();
      return Math.hypot(r.at[0] - x, r.at[1] - y);
    });
    nearest = Math.min(nearest, d);
  });
  R.check('a tapped rival reels the bike up alongside it (within 4 cells)', alongside > 5 && nearest < 4, { alongside, nearest: +nearest.toFixed(1) });
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
  // (round 118) the life drain: a double tap floats the foe up before the lich's face
  const victim = await p.evaluate(() => {
    const s = window.reclaimed.play;
    s.hero.dropAll();
    const [x, y] = s.hero.position();
    return window.reclaimed.units.spawn('raider', [x + 4, y + 2], 'f-raiders', { hostile: true, health: 30, sight: 2, speed: 1, role: 'raider' });
  });
  await sleep(1500);
  let faced = 0;
  let rose = -Infinity;
  await gif('lich-drain.gif', 30, 60, async (i) => {
    if (i === 1 || i === 2) await tapUnit(victim);
    const r = await p.evaluate((id) => {
      const s = window.reclaimed.play;
      const u = window.reclaimed.units.get(id);
      return { st: s.hero.status(), dz: u ? u.at[2] - s.hero.position()[2] : null };
    }, victim);
    if (/FACE TO FACE/.test(r.st)) faced++;
    if (r.dz !== null) rose = Math.max(rose, r.dz);
  });
  R.check('a double tap floats the foe up before the lich and drains it', faced > 5 && rose > -0.5, { faced, rose: +rose.toFixed(2) });
  await p.evaluate(() => (window.reclaimed.play.controls.script = null));
});
