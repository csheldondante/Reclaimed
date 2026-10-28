// Round 104 (slidehitch): a straight pan taken apart slide by slide. One page (the atlas at the phone tier, every
// system on, 1x, ?hitch=1), a window and zoom, then a pan up the screen at a speed from one land source:
//   gen    new land (made as it comes)
//   pool   back and forth over --leg cells (what comes back is in the GPU pool)
//   disk   a line panned first with every region touched (saved as it leaves), the window warped back to its start,
//          then panned again: what comes in is loaded from the store
// Every frame's interval is kept with the streamer's state; each slide's frames (the slide's own, two before and
// three after) are reported with the worst interval in them, and the hitch recorder's worst frames with their steps.
//   node scripts/slideprobe.mjs [--url http://localhost:5303] [--win 512] [--zoom 5] [--speed 60] [--seconds 12]
//     [--mode gen|pool|disk] [--leg 384] [--throttle 4] [--wait 35000] [--extra "&x=1"] [--json out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5303');
const win = Number(opt('win', 512));
const zoom = Number(opt('zoom', 5));
const speeds = opt('speed', '60').split(',').map(Number);
const seconds = Number(opt('seconds', 12));
const mode = opt('mode', 'gen');
const leg = Number(opt('leg', 384));
const wait = Number(opt('wait', 35000));
const throttle = Number(opt('throttle', 0));
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
const results = [];
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 300)));
  const world = `probe-${Date.now().toString(36)}`;
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&hitch=1&hitchhud=0&at=15024,14337&win=${win}&world=${world}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimedHitch, { timeout: 240000 });
  await sleep(wait);
  if (throttle > 1) {
    const cdp = await p.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  // the line, and the in-page frame log
  await p.evaluate((zoom) => {
    const R = window.reclaimed;
    R.scene.drive = null;
    R.scene.pan = null;
    R.camera.zoom = zoom;
    const [ux, uy] = R.camera.screenDeltaToWorld(0, -1);
    const l = Math.hypot(ux, uy) || 1;
    window.__dir = [ux / l, uy / l];
    window.__o0 = [...R.stream.origin];
    const log = (window.__log = { on: false, f: [] });
    const S = R.stream;
    const mem = window.reclaimedHitch.mem;
    let last = performance.now();
    let io0 = { ...mem.io };
    // (copy commands a frame: buffer to buffer, and those touching a texture)
    const P = GPUCommandEncoder.prototype;
    window.__copies = 0;
    for (const k of ['copyBufferToBuffer', 'copyBufferToTexture', 'copyTextureToBuffer', 'copyTextureToTexture', 'clearBuffer']) {
      const f = P[k];
      if (f.__probe) continue;
      P[k] = function (...a) {
        window.__copies++;
        return f.apply(this, a);
      };
      P[k].__probe = true;
    }
    const tick = (t) => {
      if (log.on) {
        const io = mem.io;
        log.f.push([+(t - last).toFixed(1), S.stats.slides, S.busy ? 1 : 0, S.stats.uploads, +((io.writeBytes - io0.writeBytes) / 1048576).toFixed(2), +((io.copyBytes - io0.copyBytes) / 1048576).toFixed(2), io.maps - io0.maps, window.__copies]);
      }
      io0 = { ...mem.io };
      window.__copies = 0;
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, zoom);
  const pan = (speed, sign = 1) =>
    p.evaluate(
      (speed, sign) => {
        const d = window.__dir;
        window.reclaimed.scene.pan = { speed, dir: [d[0] * sign, d[1] * sign], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
      },
      speed,
      sign,
    );
  if (mode === 'disk') {
    // fill: pan the line with every region touched, then back to its start
    const fillCells = speeds.reduce((t, v) => t + v * seconds, 0) + win + 256;
    console.log(`filling ${fillCells} cells…`);
    await pan(300);
    await p.waitForFunction(
      (n) => {
        const R = window.reclaimed;
        R.stream.touch(0, 0, R.stream.W, R.stream.H);
        return R.scene.pan.asked >= n;
      },
      { timeout: 120000, polling: 'raf' },
      fillCells,
    );
    await p.evaluate(() => (window.reclaimed.scene.pan = null));
    await sleep(3000);
    await p.evaluate(async () => {
      const S = window.reclaimed.stream;
      await S.store?.flush?.();
      await S.warp(window.__o0[0], window.__o0[1], S.oz);
    });
    await sleep(6000);
    console.log(`store ${await p.evaluate(() => window.reclaimed.stream.store.size)} regions`);
  }
  for (const speed of speeds) {
    if (mode === 'gen' || mode === 'disk') await pan(speed);
    if (mode === 'pool') {
      // a leg there and back first: what comes back is the pool's
      await pan(speed);
      await p.waitForFunction((n) => window.reclaimed.scene.pan.asked >= n, { timeout: 120000, polling: 100 }, leg);
      await pan(speed, -1);
      await p.waitForFunction((n) => window.reclaimed.scene.pan.asked >= n, { timeout: 120000, polling: 100 }, leg);
      await pan(speed);
    }
    await sleep(1000);
    const st0 = await p.evaluate(() => {
      window.reclaimedHitch.rec.reset();
      window.reclaimed.core.host.profiler.resetTotals();
      window.__log.f = [];
      window.__log.on = true;
      return { ...window.reclaimed.stream.stats };
    });
    const t0 = Date.now();
    let sign = 1;
    while (Date.now() - t0 < seconds * 1000) {
      if (mode === 'pool') {
        const asked = await p.evaluate(() => window.reclaimed.scene.pan.asked);
        if (asked >= leg) {
          sign = -sign;
          await pan(speed, sign);
        }
      }
      await sleep(100);
    }
    const r = await p.evaluate((st0) => {
      window.__log.on = false;
      const S = window.reclaimed.stream;
      const st = S.stats;
      const came = { generated: st.generated - st0.generated, thawed: st.thawed - st0.thawed, loaded: st.loaded - st0.loaded, gpuMade: st.gpuMade - st0.gpuMade, slides: st.slides - st0.slides, evicted: st.evicted - st0.evicted, uploads: st.uploads - st0.uploads };
      const f = window.__log.f;
      // each slide: the frames from two before it began (busy) to three after it ended
      const slides = [];
      for (let i = 1; i < f.length; i++)
        if (f[i][2] && !f[i - 1][2]) {
          let j = i;
          while (j < f.length && f[j][2]) j++;
          const a = Math.max(0, i - 2);
          const b = Math.min(f.length, j + 4);
          const fr = f.slice(a, b);
          slides.push({ frames: fr.map((x) => x[0]), worst: Math.max(...fr.map((x) => x[0])), busyFrames: j - i, writeMB: +fr.reduce((s, x) => s + x[4], 0).toFixed(1), copyMB: +fr.reduce((s, x) => s + x[5], 0).toFixed(1), cmds: fr.reduce((s, x) => s + x[7], 0), cmdMax: Math.max(...fr.map((x) => x[7])) });
        }
      const iv = f.map((x) => x[0]).sort((a, b) => a - b);
      const rep = window.reclaimedHitch.report();
      const prof = window.reclaimed.core.host.profiler;
      const cpu = Object.entries(rep.cpuSteps ?? {}).filter(([k]) => /^(slide|write|rs\.|pool|band|relief|gen\.)/.test(k)).map(([k, v]) => `${k} ${v.max}/${v.mean}`).join(', ');
      return {
        cpu,
        slideGpu: { max: +(prof.maxMs.get('slide') ?? -1).toFixed(1), smooth: +(prof.passMs.get('slide') ?? -1).toFixed(1) },
        slideDone: [...S.slideDone].slice(-12),
        baseDone: [...S.baseDone].sort((a, b) => a - b)[Math.floor(S.baseDone.length / 2)],
        slideCpu: S.trace.slice(-12).map((t) => +(t.sync - t.t0).toFixed(1)),
        came,
        frames: iv.length,
        p50: iv[Math.floor(iv.length * 0.5)],
        p99: iv[Math.floor(iv.length * 0.99)],
        max: iv[iv.length - 1],
        over33: iv.filter((x) => x > 33).length,
        over50: iv.filter((x) => x > 50).length,
        slides,
        causes: rep.causes,
        worst: rep.worst.slice(0, 8).map((h) => `${h.ms} ${h.cause}${h.busy ? ' [slide]' : ''} cpu ${h.cpu} gpu ${h.gpu}${h.gpuTop ? ' (' + h.gpuTop + ')' : ''} held ${h.held} | ${h.steps.map((s) => s.label + ' ' + s.ms).join(', ')} | async ${h.async.map((s) => s.label + ' ' + s.ms).join(', ')} | ${h.long.join(' ; ').slice(0, 300)} | io ${JSON.stringify(h.io ?? null)}`),
      };
    }, st0);
    r.speed = speed;
    r.mode = mode;
    results.push(r);
    console.log(`SPEED ${speed} ${mode} win ${win} zoom ${zoom}: frames ${r.frames} p50 ${r.p50} p99 ${r.p99} max ${r.max} >33 ${r.over33} >50 ${r.over50} came ${JSON.stringify(r.came)}`);
    console.log(`  causes ${JSON.stringify(r.causes)}`);
    console.log(`  slide done ms ${r.slideDone.join(' ')} | base done p50 ${r.baseDone} | slide CPU sync ms ${r.slideCpu.join(' ')}`);
    console.log(`  slide GPU ms max ${r.slideGpu.max} smoothed ${r.slideGpu.smooth} | cpu max/mean (page) ${r.cpu}`);
    for (const s of r.slides) console.log(`  slide worst ${s.worst} busy ${s.busyFrames} write ${s.writeMB} MB copy ${s.copyMB} MB cmds ${s.cmds} (max ${s.cmdMax} a frame) | ${s.frames.join(' ')}`);
    for (const w of r.worst) console.log(`  worst ${w}`);
    await p.evaluate(() => (window.reclaimed.scene.pan = null));
    await sleep(1500);
  }
  if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
} finally {
  await browser.close();
}
if (bad) process.exit(1);
