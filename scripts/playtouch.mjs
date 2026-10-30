// Round 117 (play): the sandbox driven by real touches (CDP Input.dispatchTouchEvent, several fingers at once) on a
// phone-shaped page — the path a phone takes, not the scripted one: the left thumb's stick held while the right
// thumb swipes beside the bike; the tune panel opened by a tap; the lich chosen by a tap and sent by a tap.
//   node scripts/playtouch.mjs [--settle 30000] [--out C:/Projects/shots88/play]
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'playtouch', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/play');
  fs.mkdirSync(out, { recursive: true });
  const page = await R.page();
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const p = await R.level({ level: 'atlas', play: 'hoverbike' }, { page });
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
  // (Chrome reads a touchEnd's points as the ones lifted: the others stay down)
  const up = async (id) => {
    const at = fingers.get(id);
    fingers.delete(id);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: at[0], y: at[1], id }] });
    return at;
  };
  const pos = () => p.evaluate(() => window.reclaimed.play.hero.position());
  const a0 = await pos();
  // the left thumb down in the bottom-left zone and pushed up the screen, held 3 s
  await down(0, 90, 780);
  for (let i = 1; i <= 6; i++) await move(0, 90, 780 - i * 12);
  for (let k = 0; k < 15; k++) {
    await sleep(100);
    await move(0, 90 + (k % 2), 708);
  }
  // the right thumb: a quick swipe starting left of the bike, forward (up the screen)
  const from = await p.evaluate(() => {
    const h = window.reclaimed.play.hero;
    const [x, y, z] = h.position();
    const a = h.heading();
    return window.reclaimed.core.camera.project(x - Math.sin(a) * 2, y + Math.cos(a) * 2, z);
  });
  await down(1, from[0], from[1]);
  for (let i = 1; i <= 4; i++) {
    await sleep(16);
    await move(1, from[0], from[1] - i * 18);
  }
  await up(1);
  for (let k = 0; k < 15; k++) {
    await sleep(100);
    await move(0, 90 + (k % 2), 708);
  }
  const a1 = await pos();
  await up(0);
  const moved = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
  R.check('a held touch stick rides the bike (> 20 cells in 3 s)', moved > 20, { moved: +moved.toFixed(1) });
  const told = await p.evaluate(() => window.reclaimed.play.hero.told);
  R.log(`trace ${JSON.stringify(await p.evaluate(() => window.reclaimed.play.controls.trace))}`);
  R.check('a touch swipe beside the bike is read as a slash', /slash/.test(told), { told });
  await p.screenshot({ path: path.join(out, 'touch-bike.png') });
  // the tune panel, by a tap on ⚙
  const tap = async (sel) => {
    const r = await p.evaluate((s) => {
      const e = [...document.querySelectorAll('.play-chip')].find((b) => b.textContent === s || b.dataset.id === s);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return [b.x + b.width / 2, b.y + b.height / 2];
    }, sel);
    if (!r) throw new Error(`no chip ${sel}`);
    await down(5, r[0], r[1]);
    await sleep(60);
    await up(5);
    await sleep(300);
  };
  await tap('⚙️');
  const panel = await p.evaluate(() => !!document.querySelector('.play-panel'));
  R.check('a tap on the gear opens the tune panel', panel);
  await p.screenshot({ path: path.join(out, 'touch-tune.png') });
  await tap('⚙️');
  // the lich, by a tap on its chip; then a tap on the ground sends it there
  await tap('lich');
  await sleep(1500);
  const role = await p.evaluate(() => window.reclaimed.play.hero.role);
  R.check('a tap on the skull switches to the lich', role === 'lich', { role });
  R.log(`at 206,300: ${await p.evaluate(() => { const e = document.elementFromPoint(206, 300); return e ? e.className + ' / ' + e.tagName : null; })}`);
  const l0 = await pos();
  await down(2, 206, 300);
  await sleep(60);
  await up(2);
  await sleep(4000);
  const l1 = await pos();
  R.log(`trace ${JSON.stringify(await p.evaluate(() => window.reclaimed.play.controls.trace))}`);
  const went = Math.hypot(l1[0] - l0[0], l1[1] - l0[1]);
  R.check('a tap on the ground glides the lich there', went > 3, { went: +went.toFixed(1) });
  await p.screenshot({ path: path.join(out, 'touch-lich.png') });
});
