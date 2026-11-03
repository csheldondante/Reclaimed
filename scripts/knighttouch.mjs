// (knight, round 128) The knight's station driven by real touches (CDP Input.dispatchTouchEvent) on a phone-shaped page,
// every system in play at 1x: the three heroes' run speeds measured on the same ground; swipes that slash and lunge into
// enemies; the bow drawn back and loosed; the spin flicked into a crowd; a dodge; the raiders hitting back. GIFs and
// shots of each go to --out (default C:/Projects/shots88/knight).
//   node scripts/knighttouch.mjs [--settle 30000] [--out C:/Projects/shots88/knight]
import fs from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'knighttouch', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/knight');
  fs.mkdirSync(out, { recursive: true });
  const page = await R.page();
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const p = await R.level({ level: 'atlas', play: 'knight', station: '1' }, { page });
  await p.waitForFunction(() => window.reclaimed?.play?.hero, { timeout: 120000, polling: 250 });
  await sleep(Number(R.opt('settle', 30000)));
  const cdp = p.cdp;
  const fingers = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...fingers.entries()].map(([id, [x, y]]) => ({ x, y, id })) });
  const down = async (id, x, y) => {
    fingers.set(id, [x, y]);
    await send('touchStart');
  };
  const move = async (id, x, y) => {
    fingers.set(id, [x, y]);
    await send('touchMove');
  };
  const up = async (id) => {
    const at = fingers.get(id);
    fingers.delete(id);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: at[0], y: at[1], id }] });
  };
  /** a stroke of the right thumb through screen points, `ms` apart, by real touches (CDP: ~90 ms an event under load) */
  const touchStroke = async (pts, ms = 16, hold = 0) => {
    await down(1, pts[0][0], pts[0][1]);
    for (const q of pts.slice(1)) {
      await sleep(ms);
      await move(1, q[0], q[1]);
    }
    if (hold) await sleep(hold);
    await up(1);
  };
  /**
   * a stroke dispatched in the page as touch pointer events on the play pad, `ms` apart: a finger's timing (CDP's
   * round trips under a loaded GPU stretch a 60 ms swipe to 350 ms, past the double swipe's 0.3 s)
   */
  const stroke = (pts, ms = 16, hold = 0) =>
    p.evaluate(
      async (pts, ms, hold) => {
        const pad = document.querySelector('.play-pad');
        const id = 40 + Math.floor(Math.random() * 1000);
        const ev = (type, [x, y]) => pad.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: false }));
        const wait = (t) => new Promise((r) => setTimeout(r, t));
        ev('pointerdown', pts[0]);
        for (const q of pts.slice(1)) {
          await wait(ms);
          ev('pointermove', q);
        }
        if (hold) await wait(hold);
        ev('pointerup', pts[pts.length - 1]);
      },
      pts,
      ms,
      hold,
    );
  const line = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  const hero = () => p.evaluate(() => ({ at: window.reclaimed.play.hero.position(), speed: window.reclaimed.play.hero.speed(), stats: window.reclaimed.play.hero.stats, act: window.reclaimed.play.hero.act?.kind, arm: window.reclaimed.play.hero.arm, hp: window.reclaimed.play.hero.health }));
  /** the screen direction from the knight to the nearest unit (or null) */
  const toNearest = () =>
    p.evaluate(() => {
      const r = window.reclaimed;
      const h = r.play.hero;
      const [x, y, z] = h.position();
      const us = r.units.query([x, y], 20);
      if (!us.length) return null;
      const u = us[0];
      const a = r.core.camera.project(x, y, z);
      const b = r.core.camera.project(u.at[0], u.at[1], u.at[2]);
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return { dir: [(b[0] - a[0]) / d, (b[1] - a[1]) / d], cells: Math.hypot(u.at[0] - x, u.at[1] - y), id: u.id };
    });
  const button = async (i) => {
    const r = await p.evaluate((k) => {
      const b = document.querySelectorAll('.play-btn')[k].getBoundingClientRect();
      return [b.x + b.width / 2, b.y + b.height / 2];
    }, i);
    await down(5, r[0], r[1]);
    await sleep(60);
    await up(5);
    await sleep(60);
  };
  const station = async (label) => {
    await p.evaluate((l) => [...document.querySelectorAll('.play-station button')].find((b) => b.textContent === l).click(), label);
    await sleep(300);
  };
  /** a GIF captured while `act` runs */
  const gif = async (name, frames, every, act) => {
    const enc = GIFEncoder();
    let done = false;
    const cap = (async () => {
      for (let i = 0; i < frames && !done; i++) {
        const t0 = Date.now();
        const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
        kept.push(png);
        const pal = quantize(png.data, 128);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
        await sleep(Math.max(0, every - (Date.now() - t0)));
      }
    })();
    await act();
    await cap;
    done = true;
    enc.finish();
    fs.writeFileSync(path.join(out, name), enc.bytes());
    // (a contact sheet of a dozen frames round the middle, to look at without a GIF viewer)
    const sheet = new PNG({ width: 4 * 206, height: Math.ceil(Math.min(12, kept.length) / 4) * 240 });
    const step = Math.max(1, Math.floor(kept.length / 12));
    kept.filter((_, i) => i % step === 0).slice(0, 12).forEach((f, k) => {
      const ox = (k % 4) * 206;
      const oy = Math.floor(k / 4) * 240;
      for (let y = 0; y < 240; y++)
        for (let x = 0; x < 206; x++) {
          const si = ((217 + y * 2) * f.width + x * 2) * 4;
          const di = ((oy + y) * sheet.width + ox + x) * 4;
          for (let c = 0; c < 4; c++) sheet.data[di + c] = f.data[si + c];
        }
    });
    fs.writeFileSync(path.join(out, name.replace('.gif', '-sheet.png')), PNG.sync.write(sheet));
    if (kept.length) fs.writeFileSync(path.join(out, name.replace('.gif', '-still.png')), PNG.sync.write(kept[Math.floor(kept.length * 0.4)]));
    kept.length = 0;
    R.log(`saved ${name}`);
  };
  const kept = [];
  const S = [230, 330];

  // ---- speeds: each hero on the same spot, the stick held up the screen 3 s (scripted thumb: the same push for all)
  const speeds = {};
  const start = (await hero()).at;
  for (const id of ['knight', 'lich', 'hoverbike']) {
    await p.evaluate((h) => window.reclaimed.play.choose(h), id);
    await p.evaluate((at) => window.reclaimed.play.hero.place([at[0], at[1]]), start);
    await sleep(600);
    await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, -1], buttons: [] }));
    let top = 0;

    for (let k = 0; k < 30; k++) {
      await sleep(100);
      top = Math.max(top, (await hero()).speed);
    }
    await p.evaluate(() => (window.reclaimed.play.controls.script = null));
    speeds[id] = { top: +top.toFixed(1) };
  }
  R.log(`speeds ${JSON.stringify(speeds)}`);
  R.check('the knight runs faster than the lich and slower than the bike', speeds.knight.top > speeds.lich.top && speeds.knight.top < speeds.hoverbike.top, speeds);
  await p.evaluate(() => window.reclaimed.play.choose('knight'));
  await p.evaluate((at) => window.reclaimed.play.hero.place([at[0], at[1]]), start);
  await sleep(1500);
  await p.screenshot({ path: path.join(out, 'station.png') });

  // ---- slashes and lunges into the dummies
  await station('Dummies');
  await sleep(1500);
  await p.evaluate(() => {
    const r = window.reclaimed;
    const h = r.play.hero;
    const [x, y] = h.position();
    const u = r.units.query([x, y], 12).find((v) => v.role === 'dummy');
    const d = Math.hypot(u.at[0] - x, u.at[1] - y);
    h.place([u.at[0] - ((u.at[0] - x) / d) * 2.6, u.at[1] - ((u.at[1] - y) / d) * 2.6]);
  });
  await sleep(1200);
  const h0 = await hero();
  await gif('slash.gif', 34, 90, async () => {
    // (a light swing, a chained second, then a double swipe — the lunge — then a wide string of three)
    const plan = [380, 900, 40, 900, 60, 60, 900];
    for (const gap of plan) {
      const t = await toNearest();
      const d = t ? t.dir : [1, 0];
      await stroke(line(S, [S[0] + d[0] * 70, S[1] + d[1] * 70], 4), 14);
      await sleep(gap);
    }
  });
  const h1 = await hero();
  R.log(`slash ${JSON.stringify(h1.stats)} trace ${JSON.stringify(await p.evaluate(() => window.reclaimed.play.controls.trace.slice(-6)))}`);
  R.check('swipes slash: blows land on the dummies', h1.stats.hits - h0.stats.hits >= 2, { hits: h1.stats.hits - h0.stats.hits, swings: h1.stats.swings - h0.stats.swings });
  R.check('a double swipe lunges', h1.stats.lunges > h0.stats.lunges, { lunges: h1.stats.lunges });
  await p.screenshot({ path: path.join(out, 'slash-end.png') });

  // ---- the bow: ⇄, then pull back away from a dummy and let go
  await p.evaluate((at) => window.reclaimed.play.hero.place([at[0], at[1]]), start);
  await station('Dummies');
  await sleep(800);
  await button(1);
  const arm = (await hero()).arm;
  R.check('⇄ switches to the bow', arm === 'bow', { arm });
  await p.evaluate(() => window.reclaimed.play.hero.place([window.reclaimed.play.hero.position()[0], window.reclaimed.play.hero.position()[1]]));
  // (step back from the dummies: a shot with some flight)
  await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, 1], buttons: [] }));
  await sleep(500);
  await p.evaluate(() => (window.reclaimed.play.controls.script = null));
  await sleep(400);
  const b0 = await hero();
  await gif('bow.gif', 26, 90, async () => {
    for (let k = 0; k < 2; k++) {
      const t = await toNearest();
      const d = t ? t.dir : [0, -1];
      await stroke(line(S, [S[0] - d[0] * 110, S[1] - d[1] * 110], 10), 30, 700);
      if (k === 0) await touchStroke(line(S, [S[0] - d[0] * 110, S[1] - d[1] * 110], 4), 30, 700);
      await sleep(500);
    }
  });
  const b1 = await hero();
  R.check('drawn back and let go, arrows fly and land', b1.stats.arrows - b0.stats.arrows >= 2 && b1.stats.arrowHits > b0.stats.arrowHits, { arrows: b1.stats.arrows - b0.stats.arrows, hits: b1.stats.arrowHits - b0.stats.arrowHits });
  await button(1);

  // ---- the spin: a circle drawn, then flicked into the dummies; a wave round it to bounce off
  const home = () => p.evaluate((at) => window.reclaimed.play.hero.place([at[0], at[1]]), start);
  await home();
  await station('Clear');
  await station('Dummies');
  await station('Wave');
  await sleep(3500);
  const s0 = await hero();
  await gif('spin.gif', 40, 90, async () => {
    const ring = Array.from({ length: 30 }, (_, i) => [S[0] + 55 * Math.cos((i * Math.PI * 2) / 26), S[1] + 55 * Math.sin((i * Math.PI * 2) / 26)]);
    await stroke(ring, 12);
    await sleep(200);
    for (let k = 0; k < 3; k++) {
      const t = await toNearest();
      const d = t ? t.dir : [1, 0];
      await stroke(line(S, [S[0] + d[0] * 150, S[1] + d[1] * 150], 6), 16);
      await sleep(700);
    }
  });
  const s1 = await hero();
  R.log(`spin ${JSON.stringify(s1.stats)}`);
  R.check('a drawn circle spins the knight', s1.stats.spins > s0.stats.spins, { spins: s1.stats.spins });
  R.check('flicked about, the spin cuts and bounces off enemies', s1.stats.hits > s0.stats.hits && s1.stats.bounces > s0.stats.bounces, { hits: s1.stats.hits - s0.stats.hits, bounces: s1.stats.bounces - s0.stats.bounces });

  // ---- the dodge: the stick held, DODGE
  await home();
  await station('Clear');
  await sleep(800);
  const d0 = await hero();
  await gif('dodge.gif', 22, 90, async () => {
    await down(0, 90, 780);
    for (let i = 1; i <= 5; i++) await move(0, 90 + i * 12, 780);
    await sleep(400);
    await button(0);
    await sleep(900);
    for (let i = 1; i <= 5; i++) await move(0, 90, 780 - i * 12);
    await sleep(200);
    await button(0);
    await sleep(600);
    await up(0);
  });
  const d1 = await hero();
  R.check('DODGE dashes', d1.stats.dodges - d0.stats.dodges >= 2, { dodges: d1.stats.dodges - d0.stats.dodges });

  // ---- the raiders hit back: back on dry ground, stand among a wave a while
  await p.evaluate((at) => window.reclaimed.play.hero.place([at[0], at[1]]), start);
  await sleep(500);
  await station('Clear');
  await station('Wave');
  const hp0 = (await hero()).hp;
  let hp = hp0;
  for (let k = 0; k < 120 && hp >= hp0; k++) {
    await sleep(250);
    hp = (await hero()).hp;
  }
  R.check('the raiders hit back', hp < hp0, { hp0, hp });
  await p.screenshot({ path: path.join(out, 'raiders.png') });
  const read = await p.evaluate(() => document.querySelector('.play-station-read')?.textContent);
  R.log(`station readout: ${read}`);
  R.log(`play layer ms/frame ${JSON.stringify(await p.evaluate(() => { const s = window.reclaimed.play.stats; return { mean: +(s.ms / Math.max(1, s.frames)).toFixed(3), max: +s.max.toFixed(2), frames: s.frames }; }))}`);
});
