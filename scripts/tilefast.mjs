// Round 112 (tilefast): a render-only tile's latency and the pop-in at a pan, the pan bench's way, short. One page at
// the phone tier (every system on, 1x, the bench page's phone settings), the window 256; for each zoom a straight pan up
// the screen (the bench's: scene.pan) at each speed for --seconds, every frame sampled:
//   - the screen's 12 x 12 points not in detail (past the window, no tile drawn), split ahead / side / behind, and why
//     (TileCache.whyMissing: tile left out, its land being made, made, queued, none) — the worst frame's shares;
//   - the tiles' stages (wanted -> started -> made -> baked -> drawn) of those drawn in the run, p50 / p95;
//   - the pacer's turns a frame (perFrame, turns run, those run on a frame's credit), the atlas's slots, frames' ms.
//   node scripts/tilefast.mjs [--url http://localhost:5231] [--zooms 5,2.2] [--speeds 20,80] [--seconds 6]
//     [--throttle 4] [--extra "&tilechain=0"] [--json out.json] [--gif g.gif] [--shot s.png]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5231');
const zooms = opt('zooms', '5,2.2').split(',').map(Number);
const speeds = opt('speeds', '20,80').split(',').map(Number);
const seconds = Number(opt('seconds', 6));
const throttle = Number(opt('throttle', 0));
const extra = opt('extra', '');
const win = opt('win', '256');
const at = opt('at', '15024,14337');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
});
const out = { url: '', runs: [] };
let bad = false;
try {
  const p = await browser.newPage();
  if (throttle > 1) {
    const cdp = await p.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 300)));
  // (the pan bench page's own settings — src/perf/bench.ts, the phone's flags — less the bench)
  const u = `${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&hitch=1&hitchhud=0&tufts=0&shadowcache=4&prepevery=2&bandh=2&shadowsize=512&hybrid=1&settle=0&inplace=1&sleepmore=1&at=${at}&win=${win}${extra}`;
  out.url = u;
  console.log(u);
  await p.goto(u, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimed?.scene, { timeout: 240000 });
  await sleep(Number(opt('wait', 35000)));
  for (const z of zooms) {
    await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
    await sleep(5000);
    for (const v of speeds) {
      const r = await p.evaluate(async (v, secs) => {
        const R = window.reclaimed;
        const cam = R.camera;
        const TL = R.renderer.tiles;
        const land = TL?.land;
        const pz = R.atlas?.pacer ?? R.stream?.source?.atlas?.pacer;
        const ROW_H = Math.sqrt(3) / 2;
        const [ux, uy] = cam.screenDeltaToWorld(0, -1);
        const l = Math.hypot(ux, uy) || 1;
        const dir = [ux / l, uy / l];
        R.scene.pan = { speed: v, dir: [...dir], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
        const t0 = performance.now();
        const ev0 = TL.stats.evicted;
        const ns0 = land?.stats.noSlot ?? 0;
        const pc0 = pz ? { tiles: pz.tiles, chained: pz.chained ?? 0 } : null;
        const frames = [];
        const worst = { ahead: 0, side: 0, behind: 0 };
        const why = {};
        const whyBehind = {};
        let per = 0;
        let usedMax = 0;
        let drawnMax = 0;
        let last = t0;
        const S = R.stream;
        // (TileCache.whyMissing where the build has it; else the same from its insides — the build before round 112's)
        const whyOf = (x, y) => {
          if (TL.whyMissing) return TL.whyMissing(x, y, cam.azimuth);
          const o = TL.origin;
          const rx = Math.floor((x + o[0]) / 64);
          const ry = Math.floor((y + o[1]) / 64);
          if (TL.tiles.has(`${rx},${ry},${Math.round(cam.azimuth * 1e4)}`)) return 'tile';
          for (const t of TL.tiles.values()) if (t.rx === rx && t.ry === ry) return 'turn';
          const j = land?.jobs?.get(`${rx},${ry}`);
          if (j) return j.made ? 'made' : 'making';
          return land?.firstWanted?.has(`${rx},${ry}`) ? 'queued' : 'none';
        };
        while (performance.now() - t0 < secs * 1000) {
          const t = await new Promise((r) => requestAnimationFrame(r));
          frames.push(t - last);
          last = t;
          const G = 12;
          const o = { ahead: 0, side: 0, behind: 0 };
          const fw = {};
          const fb = {};
          for (let j = 0; j < G; j++)
            for (let i = 0; i < G; i++) {
              const [dx, dy] = cam.screenDeltaToWorld(((i + 0.5) / G - 0.5) * cam.viewportW, ((j + 0.5) / G - 0.5) * cam.viewportH);
              const x = cam.target[0] + dx;
              const y = (cam.target[1] + dy) / ROW_H;
              if (x >= 0 && x < S.W && y >= 0 && y < S.H) continue;
              if (TL.drawsAt(x, y)) continue;
              const along = (dx * dir[0] + dy * dir[1]) / (Math.hypot(dx, dy) || 1);
              const k = whyOf(x, y);
              fw[k] = (fw[k] ?? 0) + 1 / (G * G);
              if (along > 0.5) o.ahead++;
              else if (along < -0.5) {
                o.behind++;
                fb[k] = (fb[k] ?? 0) + 1 / (G * G);
              } else o.side++;
            }
          for (const k in o) worst[k] = Math.max(worst[k], o[k] / (G * G));
          for (const k in fw) why[k] = Math.max(why[k] ?? 0, fw[k]);
          for (const k in fb) whyBehind[k] = Math.max(whyBehind[k] ?? 0, fb[k]);
          per += pz?.perFrame ?? 0;
          usedMax = Math.max(usedMax, TL.stats.used);
          drawnMax = Math.max(drawnMax, TL.stats.drawn);
        }
        R.scene.pan = null;
        const L = (land?.latencies ?? []).filter((t) => t.drawn >= t0);
        const q = (a, f) => (a.length ? +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))].toFixed(1) : null);
        const st = (f) => {
          const a = L.map(f).filter(Number.isFinite);
          return [q(a, 0.5), q(a, 0.95)];
        };
        const fs = frames.slice(2).sort((a, b) => a - b);
        const r3 = (x) => +x.toFixed(3);
        const w = {};
        for (const k in why) w[k] = r3(why[k]);
        const wb = {};
        for (const k in whyBehind) wb[k] = r3(whyBehind[k]);
        return {
          speed: v,
          fps: +((frames.length / secs).toFixed(1)),
          p99: q(fs, 0.99),
          max: q(fs, 1),
          over20: fs.filter((f) => f > 20).length,
          missMax: { ahead: r3(worst.ahead), side: r3(worst.side), behind: r3(worst.behind) },
          why: w,
          whyBehind: wb,
          tiles: { n: L.length, queue: st((t) => t.start - t.wanted), land: st((t) => t.mapped - t.start), landFrames: st((t) => t.frames ?? NaN), toBake: st((t) => t.baked - t.mapped), toDrawn: st((t) => t.drawn - t.baked), total: st((t) => t.drawn - t.wanted) },
          slots: { slots: TL.stats.slots, mb: TL.stats.mb, usedMax, drawnMax, evicted: TL.stats.evicted - ev0, noSlot: (land?.stats.noSlot ?? 0) - ns0 },
          pacer: pz ? { perFrameMean: +(per / frames.length).toFixed(2), turnsPerFrame: +((pz.tiles - pc0.tiles) / frames.length).toFixed(2), chained: (pz.chained ?? 0) - pc0.chained } : null,
        };
      }, v, seconds);
      r.zoom = z;
      out.runs.push(r);
      console.log(JSON.stringify(r));
      await sleep(1500);
    }
  }
  if (opt('shot', '')) await p.screenshot({ path: opt('shot', '') });
  if (opt('json', '')) fs.writeFileSync(opt('json', ''), JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}
if (bad) process.exit(1);
