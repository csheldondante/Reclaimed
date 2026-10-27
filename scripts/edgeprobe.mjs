// Round 91 (phonecam, the user: "I notice that I easily hit the edge of the loaded ground"): how close the view
// comes to land that isn't built while moving, at phone size. Each frame: the camera's target's distance to the
// window's edge, and a grid of points over the screen (the ground plane at the target's height) — how many lie
// past the window (the rings draw there: coarse, not the window's) and how many on regions a slide has moved the
// window over but not written yet (Streamer.unwritten: stale land, a hole). Also the slides' latency.
//   node scripts/edgeprobe.mjs [--url http://localhost:5261] [--mode pan|drive] [--speed 40] [--seconds 20]
//     [--key w] [--extra "&win=320"] [--at 11956,15471] [--turn 0] [--gif out.gif --frames 30 --every 150]
//     [--size 412x915] [--wait 35000] [--face deg]
import puppeteer from 'puppeteer-core';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const { GIFEncoder, quantize, applyPalette } = gifenc;
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5261');
const mode = opt('mode', 'pan');
const speed = opt('speed', '40');
const seconds = Number(opt('seconds', 20));
const key = opt('key', 'w');
const extra = opt('extra', '');
const at = opt('at', '11956,15471');
const turn = Number(opt('turn', 0));
// (round 93, --face deg: the view's azimuth itself, eased to through the level's Turn — 45 the default view)
const face = opt('face', '');
const gif = opt('gif', '');
const frames = Number(opt('frames', 30));
const every = Number(opt('every', 150));
const wait = Number(opt('wait', 35000));
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  protocolTimeout: 600000,
});
let bad = false;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text()));
  const drive = mode === 'drive' ? `&drive=${speed}` : '';
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=${at}${drive}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, wait));
  if (face !== '') {
    await p.evaluate((d) => window.reclaimed.scene.turn.face((d * Math.PI) / 180), Number(face));
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (turn) {
    // (the view turned first: a tap of the turn button per step)
    const btn = await p.$$('.turn-ctl button');
    for (let k = 0; k < Math.abs(turn); k++) {
      const box = await btn[turn > 0 ? 1 : 0].boundingBox();
      await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  await p.evaluate(() => {
    const R = window.reclaimed;
    const S = R.stream;
    const c = R.camera;
    const ROW_H = Math.sqrt(3) / 2;
    const W = S.W;
    const H = S.H;
    const reg = S.R;
    const out = (window.__edge = { frames: 0, ms: [], tEdge: Infinity, vEdge: Infinity, hole: 0, holeMax: 0, holeFrames: 0, past: 0, slides: [], busyFrames: 0, behind: 0 });
    let last = performance.now();
    let slides = S.stats.slides;
    const NX = 9;
    const NY = 19;
    const tick = () => {
      const now = performance.now();
      out.ms.push(now - last);
      last = now;
      out.frames++;
      if (S.busy) out.busyFrames++;
      const [tx, tyw, tz] = c.target;
      const ty = tyw / ROW_H;
      out.tEdge = Math.min(out.tEdge, tx, W - tx, ty, H - ty);
      let past = 0;
      let hole = 0;
      let vEdge = Infinity;
      for (let j = 0; j < NY; j++)
        for (let i = 0; i < NX; i++) {
          const sx = ((i + 0.5) / NX) * c.viewportW;
          const sy = ((j + 0.5) / NY) * c.viewportH;
          const [dx, dy] = c.screenDeltaToWorld(sx - c.viewportW / 2, sy - c.viewportH / 2);
          const x = tx + dx;
          const y = (tyw + dy) / ROW_H;
          const m = Math.min(x, W - x, y, H - y);
          vEdge = Math.min(vEdge, m);
          if (m < 0) past++;
          else if ((S.unwritten ?? []).some(([lx, ly]) => x >= lx && x < lx + reg && y >= ly && y < ly + reg)) hole++;
        }
      out.vEdge = Math.min(out.vEdge, vEdge);
      out.past += past / (NX * NY);
      out.hole += hole / (NX * NY);
      out.holeMax = Math.max(out.holeMax, hole / (NX * NY));
      if (hole) out.holeFrames++;
      if (S.stats.slides !== slides) {
        slides = S.stats.slides;
        out.slides.push(S.stats.lastMs);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  if (mode === 'pan') await p.keyboard.down(key);
  if (gif) {
    const enc = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
      await new Promise((r) => setTimeout(r, every));
    }
    enc.finish();
    fs.writeFileSync(gif, enc.bytes());
    console.log('saved', gif);
  } else await new Promise((r) => setTimeout(r, seconds * 1000));
  if (mode === 'pan') await p.keyboard.up(key);
  const r = await p.evaluate(() => {
    const o = window.__edge;
    const f = o.ms.slice(1).sort((a, b) => a - b);
    const q = (x) => +f[Math.min(f.length - 1, Math.floor(x * f.length))].toFixed(1);
    const s = [...o.slides].sort((a, b) => a - b);
    const R = window.reclaimed;
    return {
      frames: o.frames,
      p50: q(0.5),
      p95: q(0.95),
      worst: +f[f.length - 1].toFixed(0),
      targetMinToEdge: +o.tEdge.toFixed(1),
      viewMinToEdge: +o.vEdge.toFixed(1),
      viewPastWindow: +((100 * o.past) / o.frames).toFixed(1),
      viewOnUnwritten: +((100 * o.hole) / o.frames).toFixed(2),
      viewOnUnwrittenMax: +(100 * o.holeMax).toFixed(1),
      framesWithHole: +((100 * o.holeFrames) / o.frames).toFixed(1),
      busy: +((100 * o.busyFrames) / o.frames).toFixed(1),
      slides: o.slides.length,
      slideMs: s.length ? { p50: s[Math.floor(s.length / 2)], max: s[s.length - 1] } : null,
      zoom: +R.camera.zoom.toFixed(2),
      az: +((R.camera.azimuth * 180) / Math.PI).toFixed(0),
      win: R.stream.W,
      stats: R.stream.stats,
      fatal: !!document.querySelector('.fatal'),
    };
  });
  if (r.fatal) bad = true;
  console.log(JSON.stringify(r));
  console.log(`EDGE mode ${mode}${mode === 'drive' ? ` ${speed}` : ` ${key}`} win ${r.win} az ${r.az} | target min to edge ${r.targetMinToEdge} | view: min to edge ${r.viewMinToEdge}, past window ${r.viewPastWindow}%, on unwritten ${r.viewOnUnwritten}% (max ${r.viewOnUnwrittenMax}%, ${r.framesWithHole}% of frames) | busy ${r.busy}% | slides ${r.slides} ms ${JSON.stringify(r.slideMs)} | p50 ${r.p50} p95 ${r.p95} worst ${r.worst}`);
} finally {
  await browser.close();
}
if (bad) process.exit(1);
