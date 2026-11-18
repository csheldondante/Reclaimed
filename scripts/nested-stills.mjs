// Nested scales stills (round 6, the box draw): the watertight suite's scene (src/nested/suite.ts: a mound with a
// tunnel through it, a blob on a stalk, a mid-air blob, an arch, a stroke across a level rim), shot from the round's
// cameras; a plain hillside at levels 0-2 (and 3) of one spot with how much detail each level adds; a zoom GIF from the
// map to the finest level; and a carve at the finest level that must come back bit for bit after zooming out and in.
// node scripts/nested-stills.mjs --chromeargs ignore-certificate-errors [--only a,b] [--out dir] [--tag -box]
//   [--port 5461]
import { run, sleep } from './lib/runner.mjs';
import * as gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
// (gifenc is CommonJS: its functions arrive on the default export)
const { GIFEncoder, quantize, applyPalette } = gifenc.GIFEncoder ? gifenc : gifenc.default;

await run({ name: 'stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'local/nested');
  const tag = R.opt('tag', '-box');
  const port = R.opt('port', '5461');
  const only = (R.opt('only', '') || '').split(',').filter(Boolean);
  const want = (n) => !only.length || only.includes(n);
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(1500);
  const shot = async (name, v, wait = 3500, tint = false) => {
    await page.evaluate(
      ([v, tint]) => {
        nested.tint(tint);
        nested.setView(v);
      },
      [v, tint],
    );
    await sleep(wait);
    const st = await page.evaluate(() => ({ live: nested.state().live, eye: nested.eye() }));
    await page.screenshot({ path: `${out}/${name}${tag}.png` });
    console.log(`${name}: ${st.live} levels, eye ${[st.eye.x, st.eye.y, st.eye.z].map((x) => x.toFixed(2)).join(', ')}`);
    await page.evaluate(() => nested.tint(false));
  };
  // (1) the plain hillside before any edit, one spot at each level, and the detail each level adds
  if (want('hillside')) {
    const spot = await page.evaluate(() => {
      const e = nested.eye();
      const f = nested.app.forward();
      return [e.x + f[0] * e.dHit + 18, e.y + f[1] * e.dHit - 22];
    });
    const ground = async () => page.evaluate(() => nested.eye());
    for (const [L, d, pitch] of [
      [0, 40, 0.6],
      [1, 5, 0.55],
      [2, 0.6, 0.5],
      [3, 0.08, 0.5],
    ]) {
      // (back from the spot along the view by d world units, at the pitch)
      await page.evaluate(([x, y, d, pitch]) => nested.setView({ tx: x, ty: y, d, yaw: 0.7, pitch }), [spot[0], spot[1], d, pitch]);
      await sleep(4000);
      const st = await page.evaluate(() => nested.state().live);
      await page.screenshot({ path: `${out}/hillside-L${L}${tag}.png` });
      console.log(`hillside L${L}: ${st} levels live (eye ${JSON.stringify(await ground())})`);
    }
    // the detail each level adds over the same spot: per live level, the mean |top - the parent's top under it| (local
    // units of that level) over its window, and as world units
    const det = await page.evaluate(async () => {
      const a = nested.app;
      const s = await a.nest.readAll();
      const out = [];
      for (let L = 1; L < a.nest.live; L++) {
        const w = a.nest.wins[L];
        const zo = s.zOrigin(L);
        let sum = 0;
        let n = 0;
        let maxd = 0;
        for (let y = 0; y < w.n; y += 3)
          for (let x = 0; x < w.n; x += 3) {
            const c = s.column(L, w.gx + x, w.gy + y);
            const p = s.column(L - 1, Math.floor((w.gx + x) / 8), Math.floor((w.gy + y) / 8));
            const d = Math.abs(c.z1[c.z1.length - 1] - (p.z1[p.z1.length - 1] - zo) * 8);
            sum += d;
            maxd = Math.max(maxd, d);
            n++;
          }
        out.push({ L, meanLocal: sum / n, maxLocal: maxd, meanWorld: sum / n / 8 ** L });
      }
      return out;
    });
    for (const d of det) console.log(`detail at level ${d.L}: mean |top - parent's top| ${d.meanLocal.toFixed(3)} of its columns (max ${d.maxLocal.toFixed(2)}), ${(d.meanWorld * 100).toFixed(2)} cm world`);
  }
  // (2) the zoom GIF from the map to the finest level, over a plain spot
  if (want('gif')) {
    const spot = await page.evaluate(() => {
      const e = nested.eye();
      const f = nested.app.forward();
      return [e.x + f[0] * e.dHit + 18, e.y + f[1] * e.dHit - 22];
    });
    await page.evaluate(([x, y]) => nested.setView({ tx: x, ty: y, d: 120, yaw: 0.7, pitch: 0.75 }), spot);
    await sleep(3000);
    const enc = GIFEncoder();
    const lv = [];
    for (let i = 0; i < 70; i++) {
      // (the eye backed off from the spot by 120 world units down to 5 cm, geometrically)
      await page.evaluate(([x, y, d]) => nested.setView({ tx: x, ty: y, d, yaw: 0.7, pitch: 0.75 }), [spot[0], spot[1], 120 * (0.05 / 120) ** (i / 69)]);
      await sleep(i % 10 === 9 ? 900 : 160);
      const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 960, height: 640 } })));
      // (half size: the GIF stays small)
      const w = 480;
      const h = 320;
      const half = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) half[(y * w + x) * 4 + c] = png.data[(y * 2 * 960 + x * 2) * 4 + c];
      const pal = quantize(half, 256);
      enc.writeFrame(applyPalette(half, pal), w, h, { palette: pal, delay: 110 });
      if (i % 10 === 0) lv.push(await page.evaluate(() => nested.state().live));
    }
    enc.finish();
    fs.writeFileSync(`${out}/zoom${tag}.gif`, enc.bytes());
    console.log(`zoom gif: levels live along it ${JSON.stringify(lv)}`);
  }
  // (3) the scene, and the stills round it
  const h = await page.evaluate(async () => {
    const { watertightSuite } = await import('/src/nested/suite.ts');
    nested.setView({ tx: 100, ty: 140, d: 8, yaw: 0, pitch: 0.3 });
    await new Promise((r) => setTimeout(r, 3000));
    const e = nested.eye();
    const f = nested.app.forward();
    const h = [e.x + f[0] * e.dHit, e.y + f[1] * e.dHit, e.z + f[2] * e.dHit];
    await watertightSuite(window.nested, { manifold: false, screen: false });
    return h;
  });
  const [hx, hy, hz] = h;
  const tz = hz + 1.3;
  if (want('scene')) {
    await shot('tunnel-outside', { yaw: 0, pitch: 0.03, eye: [hx + 7, hy, tz + 0.2] });
    await shot('tunnel-inside-d2', { yaw: 0, pitch: 0.0, eye: [hx + 0.3, hy, tz - 0.1] }, 4500);
    await shot('tunnel-mouth', { yaw: 0, pitch: 0.05, eye: [hx + 2.6, hy + 0.2, tz] }, 4500);
    await shot('tunnel-rim', { yaw: Math.PI, pitch: 0.0, eye: [hx - 0.6, hy, tz - 0.1] }, 4500);
    await shot('tunnel-rim-tint', { yaw: Math.PI, pitch: 0.0, eye: [hx - 0.6, hy, tz - 0.1] }, 2500, true);
    await shot('arch', { yaw: Math.PI, pitch: 0.1, eye: [hx - 9, hy, hz + 1.2] });
    await shot('stalk', { yaw: 0, pitch: 0.1, eye: [hx + 6, hy + 5, hz + 2.5] });
    await shot('blob-midair', { yaw: Math.PI / 2, pitch: 0.2, eye: [hx + 4, hy - 8, hz + 3.5] });
    await shot('rim-overview-tint', { yaw: 0.3, pitch: 0.5, eye: [hx + 9, hy + 3, hz + 5] }, 4500, true);
  }
  // (4) an edit at the finest level survives zooming out and back in, bit for bit
  if (want('survive')) {
    // (close to plain ground, so the finest level open is level 2 or 3)
    await page.evaluate(([x, y]) => nested.setView({ tx: x, ty: y, d: 0.25, yaw: 0.7, pitch: 0.5 }), [hx + 9.4, hy - 3]);
    await sleep(6000);
    const r = await page.evaluate(async () => {
      const W = (ms) => new Promise((s) => setTimeout(s, ms));
      const a = nested.app;
      const L = a.nest.live - 1;
      const w = a.nest.wins[L];
      const s0 = await a.nest.readAll();
      const cx = w.gx + w.n / 2;
      const cy = w.gy + w.n / 2;
      const c0 = s0.column(L, cx, cy);
      const top = c0.z1[c0.z1.length - 1];
      while (!a.nest.edit({ op: 'carve', radius: 12 / 8 ** L, amount: 0, at: { level: L, x: w.n / 2 + 0.5, y: w.n / 2 + 0.5, z: top } })) await W(30);
      await W(300);
      const grab = async () => {
        const s = await a.nest.readAll();
        const out = [];
        for (let y = -16; y < 16; y++) for (let x = -16; x < 16; x++) out.push(JSON.stringify(s.records(L, cx + x, cy + y)));
        return out;
      };
      const before = await grab();
      const win = { ...w };
      // zoom out until level L is demoted, then back to the same view
      const view = { ...nested.eye() };
      nested.setView({ tx: view.x, ty: view.y, d: 60, yaw: 0.7, pitch: 0.6 });
      for (let i = 0; i < 100 && a.nest.live > L; i++) await W(50);
      const demoted = a.nest.live <= L;
      nested.setView({ yaw: 0.7, pitch: 0.5, eye: [view.x, view.y, view.z] });
      for (let i = 0; i < 200 && (a.nest.live <= L || JSON.stringify(a.nest.wins[L]) !== JSON.stringify(win)); i++) await W(50);
      await W(500);
      const back = a.nest.live > L && JSON.stringify(a.nest.wins[L]) === JSON.stringify(win);
      const after = await grab();
      const differ = before.filter((b, i) => b !== after[i]).length;
      return { L, demoted, back, differ, carved: JSON.parse(before[16 * 32 + 16]) };
    });
    console.log(`survive: carve at level ${r.L}; demoted ${r.demoted}; same window back ${r.back}; ${r.differ} of 1024 columns differ; column at the centre ${JSON.stringify(r.carved)}`);
    R.check('a carve at the finest level survives zooming out (demoted) and back in, bit for bit', r.L >= 2 && r.demoted && r.back && r.differ === 0, JSON.stringify(r));
    await shot('survive', { tx: hx + 9.4, ty: hy - 3, d: 0.25, yaw: 0.7, pitch: 0.5 }, 2500);
  }
  await R.fatal(page);
});
