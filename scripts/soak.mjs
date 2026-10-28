// Round 100 (hitchrec): a light soak — --minutes (10) on the atlas at the phone tier (q=low 412x915, every system
// on, 1x, ?hitch=1): the driveprofile ride (?drive=18, back and forth along its road), a lightning strike every
// 30 s, a meteor at the camera every 2 minutes, a storm at minutes 1 and 5. Each minute: frame p50/p95/p99 and the
// worst, hitches by cause (the recorder), the JS heap (precise, after the minute; and CDP's used/total) and the GPU's
// buffer and texture bytes alive (src/perf/gpumem.ts) with the largest labels — growth minute on minute is a leak.
//   node scripts/soak.mjs [--url http://localhost:5287] [--minutes 10] [--wait 35000] [--at 15024,14337] [--json out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5287');
const minutes = Number(opt('minutes', 10));
const wait = Number(opt('wait', 35000));
const at = opt('at', '15024,14337');
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
const rows = [];
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 300)));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&hitch=1&drive=18&at=${at}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimedHitch, { timeout: 240000 });
  await sleep(wait);
  const cdp = await p.createCDPSession();
  await p.evaluate(() => window.reclaimedHitch.rec.reset());
  const t0 = Date.now();
  let nextLightning = 30;
  let nextMeteor = 60;
  const storms = new Set([60, 300]);
  let minute = 0;
  while ((Date.now() - t0) / 1000 < minutes * 60) {
    await sleep(5000);
    const s = (Date.now() - t0) / 1000;
    const act = [];
    if (s >= nextLightning) {
      nextLightning += 30;
      act.push('lightning');
    }
    if (s >= nextMeteor) {
      nextMeteor += 120;
      act.push('meteor');
    }
    for (const st of storms)
      if (s >= st) {
        storms.delete(st);
        act.push('storm');
      }
    if (act.length)
      await p.evaluate((act) => {
        const R = window.reclaimed;
        const [x, y, z] = R.camera.target;
        for (const a of act) {
          if (a === 'lightning') R.globals.events.push({ kind: 1, x: x + 12, y: y + 8, radius: 5, strength: 20 });
          if (a === 'meteor') R.meteorNow(x + 20, y - 10, z);
          if (a === 'storm') R.weather.spawn(x + 30, y);
        }
      }, act);
    if (s >= (minute + 1) * 60) {
      minute++;
      const usage = await cdp.send('Runtime.getHeapUsage');
      const r = await p.evaluate((m) => {
        const H = window.reclaimedHitch;
        const rep = H.report();
        const row = rep.minutes[m - 1] ?? {};
        return {
          row,
          heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
          gpuMem: rep.gpuMem,
          trackedMB: +(window.reclaimed.core.host.profiler.totalMemoryBytes() / 1048576).toFixed(1),
          slides: window.reclaimed.stream.stats.slides,
          causes: rep.causes,
          judge: (({ passes, lastMs, deferred }) => ({ passes, lastMs: +lastMs.toFixed(1), deferred }))(window.reclaimed.core.integrity?.stats ?? { passes: 0, lastMs: 0, deferred: 0 }),
          judgeMax: rep.cpuSteps['judge.pass']?.max ?? 0,
        };
      }, minute);
      r.cdpUsedMB = +(usage.usedSize / 1048576).toFixed(1);
      r.cdpTotalMB = +(usage.totalSize / 1048576).toFixed(1);
      rows.push(r);
      const w = r.row;
      console.log(`MIN ${minute}: p50 ${w.p50} p95 ${w.p95} p99 ${w.p99} max ${w.max} frames ${w.frames} hitches ${w.hitches} ${JSON.stringify(w.causes)} | heap ${r.heapMB} MB (cdp ${r.cdpUsedMB}/${r.cdpTotalMB}) gc ${w.gcYoung}/${w.gcOld} | gpu live ${r.gpuMem.liveMB} MB (bufs made ${r.gpuMem.created}, destroyed ${r.gpuMem.destroyed}, collected ${r.gpuMem.collected}) tracked ${r.trackedMB} | slides ${r.slides} | judge ${JSON.stringify(r.judge)} max ${r.judgeMax}`);
    }
  }
  const fin = await p.evaluate(() => window.reclaimedHitch.report());
  console.log(`CAUSES ${JSON.stringify(fin.causes)}`);
  console.log(`GPU TOP ${JSON.stringify(fin.gpuMem.top)}`);
  for (const h of fin.worst) console.log(`WORST ${h.ms} ${h.cause} @${h.t}s cpu ${h.cpu} gpu ${h.gpu} held ${h.held} | ${h.steps.map((s) => s.label + ' ' + s.ms).join(', ')} | async ${h.async.map((s) => s.label + ' ' + s.ms).join(', ')} | ${h.long.join(' ; ')} | io ${JSON.stringify(h.io ?? null)}`);
  if (out) fs.writeFileSync(out, JSON.stringify({ rows, final: fin }, null, 1));
  await p.screenshot({ path: opt('shot', 'C:/Projects/shots88/hitchrec/soak_end.png') });
} finally {
  await browser.close();
}
if (bad) process.exit(1);
