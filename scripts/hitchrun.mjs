// Round 100 (hitchrec): the hitch recorder on the desktop at the phone tier, and the GC audit. One page (the atlas,
// q=low 412x915, every system on, 1x, ?hitch=1), then phases, each its own recorder session:
//   drive   the driveprofile ride (?drive=18 along the road from --at)
//   pan120  speedsweep's straight pan at 120 cells/s (up the screen)
//   climb   a pan at 40 cells/s towards the highest ground within ~1200 cells (slides in z on the way up)
// For each: frames p50/p95/p99, hitches over the threshold by cause, the worst ten with their steps; with --heap,
// Chrome's sampling heap profiler over the phase (objects collected by minor and major GCs included): bytes
// allocated a second and the top allocating call sites.
//   node scripts/hitchrun.mjs [--url http://localhost:5287] [--phases drive,pan120,climb] [--seconds 20]
//     [--wait 35000] [--at 15024,14337] [--heap] [--interval 8192] [--json out.json] [--extra "&x=1"]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5287');
const phases = opt('phases', 'drive,pan120,climb').split(',');
const seconds = Number(opt('seconds', 20));
const wait = Number(opt('wait', 35000));
const at = opt('at', '15024,14337');
const heap = argv.includes('--heap');
const interval = Number(opt('interval', 8192));
const extra = opt('extra', '');
const out = opt('json', '');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-precise-memory-info', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
});
let bad = false;
const results = {};
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 300)));
  const drive = phases.includes('drive') ? '&drive=18' : '';
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&hitch=1&at=${at}${drive}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimedHitch, { timeout: 240000 });
  await sleep(wait);
  const cdp = await p.createCDPSession();
  if (heap) await cdp.send('HeapProfiler.enable');
  for (const ph of phases) {
    await p.evaluate((ph) => {
      const R = window.reclaimed;
      const sc = R.scene;
      const c = R.camera;
      if (ph !== 'drive') sc.drive = null;
      if (ph === 'pan120' || ph === 'climb') {
        let dir;
        if (ph === 'pan120') {
          const [ux, uy] = c.screenDeltaToWorld(0, -1);
          const l = Math.hypot(ux, uy) || 1;
          dir = [ux / l, uy / l];
        } else {
          // (the highest macro ground within ~1200 cells of the camera)
          const a = sc.opts.atlas.atlas;
          const S = R.stream;
          const n = a.p.n;
          const wx = c.target[0] + S.origin[0];
          const wy = c.target[1] + S.origin[1] * (Math.sqrt(3) / 2);
          const cx = (wx / a.worldW) * n;
          const cy = (wy / a.worldH) * n;
          const rr = Math.round((1200 / a.worldW) * n);
          let best = [0, 0, -1e9];
          for (let j = -rr; j <= rr; j++)
            for (let i = -rr; i <= rr; i++) {
              if (i * i + j * j > rr * rr) continue;
              const x = Math.round(cx + i);
              const y = Math.round(cy + j);
              const h = a.hmac[((y % n) + n) % n * n + (((x % n) + n) % n)];
              if (h > best[2]) best = [i, j, h];
            }
          const l = Math.hypot(best[0], best[1]) || 1;
          dir = [best[0] / l, best[1] / l];
          window.__climb = { from: a.hmac[((Math.round(cy) % n) + n) % n * n + (((Math.round(cx) % n) + n) % n)], peak: best[2], cells: Math.round((l / n) * a.worldW) };
        }
        sc.pan = { speed: ph === 'pan120' ? 120 : 40, dir, t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
      }
    }, ph);
    // (a second to get going)
    await sleep(1500);
    await p.evaluate(() => {
      window.reclaimedHitch.rec.reset();
      window.reclaimed.core.host.profiler.resetTotals();
      window.reclaimed.scene.cpuReset?.();
      window.__tz0 = window.reclaimed.stream.stats.tiers;
      window.__s0 = window.reclaimed.stream.stats.slides;
    });
    if (heap) await cdp.send('HeapProfiler.startSampling', { samplingInterval: interval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const t0 = Date.now();
    await sleep(seconds * 1000);
    let sites = null;
    let bytesPerS = null;
    if (heap) {
      const { profile } = await cdp.send('HeapProfiler.stopSampling');
      const dur = (Date.now() - t0) / 1000;
      const agg = new Map();
      let total = 0;
      const walk = (node, stack) => {
        const f = node.callFrame;
        const here = `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber + 1}`;
        if (node.selfSize) {
          total += node.selfSize;
          // (the site, and its caller: a hot helper is named by who calls it)
          const key = `${here} <- ${stack[stack.length - 1] ?? '-'}`;
          agg.set(key, (agg.get(key) ?? 0) + node.selfSize);
        }
        for (const c of node.children) walk(c, [...stack, here]);
      };
      walk(profile.head, []);
      bytesPerS = Math.round(total / dur);
      sites = [...agg].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${(v / dur / 1024).toFixed(1)} KB/s  ${k}`);
    }
    const r = await p.evaluate(() => {
      const H = window.reclaimedHitch;
      const rep = H.report();
      return {
        minutes: rep.minutes,
        causes: rep.causes,
        gc: rep.gc,
        held: rep.heldForGpu,
        frames: rep.frames,
        worst: rep.worst.map((h) => `${h.ms} ${h.cause} cpu ${h.cpu} gpu ${h.gpu}${h.gpuTop ? ' (' + h.gpuTop + ')' : ''} held ${h.held} gc ${h.gc.young}/${h.gc.old}/${h.gc.dropMB} | ${h.steps.map((s) => s.label + ' ' + s.ms).join(', ')} | async ${h.async.map((s) => s.label + ' ' + s.ms).join(', ')} | ${h.long.join(' ; ')} | io ${JSON.stringify(h.io ?? null)}`),
        support: rep.support,
        cpuSteps: rep.cpuSteps,
        gpuPasses: rep.gpuPasses === 'n/a' ? 'n/a' : { frameMeanMs: rep.gpuPasses.frameMeanMs },
        gpuMem: rep.gpuMem,
        heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
        slides: window.reclaimed.stream.stats.slides - window.__s0,
        tiers: window.reclaimed.stream.stats.tiers - window.__tz0,
        climb: window.__climb ?? null,
      };
    });
    r.bytesPerS = bytesPerS;
    r.sites = sites;
    results[ph] = r;
    const m = r.minutes[0] ?? {};
    console.log(`PHASE ${ph}: frames ${r.frames} p50 ${m.p50} p95 ${m.p95} p99 ${m.p99} max ${m.max} hitches ${m.hitches} held ${r.held} gc ${r.gc.young}/${r.gc.old} slides ${r.slides} z ${r.tiers} heap ${r.heapMB} MB gpuMem ${r.gpuMem.liveMB} MB${bytesPerS !== null ? ` alloc ${(bytesPerS / 1024).toFixed(0)} KB/s` : ''}${r.climb ? ` climb ${JSON.stringify(r.climb)}` : ''}`);
    console.log(`  causes ${JSON.stringify(r.causes)}`);
    for (const w of r.worst) console.log(`  worst ${w}`);
    if (sites) for (const s of sites) console.log(`  alloc ${s}`);
  }
  if (argv.includes('--shot')) await p.screenshot({ path: opt('shot', 'hitch.png') });
  if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
} finally {
  await browser.close();
}
if (bad) process.exit(1);
