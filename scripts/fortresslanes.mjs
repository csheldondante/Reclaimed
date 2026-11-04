// (round 128f) Roads narrower than a cell (fortress/lanes.ts): a second grid's lanes inside the tiles, dense in the town,
// sparse tracks in the fields, along the contours on a slope with stepped lanes climbing it; the main roads a lane wide.
// A walled ring with a gate, the keep, houses and a warehouse, a farm outside, planned by the API on a flat dry site near
// the town and again on a hillside; the lanes' numbers printed, shots at play zoom while planning and built.
// (round 128i) Then Build: the builders at work for BUILD_S, and how often a walking builder stands on a road or lane
// (the agents' road bits are stamped on the GPU from the fortress's shapes) against the roads' share of the ground
// round the town; a GIF at play zoom (lanes-<kind>.gif).
//   node scripts/fortresslanes.mjs [--out C:/Projects/Reclaimed-fortress/fortress]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
const FIELD = 9;
const BUILD_S = Number(process.env.BUILD_S ?? 40);
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
        roadShapes: f.roadShapes().length / 12,
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
    // ---- build: the builders walk the lanes
    await page.evaluate(() => {
      const c = window.reclaimed.camera;
      c.target[1] += 160 / 3.2 * 0.5 - 160 / 7 * 0.5;
      c.zoom = 3.2;
      [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Build').click();
    });
    const t0 = Date.now();
    let on = 0;
    let walking = 0;
    let share = null;
    while (Date.now() - t0 < BUILD_S * 1000) {
      await sleep(1000);
      await R.fatal(page);
      const r = await page.evaluate(() => {
        const Rc = window.reclaimed;
        const f = Rc.fortress;
        const life = Rc.fortressLife();
        if (!life) return null;
        const S = f.roadShapes();
        const n = S.length / 12;
        const sd = (px, py, ax, ay, bx, by) => {
          const dx = bx - ax;
          const dy = by - ay;
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / Math.max(dx * dx + dy * dy, 1e-12)));
          return Math.hypot(px - ax - dx * t, py - ay - dy * t);
        };
        // (agents/roads.ts roadInside)
        const inside = (x, y) => {
          for (let i = 0; i < n; i++) {
            const o = i * 12;
            if (S[o + 9] < 0.5) {
              if (sd(x, y, S[o], S[o + 1], S[o + 2], S[o + 3]) <= S[o + 8]) return true;
              continue;
            }
            const P = [0, 2, 4, 6].map((k) => [S[o + k], S[o + k + 1]]);
            const cr = P.map((a, k) => {
              const b = P[(k + 1) % 4];
              return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
            });
            if (cr.every((v) => v >= 0) || cr.every((v) => v <= 0)) return true;
          }
          return false;
        };
        let on = 0;
        let walking = 0;
        const pts = [];
        for (const id of life.people()) {
          const u = Rc.units.get(id);
          if (!u || u.state !== 'walk') continue;
          const [bx, by] = f.toBox(u.at[0], u.at[1]);
          walking++;
          pts.push([bx, by]);
          if (inside(bx, by)) on++;
        }
        // the roads' share of the ground the walkers walk: the box round them
        let share = null;
        if (pts.length) {
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          const [x0, x1, y0, y1] = [Math.min(...xs) - 4, Math.max(...xs) + 4, Math.min(...ys) - 4, Math.max(...ys) + 4];
          let a = 0;
          let k = 0;
          for (let x = x0; x <= x1; x += 1.5)
            for (let y = y0; y <= y1; y += 1.5) {
              k++;
              if (inside(x, y)) a++;
            }
          share = a / k;
        }
        return { on, walking, share };
      });
      if (!r) continue;
      on += r.on;
      walking += r.walking;
      if (r.share !== null) share = share === null ? r.share : (share + r.share) / 2;
    }
    console.log('walkers', JSON.stringify({ kind, onRoad: on, walking, onRoadShare: walking ? +(on / walking).toFixed(2) : null, roadAreaShare: share === null ? null : +share.toFixed(2) }));
    if (OUT) {
      await page.screenshot({ path: `${OUT}/lanes-${kind}-build.png` });
      const enc = GIFEncoder();
      for (let i = 0; i < 36; i++) {
        const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
        const pal = quantize(png.data, 256);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 120 });
        await sleep(120);
      }
      enc.finish();
      fs.writeFileSync(`${OUT}/lanes-${kind}.gif`, enc.bytes());
    }
    // back to planning for the next site
    await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Plan')?.click());
    await sleep(1000);
  }
});
