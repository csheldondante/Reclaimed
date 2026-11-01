// (round 121, herolab; BACKLOG CAM1, HL1) The hero lab, headless: the level up, then per terrain × camera mode the
// autopilot riding its station — a screenshot, a GIF, the camera metrics on the live world (play/camera/metrics.ts:
// the hero hidden, the way ahead unseen, the view's turn) — or, with --cost, the frame's cost of each mode against
// the chase on the phone proxy, by toggling (A/B/A/B windows: a tiler GPU's passes can't be timed one by one).
//   node scripts/herolab.mjs [--out C:/Projects/shots88/herolab] [--terrains cliff,canyon] [--cams "chase|edge+dither"]
//     [--secs 10] [--gifs] [--frames 24] [--every 120] [--dev]
//   node scripts/herolab.mjs --cost [--cams "rotate|cutaway"] [--terrains cliff] [--window 4] [--rounds 3]
//     [--chromeargs disable-gpu-vsync,disable-frame-rate-limit]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const COST = process.argv.includes('--cost');
const ALL_TERRAINS = ['cliff', 'canyon', 'forest', 'city', 'cave', 'hills'];
const ALL_CAMS = ['chase', 'rotate', 'tilt', 'dither', 'cutaway', 'edge', 'edge+dither', 'rotate+dither', 'tilt+cutaway'];

