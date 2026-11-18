// Nested scales stills: a mound with a tunnel through it, a blob on a stalk; views shot in one browser, each with the
// draw's uncapped cost (nested.benchDraw: n draws back to back, GPU done) and its parts toggled.
// node scripts/nested-stills.mjs --chromeargs ignore-certificate-errors --size 960x640 [--only a,b] [--out dir]
//   [--tag suffix] [--port 5461] [--bench 1]
import { run, sleep } from './lib/runner.mjs';
import * as gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'local/nested');
  const tag = R.opt('tag', '');
  const port = R.opt('port', '5461');
  const bench = R.opt('bench', '1') === '1';
  const only = (R.opt('only', '') || '').split(',').filter(Boolean);
  const want = (n) => !only.length || only.includes(n);
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  const t0 = Date.now();
  await page.waitForFunction(() => window.nested && nested.app.frames.length > 60, { timeout: 120000, polling: 100 });
  console.log(`frames flowing after ${Date.now() - t0} ms`);
  await sleep(2500);
  const scene = await page.evaluate(async () => {
    const W = (ms) => new Promise((s) => setTimeout(s, ms));
    const e = nested.eye();
    const a = nested.app;
    const f = a.forward();
    const h = [e.x + f[0] * e.dHit, e.y + f[1] * e.dHit, e.z + f[2] * e.dHit];
    // edits on level 1 (its window local units), smooth at that level's resolution (radius >= 2.4 of its columns)
    const snap = await a.nest.readAll();
    const zo = snap.zOrigin(1);
    const w1 = a.nest.wins[1];
    const ed = (op, x, y, z, r) => a.nest.edit({ op, radius: r, amount: 0, at: { level: 1, x: x * 8 - w1.gx, y: y * 8 - w1.gy, z: (z - zo) * 8 } });
    ed('add', h[0], h[1], h[2] + 1.2, 2.2);
    for (let t = -3.2; t <= 3.2; t += 0.3) ed('carve', h[0] - t, h[1], h[2] + 1.3, 0.75);
    for (let z = 0.2; z <= 2.6; z += 0.2) ed('add', h[0], h[1] + 5, h[2] + z, 0.3);
    ed('add', h[0], h[1] + 5, h[2] + 3.4, 1.0);
    await W(500);
    return { h, w1, zo, stats: nested.state().stats };
  });
  console.log('scene', JSON.stringify(scene));
  const [hx, hy, hz] = scene.h;
  const tintAll = R.opt('tint', '0') === '1';
  const shot = async (name, view, wait = 3500, tint = false) => {
    if (!want(name)) return;
    tint ||= tintAll;
    await page.evaluate((v, t, dg) => {
      nested.app.render.diagB = dg;
      nested.tint(t);
      nested.setView(v);
    }, view, tint, R.opt('diag', '0') === '1');
    await sleep(wait);
    await R.fatal(page);
    const st = await page.evaluate(async (bench) => {
      const med = () => [...nested.app.frames.slice(-60)].sort((a, b) => a - b)[30].toFixed(1);
      const r = nested.app.render;
      const out = { live: nested.state().live, frameMs: med(), eye: +nested.eye().dNear.toFixed(3), pages: nested.state().stats.used };
      if (bench) {
        const b = async (set) => {
          Object.assign(r, { sheetsOnly: false, noMorphB: false, scanOnly: false }, set);
          const ms = await nested.benchDraw(10);
          Object.assign(r, { sheetsOnly: false, noMorphB: false, scanOnly: false });
          return +ms.toFixed(2);
        };
        out.drawMs = { all: await b({}), noMorphB: await b({ noMorphB: true }), sheetsOnly: await b({ sheetsOnly: true }) };
        out.frameGpuMs = +(await nested.benchFrame(20)).toFixed(2);
      }
      return out;
    }, bench);
    console.log(name, JSON.stringify(st));
    await page.screenshot({ path: `${out}/${name}${tag}.png` });
  };
  if (want('gapprobe')) {
    // (diagnostics) level 1's columns with more than one air gap far from the blob and tunnel
    const r = await page.evaluate(async (s) => {
      const snap = await nested.app.nest.readAll();
      const w = nested.app.nest.wins[1];
      const out = [];
      for (let Y = w.gy; Y < w.gy + w.n; Y++)
        for (let X = w.gx; X < w.gx + w.n; X++) {
          const c = snap.column(1, X, Y);
          let gaps = 1;
          for (let i = 1; i < c.mat.length; i++) if (c.z0[i] > c.z1[i - 1] + 0.25) gaps++;
          const wx = X / 8 - s.h[0];
          const wy = Y / 8 - s.h[1];
          if (gaps > 1 && Math.hypot(wx, wy) > 3.5) out.push({ wx: +wx.toFixed(2), wy: +wy.toFixed(2), z0: c.z0.map((v) => +v.toFixed(2)), z1: c.z1.map((v) => +v.toFixed(2)), m: c.mat });
        }
      return { n: out.length, some: out.slice(0, 6) };
    }, scene);
    console.log('gapprobe', JSON.stringify(r));
  }
  const tz = hz + 1.3;
  await shot('tunnel-outside', { yaw: 0, pitch: 0.03, eye: [hx + 7, hy, tz + 0.2] });
  await shot('dash-top', { yaw: 0, pitch: 1.0, eye: [hx + 5.5, hy, hz + 3.5] });
  await shot('tunnel-inside-out', { yaw: 0, pitch: 0.0, eye: [hx + 0.3, hy, tz - 0.1] });
  await shot('tunnel-inside-back', { yaw: Math.PI, pitch: 0.0, eye: [hx - 0.3, hy, tz - 0.1] });
  await shot('arch-side', { yaw: -Math.PI / 2, pitch: 0.12, eye: [hx, hy - 7, hz + 2] });
  await shot('tunnel-mouth-d2', { yaw: 0, pitch: 0.05, eye: [hx + 2.6, hy + 0.2, tz] }, 5000);
  if (want('carve-bench')) {
    // a small carve beside the tunnel at level 1 (three levels open): the edit's GPU time with and without the bakes
    const r = await page.evaluate(async (s) => {
      const out = [];
      const w1 = nested.app.nest.wins[1];
      for (const dz of [0.6, 0.9, 1.2]) out.push(await nested.benchEdit({ op: 'carve', radius: 0.35, amount: 0, at: { level: 1, x: (s.h[0] + 1.5) * 8 - w1.gx, y: (s.h[1] + 1.2) * 8 - w1.gy, z: (s.h[2] + dz - s.zo) * 8 } }));
      return { live: nested.state().live, runs: out.map((o) => ({ withBake: +o.withBake.toFixed(2), gapsOnly: +o.gapsOnly.toFixed(2), without: +o.without.toFixed(2) })) };
    }, scene);
    console.log('carve-bench', JSON.stringify(r));
  }
  await shot('rim-crossing-tint', { yaw: 0, pitch: 0.05, eye: [hx + 2.6, hy + 0.2, tz] }, 1500, true);
  await shot('rim-crossing-plain', { yaw: 0, pitch: 0.05, eye: [hx + 2.6, hy + 0.2, tz] }, 1500, false);
  await shot('rim-far-tint', { yaw: 0, pitch: 0.12, eye: [hx + 20, hy, hz + 3] }, 4000, true);
  await shot('rim-far-plain', { yaw: 0, pitch: 0.12, eye: [hx + 20, hy, hz + 3] }, 1500, false);
  await shot('blob-stalk', { yaw: 0, pitch: 0.1, eye: [hx + 6, hy + 5, hz + 2.5] });
  await shot('from-root', { yaw: 0, pitch: 0.35, eye: [hx + 60, hy, hz + 25] }, 4000);
  if (want('gif')) {
    await page.evaluate((v) => nested.setView(v), { yaw: 0, pitch: 0.0, eye: [hx + 7, hy, tz] });
    await sleep(3500);
    await page.evaluate(() => (nested.app.hook = (dt) => nested.fly(-2.5 * dt, 0, 0)));
    const enc = GIFEncoder();
    const eyes = [];
    for (let i = 0; i < 45; i++) {
      const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 90 });
      if (i % 5 === 0) eyes.push(await page.evaluate(() => nested.eye()));
      await sleep(60);
    }
    enc.finish();
    fs.writeFileSync(`${out}/tunnel-fly${tag}.gif`, enc.bytes());
    console.log('gif eyes', JSON.stringify(eyes.map((e) => [e.x.toFixed(2), e.dNear.toFixed(3), e.lifts])));
  }
  await R.fatal(page);
});
