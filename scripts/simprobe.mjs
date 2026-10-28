// Round 104 (simscale): what each simulation system costs on the GPU, per window size, parked or riding — the
// deployed atlas page as the phone runs it (every system on, 1x speed). Two views of each system:
//   inSitu   its passes' GPU ms a frame while the game runs (the profiler's per-pass totals; copies between
//            passes aren't in them)
//   isolated one run of the system alone, bracketed by two empty timestamped passes so the copies between its
//            passes count too (median of 6), and that a tick (÷ its period)
//   node scripts/simprobe.mjs [--url http://localhost:5301] [--wins 320,448,512] [--drive 0|18] [--seconds 12]
//     [--size 412x915] [--q low] [--at 15024,14337] [--extra "&x=y"] [--out file.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5301');
const wins = opt('wins', '320,448,512').split(',').map(Number);
const drives = opt('drive', '0').split(',').map(Number);
const seconds = Number(opt('seconds', 12));
const q = opt('q', 'low');
const at = opt('at', '15024,14337');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const extra = opt('extra', '');
const firstWait = Number(opt('firstwait', 30000));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2.6 },
  protocolTimeout: 600000,
});
const results = [];
let first = true;
try {
  for (const win of wins)
    for (const drive of drives) {
      const p = await browser.newPage();
      const errs = [];
      p.on('pageerror', (e) => errs.push(e.message));
      p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errs.push(m.text().slice(0, 300)));
      const u = `${url}/?skipmenu=1&level=atlas&tutorial=0&q=${q}&perf=1&win=${win}&at=${at}${drive ? `&drive=${drive}` : ''}${extra}`;
      await p.goto(u, { waitUntil: 'load' });
      await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
      await new Promise((r) => setTimeout(r, first ? firstWait : 8000));
      first = false;
      await p.evaluate(() => {
        const R = window.reclaimed;
        R.core.host.profiler.resetTotals();
        window.__t0 = performance.now();
        window.__tick0 = R.core.sim.tick;
        window.__frames = 0;
        window.__awake = [];
        const f = () => {
          window.__frames++;
          window.__awake.push(R.core.sleep?.awake ?? -1);
          requestAnimationFrame(f);
        };
        requestAnimationFrame(f);
      });
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const r = await p.evaluate(async () => {
        const R = window.reclaimed;
        const prof = R.core.host.profiler;
        const fr = Math.max(prof.framesResolved, 1);
        const secs = (performance.now() - window.__t0) / 1000;
        const ticks = R.core.sim.tick - window.__tick0;
        const inSitu = Object.fromEntries([...prof.totalMs].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / fr).toFixed(3)]));
        const aw = window.__awake.filter((x) => x >= 0).sort((a, b) => a - b);
        // isolated: each system alone, bracketed
        const dev = R.core.host.gpu.device;
        const qs = dev.createQuerySet({ type: 'timestamp', count: 2 });
        const res = dev.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
        const st = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const sims = R.core.sim.systems.filter((x) => !/^(edit|layerpull|landbrush|townstamp|placeop|stats)$/.test(x.name));
        const items = sims.map((s) => [s.name, s.period, (e) => s.encode(e, R.core.sim.tick), s]);
        if (R.agents) items.push(['agents', 1, (e) => R.agents.encode(e), R.agents]);
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const iso = {};
        for (const [name, period, enc, s] of items) {
          const ms = [];
          for (let k = 0; k < 6; k++) {
            await frame();
            const e = dev.createCommandEncoder();
            let pa = e.beginComputePass({ timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0 } });
            pa.end();
            const was = prof.active;
            prof.active = false;
            try {
              enc(e);
            } finally {
              prof.active = was;
            }
            pa = e.beginComputePass({ timestampWrites: { querySet: qs, endOfPassWriteIndex: 1 } });
            pa.end();
            e.resolveQuerySet(qs, 0, 2, res, 0);
            e.copyBufferToBuffer(res, 0, st, 0, 16);
            dev.queue.submit([e.finish()]);
            s.afterSubmit?.();
            await st.mapAsync(GPUMapMode.READ);
            const b = new BigUint64Array(st.getMappedRange().slice(0));
            st.unmap();
            ms.push(Number(b[1] - b[0]) / 1e6);
          }
          ms.sort((a, b) => a - b);
          const med = (ms[2] + ms[3]) / 2;
          iso[name] = { run: +med.toFixed(3), perTick: +(med / period).toFixed(3), period };
        }
        const isoSum = +Object.entries(iso).filter(([k]) => k !== 'agents').reduce((a, [, v]) => a + v.perTick, 0).toFixed(3);
        return {
          window: [R.core.dims.w, R.core.dims.h],
          chunks: (R.core.dims.w / 16) * (R.core.dims.h / 16),
          fps: +(window.__frames / secs).toFixed(1),
          ticksPerFrame: +(ticks / Math.max(window.__frames, 1)).toFixed(2),
          gpuFrame: +(prof.gpuTotalMs / fr).toFixed(2),
          awake: aw.length ? { p50: aw[aw.length >> 1], max: aw[aw.length - 1] } : null,
          isoSimsPerTick: isoSum,
          scope: { agentsChunks: R.agents?.lastScopeChunks ?? null, agentsRelaxed: R.agents?.lastRelaxed ?? null, agentsFrozen: R.agents?.scope?.frozen ?? null, windBox: R.core.sim.wind.lastBox ?? null, projectChunks: R.core.sim.project?.lastChunks ?? null, units: R.agents?.size ?? null },
          iso,
          inSitu,
        };
      });
      r.drive = drive;
      r.errors = errs;
      results.push(r);
      console.log(`WIN ${win} drive ${drive}: fps ${r.fps} gpuFrame ${r.gpuFrame} ticks/frame ${r.ticksPerFrame} awake ${JSON.stringify(r.awake)} sims/tick ${r.isoSimsPerTick} ms`);
      console.log('  scope ' + JSON.stringify(r.scope));
      console.log('  iso ' + Object.entries(r.iso).sort((a, b) => b[1].perTick - a[1].perTick).map(([k, v]) => `${k} ${v.perTick}`).join(', '));
      console.log('  inSitu ' + Object.entries(r.inSitu).slice(0, 30).map(([k, v]) => `${k} ${v}`).join(', '));
      if (errs.length) console.log('  ERRORS ' + errs.slice(0, 3).join(' | '));
      await p.close();
    }
} finally {
  await browser.close();
  if (opt('out', '')) fs.writeFileSync(opt('out', ''), JSON.stringify(results, null, 1));
}
