// Stills of the flow lab's pool fall (round 86): breach, then side-view shots at given times (ms after the breach),
// and the stream's state over a few columns (flow.water.probe is runs only; this reads the GPU's frame).
//   node scripts/fallstill.mjs [--url http://localhost:5247] [--at 800,1600,3000,6000] [--out prefix] [--extra ""]
//        [--az 1.5708] [--zoom 9] [--base]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5247');
const out = opt('out', 'fallstill');
const at = opt('at', '800,1600,3000,6000').split(',').map(Number);
const az = Number(opt('az', String(Math.PI / 2)));
const zoom = Number(opt('zoom', '9'));
const base = argv.includes('--base');
const dx = Number(opt('dx', '8'));
const tz = Number(opt('z', '16'));
const [W, H] = opt('size', '640x480').split('x').map(Number);
const ROW_H = Math.sqrt(3) / 2;
const cellPos = (x, y) => [x + 0.5 + 0.5 * (y & 1), (y + 0.5) * ROW_H];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
let failed = false;
try {
  const p = await browser.newPage();
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text().slice(0, 600)}`);
  });
  p.on('pageerror', (e) => {
    failed = true;
    console.log(`[pageerror] ${e.message}`);
  });
  await p.goto(`${url}/?skipmenu=1&level=flowlab&tutorial=0&tod=0.4${base ? '' : '&flow=1'}${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.core, { timeout: 240000 });
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal: ${fatal}`);
  await p.evaluate(() => (document.getElementById('ui').style.visibility = 'hidden'));
  const [px, py] = cellPos(66, 55);
  await p.evaluate(
    (x, y, zoom, az, tz) => {
      const c = window.reclaimed.camera;
      c.target = [x, y, tz];
      c.zoom = zoom;
      c.azimuth = az;
    },
    px + dx,
    py,
    zoom,
    az,
    tz,
  );
  await sleep(1500);
  const t0 = Date.now();
  if (base)
    await p.evaluate(
      (pts, str) => {
        for (const [x, y] of pts) for (let k = 0; k < 3; k++) window.reclaimed.globals.events.push({ kind: 5, x, y, z: 2 * 32 + 512, radius: 2.2, strength: str });
      },
      [53.5, 55.5].map((y) => cellPos(65, y)),
      1,
    );
  else await p.evaluate(() => window.reclaimed.flow.breach(1.5));
  for (const ms of at) {
    const wait = t0 + ms - Date.now();
    if (wait > 0) await sleep(wait);
    await p.screenshot({ path: `${out}-${ms}.png` });
    console.log(`saved ${out}-${ms}.png`);
    if (argv.includes('--waterprobe')) {
      const r = await p.evaluate(async () => {
        const f = new Float32Array((await window.reclaimed.readBuffer('water')).buffer);
        let mx = 0, at = null, sum = 0;
        for (let y = 40; y < 70; y++) for (let x = 40; x < 75; x++) { const d = f[y * 256 + x]; sum += d; if (d > mx) { mx = d; at = [x, y]; } }
        let pm = 0, pat = null, ps = 0;
        for (let y = 40; y < 70; y++) for (let x = 70; x < 120; x++) { const d = f[y * 256 + x]; ps += d; if (d > pm) { pm = d; pat = [x, y]; } }
        return { max: +mx.toFixed(2), at, sum: +sum.toFixed(1), plainMax: +pm.toFixed(4), plainAt: pat, plainSum: +ps.toFixed(3) };
      });
      console.log(`[water ${ms}] ` + JSON.stringify(r));
    }
    if (!base && argv.includes('--probe')) {
      const r = await p.evaluate(async () => {
        const st = await window.reclaimed.flow.water.probeStreams();
        const keys = ['ez', 'vz', 'tEnd', 'lip', 'rate', 'us'];
        const row = (s) => ({ ez: s.e[2], vz: s.vz, tEnd: s.tEnd, lip: s.lip, rate: s.rate, us: Math.hypot(s.u[0], s.u[1]) });
        const lo = {}, hi = {};
        for (const s of st) {
          const r = row(s);
          for (const k of keys) {
            lo[k] = Math.min(lo[k] ?? Infinity, r[k]);
            hi[k] = Math.max(hi[k] ?? -Infinity, r[k]);
          }
        }
        const odd = st.filter((s) => !(s.vz <= 1e-3) || !(s.e[2] < 31) || !(s.tEnd < 3) || ![s.e[0], s.e[1], s.u[0], s.u[1], s.rate, s.lip].every(Number.isFinite)).slice(0, 6);
        return { n: st.length, lo, hi, odd };
      });
      console.log(`[streams ${ms}] ` + JSON.stringify(r));
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
