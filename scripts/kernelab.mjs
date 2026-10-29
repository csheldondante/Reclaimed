// Round 107 (`pages`, PG4): each sim system's dispatches replayed alone, timed inside one compute pass (bench v4's
// way), on any build — to compare two builds kernel by kernel without the frame's noise or its sleep's.
// The atlas at window W parked; each system encoded once through a recorder, then each dispatch REPS times a pass.
//   node scripts/kernelab.mjs --url http://localhost:5313 [--win 256] [--wait 40000] [--samples 9]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5313');
const win = opt('win', '256');
const wait = Number(opt('wait', 40000));
const samples = Number(opt('samples', 9));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 900000,
});
try {
  const p = await browser.newPage();
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=15024,14337&win=${win}${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.core, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, wait));
  const r = await p.evaluate(async (samples) => {
    const R = window.reclaimed;
    const core = R.core;
    const dev = core.host.gpu.device;
    const REPS = 10;
    const qs = dev.createQuerySet({ type: 'timestamp', count: 2 });
    const res = dev.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const st = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const record = (sys) => {
      const out = [];
      const real = dev.createCommandEncoder();
      const pass = (label) => {
        let pipeline = null;
        const groups = [];
        return {
          setPipeline: (x) => (pipeline = x),
          setBindGroup: (i, g) => (groups[i] = g),
          dispatchWorkgroups: (x, y = 1, z = 1) => out.push({ label, pipeline, groups: groups.slice(), x: [x, y, z] }),
          dispatchWorkgroupsIndirect: (b, o) => out.push({ label, pipeline, groups: groups.slice(), ind: [b, o] }),
          end: () => {},
          pushDebugGroup: () => {},
          popDebugGroup: () => {},
          insertDebugMarker: () => {},
        };
      };
      const enc = new Proxy(real, {
        get(t, key) {
          if (key === 'beginComputePass') return (d) => pass(d?.label ?? '?');
          const v = t[key];
          if (typeof v === 'function') return () => {};
          return v;
        },
      });
      sys.encode(enc, core.sim.tick);
      return out;
    };
    const time = async (d) => {
      const xs = [];
      for (let k = 0; k < samples; k++) {
        await new Promise((r) => requestAnimationFrame(r));
        const enc = dev.createCommandEncoder();
        const ps = enc.beginComputePass({ timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } });
        for (let j = 0; j < REPS; j++) {
          ps.setPipeline(d.pipeline);
          d.groups.forEach((g, i) => g && ps.setBindGroup(i, g));
          if (d.x) ps.dispatchWorkgroups(...d.x);
          else ps.dispatchWorkgroupsIndirect(...d.ind);
        }
        ps.end();
        enc.resolveQuerySet(qs, 0, 2, res, 0);
        enc.copyBufferToBuffer(res, 0, st, 0, 16);
        dev.queue.submit([enc.finish()]);
        await st.mapAsync(GPUMapMode.READ);
        const w = new BigUint64Array(st.getMappedRange().slice(0));
        st.unmap();
        xs.push(Number(w[1] - w[0]) / 1e6 / REPS);
      }
      xs.sort((a, b) => a - b);
      return xs[Math.floor(xs.length / 2)];
    };
    const prof = core.host.profiler;
    const was = prof.active;
    prof.active = false;
    const out = {};
    try {
      for (const sys of core.sim.systems) {
        if (/^(edit|layerpull|landbrush|townstamp|placeop|stats)$/.test(sys.name)) continue;
        let recs;
        try {
          recs = record(sys);
        } catch {
          continue;
        }
        const seen = new Set();
        for (const d of recs) {
          if (seen.has(d.label) || !d.pipeline) continue;
          seen.add(d.label);
          out[d.label] = { ms: +(await time(d)).toFixed(4), groups: d.x ? d.x[0] * d.x[1] * d.x[2] : -1 };
        }
      }
    } finally {
      prof.active = was;
    }
    return out;
  }, samples);
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
