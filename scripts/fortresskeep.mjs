// (round 128m, townlab C) The window keeps the fortress's box (scenes/streamer/keep.ts): on the user's link at the
// phone's size, the reach's answers at 24 points round the stores (30, 60, 120 m, eight ways, `why` asked) at the start,
// then with the camera panned 150 m each of four ways and back. Before the keep, a pan slid the window off part of the
// box and whole sides read "A cliff or a building is in the way" (every placement, once the stores left the window).
// Every answer must equal the start's. Shots at play zoom panned away (the far land past the window: no holes).
//   node scripts/fortresskeep.mjs [--out dir]
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep, ROOT } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : path.join(ROOT, '.testcache', 'fortresskeep');
await run({ name: 'fortresskeep', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  fs.mkdirSync(OUT, { recursive: true });
  const page = await R.page();
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1&fresh=1&q=low`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => (window.reclaimed?.fortress?.ready && window.reclaimed.fortress.reachKnown) || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(2000);
  const probe = () =>
    page.evaluate(async () => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const S = Rc.stream;
      const at = f.storesAt();
      const pts = [];
      for (const d of [30, 60, 120])
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          pts.push([at[0] + Math.cos(a) * d, at[1] + Math.sin(a) * d]);
        }
      // (the same box cells every time: a slide moves the window's frame, not the box)
      const cells = pts.map(([x, y]) => f.cellAt(x, y));
      await f.settled();
      const Re = f.io.reach;
      Re.setSpans(f.spansNow());
      const reply = await Re.check(f.reachAsk(cells, false, true));
      const box = f.box;
      const inWin = box.origin[0] - S.origin[0] >= 0 && box.origin[1] - S.origin[1] >= 0 && box.origin[0] + box.w <= S.origin[0] + S.W && box.origin[1] + box.h <= S.origin[1] + S.H;
      return { origin: [...S.origin], boxInWindow: inWin, bits: [...reply.bits].join(',') };
    });
  const start = await probe();
  console.log('start', JSON.stringify(start));
  if (!start.boxInWindow) R.check?.('box in the window at the start', false, JSON.stringify(start));
  if (!start.boxInWindow) throw new Error(`the fortress's box isn't wholly in the window at the start: ${JSON.stringify(start)}`);
  let bad = 0;
  for (const [name, dx, dy] of [['east', 150, 0], ['west', -150, 0], ['south', 0, 150], ['north', 0, -150]]) {
    for (const back of [false, true]) {
      await page.evaluate(([dx, dy]) => {
        const Rc = window.reclaimed;
        const at = Rc.fortress.storesAt();
        Rc.camera.target[0] = at[0] + dx;
        Rc.camera.target[1] = at[1] + dy;
        Rc.camera.zoom = 6;
      }, back ? [0, 0] : [dx, dy]);
      await sleep(6000);
      const p = await probe();
      const same = p.bits === start.bits && p.boxInWindow;
      if (!same) bad++;
      console.log(`${back ? 'back from' : 'panned'} ${name}: origin ${p.origin}, box in window ${p.boxInWindow}, answers ${same ? 'the same' : `DIFFER: ${p.bits}`}`);
      if (!back && name === 'east') await page.screenshot({ path: path.join(OUT, 'keep-panned-east.png') });
      if (!back && name === 'south') await page.screenshot({ path: path.join(OUT, 'keep-panned-south.png') });
    }
  }
  if (bad) throw new Error(`${bad} probes answered differently from the start`);
});
