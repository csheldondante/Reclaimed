// Round 120 (JB6, "no CPU readback on the hot path"): what JB6 took away, measured by toggling it (the user: "You need to
// toggle systems to measure the diff for an accurate number" — not per-pass timestamps on a tiler). The atlas as the
// phone runs it (every system, 1x, 412 x 915, q=low, dpr 2.6), the given solver x judge, alternately with `&jb6=0` (the
// CPU copy kept and read before every pass, as before JB6) and without; a workload of cuts and blows near the camera:
// every 1.2 s a bowl dug into the hill at the next spot round a ring (judged: what hangs is freed) and every 3 s a stone
// block dropped from 14 up (a blow). For each run: the frames' intervals (rAF: p50, p95, p99, max, over 33 ms), the GPU's
// frame ms (the profiler's), the integrity system's bytes read back and passes.
//   node scripts/jb6toggle.mjs [--url http://localhost:5431] [--pair lattice:sections] [--runs 2] [--seconds 30]
//     [--out data/perf/jb6/toggle-lattice-sections.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5431');
const [solver, judge] = opt('pair', 'lattice:sections').split(':');
const runs = Number(opt('runs', 2));
const seconds = Number(opt('seconds', 30));
const wait = Number(opt('wait', 35000));
const out = opt('out', `data/perf/jb6/toggle-${solver}-${judge}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { when: new Date().toISOString(), solver, judge, seconds, viewport: '412x915 dpr 2.6 q=low', runs: [] };
let failed = false;

async function one(jb6) {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
    defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
    protocolTimeout: 600000,
  });
  try {
    const p = await browser.newPage();
    p.on('pageerror', (e) => {
      failed = true;
      console.log('pageerror', e.message);
    });
    p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text().slice(0, 300)));
    await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&perf=1&level=atlas&solver=${solver}&judge=${judge}${jb6 ? '' : '&jb6=0'}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimed?.integrity?.(), { timeout: 240000 });
    // (the first load after a server start is slow: the land settles first)
    await sleep(wait);
    if (await p.evaluate(() => !!document.querySelector('.fatal, #fatal'))) throw new Error('fatal overlay');
    const r = await p.evaluate(
      async (seconds) => {
        const R = window.reclaimed;
        R.stream.auto = false;
        const ig = R.integrity();
        const t = R.api.terrain;
        const [cx, cy] = R.camera.target;
        const bytes0 = ig.readBytes;
        const passes0 = ig.stats.passes;
        const frames = [];
        const gpu = [];
        let listening = true;
        R.core.host.profiler.listen((_f, ms) => listening && gpu.push(ms));
        let last = performance.now();
        const t0 = last;
        let nextCut = 0;
        let nextDrop = 1500;
        let k = 0;
        let d = 0;
        await new Promise((done) => {
          const tick = () => {
            const now = performance.now();
            frames.push(now - last);
            last = now;
            const el = now - t0;
            if (el >= nextCut) {
              // (a bowl into the ground round a ring about the camera: what hangs over it is judged)
              const a = k * 2.399;
              const x = cx + Math.cos(a) * (8 + (k % 5) * 3);
              const y = cy + Math.sin(a) * (8 + (k % 5) * 3);
              const z = t.heightAt(x, y) ?? 10;
              t.crater(x, y, { radius: 2.5 + (k % 3), z: z - 1 });
              k++;
              nextCut += 1200;
            }
            if (el >= nextDrop) {
              // (a stone block dropped: a blow where it lands)
              const a = d * 1.7 + 0.5;
              const x = cx + Math.cos(a) * 10;
              const y = cy + Math.sin(a) * 10;
              const z = t.heightAt(x, y) ?? 10;
              const [i, j] = [Math.round(x), Math.round(y / 0.8660254)];
              const cells = [];
              for (let dz = 0; dz < 3; dz++) for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) cells.push({ x: i + dx, y: j + dy, z: Math.ceil(z) + 14 + dz, mat: 1 });
              ig.dropBody(cells);
              d++;
              nextDrop += 3000;
            }
            if (el < seconds * 1000) requestAnimationFrame(tick);
            else done();
          };
          requestAnimationFrame(tick);
        });
        listening = false;
        const q = (a, f) => {
          const s = [...a].sort((x, y) => x - y);
          return +(s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? 0).toFixed(2);
        };
        return {
          frames: { n: frames.length, mean: +(frames.reduce((s, x) => s + x, 0) / frames.length).toFixed(2), p50: q(frames, 0.5), p95: q(frames, 0.95), p99: q(frames, 0.99), max: q(frames, 1), over33: frames.filter((x) => x > 33.4).length },
          gpu: { n: gpu.length, mean: +(gpu.reduce((s, x) => s + x, 0) / Math.max(1, gpu.length)).toFixed(2), p50: q(gpu, 0.5), p95: q(gpu, 0.95) },
          readKB: +((ig.readBytes - bytes0) / 1024).toFixed(0),
          passes: ig.stats.passes - passes0,
          keepsCopy: ig.keepsCopy,
          cuts: k,
          drops: d,
        };
      },
      seconds,
    );
    return r;
  } finally {
    await browser.close();
  }
}

for (let i = 0; i < runs; i++)
  for (const jb6 of [false, true]) {
    const r = await one(jb6);
    console.log(`${jb6 ? 'jb6   ' : 'jb6=0 '} run ${i + 1}: frames p50 ${r.frames.p50} p95 ${r.frames.p95} p99 ${r.frames.p99} max ${r.frames.max} >33ms ${r.frames.over33}/${r.frames.n} | GPU mean ${r.gpu.mean} p95 ${r.gpu.p95} | read ${r.readKB} KB in ${r.passes} passes (copy kept: ${r.keepsCopy})`);
    report.runs.push({ jb6, ...r });
  }
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`wrote ${out}`);
process.exit(failed ? 1 : 0);
