// The perf gate (2026-11-17; the owner: "The performance is very bad again even though we had streaming working and
// simulation blocks sleeping and fast tiles streaming before … make a quick unit test to flag that if it ever happens
// again so we know right away what change caused it"). Headless Chrome on the real GPU, q=low, fresh world, at phone
// (412x915) and desktop (1280x720) size, three scenarios:
//   loop     the game loop idle at the town (?level=atlas&town=1&loop=1, the first leader picked)
//   sandbox  the atlas sandbox idle at the same town (no loop)
//   jump     in the sandbox: the camera jumped to fresh land and back (streaming)
// Per scenario: time to the level, to the first frame, to a full screen (coverage >= 99 %, render/coverage.ts); at
// idle the per-frame census (src/gpu/census.ts: passes, dispatches, draws, reads, uploads, ticks — deterministic) plus
// direct-draw instances and vertices, the systems doing GPU work; frame GPU ms (timestamps) and rAF CPU ms (median, p90).
// Then compares with data/perf/gate-baseline.json (scripts/lib/perfgate-compare.mjs) and fails naming the scenario, the
// metric, the baseline and the new value.
//   npm run perfgate                       measure + compare (exit 1 on a failure)
//   npm run perfgate -- --update           measure + rewrite the baseline (say why in the DEVLOG)
//   npm run perfgate -- --quick            phone size only
//   --scenarios loop,sandbox,jump  --sizes 412x915,1280x720  --idle 8  --settle 12  --out perf-reports/perfgate.json
//   --nocompare                            measure only (the bisect: older commits, their own runner)
import fs from 'node:fs';
import path from 'node:path';
import { run, ROOT } from './lib/runner.mjs';
import { compare, COVER_FULL } from './lib/perfgate-compare.mjs';

const BASELINE = path.join(ROOT, 'data/perf/gate-baseline.json');
/** systems put to sleep in a quiet world (src/sim/quiet.ts QUIET_SYSTEMS): never awake at the loop's idle */
const QUIET = ['ecology', 'wilt', 'climate', 'cover', 'moisture', 'contamination', 'sediment', 'oil', 'lava', 'structure', 'fire'];

/** the page hook: rAF CPU ms per frame, direct-draw instances and vertices (the census counts calls, not instances) */
function hook() {
  const g = (window.__pg = { frames: 0, cpu: [], inst: 0, verts: 0, gpu: [] });
  const raf = window.requestAnimationFrame.bind(window);
  let inFrame = 0;
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      const t0 = performance.now();
      try {
        cb(t);
      } finally {
        inFrame += performance.now() - t0;
      }
    });
  const tick = () => {
    if (inFrame > 0) {
      g.frames++;
      g.cpu.push(inFrame);
      if (g.cpu.length > 2000) g.cpu.shift();
    }
    inFrame = 0;
    raf(tick);
  };
  raf(tick);
  const wrapDraw = () => {
    if (typeof GPURenderPassEncoder === 'undefined') return;
    // (the page's own count of passes and dispatches: the same at every commit, census or not)
    g.cp = g.disp = g.ind = g.rp = g.drawsAll = 0;
    const wrap = (proto, name, f) => {
      const o = proto[name];
      proto[name] = function (...a) {
        f(a);
        return o.apply(this, a);
      };
    };
    wrap(GPUCommandEncoder.prototype, 'beginComputePass', () => g.cp++);
    wrap(GPUCommandEncoder.prototype, 'beginRenderPass', () => g.rp++);
    wrap(GPUComputePassEncoder.prototype, 'dispatchWorkgroups', () => g.disp++);
    wrap(GPUComputePassEncoder.prototype, 'dispatchWorkgroupsIndirect', () => (g.disp++, g.ind++));
    for (const d of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) wrap(GPURenderPassEncoder.prototype, d, () => g.drawsAll++);
    const P = GPURenderPassEncoder.prototype;
    const d = P.draw;
    P.draw = function (v, i = 1, ...r) {
      g.inst += i;
      g.verts += v * i;
      return d.call(this, v, i, ...r);
    };
    const di = P.drawIndexed;
    P.drawIndexed = function (n, i = 1, ...r) {
      g.inst += i;
      g.verts += n * i;
      return di.call(this, n, i, ...r);
    };
  };
  wrapDraw();
}

const q = (a, f) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(2);
};