await run({ name: 'herolab', kind: COST ? 'timing' : 'behaviour', size: '412x915', dpr: COST ? 2.6 : 1, echo: true }, async (R) => {
  const arg = (k, d) => {
    const i = R.argv.indexOf(`--${k}`);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const out = arg('out', 'C:/Projects/shots88/herolab');
  fs.mkdirSync(out, { recursive: true });
  const terrains = arg('terrains', ALL_TERRAINS.join(',')).split(',');
  const cams = arg('cams', COST ? 'rotate|tilt|dither|cutaway|edge|edge+dither' : ALL_CAMS.join('|')).split('|');
  const p = await R.level({ level: 'herolab', station: terrains[0], cam: 'chase', perf: COST ? '1' : '0' });
  await p.waitForFunction(() => window.reclaimed?.lab, { timeout: 120000, polling: 250 });
  // (the first load after a server start is slow: the land and the trees settle)
  await sleep(Number(arg('settle', 30)) * 1000);
  await R.fatal(p);

  if (COST) {
    // frame intervals over a window (rAF deltas: uncapped, the GPU's cost; vsync'd, the frames missed)
    const windowS = Number(arg('window', 4));
    const rounds = Number(arg('rounds', 3));
    const frames = async () =>
      p.evaluate(
        (ms) =>
          new Promise((res) => {
            const d = [];
            let last = performance.now();
            const t0 = last;
            const f = (t) => {
              d.push(t - last);
              last = t;
              if (t - t0 < ms) requestAnimationFrame(f);
              else res(d);
            };
            requestAnimationFrame(f);
          }),
        windowS * 1000,
      );
    const stat = (a) => {
      const s = [...a].sort((x, y) => x - y);
      return { n: s.length, p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], mean: s.reduce((x, y) => x + y, 0) / s.length };
    };
    const rows = [];
    for (const t of terrains) {
      await p.evaluate((t) => window.reclaimed.lab.pick({ station: t, cam: 'chase' }), t);
      await sleep(2000);
      for (const c of cams) {
        const A = [];
        const B = [];
        for (let r = 0; r < rounds; r++) {
          await p.evaluate(() => window.reclaimed.lab.pick({ cam: 'chase' }));
          await sleep(500);
          A.push(...(await frames()));
          await p.evaluate((c) => window.reclaimed.lab.pick({ cam: c }), c);
          await sleep(500);
          B.push(...(await frames()));
        }
        const a = stat(A);
        const b = stat(B);
        const row = { terrain: t, cam: c, chase: a, mode: b, dP50: b.p50 - a.p50, dMean: b.mean - a.mean };
        rows.push(row);
        R.log(`${t.padEnd(7)} ${c.padEnd(14)} chase p50 ${a.p50.toFixed(2)} mean ${a.mean.toFixed(2)} ms · mode p50 ${b.p50.toFixed(2)} mean ${b.mean.toFixed(2)} ms · Δmean ${(b.mean - a.mean).toFixed(2)} ms`);
      }
    }
    fs.writeFileSync(path.join(out, 'cost.json'), JSON.stringify(rows, null, 1));
    await R.fatal(p);
    return;
  }

  const nFrames = Number(arg('frames', 24));
  const every = Number(arg('every', 120));
  // (round 120) --traits: the traits station with a hero — the crowd, smite, the lich raising, the bike through the sanctuary
  if (R.argv.includes('--traits')) {
    const shot = async (name) => p.screenshot({ path: path.join(out, `traits-${name}.png`) });
    await p.evaluate(() => window.reclaimed.lab.pick({ station: 'traits', hero: 'lich', cam: 'cutaway+tilt' }));
    await sleep(2000);
    for (const [act, wait] of [['crowd', 5000], ['smite', 3000], ['raise', 4000]]) {
      await p.evaluate((a) => window.reclaimed.lab.act(a), act);
      await sleep(wait);
      await shot(act);
      R.log(`traits ${act}: ${JSON.stringify(await p.evaluate(() => window.reclaimed.lab.census?.()))}`);
    }
    await p.evaluate(() => window.reclaimed.lab.pick({ hero: 'hoverbike' }));
    await p.evaluate(() => window.reclaimed.lab.act('sanctuary'));
    await sleep(3000);
    await shot('sanctuary-bike');
    await gif(path.join(out, 'traits-sanctuary-bike.gif'));
    await R.fatal(p);
    return;
  }
  // (round 120, PL30) --handling "stock|grip+corridor+avoid": GIFs of the bike's handling variants on the canyon and the city
  const hand = arg('handling', '');
  if (hand) {
    for (const t of ['moves-canyon', 'moves-city'])
      for (const v of hand.split('|')) {
        await p.evaluate((o) => window.reclaimed.lab.pick(o), { station: t, hero: 'hoverbike', handling: v, cam: 'cutaway+tilt' });
        await sleep(2500);
        await p.screenshot({ path: path.join(out, `${t}-${v.replace(/\+/g, '_')}.png`) });
        await gif(path.join(out, `${t}-${v.replace(/\+/g, '_')}.gif`));
        await R.fatal(p);
      }
    return;
  }
  const secs = Number(arg('secs', 10));
  const gifs = R.argv.includes('--gifs');
  async function gif(file) {
    const enc = GIFEncoder();
    for (let i = 0; i < nFrames; i++) {
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      const half = halve(png);
      const pal = quantize(half.data, 256);
      enc.writeFrame(applyPalette(half.data, pal), half.width, half.height, { palette: pal, delay: every });
      await sleep(every);
    }
    enc.finish();
    fs.writeFileSync(file, enc.bytes());
  }
  const rows = [];
  for (const t of terrains) {
    for (const c of cams) {
      await p.evaluate((o) => window.reclaimed.lab.pick(o), { station: t, cam: c });
      // (the camera settles on the new mode, the hero up to speed)
      await sleep(2500);
      const m = await p.evaluate((s) => window.reclaimed.lab.measure(s), secs);
      const row = { terrain: t, cam: c, ...m };
      rows.push(row);
      R.log(`${t.padEnd(7)} ${c.padEnd(14)} hero ${pct(m.hero)} ahead ${pct(m.ahead)} (off ${pct(m.aheadOff)}) mid ${pct(m.aheadMid)} turn ${m.turn.toFixed(1)}°/s p95 ${m.turn95.toFixed(0)}`);
      const name = `${t}-${c.replace(/\+/g, '_')}`;
      await p.screenshot({ path: path.join(out, `${name}.png`) });
      if (gifs) {
        const enc = GIFEncoder();
        for (let i = 0; i < nFrames; i++) {
          const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
          const half = halve(png);
          const pal = quantize(half.data, 256);
          enc.writeFrame(applyPalette(half.data, pal), half.width, half.height, { palette: pal, delay: every });
          await sleep(every);
        }
        enc.finish();
        fs.writeFileSync(path.join(out, `${name}.gif`), enc.bytes());
      }
      await R.fatal(p);
    }
  }
  fs.writeFileSync(path.join(out, 'metrics-browser.json'), JSON.stringify(rows, null, 1));
  R.log(`saved ${rows.length} rows and shots to ${out}`);
});

function pct(v) {
  return `${(v * 100).toFixed(0).padStart(3)}%`;
}

/** a PNG at half its size (2 × 2 boxes averaged): smaller GIFs */
function halve(png) {
  const w = png.width >> 1;
  const h = png.height >> 1;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        const i = (y * 2 * png.width + x * 2) * 4 + c;
        data[(y * w + x) * 4 + c] = (png.data[i] + png.data[i + 4] + png.data[i + png.width * 4] + png.data[i + png.width * 4 + 4]) >> 2;
      }
  return { width: w, height: h, data };
}
