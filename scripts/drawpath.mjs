// Round 120 (the user: "the mesh changes appearance and sometimes turns into blocks during falling"): how each moving
// rock is drawn, frame by frame, from its break to its rest — Integrity.drawPaths (skin | matrix | split | cubes | none)
// — with the rock mesh's slot refusals (RockMesh.stats) and the draws a frame, while a station's buttons are pressed.
// Prints each body's path sequence (runs collapsed) and fails (exit 1) when a body's path changed other than from
// `split` (its parent's mesh, while its own is built) to its own, or was ever `cubes`/`none`.
//   node scripts/drawpath.mjs --url http://localhost:5211 --solver nodes --level rocklab --station collapse \
//     --press "2:cut a foot;8:cut the dome's ring" --secs 14 [--shots C:/Projects/shots88/solver/drawpath]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5211');
const variant = opt('solver', 'nodes');
const judge = opt('judge', 'runs');
const level = opt('level', 'rocklab');
const station = opt('station', 'collapse');
const press = opt('press', "1:cut a foot;6:cut the dome's ring;12:undercut the cliff;18:undercut the spire;24:cut the keystone")
  .split(';')
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf(':');
    return [Number(s.slice(0, i)), s.slice(i + 1)];
  });
const secs = Number(opt('secs', 40));
const shots = opt('shots', '');
const extra = opt('params', '');
// (--burst N: after each press, N screenshots as fast as they come — to see a break frame by frame; --clip x,y,w,h)
const burst = Number(opt('burst', 0));
const clip = opt('clip', '') ? (([x, y, width, height]) => ({ x, y, width, height }))(opt('clip').split(',').map(Number)) : undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (shots) fs.mkdirSync(shots, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    failed = true;
    console.log(`FAIL pageerror ${e.message}`);
  });
  p.on('console', (m) => {
    if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 300)}`);
  });
  await p.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&q=${opt('q', 'low')}&solver=${variant}&judge=${judge}${extra ? '&' + extra : ''}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.scene?.bugReport, { timeout: 240000 });
  await sleep(25000);
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal overlay: ${fatal}`);
  await p.evaluate(() => {
    window.reclaimed.scene.tunePanel?.toggle(false);
    for (const el of document.querySelectorAll('.editor')) el.style.display = 'none';
  });
  const at = await p.evaluate((id) => window.reclaimed.scene.level.stations.findIndex((s) => s.id === id), station);
  if (at < 0) throw new Error(`no station ${station}`);
  await p.evaluate((i) => window.reclaimed.scene.stationsBar.pick(i), at);
  await sleep(3000);
  // (--eval js: after the station's picked — a closer camera, say)
  if (opt('eval', '')) await p.evaluate(opt('eval'));
  await sleep(1500);
  if (opt('poses', '')) await p.evaluate(() => (window.__POSES = true));
  // a sampler in the page: every frame, each rock's path (and its size, height and speed), the mesh's refusals
  await p.evaluate(() => {
    const ig = window.reclaimed.scene.integrity;
    const log = (window.__paths = { bodies: {}, frames: 0, maxDraws: 0, stats: null });
    const tick = () => {
      log.frames++;
      for (const b of ig.rigid.list) {
        const path = ig.drawPaths.get(b.id) ?? '-';
        const e = (log.bodies[b.id] ??= { cells: b.cells.length, gen: b.gen, seq: [], first: [] });
        if (e.first.length < 4) {
          const sb = ig.rigid.engineBody(b);
          const m = ig.rigid.drawMatrix(b);
          e.first.push({ f: log.frames, pos: b.pos.map((v) => +v.toFixed(1)), m: [m[3], m[7], m[11]].map((v) => +v.toFixed(1)), slot: sb?.slot });
        }
        const last = e.seq[e.seq.length - 1];
        if (!last || last.p !== path) e.seq.push({ p: path, n: 1, f: log.frames, z: +b.pos[2].toFixed(1), v: +Math.hypot(...b.v).toFixed(1) });
        else last.n++;
      }
      log.maxDraws = Math.max(log.maxDraws, ig.rockMesh?.count ?? 0);
      // (each draw this frame — mode, slot rect, transform or skin — when one is odd: a matrix with no translation)
      const d = ig.rockMesh?.data;
      if (d)
        for (let e = 0; e < d[0]; e++) {
          const o = 4 + e * 48;
          const mode = d[o + 19];
          if (mode < 0.5 && Math.abs(d[o + 7]) + Math.abs(d[o + 11]) < 1e-3 && d[o + 4] !== 0) (log.odd ??= []).push({ f: log.frames, e, m: Array.from(d.subarray(o + 4, o + 16)).map((v) => +v.toFixed(2)) });
          // (a slot whose transform jumps: its translation this frame against last frame's; or isn't a rotation)
          if (mode < 0.5 && d[o] < d[o + 2]) {
            const rows = [0, 1, 2].map((r) => Math.hypot(d[o + 4 + r * 4], d[o + 5 + r * 4], d[o + 6 + r * 4]));
            if (rows.some((v) => Math.abs(v - 1) > 0.05)) (log.odd ??= []).push({ f: log.frames, e, rows: rows.map((v) => +v.toFixed(2)), m: Array.from(d.subarray(o + 4, o + 16)).map((v) => +v.toFixed(2)) });
          }
          if (mode > 0.5 && mode < 1.5 && (log.ghosts ??= []).length < 6) {
            const g = { f: log.frames, e, rect: Array.from(d.subarray(o, o + 4)), shift: Array.from(d.subarray(o + 16, o + 19)), hit: Array.from(d.subarray(o + 20, o + 24)), seeds: [] };
            for (let k = 0; k < 6; k++) {
              const s = Array.from(d.subarray(o + 24 + k * 4, o + 28 + k * 4));
              const t = s[3];
              g.seeds.push({ s: s.map((v) => +v.toFixed(1)), t: t >= 0 ? { mode: d[4 + t * 48 + 19], rect: Array.from(d.subarray(4 + t * 48, 4 + t * 48 + 4)), a: Array.from(d.subarray(4 + t * 48 + 4, 4 + t * 48 + 12)).map((v) => +v.toFixed(2)) } : null });
            }
            log.ghosts.push(g);
          }
          if (mode < 0.5) {
            const key = `${d[o]},${d[o + 1]}`;
            const t = [d[o + 7], d[o + 11], d[o + 15]];
            const was = (log.lastT ??= {})[key];
            if (was && Math.hypot(t[0] - was[0], t[1] - was[1], t[2] - was[2]) > 3) (log.odd ??= []).push({ f: log.frames, e, key, jump: [was.map((v) => +v.toFixed(1)), t.map((v) => +v.toFixed(1))], n: d[0] });
            log.lastT[key] = t;
          }
        }
      log.stats = { ...ig.rockMesh?.stats };
      // (--poses: the solver's node poses read back each frame they can be — a live node drawn off the map, or near
      // its corner, is what a streak to the sky would be)
      const sv = ig.solver;
      if (window.__POSES && sv && (log.inflight ?? 0) < 8 && sv.used > 0) {
        const dev = window.reclaimed.core.host.gpu.device;
        const n = sv.used * 64;
        const st = dev.createBuffer({ size: n * 64 + n * 128, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const enc = dev.createCommandEncoder();
        enc.copyBufferToBuffer(sv.pose, 0, st, 0, n * 64);
        enc.copyBufferToBuffer(sv.lanes, 0, st, n * 64, n * 128);
        dev.queue.submit([enc.finish()]);
        log.inflight = (log.inflight ?? 0) + 1;
        const f0 = log.frames;
        const draws = Array.from(ig.rockMesh.data.subarray(0, 4 + ig.rockMesh.data[0] * 48));
        const cpu = {};
        for (const b of ig.rigid.list) {
          const sb = ig.rigid.engineBody(b);
          if (sb) cpu[sb.slot] = { pos: [...b.pos], id: b.id };
        }
        st.mapAsync(GPUMapMode.READ).then(() => {
          const a = new Float32Array(st.getMappedRange().slice(0));
          st.destroy();
          log.inflight--;
          // each skinned draw: where each of its live nodes puts the body's rest centre (x − q·rest): one place
          const qr = (q, v) => {
            const [x, y, z, w] = q;
            const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
            return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
          };
          for (let e = 0; e < draws[0]; e++) {
            const o = 4 + e * 48;
            if (draws[o + 19] < 1.5) continue;
            const slot = draws[o + 4];
            const nn = draws[o + 8];
            for (const k of [0, 2]) {
              const cs = [];
              for (let i = 0; i < nn; i++) {
                const j = slot * 64 + i;
                if (j >= n || a[n * 16 + j * 32 + 3] < 0) continue;
                const rest = [a[n * 16 + j * 32 + 24], a[n * 16 + j * 32 + 25], a[n * 16 + j * 32 + 26]];
                const x = [a[j * 16 + k * 4], a[j * 16 + k * 4 + 1], a[j * 16 + k * 4 + 2]];
                const q = [a[j * 16 + k * 4 + 4], a[j * 16 + k * 4 + 5], a[j * 16 + k * 4 + 6], a[j * 16 + k * 4 + 7]];
                const r = qr(q, rest);
                cs.push([x[0] - r[0], x[1] - r[1], x[2] - r[2]]);
              }
              let spread = 0;
              for (const c of cs) spread = Math.max(spread, Math.hypot(c[0] - cs[0][0], c[1] - cs[0][1], c[2] - cs[0][2]));
              if (spread > 1.5) (log.spread ??= []).push({ f: f0, e, slot, k, spread: +spread.toFixed(1), nn, live: cs.length });
              const c = cpu[slot];
              if (c && cs.length && Math.hypot(cs[0][0] - c.pos[0], cs[0][1] - c.pos[1], cs[0][2] - c.pos[2]) > 4) (log.far ??= []).push({ f: f0, e, slot, k, id: c.id, gpu: cs[0].map((v) => +v.toFixed(1)), cpu: c.pos.map((v) => +v.toFixed(1)) });
            }
          }
          const W = window.reclaimed.core.dims.w;
          for (let j = 0; j < n; j++) {
            if (a[n * 16 + j * 32 + 3] < 0) continue; // a dead lane
            for (const k of [0, 2]) {
              const x = a[j * 16 + k * 4];
              const y = a[j * 16 + k * 4 + 1];
              const z = a[j * 16 + k * 4 + 2];
              if (!(x > 2 && y > 2 && x < W && z > -2 && z < 150)) {
                (log.bad ??= []).push({ f: f0, slot: Math.floor(j / 64), node: j % 64, k, p: [x, y, z].map((v) => +v.toFixed(2)) });
              }
            }
          }
          if (log.bad?.length && !log.badDraws) log.badDraws = draws.map((v) => +v.toFixed(2));
        });
      }
      log.resting = ig.restingCount;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let s = 0, k = 0; s < secs; s++) {
    for (const [t, label] of press)
      if (t === s)
        await p.evaluate((label) => {
          const b = [...document.querySelectorAll('.stations button')].find((x) => x.textContent === label);
          if (!b) throw new Error(`no button ${label}`);
          b.click();
        }, label);
    if (shots && burst && press.some(([t]) => t === s))
      for (let b = 0; b < burst; b++) await p.screenshot({ path: path.join(shots, `${variant}-s${s}-${String(b).padStart(3, '0')}.png`), clip });
    if (shots) await p.screenshot({ path: path.join(shots, `${variant}-${String(k++).padStart(3, '0')}.png`) });
    await sleep(1000);
  }
  const log = await p.evaluate(() => window.__paths);
  let bad = 0;
  const lines = [];
  for (const [id, e] of Object.entries(log.bodies)) {
    const seq = e.seq.map((s) => `${s.p}×${s.n}@${s.f}(z${s.z} v${s.v})`).join(' → ');
    // (its pose's source — the solver's skin or the CPU matrix — the same throughout, its parent's mesh while its own
    // is built (split-) included; never its cubes in place of its mesh, never left out. '-': the frame it was made)
    const ps = e.seq.map((s) => s.p.replace('split-', '')).filter((q) => q !== '-');
    const wrong = new Set(ps).size > 1 || ps.some((q) => q === 'cubes' || q === 'none');
    if (wrong) bad++;
    lines.push(`${wrong ? 'CHANGED' : 'ok     '} body ${id} (${e.cells} cells, gen ${e.gen}): ${seq}`);
    if (opt('first', '')) lines.push(`        first ${JSON.stringify(e.first)}`);
  }
  console.log(lines.join('\n'));
  if (log.far) console.log('far', log.far.length, JSON.stringify(log.far.slice(0, 12)));
  if (log.spread) console.log('spread', log.spread.length, JSON.stringify(log.spread.slice(0, 12)));
  if (log.bad) console.log('bad poses', log.bad.length, JSON.stringify(log.bad.slice(0, 12)), 'draws then', JSON.stringify(log.badDraws));
  if (log.ghosts) console.log('ghosts', JSON.stringify(log.ghosts.slice(0, 2)));
  if (log.odd) console.log('odd draws', JSON.stringify(log.odd.slice(0, 12)));
  console.log(`frames ${log.frames}, most draws a frame ${log.maxDraws}, resting ${log.resting}, rock mesh ${JSON.stringify(log.stats)}`);
  console.log(`${bad} of ${Object.keys(log.bodies).length} bodies changed how they're drawn`);
  if (bad) failed = true;
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.message}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
