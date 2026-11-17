// (loop round 11) The town's paving looked at: the top material under points along each road and round the square
// (the world API's surface pages), and stills of one road point and the square at three zooms (px a cell), 412x915 —
// to tell which surface reads as a speckle and at what zoom.
//   node scripts/lab/pavelook.mjs [--out dir] [--tag t] [--params ...]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'pavelook', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'pavelook');
  const tag = R.opt('tag', 'look');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0${R.opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => (window.rungame.pick('ysolt'), window.rungame.closePanel()));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(5000);
  const pts = await p.evaluate(async () => {
    const t = [...window.citygen.live.values()][0];
    const T = window.reclaimed.scene.worldApi.terrain;
    const c = t.centreInWindow();
    const res = { square: {}, roads: [] };
    const mat = async (x, y) => {
      await T.load(x - 1, y - 1, x + 1, y + 1);
      return T.surfaceAt(x, y)?.mat ?? 'none';
    };
    for (let a = 0; a < 8; a++) {
      const m = await mat(c[0] + 8 * Math.cos(a), c[1] + 8 * Math.sin(a));
      res.square[m] = (res.square[m] ?? 0) + 1;
    }
    for (let k = 0; k < t.roadCount; k++) {
      const row = { k, mats: [] };
      for (const q of t.roadInWindow(k)) {
        const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
        if (d > 20 && d < 90 && T.inWindow(q[0], q[1])) row.mats.push(`${d.toFixed(0)}:${await mat(q[0], q[1])}`);
      }
      res.roads.push(row);
    }
    const line = t.roadInWindow(2);
    const at = line.find((q) => Math.hypot(q[0] - c[0], q[1] - c[1]) > 40) ?? line[line.length - 1];
    return { ...res, centre: c, road: at };
  });
  R.log(JSON.stringify(pts));
  for (const [name, at] of [['road', pts.road], ['square', pts.centre]]) {
    for (const z of [6, 16, 32]) {
      await p.evaluate(
        (q, zz) => {
          window.reclaimed.core.camera.elevation = (55 * Math.PI) / 180;
          return window.rungame.cam.look([q[0], q[1], window.rungame.z?.(q[0], q[1]) ?? 0], { zoom: zz, ease: 0.2, place: [0.5, 0.4] });
        },
        at,
        z,
      );
      await R.sleep(2500);
      await p.screenshot({ path: path.join(out, `${tag}-${name}-z${z}.png`) });
    }
  }
});
