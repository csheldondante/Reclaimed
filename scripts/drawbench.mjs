// Round 82: what the draw costs, piece by piece, on one still frame — the atlas level at a place, the camera
// still, the sim stopped (?speed=0), then for each piece left out (renderer SKIP, changed at run time) the
// GPU's draw and shadow passes summed over many frames. A/B in turns (each piece measured several times,
// interleaved) so the laptop's clocks and heat don't favour one.
//   node scripts/drawbench.mjs [--url http://localhost:5207] [--at 12304,5457] [--frames 120] [--rounds 3]
//     [--size 412x915] [--dpr 2.6] [--q low] [--zoom z]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const at = opt('at', '12304,5457');
const frames = Number(opt('frames', 120));
const rounds = Number(opt('rounds', 3));
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const dpr = Number(opt('dpr', '2.6'));
const q = opt('q', 'low');
const zoom = opt('zoom', '');
const pieces = opt('pieces', 'none,mesh,band,far,shadow,water,prisms,plants,tops,opaque,particles').split(',');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: dpr },
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  p.on('console', (m) => m.text().startsWith('drawn') && console.log(m.text()));
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=${q}&at=${at}&speed=0&perf=1${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  if (zoom) await p.evaluate((z) => (window.reclaimed.camera.zoom = z), Number(zoom));
  await new Promise((r) => setTimeout(r, 8000));
  const r = await p.evaluate(
    async (pieces, frames, rounds) => {
      const SKIP = window.reclaimed.core.renderer.constructor.skip;
      const prof = window.reclaimed.core.host.profiler;
      const raf = () => new Promise((res) => requestAnimationFrame(res));
      const res = {};
      for (let k = 0; k < rounds; k++)
        for (const piece of pieces) {
          SKIP.clear();
          if (piece !== 'none') for (const s of piece.split('+')) SKIP.add(s);
          for (let f = 0; f < 10; f++) await raf();
          prof.resetTotals();
          for (let f = 0; f < frames; f++) await raf();
          const n = Math.max(prof.framesResolved, 1);
          const o = (res[piece] ??= { draw: 0, shadow: 0, gpu: 0, n: 0 });
          o.draw += (prof.totalMs.get('draw') ?? 0) / n;
          o.shadow += (prof.totalMs.get('shadow') ?? 0) / n;
          o.gpu += prof.gpuTotalMs / n;
          o.n++;
          if (piece === 'none' && k === rounds - 1) o.top = [...prof.totalMs].map(([kk, v]) => [kk, v / n]).sort((x, y) => y[1] - x[1]).slice(0, 14).map(([kk, v]) => `${kk} ${v.toFixed(2)}`).join(', ');
        }
      SKIP.clear();
      const R = window.reclaimed.core.renderer;
      console.log('drawn', R.fieldMesh.drawn, 'band', R.band?.mesh.drawn, 'stats', JSON.stringify(R.fieldMesh.stats));
      const out = {};
      for (const [k, o] of Object.entries(res)) out[k] = { top: o.top, draw: +(o.draw / o.n).toFixed(2), shadow: +(o.shadow / o.n).toFixed(2), gpu: +(o.gpu / o.n).toFixed(2) };
      return out;
    },
    pieces,
    frames,
    rounds,
  );
  const base = r.none;
  console.log('passes (still frame):', r.none.top);
  for (const [k, o] of Object.entries(r)) console.log(k.padEnd(10), `draw ${o.draw.toFixed(2)}`, `shadow ${o.shadow.toFixed(2)}`, `gpu ${o.gpu.toFixed(2)}`, k === 'none' ? '' : `saves draw ${(base.draw - o.draw).toFixed(2)}, gpu ${(base.gpu - o.gpu).toFixed(2)}`);
} finally {
  await browser.close();
}
