// Round 114 (framepace): the frame pacing probe (src/perf/framepace.ts) headless at the phone's shape, parked —
// the bench's pan page's phases (timed, untimed, frames in flight 1 and 3, the sim off) without the bench's chain.
//   node scripts/paceprobe.mjs [--url http://localhost:5211] [--size 412x915] [--dpr 2.6] [--q low] [--wait 35]
//     [--seconds 4] [--extra "&x=1"] [--zoom 14] [--out pace.json] [--uncapped]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5211');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const dpr = Number(opt('dpr', '2.6'));
const q = opt('q', 'low');
const wait = Number(opt('wait', 35)) * 1000;
const seconds = Number(opt('seconds', 4));
const extra = opt('extra', '');
const zoom = opt('zoom', '');
const out = opt('out', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`].concat(argv.includes('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: dpr, hasTouch: true, isMobile: true },
  protocolTimeout: 600000,
});
let bad = 0;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad++;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 300)));
  const u = `${url}/?skipmenu=1&level=atlas&tutorial=0&q=${q}&hitch=1&hitchhud=0${extra}`;
  console.log(u);
  await p.goto(u, { waitUntil: 'load', timeout: 240000 });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimedPace, { timeout: 240000 });
  if (zoom) await p.evaluate((z) => (window.reclaimed.camera.zoom = z), Number(zoom));
  await sleep(wait);
  const res = await p.evaluate(async (seconds) => {
    const pace = window.reclaimedPace;
    const R = window.reclaimed;
    const prof = R.core.host.profiler;
    pace.sources.simTick = () => R.core.sim.tick;
    pace.sources.slowSystems = () => R.core.sim.systems.filter((x) => x.period > 1);
    const sum = (o) => Object.values(o ?? {}).reduce((t, v) => t + (typeof v === 'number' ? v : 0), 0);
    pace.sources.counters = { coarse: () => R.atlas?.coarse?.partsRun ?? 0, stream: () => sum(R.stream?.stats) };
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const phase = async (key, setup) => {
      const undo = setup();
      await sl(400);
      const m = pace.mark();
      await sl(seconds * 1000);
      await R.core.host.gpu.device.queue.onSubmittedWorkDone();
      await sl(150);
      out[key] = pace.report(m, key);
      undo();
    };
    const was = prof.active;
    await phase('timed', () => ((prof.active = true), () => (prof.active = was)));
    await phase('untimed', () => ((prof.active = false), () => (prof.active = was)));
    for (const n of [1, 3]) await phase(`inFlight${n}`, () => ((prof.active = false), (pace.maxInFlight = n), () => ((pace.maxInFlight = 2), (prof.active = was))));
    const sims = R.core.sim.systems.filter((x) => !/^(edit|layerpull|landbrush|townstamp|placeop|stats)$/.test(x.name));
    const own = sims.map((x) => Object.prototype.hasOwnProperty.call(x, 'encode'));
    const enc = sims.map((x) => x.encode);
    await phase('simOff', () => {
      prof.active = false;
      sims.forEach((x) => (x.encode = () => {}));
      return () => {
        sims.forEach((x, i) => (own[i] ? (x.encode = enc[i]) : delete x.encode));
        prof.active = was;
      };
    });
    return out;
  }, seconds);
  const brief = (r) =>
    `${r.label}: ${r.fps} fps, vsync ${r.vsyncMs}, slow ${r.slow?.n}/${r.frames} ${JSON.stringify(r.vsyncsPerFrame)}, interval p99 ${r.interval?.p99}, lag p50 ${r.lag?.p50}, cpu p50/p95 ${r.cpu?.p50}/${r.cpu?.p95}, toSubmit p50 ${r.toSubmit?.p50}, done p50/p95 ${r.done?.p50}/${r.done?.p95}, gpu p50/p95 ${r.gpu?.p50 ?? '-'}/${r.gpu?.p95 ?? '-'}, gap p50 ${r.gap?.p50 ?? '-'}, inFlight ${JSON.stringify(r.inFlightAtStart)}, held ${r.heldRafs}, ticks ${JSON.stringify(r.ticksPerFrame)}, slow by ticks ${JSON.stringify(r.slowFramesByTicks)}`;
  for (const r of Object.values(res)) console.log(brief(r));
  console.log('canvas', JSON.stringify(res.timed.canvas));
  console.log('passes ok', JSON.stringify(res.timed.passesOk));
  console.log('passes slow', JSON.stringify(res.timed.passesSlow));
  console.log('slow vs ok (timed)', JSON.stringify({ ok: res.timed.ok, slow: res.timed.slow, before: res.timed.beforeSlow }));
  for (const w of res.timed.worst) console.log('  worst', w);
  for (const w of res.untimed.worst.slice(0, 4)) console.log('  worst untimed', w);
  if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
