// Round 107 (agentspike, FRAMECOST FC4): where the agents' GPU time goes a frame, and on which ticks it spikes. The
// atlas at the phone tier (every system on, 1x), ?agentprof=1 (agents.ts: a timed pass a stage — agents-in, -peel,
// -relax, -units — and a log a tick: the scope's chunks, those come in, the marks, the peel, each sweep's front).
// Parked (the framecost spot) or riding (--drive S: the camera along a road, as driveprofile.mjs). Reports the agents'
// GPU a frame (mean / p95 / max, and by stage), and the worst frames with their ticks' logs.
//   node scripts/agentspike.mjs [--url http://localhost:5311] [--win 512] [--zoom 5] [--seconds 20] [--wait 35000]
//     [--drive 18] [--at x,y] [--top 12] [--prof 0] [--extra "&agentscope=0"] [--json out.json]
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
const seconds = Number(opt('seconds', 20));
const wait = Number(opt('wait', 35000));
const drive = opt('drive', '');
const top = Number(opt('top', 12));
const extra = opt('extra', '');
const out = opt('json', '');
// (--prof 0: the agents' tick as one pass, as the game runs it — for before / after against a build without the probe)
const prof = opt('prof', '1') !== '0';
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
});
let bad = false;
try {
  let at = opt('at', '15024,14337');
  if (drive && !argv.includes('--at')) {
    const v = await browser.newPage();
    await v.goto(`${url}/?atlas=view&overlay=0`, { waitUntil: 'load' });
    await v.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
    at = await v.evaluate(() => {
      const a = window.reclaimed.atlas;
      const warm = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
      const r = a.settlement.roads.filter((r) => warm(r.path[1]) > 0.55).sort((x, y) => y.length - x.length)[0];
      const k = Math.floor(r.path.length / 4) * 2;
      return `${Math.floor(r.path[k])},${Math.floor(r.path[k + 1] / 0.866)}`;
    });
    await v.close();
  }
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 300)));
  const world = `as-${Date.now().toString(36)}`;
  const u = `${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&hitch=1&hitchhud=0${prof ? '&agentprof=1' : ''}&at=${at}&win=${win}&world=${world}${drive ? `&drive=${drive}` : ''}${extra}`;
  console.log(u);
  await p.goto(u, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimed?.agents, { timeout: 240000 });
  await sleep(wait);
  await p.evaluate(
    (zoom, drive) => {
      const R = window.reclaimed;
      if (!drive) {
        R.scene.drive = null;
        R.scene.pan = null;
        R.camera.zoom = zoom;
      }
      const prof = R.core.host.profiler;
      const log = (window.__as = { on: false, g: new Map() });
      const prev = prof.onFrame;
      prof.onFrame = (n, ms, t) => {
        prev?.(n, ms, t);
        if (!log.on) return;
        const a = {};
        for (const [k, v] of prof.lastPasses) if (k.startsWith('agents')) a[k] = v;
        log.g.set(n, { span: ms, a });
      };
    },
    zoom,
    drive,
  );
  await sleep(1500);
  await p.evaluate(() => {
    window.__agentLog = [];
    window.__as.on = true;
  });
  await sleep(seconds * 1000);
  const r = await p.evaluate(async (top) => {
    window.__as.on = false;
    await new Promise((res) => setTimeout(res, 400));
    const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);
    const byFrame = new Map();
    for (const t of window.__agentLog) {
      if (!byFrame.has(t.frame)) byFrame.set(t.frame, []);
      byFrame.get(t.frame).push(t);
    }
    const frames = [...window.__as.g].map(([n, g]) => ({ n, span: g.span, a: g.a, tot: Object.values(g.a).reduce((s, x) => s + x, 0), ticks: byFrame.get(n) ?? [] }));
    const stat = (v) => {
      v = v.slice().sort((a, b) => a - b);
      return { mean: +(v.reduce((s, x) => s + x, 0) / Math.max(1, v.length)).toFixed(3), p95: +pct(v, 0.95).toFixed(2), max: +(v[v.length - 1] ?? 0).toFixed(2) };
    };
    const stages = ['agents', 'agents-in', 'agents-peel', 'agents-relax', 'agents-units'];
    const by = Object.fromEntries(stages.map((k) => [k, stat(frames.map((f) => f.a[k] ?? 0))]));
    const ticks = window.__agentLog;
    const fronts = ticks.flatMap((t) => t.front);
    const worst = frames
      .slice()
      .sort((a, b) => b.tot - a.tot)
      .slice(0, top)
      .map((f) => ({ frame: f.n, tot: +f.tot.toFixed(2), span: +f.span.toFixed(1), a: Object.fromEntries(Object.entries(f.a).map(([k, v]) => [k, +v.toFixed(2)])), ticks: f.ticks.map((t) => `t${t.tick} scope ${t.scope} in ${t.enter} marks ${t.marks} peel ${t.peel} units ${t.units} fields ${t.fields} front [${t.front.join(',')}] asked [${(t.asked ?? []).join(',')}]`) }));
    const A = window.reclaimed.agents;
    return {
      frames: frames.length,
      ticks: ticks.length,
      total: stat(frames.map((f) => f.tot)),
      by,
      scope: stat(ticks.map((t) => t.scope)),
      enter: { ticks: ticks.filter((t) => t.enter).length, chunks: ticks.reduce((s, t) => s + t.enter, 0) },
      marks: { ticks: ticks.filter((t) => t.marks).length, chunks: ticks.reduce((s, t) => s + t.marks, 0) },
      peels: ticks.filter((t) => t.peel).length,
      front: stat(fronts),
      asked: stat(ticks.flatMap((t) => t.asked ?? [])),
      units: stat(ticks.map((t) => t.units)),
      sweeps: A.sweeps,
      series: ticks.map((t) => [t.tick, t.front[0] ?? -1, (t.asked ?? [])[0] ?? -1, t.marks, t.peel, t.scope]),
      worst,
    };
  }, top);
  console.log(`=== ${drive ? `riding ${drive}` : 'parked'} win ${win} zoom ${zoom}: ${r.frames} GPU frames, ${r.ticks} agent ticks, sweeps ${r.sweeps}`);
  console.log(`  agents GPU a frame (mean/p95/max): ${r.total.mean}/${r.total.p95}/${r.total.max}`);
  for (const [k, v] of Object.entries(r.by)) if (v.max > 0) console.log(`    ${k.padEnd(13)} ${v.mean}/${v.p95}/${v.max}`);
  console.log(`  scope chunks ${JSON.stringify(r.scope)} | enter ticks ${r.enter.ticks} (${r.enter.chunks} chunks) | mark ticks ${r.marks.ticks} (${r.marks.chunks}) | peels ${r.peels} | front a sweep ${JSON.stringify(r.front)} asked ${JSON.stringify(r.asked)} | units ${JSON.stringify(r.units)}`);
  for (const w of r.worst) console.log(`  worst ${w.tot} ms (span ${w.span}) ${JSON.stringify(w.a)}\n      ${w.ticks.join('\n      ')}`);
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 1));
} finally {
  await browser.close();
}
if (bad) process.exit(1);