await run({ name: 'perfgate', kind: 'behaviour' }, async (R) => {
  const scen = R.opt('scenarios', 'loop,sandbox,jump,pan,tall').split(',');
  const sizes = R.flag('quick') ? ['412x915'] : R.opt('sizes', '412x915,1280x720').split(',');
  const idleS = Number(R.opt('idle', 8));
  const settleS = Number(R.opt('settle', 12));
  const out = path.resolve(ROOT, R.opt('out', 'perf-reports/perfgate.json'));
  const result = { at: new Date().toISOString(), scenarios: {} };

  /** wait for coverage >= COVER_FULL, polled every 100 ms; ms from now, reached, best */
  const waitCover = (p, limitMs) =>
    p.evaluate(
      (limit, full) =>
        new Promise((res) => {
          const t0 = performance.now();
          const f0 = window.__pg.frames;
          let best = 0;
          // (a trace a second: [s, coverage or null (no check: flying, no window), frames drawn so far])
          const trace = [];
          let nextT = 0;
          const look = () => {
            const R = window.reclaimed;
            const gc = R?.renderer?.tiles?.coverCheck?.(R.camera);
            const cov = gc ? 1 - gc.share : 0;
            best = Math.max(best, cov);
            const ms = performance.now() - t0;
            if (ms >= nextT) {
              trace.push([Math.round(ms / 1000), gc ? +cov.toFixed(3) : null, window.__pg.frames - f0]);
              nextT += 1000;
            }
            const frames = window.__pg.frames - f0;
            if (gc && cov >= full) return res({ reached: true, ms: Math.round(ms), best, frames, trace });
            if (ms > limit || document.querySelector('.fatal')) return res({ reached: false, ms: Math.round(ms), best, frames, trace });
            setTimeout(look, 100);
          };
          // (two frames first: a camera just moved is judged on what the frames after it drew)
          requestAnimationFrame(() => requestAnimationFrame(look));
        }),
      limitMs,
      COVER_FULL,
    );

  /** the census and the hook over `s` seconds of idle */
  const idle = async (p, s) => {
    await p.evaluate(() => {
      window.__census?.take();
      const g = window.__pg;
      g.cpu.length = 0;
      g.gpu.length = 0;
      g.f0 = g.frames;
      g.i0 = g.inst;
      g.v0 = g.verts;
      g.c0 = [g.cp, g.rp, g.disp, g.ind, g.drawsAll];
      const pr = window.reclaimed.core.host.profiler;
      if (pr?.enabled && !g.listening) {
        g.listening = true;
        pr.active = true;
        pr.listen((_f, ms) => g.gpu.push(ms));
      }
      pr?.resetTotals?.();
    });
    await R.sleep(s * 1000);
    return p.evaluate(() => {
      const g = window.__pg;
      const n = Math.max(1, g.frames - g.f0);
      // (no census at this commit: the hook's own counts stand in for its totals, no systems)
      const own = [g.cp, g.rp, g.disp, g.ind, g.drawsAll].map((v, i) => (v - g.c0[i]) / n);
      const c = window.__census?.take() ?? { ticksPerFrame: null, systems: [], total: { computePasses: own[0], renderPasses: own[1], direct: own[2] - own[3], indirect: own[3], draws: own[4], drawsIndirect: 0, readBytes: NaN, uploads: NaN, uploadBytes: NaN, copyBytes: NaN, phoneMs: NaN } };
      // (the GPU's ms a frame by pass, the top 10: shares within a run hold even on a shared GPU)
      const pr = window.reclaimed.core.host.profiler;
      const fr = Math.max(1, pr?.framesResolved ?? 0);
      const passes = pr?.totalMs ? Object.fromEntries([...pr.totalMs].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => [k, +(v / fr).toFixed(2)])) : null;
      const sim = window.reclaimed.sim ?? window.reclaimed.core?.sim;
      const simNames = sim?.systems ? ['sim-tick', ...sim.systems.filter((x) => !x.perFrame).map((x) => x.name)] : [];
      return {
        simNames,
        passes, census: c, frames: n, inst: (g.inst - g.i0) / n, verts: (g.verts - g.v0) / n, cpu: [...g.cpu], gpu: [...g.gpu] };
    });
  };

  const scenario = (m) => {
    // (as at one sim tick a frame: the sim's systems run per tick — 60 a second — so on a GPU slowed by others the frame
    // carries more ticks and their passes; each sim system's counts are divided by the ticks a frame, the rest kept.
    // That makes the counters the frame's own whatever the frame rate)
    const tpf = m.census.ticksPerFrame;
    const sim = new Set(m.simNames ?? []);
    const t = { ...m.census.total };
    if (tpf > 0 && m.census.systems.length) {
      for (const k of Object.keys(t)) if (typeof t[k] === 'number') t[k] = 0;
      for (const s of m.census.systems) {
        const d = sim.has(s.system) ? tpf : 1;
        for (const k of Object.keys(t)) if (typeof s[k] === 'number') t[k] += s[k] / d;
      }
    }
    const counters = {
      computePasses: t.computePasses,
      renderPasses: t.renderPasses,
      dispatches: t.direct + t.indirect,
      indirectDispatches: t.indirect,
      draws: t.draws + t.drawsIndirect,
      instances: +m.inst.toFixed(1),
      vertices: Math.round(m.verts),
      readKB: +(t.readBytes / 1024).toFixed(2),
      uploads: t.uploads,
      uploadKB: +(t.uploadBytes / 1024).toFixed(2),
      copyKB: +(t.copyBytes / 1024).toFixed(2),
      estPhoneMs: +t.phoneMs.toFixed(3),
    };
    const awake = m.census.systems.filter((s) => s.direct + s.indirect > 0.05).map((s) => s.system).sort();
    const bySystem = Object.fromEntries(m.census.systems.slice(0, 20).map((s) => [s.system, { phoneMs: s.phoneMs, passes: +(s.computePasses + s.renderPasses).toFixed(2), disp: +(s.direct + s.indirect).toFixed(2), readKB: +(s.readBytes / 1024).toFixed(2) }]));
    return { counters, ticksPerFrame: tpf, awake, bySystem, gpuPasses: m.passes, timings: { cpuMedMs: q(m.cpu, 0.5), cpuP90Ms: q(m.cpu, 0.9), gpuMedMs: q(m.gpu, 0.5), gpuP90Ms: q(m.gpu, 0.9) }, fps: +(m.frames / idleS).toFixed(1) };
  };

  /** open a level; the PI-9 first-frame stall waited out as census.mjs does */
  const open = async (size, params) => {
    const p = await R.page({ size });
    await p.evaluateOnNewDocument(hook);
    const t0 = Date.now();
    // (a param given as null is left out: the tall spot opens at `at`, not the town)
    const all = Object.fromEntries(Object.entries({ level: 'atlas', town: 1, fresh: 1, census: 1, censusevery: 0, perf: 0, ...params }).filter(([, v]) => v !== null));
    await R.level(all, { page: p, noDefaultQ: R.flag('noq') });
    const levelMs = Date.now() - t0;
    await p.waitForFunction(() => window.__pg.frames >= 2 || document.querySelector('.fatal'), { timeout: 180000, polling: 100 });
    const firstFrameMs = Date.now() - t0;
    const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (fatal && /the GPU never finished/.test(fatal)) {
      R.log(`first frames held the GPU (PI-9): overlay taken down`);
      await p.evaluate(() => document.querySelector('.fatal')?.remove());
    } else await R.fatal(p);
    return { p, levelMs, firstFrameMs };
  };

  /**
   * (scenario D, the owner 2026-11-17: "I would also test panning and streaming. My hope was to have that be fast enough
   * to be lag free") a steady pan in the page: `v` cells a second along x for `secs`, the camera at `zoom` (null: as it
   * stands), every frame's wall ms, GPU ms (timestamps, when read back), undrawn share (render/coverage.ts) and the
   * window's slides; then how long the screen takes to fill once the pan stops; the census over the pan per slide.
   */
  const pan = async (p, v, secs, zoom, idleTotal) => {
    await p.evaluate(() => window.__census?.take());
    const r = await p.evaluate(
      (v, secs, zoom) =>
        new Promise((res) => {
          const R = window.reclaimed;
          const cam = R.camera;
          const S = R.stream ?? R.scene?.stream;
          if (zoom != null) cam.zoom = zoom;
          const z = cam.zoom;
          const slides0 = S?.stats?.slides ?? 0;
          const made0 = R.renderer.tiles?.land?.stats?.made ?? 0;
          const ft = [];
          const und = [];
          const gpu = [];
          const g = window.__pg;
          const g0 = g.gpu.length;
          let slideFrames = [];
          let lastSlides = slides0;
          const t0 = performance.now();
          let last = t0;
          const step = (t) => {
            const dt = t - last;
            last = t;
            if (t > t0) ft.push(dt);
            const gc = R.renderer.tiles?.coverCheck?.(cam);
            und.push(gc ? gc.share : 1);
            const sl = S?.stats?.slides ?? 0;
            if (sl !== lastSlides) slideFrames.push(ft.length);
            lastSlides = sl;
            if (t - t0 < secs * 1000) {
              cam.target[0] += (v * dt) / 1000;
              requestAnimationFrame(step);
              return;
            }
            // (stopped: how long till the screen is full again)
            const ts = performance.now();
            const fill = () => {
              const c = R.renderer.tiles?.coverCheck?.(cam);
              const ms = performance.now() - ts;
              if ((c && c.share <= 0.01) || ms > 30000) {
                for (let i = g0; i < g.gpu.length; i++) gpu.push(g.gpu[i]);
                return res({ zoom: +z.toFixed(2), ft, und, gpu, slideFrames, slides: (S?.stats?.slides ?? 0) - slides0, tilesMade: (R.renderer.tiles?.land?.stats?.made ?? 0) - made0, settleMs: Math.round(ms), settled: !!(c && c.share <= 0.01) });
              }
              requestAnimationFrame(fill);
            };
            requestAnimationFrame(fill);
          };
          requestAnimationFrame(step);
        }),
      v,
      secs,
      zoom,
    );
    const c = await p.evaluate(() => window.__census?.take() ?? null);
    const n = r.ft.length || 1;
    // (a slide's own work: the pan's total less the idle frame's rate over the same frames, by the window's slides —
    // so the frame rate the shared GPU allows doesn't move it)
    const per = (f, div = 1) => (c && r.slides ? +(Math.max(0, (c.total[f] - (idleTotal?.[f] ?? 0)) * c.frames) / r.slides / div).toFixed(2) : null);
    // (the spike at each slide: the worst frame within 2 of it, over the pan's median)
    const med = q(r.ft, 0.5);
    const spikes = r.slideFrames.map((i) => Math.max(...r.ft.slice(Math.max(0, i - 2), i + 3)));
    const area = r.und.reduce((a, b) => a + b, 0) / Math.max(1, r.und.length);
    // (who does a slide's work: the census's systems, per slide, top 6 by each of reads, buffers made, KB uploaded, passes)
    const who = {};
    if (c && r.slides)
      for (const [f, div] of [['readBytes', 1024], ['buffers', 1], ['uploadBytes', 1024], ['computePasses', 1], ['bindGroups', 1]])
        who[f] = Object.fromEntries([...c.systems].sort((a, b) => b[f] - a[f]).slice(0, 6).filter((s) => s[f] > 0).map((s) => [s.system, +((s[f] * c.frames) / r.slides / div).toFixed(1)]));
    return {
      who,
      zoom: r.zoom,
      v,
      secs,
      frames: n,
      slides: r.slides,
      tilesPerS: +(r.tilesMade / secs).toFixed(1),
      ft: { med, p90: q(r.ft, 0.9), worst: q(r.ft, 1), over16: r.ft.filter((x) => x > 17.5).length, over33: r.ft.filter((x) => x > 34).length },
      gpu: { med: q(r.gpu, 0.5), p90: q(r.gpu, 0.9), worst: q(r.gpu, 1) },
      slideSpikeMs: spikes.length ? +Math.max(...spikes).toFixed(1) : null,
      slideSpikeOverMedMs: spikes.length && med != null ? +(spikes.reduce((a, b) => a + b, 0) / spikes.length - med).toFixed(1) : null,
      undrawn: { maxPct: +(Math.max(...r.und) * 100).toFixed(2), meanPct: +(area * 100).toFixed(3), framesAny: r.und.filter((x) => x > 0.001).length },
      settleMs: r.settleMs,
      settled: r.settled,
      perSlide: { uploads: per('uploads'), uploadKB: per('uploadBytes', 1024), copyKB: per('copyBytes', 1024), reads: per('reads'), readKB: per('readBytes', 1024), bindGroups: per('bindGroups'), pipelines: per('pipelines'), buffers: per('buffers'), textures: per('textures'), computePasses: per('computePasses') },
    };
  };

  /** the three pans (the game's zoom, a closer one, a fling) and back home, as one scenario */
  const pans = async (p, key) => {
    const home = await p.evaluate(() => [...window.reclaimed.camera.target, window.reclaimed.camera.zoom]);
    const goHome = () => p.evaluate((h) => ((window.reclaimed.camera.target[0] = h[0]), (window.reclaimed.camera.target[1] = h[1]), (window.reclaimed.camera.zoom = h[3])), home);
    // (the idle frame's rate just before, taken off each pan's totals)
    const it = (await idle(p, 4)).census.total;
    const std = await pan(p, 30, 10, null, it);
    await goHome();
    await waitCover(p, 30000);
    const close = await pan(p, 30, 6, home[3] * 0.6, it);
    await goHome();
    await waitCover(p, 30000);
    const fling = await pan(p, 160, 2, null, it);
    await goHome();
    await waitCover(p, 30000);
    const s = {
      // (per-slide deterministic work of the standard pan: fails when it rises)
      counters: Object.fromEntries(Object.entries(std.perSlide).filter(([, v]) => v != null).map(([k, v]) => [`perSlide.${k}`, v])),
      // (pop-in and hitches: judged with their own allowances, perfgate-compare.mjs PAN_TOL)
      pan: { 'std.undrawnMeanPct': std.undrawn.meanPct, 'std.undrawnMaxPct': std.undrawn.maxPct, 'std.over33': std.ft.over33, 'close.over33': close.ft.over33, 'fling.over33': fling.ft.over33, 'fling.undrawnMeanPct': fling.undrawn.meanPct },
      timings: { stdWorstMs: std.ft.worst, stdSettleMs: std.settleMs, closeSettleMs: close.settleMs, flingSettleMs: fling.settleMs, slideSpikeMs: std.slideSpikeMs },
      cover: { 'std pan settle': { reached: std.settled, ms: std.settleMs, best: 1 - std.undrawn.maxPct / 100 }, 'fling settle': { reached: fling.settled, ms: fling.settleMs, best: 1 - fling.undrawn.maxPct / 100 } },
      std,
      close,
      fling,
    };
    // (a pan's per-slide counts move with how many slides it made and where: LOOSE_TOL)
    s.loose = true;
    result.scenarios[key] = s;
    for (const [n, x] of Object.entries({ std, close, fling })) R.log(`${key} ${n}: z${x.zoom} ${x.v} c/s ${x.slides} slides, frames ${JSON.stringify(x.ft)}, gpu ${JSON.stringify(x.gpu)}, spike ${x.slideSpikeMs}, undrawn ${JSON.stringify(x.undrawn)}, settle ${x.settleMs} ms, tiles ${x.tilesPerS}/s, per slide ${JSON.stringify(x.perSlide)}`);
  };

  // (scenario E, tall land: TR24 on the terrain branch — regions standing well over the focus's plane were never asked
  // for, an undrawn hole for good. A raised-coast spot (the terrain branch's stalldiag spot): the screen must fill)
  if (scen.includes('tall')) {
    const at = R.opt('tall', '13629,6487');
    const { p, levelMs, firstFrameMs } = await open('1280x720', { at, town: null, q: R.opt('tallq', 'high') });
    const cover = await waitCover(p, 120000);
    // (and 20 s on: what stays undrawn for good)
    await R.sleep(20000);
    const gc = await p.evaluate(() => {
      const c = window.reclaimed.renderer.tiles?.coverCheck?.(window.reclaimed.camera);
      return c ? { share: c.share, undrawn: c.undrawn.slice(0, 12) } : null;
    });
    result.scenarios['tall-desk'] = { counters: {}, timings: { levelMs, firstFrameMs, coverMs: cover.ms }, awake: [], cover: { 'tall-land cover': cover }, left: gc, loose: true };
    R.log(`tall-desk at ${at}: ${JSON.stringify({ reached: cover.reached, ms: cover.ms, best: cover.best, left: gc })}`);
    await p.close();
  }

  for (const size of sizes) {
    // (--noq: the link without q=low — the quality the device picks, as the owner's own links)
    const tag = (size === '412x915' ? 'phone' : 'desk') + (R.flag('noq') ? '-noq' : '');
    if (scen.includes('loop')) {
      const { p, levelMs, firstFrameMs } = await open(size, { loop: 1 });
      const cover = await waitCover(p, 90000);
      // (the first leader picked, "The world now" and the messenger closed: the town under its leader)
      await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 180000, polling: 200 });
      await p.evaluate(() => document.querySelector('.run-full .leader button')?.click());
      await p.waitForFunction(() => /city|event/.test(window.rungame?.phase ?? ''), { timeout: 60000, polling: 200 });
      await R.sleep(600);
      await p.evaluate(() => {
        for (const b of document.querySelectorAll('.run-full button')) if (b.textContent.trim() === 'Close') b.click();
        window.rungame.closePanel?.();
        window.rungame.messenger?.skip?.();
      });
      await R.sleep(settleS * 1000);
      const m = await idle(p, idleS);
      const s = scenario(m);
      s.timings = { levelMs, firstFrameMs, coverMs: cover.ms, ...s.timings };
      s.cover = { 'load cover': cover };
      s.mustSleep = QUIET;
      s.units = await p.evaluate(() => window.season?.town?.people?.length ?? window.rungame?.town?.people?.length ?? null).catch(() => null);
      result.scenarios[`loop-${tag}`] = s;
      R.log(`loop-${tag}: ${JSON.stringify({ ...s.counters, ...s.timings, awake: s.awake.join(' ') })}`);
      if (scen.includes('pan')) await pans(p, `pan-loop-${tag}`);
      await p.close();
    }
    if (scen.includes('sandbox') || scen.includes('jump') || scen.includes('pan')) {
      const { p, levelMs, firstFrameMs } = await open(size, {});
      const cover = await waitCover(p, 90000);
      await p.waitForFunction(() => window.season?.town != null || document.querySelector('.fatal'), { timeout: 180000, polling: 250 }).catch(() => {});
      await R.sleep(settleS * 1000);
      if (scen.includes('sandbox')) {
        const m = await idle(p, idleS);
        const s = scenario(m);
        s.timings = { levelMs, firstFrameMs, coverMs: cover.ms, ...s.timings };
        s.cover = { 'load cover': cover };
        // (the sandbox's own weather moves its counts: LOOSE_TOL)
        s.loose = true;
        result.scenarios[`sandbox-${tag}`] = s;
        R.log(`sandbox-${tag}: ${JSON.stringify({ ...s.counters, ...s.timings, awake: s.awake.join(' ') })}`);
      }
      if (scen.includes('pan')) await pans(p, `pan-sandbox-${tag}`);
      if (scen.includes('jump')) {
        // (--jump cells, 600, east in one frame — fresh land, the window slides after it — then back; land stats from the tiles)
        const J = Number(R.opt('jump', 600));
        const land = () => p.evaluate(() => ({ ...(window.reclaimed.renderer.tiles?.land?.stats ?? {}) }));
        const l0 = await land();
        await p.evaluate(() => window.__census?.take());
        const tJ = Date.now();
        await p.evaluate((j) => (window.reclaimed.camera.target[0] += j), J);
        const away = await waitCover(p, 60000);
        await R.sleep(2000);
        await p.evaluate((j) => (window.reclaimed.camera.target[0] -= j), J);
        const back = await waitCover(p, 60000);
        await R.sleep(2000);
        const c = await p.evaluate(() => window.__census?.take() ?? null);
        const secs = (Date.now() - tJ) / 1000;
        const l1 = await land();
        const m = await idle(p, idleS);
        const s = scenario(m);
        const made = (l1.made ?? 0) - (l0.made ?? 0);
        s.timings = { jumpCoverMs: away.ms, backCoverMs: back.ms, ...s.timings };
        s.cover = { 'jump cover': away, 'back cover': back };
        s.stream = { tilesMade: made, tilesPerS: +(made / secs).toFixed(1), readKBDuring: c ? +((c.total.readBytes * c.frames) / 1024).toFixed(0) : null, estPhoneMsDuring: c?.total.phoneMs ?? null };
        s.loose = true;
        result.scenarios[`jump-${tag}`] = s;
        R.log(`jump-${tag}: ${JSON.stringify({ ...s.counters, ...s.timings, ...s.stream })}`);
      }
      await p.close();
    }
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  R.log(`written ${out}`);
  if (R.flag('nocompare')) return;
  if (R.flag('update')) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(result, null, 1) + '\n');
    R.log(`baseline rewritten: ${path.relative(ROOT, BASELINE)} — say why in docs/DEVLOG.md`);
    return;
  }
  const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  const { fails, warns } = compare(base, result);
  for (const w of warns) R.log(`WARN ${w}`);
  for (const f of fails) R.check(f, false);
  R.check(`perf gate: ${fails.length} failure(s), ${warns.length} warning(s)`, fails.length === 0);
});
