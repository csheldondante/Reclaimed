// Round 106 (frameprobe): where a frame's time goes, parked and panning. One page (the atlas at the phone tier, every
// system on, 1x, ?hitch=1 — as the deployed page runs), a window and a zoom; then for each speed (0 = parked) a run of
// --seconds with every frame logged:
//   - the frame's interval, its callback's CPU, the rAFs held back for the GPU before it (main.ts paces two in flight);
//   - the GPU's frame as the profiler reads it back: its span (first pass's start to last's end), the sum of its passes,
//     the idle gap since the previous frame's end, every pass's ms;
// and reported: interval percentiles, the GPU's per-pass mean / p95 / max per frame, how busy the GPU was (spans over
// wall time), the long frames (> --long ms) with their GPU span, top passes, CPU and held count, the hitch
// recorder's causes, and the slide's CPU by part (cpuStats: fz.*, sl.*, slide.*).
//   node scripts/framecost.mjs [--url http://localhost:5311] [--win 512] [--zoom 5] [--speeds 0,10,60]
//     [--seconds 10] [--throttle 4] [--wait 35000] [--long 25] [--extra "&x=1"] [--json out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5311');
const win = Number(opt('win', 512));
const zoom = Number(opt('zoom', 5));
const speeds = opt('speeds', '0,10').split(',').map(Number);
const seconds = Number(opt('seconds', 10));
const wait = Number(opt('wait', 35000));
const throttle = Number(opt('throttle', 0));
const longMs = Number(opt('long', 25));
const extra = opt('extra', '');
const out = opt('json', '');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-precise-memory-info', `--window-size=${vw},${vh}`].concat(argv.includes('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
});
let bad = false;
const results = [];
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 300)));
  const world = `fc-${Date.now().toString(36)}`;
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&hitch=1&hitchhud=0&at=15024,14337&win=${win}&world=${world}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimedHitch, { timeout: 240000 });
  await sleep(wait);
  if (throttle > 1) {
    const cdp = await p.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  await p.evaluate((zoom) => {
    const R = window.reclaimed;
    R.scene.drive = null;
    R.scene.pan = null;
    R.camera.zoom = zoom;
    const [ux, uy] = R.camera.screenDeltaToWorld(0, -1);
    const l = Math.hypot(ux, uy) || 1;
    window.__dir = [ux / l, uy / l];
    window.__fcLoad ??= performance.now();
    const prof = R.core.host.profiler;
    const rec = window.reclaimedHitch.rec;
    const mem = window.reclaimedHitch.mem;
    const log = (window.__fc = { on: false, f: [], g: new Map() });
    // (the GPU's frames as they're read back, keyed by the profiler's frame number)
    const prev = prof.onFrame;
    let lastEnd = 0;
    prof.onFrame = (n, ms, top) => {
      prev?.(n, ms, top);
      if (log.on) {
        const passes = {};
        let sum = 0;
        for (const [k, v] of prof.lastPasses) {
          passes[k] = v;
          sum += v;
        }
        log.g.set(n, { span: ms, sum, gap: lastEnd ? (prof.lastStartNs - lastEnd) / 1e6 : 0, passes });
      }
      lastEnd = prof.lastEndNs;
    };
    let last = performance.now();
    let held0 = rec.heldTotal;
    let maps0 = mem.io.maps;
    const S = R.stream;
    const tick = (t) => {
      if (log.on) log.f.push({ iv: t - last, cpu: rec.lastCpu, held: rec.heldTotal - held0, pf: rec.lastPf, busy: S.busy ? 1 : 0, sl: S.stats.slides, maps: mem.io.maps - maps0, pend: mem.io.pendingMaps });
      held0 = rec.heldTotal;
      maps0 = mem.io.maps;
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, zoom);
  // (--fill S: as the pan bench's disk line — S seconds at 300 cells/s with every region touched, so each is read back
  // and saved as it leaves; then parked again, the runs after it see what that leaves behind)
  const fill = Number(opt('fill', 0));
  if (fill > 0) {
    await p.evaluate((fill) => {
      const R = window.reclaimed;
      const d = window.__dir;
      R.scene.pan = { speed: 300, dir: [d[0], d[1]], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
      const t0 = performance.now();
      return new Promise((res) => {
        const f = () => {
          R.stream.touch(0, 0, R.stream.W, R.stream.H);
          if (performance.now() - t0 < fill * 1000) requestAnimationFrame(f);
          else {
            R.scene.pan = null;
            res();
          }
        };
        requestAnimationFrame(f);
      });
    }, fill);
    console.log(`filled: saved ${await p.evaluate(() => window.reclaimed.stream.stats.saved)} regions`);
    await sleep(Number(opt('afterfill', 1500)));
  }
  if (opt('shot', '')) {
    await p.evaluate((zoom) => (window.reclaimed.camera.zoom = zoom), zoom);
    await sleep(1500);
    await p.screenshot({ path: opt('shot', '') });
    console.log(`shot ${opt('shot', '')} at ${JSON.stringify(await p.evaluate(() => [window.reclaimed.stream.origin, window.reclaimed.camera.target.map((v) => +v.toFixed(0))]))}`);
  }
  for (const speed of speeds) {
    await p.evaluate((speed) => {
      const d = window.__dir;
      window.reclaimed.scene.pan = speed > 0 ? { speed, dir: [d[0], d[1]], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 } : null;
    }, speed);
    await sleep(1500);
    const st0 = await p.evaluate(() => {
      window.reclaimedHitch.rec.reset();
      window.reclaimed.core.host.profiler.resetTotals();
      window.reclaimed.scene.cpuReset();
      window.__fc.f = [];
      window.__fc.g = new Map();
      window.__fc.on = true;
      window.__fc.t0 = performance.now();
      return { ...window.reclaimed.stream.stats };
    });
    await sleep(seconds * 1000);
    const r = await p.evaluate(
      async (st0, longMs) => {
        const log = window.__fc;
        log.on = false;
        const wall = performance.now() - log.t0;
        // (the last frames' GPU times come back a few frames late)
        await new Promise((res) => setTimeout(res, 300));
        const S = window.reclaimed.stream;
        const st = S.stats;
        const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);
        const f = log.f;
        const iv = f.map((x) => x.iv).sort((a, b) => a - b);
        const g = [...log.g.values()];
        const spans = g.map((x) => x.span).sort((a, b) => a - b);
        const gaps = g.map((x) => x.gap).sort((a, b) => a - b);
        // per pass: ms per GPU frame (frames it didn't run in count 0)
        const names = new Set();
        for (const x of g) for (const k in x.passes) names.add(k);
        const passes = [...names]
          .map((k) => {
            const v = g.map((x) => x.passes[k] ?? 0).sort((a, b) => a - b);
            const mean = v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
            return { k, mean: +mean.toFixed(3), p95: +pct(v, 0.95).toFixed(2), max: +v[v.length - 1].toFixed(2), ran: v.filter((x) => x > 0).length };
          })
          .sort((a, b) => b.mean - a.mean);
        const longs = f
          .filter((x) => x.iv > longMs)
          .map((x) => {
            const G = log.g.get(x.pf);
            const top = G ? Object.entries(G.passes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ') : 'n/a';
            return `${x.iv.toFixed(1)} ms: cpu ${x.cpu.toFixed(1)} held ${x.held} busy ${x.busy} maps ${x.maps} pend ${x.pend} | gpu span ${G ? G.span.toFixed(1) : '?'} sum ${G ? G.sum.toFixed(1) : '?'} gap ${G ? G.gap.toFixed(1) : '?'} | ${top}`;
          });
        // (each slide: the GPU over the 20 frames from its start, less 20 of the run's median frame — the catch-up —
        // and which passes it was; the frames over 20 ms in that window)
        const med = spans[Math.floor(spans.length / 2)] ?? 0;
        const post = [];
        for (let i = 1; i < f.length; i++)
          if (f[i].sl !== f[i - 1].sl) {
            let sum = 0;
            let over = 0;
            const by = {};
            for (let j = i; j < Math.min(f.length, i + 20); j++) {
              if (f[j].iv > 20) over++;
              const G = log.g.get(f[j].pf);
              if (!G) continue;
              sum += G.span - med;
              for (const [k, v] of Object.entries(G.passes)) by[k] = (by[k] ?? 0) + v;
            }
            post.push({ extra: +sum.toFixed(1), over20: over, top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ') });
          }
        const cpu = window.reclaimed.scene.cpuWorst();
        const slideCpu = Object.fromEntries(Object.entries(cpu).filter(([k]) => /^(fz\.|sl\.|slide|rs\.freeze)/.test(k)));
        const cpuTop = Object.entries(cpu).sort((a, b) => b[1].mean * b[1].n - a[1].mean * a[1].n).slice(0, 14).map(([k, v]) => `${k} ${v.mean}x${v.n} (max ${v.max})`);
        const cpuMs = f.map((x) => x.cpu).sort((a, b) => a - b);
        const rep = window.reclaimedHitch.report();
        return {
          wall: +wall.toFixed(0),
          frames: f.length,
          fps: +((f.length / wall) * 1000).toFixed(1),
          iv: { p50: +pct(iv, 0.5).toFixed(1), p95: +pct(iv, 0.95).toFixed(1), p99: +pct(iv, 0.99).toFixed(1), max: +(iv[iv.length - 1] ?? 0).toFixed(1), over20: iv.filter((x) => x > 20).length, over25: iv.filter((x) => x > 25).length, over33: iv.filter((x) => x > 33).length, over50: iv.filter((x) => x > 50).length },
          cpu: { p50: +pct(cpuMs, 0.5).toFixed(2), p95: +pct(cpuMs, 0.95).toFixed(2), max: +(cpuMs[cpuMs.length - 1] ?? 0).toFixed(1) },
          held: f.reduce((s, x) => s + x.held, 0),
          gpu: { frames: g.length, spanP50: +pct(spans, 0.5).toFixed(2), spanP95: +pct(spans, 0.95).toFixed(2), spanMax: +(spans[spans.length - 1] ?? 0).toFixed(1), sumMean: +(g.reduce((s, x) => s + x.sum, 0) / Math.max(1, g.length)).toFixed(2), gapP50: +pct(gaps, 0.5).toFixed(2), gapP95: +pct(gaps, 0.95).toFixed(2), busy: +(g.reduce((s, x) => s + x.span, 0) / wall).toFixed(3) },
          passes,
          longs,
          causes: rep.causes,
          slideCpu,
          cpuTop,
          inst: { ...window.reclaimed.renderer.instanceCounts },
          tSec: +(performance.now() / 1000).toFixed(0),
          post,
          slides: st.slides - st0.slides,
          slideSync: S.trace.slice(-30).filter((t) => t.t0 >= log.t0).map((t) => +(t.sync - t.t0).toFixed(1)),
          came: { generated: st.generated - st0.generated, thawed: st.thawed - st0.thawed, loaded: st.loaded - st0.loaded },
        };
      },
      st0,
      longMs,
    );
    r.speed = speed;
    r.win = win;
    r.zoom = zoom;
    r.throttle = throttle;
    results.push(r);
    console.log(`\n=== win ${win} zoom ${zoom} speed ${speed} throttle ${throttle || 1}: ${r.frames} frames ${r.fps} fps | iv p50 ${r.iv.p50} p95 ${r.iv.p95} p99 ${r.iv.p99} max ${r.iv.max} >20 ${r.iv.over20} >25 ${r.iv.over25} >33 ${r.iv.over33} >50 ${r.iv.over50} | held ${r.held} | cpu p50 ${r.cpu.p50} p95 ${r.cpu.p95} max ${r.cpu.max} | t ${r.tSec}s inst ${JSON.stringify(r.inst)}`);
    console.log(`  gpu: ${r.gpu.frames} frames read, span p50 ${r.gpu.spanP50} p95 ${r.gpu.spanP95} max ${r.gpu.spanMax}, passes sum mean ${r.gpu.sumMean}, gap p50 ${r.gpu.gapP50} p95 ${r.gpu.gapP95}, busy ${r.gpu.busy}`);
    console.log(`  passes (ms/frame mean p95 max ran): ${r.passes.filter((x) => x.mean > 0.02 || x.max > 1).map((x) => `${x.k} ${x.mean}/${x.p95}/${x.max}/${x.ran}`).join(' | ')}`);
    console.log(`  causes ${JSON.stringify(r.causes)} slides ${r.slides} came ${JSON.stringify(r.came)} sync ${r.slideSync.join(' ')}`);
    console.log(`  slide cpu ${Object.entries(r.slideCpu).map(([k, v]) => `${k} ${v.mean}/${v.max}`).join(', ')}`);
    console.log(`  cpu top ${r.cpuTop.join(', ')}`);
    if (r.post.length) {
      const m = (k) => +(r.post.reduce((a, x) => a + x[k], 0) / r.post.length).toFixed(2);
      console.log(`  post-slide (20 frames): GPU over the median ${m('extra')} ms a slide, frames over 20 ms ${m('over20')} a slide | ${r.post.slice(0, 4).map((x) => `[${x.extra}: ${x.top}]`).join(' ')}`);
    }
    for (const l of r.longs.slice(0, 14)) console.log(`  long ${l}`);
  }
  // (--skips "far;mesh;opaque,tops": parked, each set of the renderer's ?skip= pieces left out for --seconds at the
  // same spot — Renderer.skip is read as each frame is encoded — and the GPU's passes against none left out)
  const skips = opt('skips', '');
  if (skips) {
    await p.evaluate(() => (window.reclaimed.scene.pan = null));
    const rows = [];
    // (each set between two runs of none: the iGPU's clock drifts, so a set is judged against the runs either side of it)
    const sets = [''];
    for (const x of skips.split(';')) sets.push(x, '');
    for (const set of sets) {
      const r = await p.evaluate(
        async (set, secs) => {
          const R = window.reclaimed;
          const S = R.renderer.constructor.skip;
          const keys = set ? set.split(',') : [];
          for (const k of keys) S.add(k);
          await new Promise((res) => setTimeout(res, 800));
          const prof = R.core.host.profiler;
          prof.resetTotals();
          const t0 = performance.now();
          let frames = 0;
          while (performance.now() - t0 < secs * 1000) {
            await new Promise((res) => requestAnimationFrame(res));
            frames++;
          }
          for (const k of keys) S.delete(k);
          const n = Math.max(1, prof.framesResolved);
          const per = Object.fromEntries([...prof.totalMs].map(([k, v]) => [k, +(v / n).toFixed(3)]));
          return { set, fps: +((frames / secs)).toFixed(1), gpu: +(prof.gpuTotalMs / n).toFixed(2), draw: per.draw ?? 0, gbuffer: per.gbuffer ?? 0, shadow: +((per.shadow ?? 0) + (per['shadow-static'] ?? 0)).toFixed(3), renderprep: per.renderprep ?? 0 };
        },
        set,
        seconds,
      );
      rows.push(r);
      console.log(`  skip ${(set || '(none)').padEnd(26)} ${r.fps} fps, GPU frame ${r.gpu} ms: draw ${r.draw} gbuffer ${r.gbuffer} shadow ${r.shadow} renderprep ${r.renderprep}`);
    }
    for (let k = 1; k < rows.length; k += 2) {
      const base = (rows[k - 1].gpu + rows[k + 1].gpu) / 2;
      const draw = (rows[k - 1].draw + rows[k + 1].draw) / 2;
      rows[k].savesGpu = +(base - rows[k].gpu).toFixed(2);
      rows[k].savesDraw = +(draw - rows[k].draw).toFixed(2);
      console.log(`  => without ${rows[k].set.padEnd(28)} saves GPU ${rows[k].savesGpu} ms a frame (draw ${rows[k].savesDraw}) of ${base.toFixed(2)}`);
    }
    results.push({ skips: rows });
  }
  if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
} finally {
  await browser.close();
}
if (bad) process.exit(1);
