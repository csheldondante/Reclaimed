// (round 128f) Roads narrower than a cell (fortress/lanes.ts): a second grid's lanes inside the tiles, dense in the town,
// sparse tracks in the fields, along the contours on a slope with stepped lanes climbing it; the main roads a lane wide.
// A walled ring with a gate, the keep, houses and a warehouse, a farm outside, planned by the API on a flat dry site near
// the town and again on a hillside; the lanes' numbers printed, shots at play zoom while planning and built.
//   node scripts/fortresslanes.mjs [--out C:/Projects/Reclaimed-fortress/fortress]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
const FIELD = 9;
await run({ name: 'fortresslanes', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const page = await R.page();
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1&tod=0.3&day=30000&speed=6`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(2000);
  for (const kind of ['flat', 'hill']) {
    const info = await page.evaluate(async (FIELD, kind) => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      // (the previous site's plan erased)
      for (const s of [...f.plan.structures()]) for (const c of [...s.cells.keys()]) for (const l of [...f.plan.levels.each(c)].reverse()) f.erase?.(c, l);
      const st = Rc.settlements;
      const rec = st.settlement(st.pinnedId);
      const [tx, ty] = st.toWindow(rec.at);
      const rd0 = Rc.units.agents.reader(FIELD);
      await rd0.refresh();
      const groundAt = (x, y) => {
        const r = Math.round(y / (Math.sqrt(3) / 2));
        const k = Math.round(x);
        const { w, h } = Rc.core.dims;
        if (k < 40 || r < 40 || k >= w - 40 || r >= h - 40) return NaN;
        if (f.windowToBoxCol(r * w + k) < 0) return NaN;
        const q = rd0.sample(x, y);
        return q && q.z > 0 ? q.z : NaN;
      };
      // a site: every column round it known; flat (within 1.5 m) or a hillside (a mean rise of 1 in 8 to 1 in 3, no cliff)
      let site = null;
      let best = 0;
      for (let r = kind === 'flat' ? 30 : 60; r <= 115 && !site; r += 5)
        for (let a = 0; a < 32 && !site; a++) {
          const x = tx + Math.cos((a / 32) * Math.PI * 2) * r;
          const y = ty + Math.sin((a / 32) * Math.PI * 2) * r;
          const g0 = groundAt(x, y);
          if (!Number.isFinite(g0)) continue;
          let ok = true;
          let sx = 0;
          let sy = 0;
          let n = 0;
          let steep = 0;
          for (let dx = -26; dx <= 26 && ok; dx += 2)
            for (let dy = -40; dy <= 26 && ok; dy += 2) {
              const z = groundAt(x + dx, y + dy);
              ok = Number.isFinite(z);
              if (!ok) break;
              if (kind === 'flat') ok = Math.abs(z - g0) < 1.5;
              else {
                const z2 = groundAt(x + dx + 2, y + dy);
                const z3 = groundAt(x + dx, y + dy + 2);
                if (Number.isFinite(z2) && Number.isFinite(z3)) steep = Math.max(steep, Math.hypot(z2 - z, z3 - z) / 2);
                sx += dx * (z - g0);
                sy += dy * (z - g0);
                n += dx * dx;
              }
            }
          if (!ok) continue;
          if (kind === 'flat') site = [x, y];
          else {
            const s = Math.hypot(sx / n, sy / (n * 1.5));
            if (s > 0.08 && s < 0.4 && steep < 1.6 && s > best) {
              best = s;
              site = [x, y];
            }
          }
        }
      if (!site) return { error: `no ${kind} site` };
      const [cx, cy] = site;
      const ring = f.ringCells(cx, cy, 16);
      for (const c of ring) f.paint(c, 0, 'wall');
      const byX = [...ring].sort((a, b) => f.centre(b)[0] - f.centre(a)[0]);
      byX.find((c) => f.setGate(c, true));
      const keep = f.cellAt(cx, cy);
      f.paint(keep, 0, 'fortress');
      f.paint(keep, 1, 'fortress');
      for (const [dx, dy, t] of [[-8, 5, 'house'], [-9, -4, 'house'], [5, 8, 'house'], [4, -9, 'warehouse']]) {
        const c = f.cellAt(cx + dx, cy + dy);
        if (f.plan.owner[c] < 0) f.paint(c, 0, t);
      }
      f.paint(f.cellAt(cx + 30, cy + 6), 0, 'farm');
      f.paint(f.cellAt(cx + 32, cy + 6), 0, 'farm');
      const L = f.lanes();
      const w = f.ways();
      const byKind = {};
      const lenOf = {};
      for (const s of L.segs) {
        byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
        lenOf[s.kind] = Math.round((lenOf[s.kind] ?? 0) + Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]));
      }
      Rc.camera.target[0] = cx;
      // (the panel covers the screen's lower part: the site a little above the middle)
      Rc.camera.target[1] = cy + 160 / 3.2 * 0.5;
      Rc.camera.zoom = 3.2;
      return {
        kind,
        site: [Math.round(cx - tx), Math.round(cy - ty)],
        slope: +L.slope.toFixed(3),
        contour: +L.contour.toFixed(2),
        uphill: L.uphill.map((v) => +v.toFixed(2)),
        segs: byKind,
        metres: lenOf,
        steps: L.segs.filter((s) => s.steps).length,
        doors: w.doors.length,
        cutOff: w.cutOff.length,
        roadCols: f.roadCols().length,
        bar: document.querySelector('.fort-bar')?.innerText?.replace(/\s+/g, ' ').slice(0, 300),
      };
    }, FIELD, kind);
    console.log('lanes', JSON.stringify(info));
    if (info.error) continue;
    await sleep(2500);
    if (OUT) await page.screenshot({ path: `${OUT}/lanes-${kind}.png` });
    // a closer look
    await page.evaluate(() => {
      const c = window.reclaimed.camera;
      c.target[1] -= 160 / 3.2 * 0.5 - 160 / 7 * 0.5;
      c.zoom = 7;
    });
    await sleep(1500);
    if (OUT) await page.screenshot({ path: `${OUT}/lanes-${kind}-near.png` });
  }
});
