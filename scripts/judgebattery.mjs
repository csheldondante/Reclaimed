// Round 120 (`judge`): the collapse judges in the browser, side by side — the atlas level as the phone runs it (every
// system in play, 1× speed), the phone proxy's viewport and tier (412 × 915, q=low), once with judge A (?judge=runs)
// and once with judge B (?judge=sections). On each: rock built with the world API near the spawn, then cut —
//   mesa   a block of stone radius 7, 24 layers, undercut on one side (a bowl at its foot);
//   tower  a stone tower radius 2.5, 30 layers, its foot cut on one side (it should lean and fall).
// For 8 s after each cut: every judge pass (Integrity's stats: the judge's wall ms, B's GPU ms, the pass's CPU ms, the
// bytes read back), the bodies freed, and the frame times (rAF). Writes data/perf/judge/browser-<q>.json; a screenshot
// of each scene a second after the cut to --shots.
//   node scripts/judgebattery.mjs [--url http://localhost:5411] [--q low] [--shots C:/Projects/shots88/judge]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5411');
const q = opt('q', 'low');
const shots = opt('shots', 'C:/Projects/shots88/judge');
const wait = Number(opt('wait', 35000));
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const out = { when: new Date().toISOString(), q, viewport: '412x915', runs: {} };
let failed = false;
const RUNS = [
  ['A', 'judge=runs'],
  ['B levels (as first built)', 'judge=sections&jbmode=levels&jbcull=0'],
  ['B levels culled', 'judge=sections&jbmode=levels'],
  ['B pairs culled', 'judge=sections&jbmode=pairs'],
  ['B auto (default)', 'judge=sections'],
];
const only = opt('only', '');
for (const [judge, query] of RUNS.filter(([j]) => !only || j.includes(only))) {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
    defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
    protocolTimeout: 600000,
  });
  try {
    const p = await browser.newPage();
    p.on('pageerror', (e) => {
      failed = true;
      console.log(judge, 'pageerror', e.message);
    });
    p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log(judge, 'console', m.text()));
    await p.goto(`${url}/?skipmenu=1&tutorial=0&perf=1&q=${q}&level=atlas&${query}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimed?.integrity?.(), { timeout: 240000 });
    // (the first load after a server start is slow: the land settles first)
    await sleep(wait);
    if (await p.evaluate(() => !!document.querySelector('.fatal, #fatal'))) throw new Error('fatal overlay');
    const runs = {};
    for (const [name, dx, build, cut] of [
      ['mesa', 14, { radius: 7, layers: 24 }, { side: 4, radius: 4 }],
      ['tower', -14, { radius: 2.5, layers: 30 }, { side: 1.5, radius: 2 }],
    ]) {
      const at = await p.evaluate(
        async (dx, build) => {
          const R = window.reclaimed;
          R.stream.auto = false;
          const t = R.api.terrain;
          await t.refresh();
          const [cx, cy] = R.camera.target;
          const x = cx + dx;
          const y = cy;
          const z = t.heightAt(x, y);
          for (let k = 0; k < build.layers; k++) t.build(x, y, 'stone', { radius: build.radius, layers: 1 });
          R.camera.target = [x, y, z + 10];
          return { x, y, z };
        },
        dx,
        build,
      );
      await sleep(5000);
      const r = await p.evaluate(
        async (at, cut) => {
          const R = window.reclaimed;
          const ig = R.integrity();
          const t = R.api.terrain;
          await t.refresh();
          const s0 = { ...ig.stats };
          const rb0 = ig.readBytes;
          const passes = [];
          const frames = [];
          // (the frames' own GPU ms, from the game's profiler: the frame B's submit lands in shares the GPU with it)
          const frameGpu = [];
          let listening = true;
          R.core.host.profiler.listen((_f, ms) => listening && frameGpu.push(ms));
          let last = performance.now();
          let seen = s0.passes;
          t.crater(at.x + cut.side, at.y, { radius: cut.radius, z: at.z + 2 });
          const t0 = performance.now();
          await new Promise((done) => {
            const tick = () => {
              const now = performance.now();
              frames.push(+(now - last).toFixed(2));
              last = now;
              const s = ig.stats;
              if (s.passes !== seen) {
                seen = s.passes;
                const js = ig.judge.stats;
                passes.push({ at: +(now - t0).toFixed(0), judgeMs: +s.judgeMs.toFixed(3), judgeGpuMs: +s.judgeGpuMs.toFixed(3), passMs: +s.lastMs.toFixed(3), readMs: +s.readMs.toFixed(2), readKB: +s.readKB.toFixed(0), bodies: s.bodies - s0.bodies, window: js.window, windows: js.windows, hanging: js.hanging, judged: js.judged, deepest: js.deepest, judgedBox: js.judgedBox, kernels: js.kernels ? Object.fromEntries(Object.entries(js.kernels).map(([k, v]) => [k, +v.toFixed(3)])) : undefined });
              }
              if (now - t0 < 8000) requestAnimationFrame(tick);
              else done();
            };
            requestAnimationFrame(tick);
          });
          listening = false;
          const gs = [...frameGpu].sort((a, b) => a - b);
          const sorted = [...frames].sort((a, b) => a - b);
          const pct = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
          const judged = passes.filter((x) => x.judgeMs > 0);
          return {
            judge: ig.judge.id,
            passes: passes.length,
            judgeMs: judged.map((x) => x.judgeMs),
            passLog: judged,
            frameGpu: { n: gs.length, p50: +(gs[Math.floor(gs.length / 2)] ?? 0).toFixed(3), max: +(gs[gs.length - 1] ?? 0).toFixed(3) },
            judgeGpuMs: judged.map((x) => x.judgeGpuMs),
            passMsMax: Math.max(0, ...passes.map((x) => x.passMs)),
            bodies: ig.stats.bodies - s0.bodies,
            crumbled: ig.stats.crumbled - s0.crumbled,
            readKB: +((ig.readBytes - rb0) / 1024).toFixed(0),
            frames: { n: frames.length, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: sorted[sorted.length - 1], over20: frames.filter((f) => f > 20).length },
            why: ig.why,
          };
        },
        at,
        cut,
      );
      await p.screenshot({ path: `${shots}/${judge.replace(/[^a-zA-Z0-9]+/g, "_")}-${name}.png` });
      runs[name] = r;
      // (the whole window judged, every column a seed: the atlas's hanging groups as they are — how many, how deep)
      if (name === 'tower') {
        runs.whole = await p.evaluate(async () => {
          const ig = window.reclaimed.integrity();
          const r = await ig.judgeAll(true);
          const js = ig.judge.stats;
          return { pieces: r.pieces, ms: +r.ms.toFixed(2), gpuMs: js.gpuMs, window: js.window, hanging: js.hanging, judged: js.judged, deepest: js.deepest, kernels: js.kernels };
        });
        console.log(judge, 'whole', JSON.stringify(runs.whole));
      }
      console.log(judge, name, JSON.stringify(r));
    }
    out.runs[judge] = runs;
  } catch (e) {
    failed = true;
    console.log(judge, 'failed', e.message);
  } finally {
    await browser.close();
  }
}
fs.mkdirSync('data/perf/judge', { recursive: true });
fs.writeFileSync(`data/perf/judge/browser-${q}${only ? '-' + only.replace(/[^a-z0-9]+/gi, '_') : ''}.json`, JSON.stringify(out, null, 1) + '\n');
process.exit(failed ? 1 : 0);
