// The dried river's numbers (docs/design/MUTATORS.md, BACKLOG MU-42): the river draw's inputs read before and after
// `dried` at the home town — the table's depth on the river's columns, the wetness the held river and the tiles read
// (the climate's + the riverWet field), the depth the table gives at that wetness, the water the columns hold, by
// distance from the place. A check's readback, never the game's.
//
//   node scripts/mutators-river.mjs [--dir <folder>] [--wait 50000] [--settle 15000] [--radius 110]
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';

const URL0 = '/?skipmenu=1&level=atlas&town=1&mutlab=1&fresh=1&opps=0&livingpanel=0&pace=0';

await run({ name: 'mutators-river', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const dir = R.opt('dir', null);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const page = await R.page();
  await page.goto(`${R.url}${URL0}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.__boot?.at.store || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(Number(R.opt('wait', 50000)));
  await R.fatal(page);
  const read = () =>
    page.evaluate(async () => {
      const c = reclaimed.core;
      const s = reclaimed.scene;
      const { w, h } = c.dims;
      const rf = (await c.readTexture(c.world.riverFlow)).data;
      // (the field as its owner last made it: weather/wetfield.ts vals — the texture is not readable)
      const wf = s.wetField;
      const rw = { data: wf.vals, w: wf.fw, h: wf.fh };
      const water = await reclaimed.readBuffer('water');
      const src = await reclaimed.readBuffer('waterSource');
      const a = s.opts.atlas;
      const home = a.settlements.settlement(a.startTown);
      const S = s.stream;
      const hx = home.at[0] - S.origin[0];
      const hy = home.at[1] / 0.8660254 - S.origin[1];
      const climate = reclaimed.globals.riverWet;
      const F = 8;
      const wetAt = (x, y) => {
        const tx = (x + 0.5 - 0.5) / F;
        const ty = (y + 0.5 - 0.5) / F;
        const i = Math.floor(tx);
        const j = Math.floor(ty);
        const fx = tx - i;
        const fy = ty - j;
        let e = 0;
        for (let k = 0; k < 4; k++) {
          const ox = k & 1;
          const oy = k >> 1;
          const ci = i + ox;
          const cj = j + oy;
          if (ci < 0 || cj < 0 || ci >= rw.w || cj >= rw.h) continue;
          e += (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy) * rw.data[cj * rw.w + ci];
        }
        return climate + e;
      };
      const bands = [60, 110, 200, 400, 1e9].map((r) => ({ r, n: 0, table: 0, wet: 0, wetMin: 9, held: 0, heldDry: 0, water: 0, waterWet: 0, shut: 0 }));
      let standing = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const tz = rf[i * 4 + 2];
          if (tz <= 0) {
            if (water[i] > 0.05) standing++;
            continue;
          }
          const d = Math.hypot(x - hx, (y - hy) * 0.8660254);
          const b = bands.find((q) => d < q.r);
          const wet = wetAt(x, y);
          let dep = tz + Math.min(rf[i * 4 + 3] * (Math.pow(Math.max(wet, 0), 0.6) - 1), 0.28);
          if (dep < 0.03) dep = 0;
          b.n++;
          b.table += tz;
          b.wet += wet;
          b.wetMin = Math.min(b.wetMin, wet);
          b.held += dep;
          if (dep === 0) b.heldDry++;
          b.water += water[i];
          if (water[i] > 0.05) b.waterWet++;
          if (src[i] < 0) b.shut++;
        }
      const inflow = s.catchWet?.inflow;
      const live = s.catchWet?.live ?? [];
      let low = 0;
      let lowest = 1;
      for (const k of live) {
        if (inflow[k] < 0.99) low++;
        lowest = Math.min(lowest, inflow[k]);
      }
      // (--nodes: the kept river nodes in the window — where (window cells), the node each runs into, its inflow)
      const cw = s.catchWet;
      const nodes = [];
      for (let j = 0; cw && j < live.length; j++) {
        const x = cw.livePos[j * 2];
        const y = cw.livePos[j * 2 + 1] / 0.8660254;
        if (x < 0 || y < 0 || x > w || y > h) continue;
        const nx = Array.prototype.indexOf.call(live, cw.next[live[j]]);
        nodes.push([Math.round(x), Math.round(y), nx < 0 ? null : [Math.round(cw.livePos[nx * 2]), Math.round(cw.livePos[nx * 2 + 1] / 0.8660254)], +inflow[live[j]].toFixed(2), Math.round(cw.g.catchments.ref[live[j]])]);
      }
      const f = (v) => +v.toFixed(3);
      return {
        dims: [w, h],
        nodes: window.__riverNodes ? nodes : undefined,
        home: [f(hx), f(hy)],
        climate: f(climate),
        riverInflow: [...s.riverInflow],
        region: a.settlements.regionAt(home.at[0], home.at[1]),
        liveNodes: live.length,
        fieldUploads: wf.uploads,
        liveLowered: low,
        liveLowest: f(lowest),
        standingNotRiver: standing,
        awake: s.sleep ? s.sleep.awake : null,
        bands: bands.map((b) => ({ within: b.r, columns: b.n, table: f(b.table / (b.n || 1)), wet: f(b.wet / (b.n || 1)), wetMin: f(b.wetMin), heldDepth: f(b.held / (b.n || 1)), heldDry: b.heldDry, water: f(b.water / (b.n || 1)), waterWet: b.waterWet, sourceShut: b.shut })),
      };
    });
  const shot = async (name) => {
    if (!dir) return;
    await page.evaluate(() => {
      for (const e of document.body.querySelectorAll('div, button, select')) if (!e.querySelector('canvas')) e.style.visibility = 'hidden';
    });
    await sleep(300);
    await page.screenshot({ path: path.join(dir, name) });
    console.log(`saved ${path.join(dir, name)}`);
  };
  console.log(`[before] ${JSON.stringify(await read())}`);
  await shot('river-before.png');
  const radius = Number(R.opt('radius', 110));
  await page.evaluate((radius) => void mutators.apply({ kind: 'dried', place: reclaimed.scene.opts.atlas.startTown, radius, seed: 5 }), radius);
  await sleep(Number(R.opt('settle', 15000)));
  await R.fatal(page);
  if (R.flag?.('nodes') || process.argv.includes('--nodes')) await page.evaluate(() => void (window.__riverNodes = true));
  console.log(`[after] ${JSON.stringify(await read())}`);
  await shot('river-after.png');
});
