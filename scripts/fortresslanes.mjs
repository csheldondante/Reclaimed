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
  for (const kind of (process.env.KINDS ?? 'flat,hill').split(',')) {
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
      // (round 128l, m4: the fortress reads no columns back any more — the water read here)
      const wbuf = await Rc.core.readBuffer('water');
      const groundAt = (x, y) => {
        const r = Math.round(y / (Math.sqrt(3) / 2));
        const k = Math.round(x);
        const { w, h } = Rc.core.dims;
        if (k < 40 || r < 40 || k >= w - 40 || r >= h - 40) return NaN;
        const bc = f.windowToBoxCol(r * w + k);
        if (bc < 0) return NaN;
        // (no sites in water)
        if (wbuf[r * w + k] > 0.1) return NaN;
        // (the fortress's ground as it was: the surface read, not the agents' surfaces — those are kept only round the
        // units, so the candidates came and went between runs)
        const z = f.groundOfCol(bc);
        return Number.isFinite(z) && z > 0 ? z : NaN;
      };
      // a site: every column round it known; flat (within 1.5 m) or a hillside (a mean rise of 1 in 20 to 1 in 3, no
      // cliff); the candidates in order (flat: nearest the town first; a hillside: steepest first), each planned until
      // one takes the whole plan (a spot across deep water from the stores is refused)
      const cands = [];
      for (let r = kind === 'flat' ? 30 : 50; r <= 160; r += 5)
        for (let a = 0; a < 32; a++) {
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
          const sl = kind === 'flat' ? 0 : Math.hypot(sx / n, sy / (n * 1.5));
          if (kind === 'hill' && !(sl > 0.05 && sl < 0.4 && steep < 1.8)) continue;
          cands.push({ x, y, sl, r });
        }
      if (kind === 'hill') cands.sort((p, q) => q.sl - p.sl);
      const erase = () => {
        for (const s of [...f.plan.structures()]) for (const c of [...s.cells.keys()]) for (const l of [...f.plan.levels.each(c)].reverse()) f.erase?.(c, l);
      };
      let site = null;
      for (const cd of cands.slice(0, 12)) {
        erase();
        try {
        const [cx, cy] = [cd.x, cd.y];
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
        // (round 128i: work to haul — the farm bigger, a quarry the other side: grain and stone carried to the warehouse)
        for (const [dx, dy] of [[30, 12], [36, 6], [36, 12]]) f.paint(f.cellAt(cx + dx, cy + dy), 0, 'farm');
        for (const [dx, dy] of [[-30, 6], [-30, 12], [-36, 6]]) f.paint(f.cellAt(cx + dx, cy + dy), 0, 'quarry');
        const types = new Set(f.plan.structures().map((s) => s.type));
        if (['fortress', 'house', 'warehouse', 'farm', 'wall', 'quarry'].every((t) => types.has(t)) && !f.ways().cutOff.length) {
          site = [cx, cy, cd.sl];
          break;
        }
        } catch (e) {
          // (a candidate whose plan reaches past the box)
        }
      }
      if (!site) {
        erase();
        return { error: `no ${kind} site (${cands.length} candidates)` };
      }
      const [cx, cy] = site;
      // (the stores topped up: the whole plan stands, so the people's work is watched, not a wait for stone)
      // (stone for the plan: within the town's room, so the farms' grain still fits once it's built)
      if (rec.stores.stone) rec.stores.stone.stock = Math.max(rec.stores.stone.stock, 200);
      if (rec.stores.log) rec.stores.log.stock = Math.max(rec.stores.log.stock, 60);
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
        keepBox: f.toBox(cx, cy),
        siteSlope: +site[2].toFixed(3),
        segs: byKind,
        metres: lenOf,
        steps: L.segs.filter((s) => s.steps).length,
        tiles: L.tiles.length,
        unjoined: L.unjoined.length,
        doors: w.doors.length,
        cutOff: w.cutOff.length,
        roadShapes: f.roadShapes().length / 12,
        bar: document.querySelector('.fort-bar')?.innerText?.replace(/\s+/g, ' ').slice(0, 300),
      };
    }, FIELD, kind);
    console.log('lanes', JSON.stringify(info));
    if (info.error) continue;
    // (EVAL_FILE: a diagnostic expression evaluated on the planned site, its value printed)
    if (process.env.EVAL_FILE) console.log('eval', await page.evaluate(fs.readFileSync(process.env.EVAL_FILE, 'utf8')));
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
    // (the view: the keep, in the box's frame — the window may slide meanwhile)
    const view = info.keepBox;
    await page.evaluate(() => {
      const c = window.reclaimed.camera;
      c.target[1] += 160 / 3.2 * 0.5 - 160 / 7 * 0.5;
      c.zoom = 3.2;
      [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Build').click();
    });
    // (round 128i, V128-14) everything built at once (the script stands every block: the builders' trips are watched in
    // lanes-<kind>-build.png before), then the people's work — the farms' grain hauled to the warehouse, home to the
    // houses — watched at play zoom over the site
    await sleep(6000);
    if (OUT) await page.screenshot({ path: `${OUT}/lanes-${kind}-builders.png` });
    await page.evaluate((view) => {
      const f = window.reclaimed.fortress;
      for (let pass = 0; pass < 8; pass++)
        for (const c of f.todoCells())
          for (const l of [...f.plan.levels.each(c)])
            if (!f.town.has(c, l))
              try {
                f.markBuilt(c, l);
              } catch {
                // (a block on one not yet standing: the next pass)
              }
      const c = window.reclaimed.camera;
      const [vx, vy] = f.toWindow(view[0], view[1]);
      c.target[0] = vx;
      c.target[1] = vy + (160 / 3.2) * 0.5;
      c.zoom = 3.2;
    }, view);
    await sleep(15000);
    // (DIAG=1: each riding unit's ride, a line a second for DIAG_S)
    for (let k = 0; process.env.DIAG && k < Number(process.env.DIAG_S ?? 20); k++) {
      await sleep(1000);
      const d = await page.evaluate(async () => {
        const Rc = window.reclaimed;
        const A = Rc.units.agents;
        const dev = A.device;
        const read = async (src, size) => {
          const tmp = dev.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
          const enc = dev.createCommandEncoder();
          enc.copyBufferToBuffer(src, 0, tmp, 0, size);
          dev.queue.submit([enc.finish()]);
          await tmp.mapAsync(GPUMapMode.READ);
          const out = tmp.getMappedRange().slice(0);
          tmp.destroy();
          return out;
        };
        const n = A.count;
        const rf = A.reader(12);
        await rf.refresh();
        const rp = A.reader(15 % 13);
        await rp.refresh();
        const U = new Float32Array(await read(A.units, n * 80));
        const UU = new Uint32Array(U.buffer);
        const S = new Uint32Array(await read(A.roadRide.state, n * 16));
        const g = A.roadRide.graph;
        const off = A.roadRide.off;
        const rows = [];
        for (let u = 0; u < n; u++) {
          const info = UU[u * 20 + 3];
          if (!((info >> 8) & 1)) continue;
          const grp = info & 0xff;
          const x = U[u * 20] - off[0];
          const y = U[u * 20 + 1] - off[1] * Math.sqrt(3) / 2;
          const node = S[u * 4 + 1];
          const nd = node < g.xy.length / 2 ? Math.hypot(g.xy[node * 2] - x, g.xy[node * 2 + 1] - y) : -1;
          const fq = rf.sample(U[u * 20], U[u * 20 + 1]);
          rows.push(`f${fq ? (Number.isFinite(fq.dist) ? fq.dist.toFixed(1) : 'inf') : '-'} u${u} g${grp} st${(info >> 12) & 7} m${S[u * 4]} n${node} d${nd.toFixed(1)} s${U[u * 20 + 19].toFixed(2)} v${Math.hypot(U[u * 20 + 4], U[u * 20 + 5]).toFixed(2)} @${x.toFixed(1)},${y.toFixed(1)}`);
        }
        const R = A.roadRide;
        // (each riding unit off the network: the nodes within 4.5 m and whether its goal's node is reached from them)
        const reach = (from) => {
          const seen = new Set([from]);
          const todo = [from];
          while (todo.length) {
            const v = todo.pop();
            for (let k = g.start[v]; k < g.start[v] + g.count[v]; k++) {
              const t = g.adj[k * 2];
              if (!seen.has(t)) {
                seen.add(t);
                todo.push(t);
              }
            }
          }
          return seen;
        };
        const near = (x, y) => {
          let b = -1;
          let bd = 1e9;
          for (let v = 0; v < g.xy.length / 2; v++) {
            const d = Math.hypot(g.xy[v * 2] - x, g.xy[v * 2 + 1] - y);
            if (d < bd) {
              bd = d;
              b = v;
            }
          }
          return [b, bd];
        };
        for (let u = 0; u < n; u++) {
          const info = UU[u * 20 + 3];
          const grp = info & 0xff;
          if (!R.goals[grp] || S[u * 4] !== 0) continue;
          const x = U[u * 20] - off[0];
          const y = U[u * 20 + 1] - off[1] * Math.sqrt(3) / 2;
          const [gn, gd] = near(R.goals[grp][0][0], R.goals[grp][0][1]);
          const net = reach(gn);
          const close = [];
          for (let v = 0; v < g.xy.length / 2; v++) {
            const d = Math.hypot(g.xy[v * 2] - x, g.xy[v * 2 + 1] - y);
            if (d < 4.5) close.push(`${v}:${d.toFixed(1)}:${net.has(v) ? 'net' : 'off'}`);
          }
          const [nn, nd] = near(x, y);
          rows.unshift(`OFF u${u} g${grp} goalnode ${gn}@${gd.toFixed(1)} net ${net.size}/${g.xy.length / 2} near ${nn}@${nd.toFixed(1)} ${net.has(nn) ? 'net' : 'off'} close [${close.join(' ')}]`);
        }
        rows.unshift(`armed ${R.armed} riding ${R.riding} goals ${JSON.stringify(R.goals.map((q) => q && q.length))} stw ${[...Array(n).keys()].map((u) => S[u * 4 + 3]).join(',')}`);
        return rows.join(' | ');
      });
      console.log('diag', d);
    }
    // (LOOK_AT=x,y: a close shot of a box point after the build — a diagnostic)
    if (process.env.LOOK_AT && OUT) {
      await page.evaluate((p) => {
        const c = window.reclaimed.camera;
        const [x, y] = window.reclaimed.fortress.toWindow(p[0], p[1]);
        c.target[0] = x;
        c.target[1] = y + (160 / 12) * 0.5;
        c.zoom = 12;
      }, process.env.LOOK_AT.split(',').map(Number));
      await sleep(2000);
      await page.screenshot({ path: `${OUT}/look-${kind}.png` });
    }
    console.log('built', JSON.stringify(await page.evaluate(() => (document.querySelector('.fort-bar')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400))));
    await page.evaluate((view) => {
      const c = window.reclaimed.camera;
      const [vx, vy] = window.reclaimed.fortress.toWindow(view[0], view[1]);
      c.target[0] = vx;
      c.target[1] = vy + (160 / 3.2) * 0.5;
      c.zoom = 3.2;
    }, view);
    const t0 = Date.now();
    let on = 0;
    let walking = 0;
    let share = null;
    let last = null;
    while (Date.now() - t0 < BUILD_S * 1000) {
      await sleep(1000);
      await R.fatal(page);
      const r = await page.evaluate(async () => {
        const Rc = window.reclaimed;
        const f = Rc.fortress;
        const life = Rc.fortressCrowd();
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
        // (round 128p, U1: where they stand asked of the GPU)
        const where = new Map((await Rc.units.query([0, 0], 1e7)).map((v) => [v.id, v.at]));
        for (const id of life.people()) {
          const u = Rc.units.get(id);
          const p = where.get(id);
          if (!u || u.state !== 'walk' || !p) continue;
          const [bx, by] = f.toBox(p[0], p[1]);
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
        // (round 128i, V128-14) the legs riding the road graph, its nodes, the fields seeded now
        const A = Rc.units.agents;
        let fields = 0;
        for (const s of A.seeds) fields |= 1 << s.field;
        if (A.rideInfo.riding) fields |= 1 << 12;
        const nf = fields.toString(2).split('').filter((b) => b === '1').length;
        return { on, walking, share, ride: life.riding, nodes: A.rideInfo.nodes, fields: nf };
      });
      if (!r) continue;
      last = r;
      on += r.on;
      walking += r.walking;
      if (r.share !== null) share = share === null ? r.share : (share + r.share) / 2;
    }
    console.log('walkers', JSON.stringify({ kind, onRoad: on, walking, onRoadShare: walking ? +(on / walking).toFixed(2) : null, roadAreaShare: share === null ? null : +share.toFixed(2), ride: last?.ride, nodes: last?.nodes, fieldsSeeded: last?.fields }));
    if (OUT) {
      await page.screenshot({ path: `${OUT}/lanes-${kind}-build.png` });
      const gif = async (name, frames) => {
        const enc = GIFEncoder();
        for (let i = 0; i < frames; i++) {
          const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
          const pal = quantize(png.data, 256);
          enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 120 });
          await sleep(120);
        }
        enc.finish();
        fs.writeFileSync(`${OUT}/${name}.gif`, enc.bytes());
      };
      // (play zoom, then closer: the people on the lanes)
      await gif(`lanes-${kind}`, 36);
      await page.evaluate((view) => {
        const c = window.reclaimed.camera;
        const [vx, vy] = window.reclaimed.fortress.toWindow(view[0], view[1]);
        c.target[0] = vx;
        c.target[1] = vy + (160 / 6) * 0.5;
        c.zoom = 6;
      }, view);
      await sleep(1500);
      await gif(`lanes-${kind}-near`, 24);
      // (closer still, on the walkers: the camera on the middle of those walking)
      await page.evaluate(async () => {
        const Rc = window.reclaimed;
        const life = Rc.fortressCrowd();
        const where = new Map((await Rc.units.query([0, 0], 1e7)).map((v) => [v.id, v.at]));
        const pts = life.people().map((id) => Rc.units.get(id)).filter((u) => u && u.state === 'walk' && where.has(u.id)).map((u) => where.get(u.id));
        if (!pts.length) return;
        pts.sort((a, b) => a[0] - b[0]);
        const m = pts[Math.floor(pts.length / 2)];
        const c = Rc.camera;
        c.target[0] = m[0];
        c.target[1] = m[1] + (160 / 14) * 0.5;
        c.zoom = 14;
      });
      await sleep(1500);
      await gif(`lanes-${kind}-walkers`, 24);
    }
    // back to planning for the next site
    await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Plan')?.click());
    await sleep(1000);
  }
});
