// Pillars backed against walls (Q16b/Q22): storms + craters at ?q=low, then
// loose-topped columns standing over all their lower neighbours (measured
// from the neighbours' real intervals: air under a roof counts), and the
// 'hidden' ones beside air under a roof. Round 63: e.g. --level sandbox --craters 8.
//   node scripts/pillartest.mjs [--url http://localhost:5177] [--level valley] [--seconds 60] [--storms 4] [--craters 6] [--speed 1] [--out p] [--mesh 1]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5177');
const seconds = Number(opt('seconds', 60));
const storms = Number(opt('storms', 4));
const craters = Number(opt('craters', 6));
const speed = Number(opt('speed', 1));
const out = opt('out', 'pillar');
const level = opt('level', 'valley');
const extra = opt('extra', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) console.log('console.error:', m.text().slice(0, 400));
  });
  await page.evaluateOnNewDocument((z) => { window.__zoom = z; }, opt('zoom', '20'));
  await page.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&q=low&speed=${speed}${extra}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 3000));
  await page.evaluate(async () => {
    const { readColumn } = await import('/src/world/layout.ts');
    const { MATERIALS, MatState } = await import('/src/world/materials.ts');
    window.__survey = async () => {
      const R = window.reclaimed;
      const core = R.core;
      const { w, h } = core.dims;
      const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
      const veg = new Float32Array((await core.readBuffer('veg')).buffer);
      let moist = null;
      try { moist = new Float32Array((await core.readBuffer('moisture')).buffer); } catch {}
      const loose = (m) => MATERIALS[m]?.state === MatState.Granular;
      const cols = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cols.push(readColumn(core.packed, slots, x, y));
      const topOf = (c) => (c.length ? c[c.length - 1].z1 : 0);
      // geometric floor of column c met at height z: inside a solid → its top (a wall)
      const floorAt = (c, z) => {
        let f = 0;
        for (const iv of c) {
          if (iv.z0 <= z + 1e-3 && iv.z1 > z + 1e-3) return { f: iv.z1, wall: true };
          if (iv.z1 <= z + 1e-3) f = Math.max(f, iv.z1);
        }
        return { f, wall: false };
      };
      const nb = (x, y) => {
        const o = y & 1;
        return [[x - 1, y], [x + 1, y], [x - 1 + o, y - 1], [x + o, y - 1], [x - 1 + o, y + 1], [x + o, y + 1]];
      };
      const H = { n: 0, ex: 0, max: 0, at: null, bad: 0, badAt: null, thin: 0, full: 0 };
      for (let i = 0; i < cols.length; i++) { const c = cols[i]; for (let k = 0; k + 1 < c.length; k++) if (loose(c[k].mat) && c[k].z1 - c[k].z0 < 0.03) H.thin++; }
      for (let i = 0; i < cols.length; i++) { const c = cols[i]; for (let k = 1; k < c.length; k++) if (c[k].z0 < c[k - 1].z1 - 1e-3) { H.bad++; H.badAt = [i % w, Math.floor(i / w)]; if (H.bad <= 3) H.badS = (H.badS ?? '') + ` | (${i % w},${Math.floor(i / w)}) ` + c.map((iv) => `${MATERIALS[iv.mat].name}:${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}`).join(' '); break; } }
      const A = []; // over every lower neighbour by > rep+2, >=2 lower neighbours
      const B = []; // loose top > 3 over all lower neighbours next to a cliff (a neighbour higher by >2)
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const c = cols[y * w + x];
          if (!c.length) continue;
          const tv = c[c.length - 1];
          if (!loose(tv.mat)) continue;
          const t = tv.z1;
          // the loose run on top (touching granular intervals): a pillar is made of it
          let rb = c.length - 1;
          while (rb > 0 && loose(c[rb - 1].mat) && Math.abs(c[rb - 1].z1 - c[rb].z0) < 1e-3) rb--;
          const runDepth = t - c[rb].z0;
          const rep = MATERIALS[tv.mat].reposeDry;
          // hidden drops: a neighbour whose top is higher but has air beside this run below its top
          for (const [a, b] of nb(x, y)) {
            const nc = cols[b * w + a];
            if (topOf(nc) <= t) continue;
            const g = floorAt(nc, t);
            const ex = t - Math.max(g.f, c[rb].z0) - rep;
            if (!g.wall && ex > 0.5) { H.n++; H.ex += ex; if (ex > H.max) { H.max = ex; H.at = [x, y]; H.t = t; } break; }
          }
          if (runDepth < Number(window.__minRun ?? 2)) continue;
          const ns = nb(x, y).map(([a, b]) => {
            const nc = cols[b * w + a];
            const g = floorAt(nc, t);
            return { a, b, top: topOf(nc), floor: g.f, wall: g.wall, gap: nc.some((iv, i) => i > 0 && iv.z0 > nc[i - 1].z1 + 1e-3) };
          });
          const lower = ns.filter((n) => n.floor <= t + 1e-3 && !n.wall);
          const drops = lower.map((n) => t - n.floor);
          const minDrop = drops.length ? Math.min(...drops) : 0;
          const cliff = ns.some((n) => n.top > t + 2);
          const rec = () => ({
            x, y, t: +t.toFixed(2), run: +runDepth.toFixed(2), rep, minDrop: +minDrop.toFixed(2), nLower: lower.length, cliff,
            hiddenDrop: ns.filter((n) => n.top >= t && n.floor < t - rep - 0.5).length, // overhang neighbour: top higher, air beside
            veg: +veg[y * w + x].toFixed(2), moist: moist ? +moist[y * w + x].toFixed(2) : null, k: c.length,
            stack: c.map((iv) => `${MATERIALS[iv.mat].name}:${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}`).join(' '),
            nbs: ns.map((n) => `${n.top.toFixed(1)}/${n.floor.toFixed(1)}${n.wall ? 'W' : ''}${n.gap ? 'g' : ''}`).join(' '),
          });
          if (lower.length >= 2 && minDrop > rep + 2) A.push(rec());
          if (lower.length >= 1 && minDrop > 3 && cliff) B.push(rec());
        }
      A.sort((a, b) => b.minDrop - a.minDrop);
      B.sort((a, b) => b.minDrop - a.minDrop);
      return { H, A: A.slice(0, 10), nA: A.length, B: B.slice(0, 10), nB: B.length };
    };
  });
  const show = (s, tag) => {
    console.log(`${tag}: A=${s.nA} B=${s.nB} hidden n=${s.H.n} excess=${s.H.ex.toFixed(1)} max=${s.H.max.toFixed(2)} at ${s.H.at}; overlapping columns ${s.H.bad}; buried thin loose slices ${s.H.thin}`);
    for (const p of s.A.slice(0, 6)) console.log('  A', JSON.stringify(p));
    for (const p of s.B.slice(0, 4)) console.log('  B', JSON.stringify(p));
  };
  show(await page.evaluate(() => window.__survey()), 'before');
  const made = await page.evaluate(async (storms, craters) => {
    const R = window.reclaimed;
    const { w, h } = R.core.dims;
    const made = [];
    for (let k = 0; k < storms; k++) {
      const x = w * (0.3 + 0.4 * ((k % 2) + 0.5) / 2) + (k * 13) % 20;
      const y = h * 0.866 * (0.3 + 0.4 * (Math.floor(k / 2) + 0.5) / Math.max(1, Math.ceil(storms / 2)));
      made.push(!!R.weather.spawn(x, y));
    }
    for (let k = 0; k < craters; k++) {
      const x = w * (0.2 + 0.6 * ((k * 0.618) % 1));
      const y = h * 0.866 * (0.2 + 0.6 * ((k * 0.382 + 0.3) % 1));
      R.api.terrain.crater(x, y, { radius: 4 + (k % 3) * 2 });
      made.push(['crater', Math.round(x), Math.round(y)]);
    }
    return made;
  }, storms, craters);
  console.log('made', JSON.stringify(made));
  let last;
  for (let t = 0; t < seconds; t += 20) {
    await new Promise((r) => setTimeout(r, Math.min(20, seconds - t) * 1000));
    last = await page.evaluate(() => window.__survey());
    const tick = await page.evaluate(() => window.reclaimed.core.globals?.tick ?? 0);
    show(last, `t=${Math.min(t + 20, seconds)}s tick=${tick}`);
  }
  if (last.H.at) {
    const st = await page.evaluate(async ([x, y]) => {
      const R = window.reclaimed;
      const { readColumn } = await import('/src/world/layout.ts');
      const { MATERIALS } = await import('/src/world/materials.ts');
      const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
      const o = y & 1;
      const out = [];
      for (const [a, b] of [[x, y], [x - 1, y], [x + 1, y], [x - 1 + o, y - 1], [x + o, y - 1], [x - 1 + o, y + 1], [x + o, y + 1]])
        out.push(`(${a},${b}) ` + readColumn(R.core.packed, slots, a, b).map((iv) => `${MATERIALS[iv.mat].name}:${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}`).join(' '));
      return out;
    }, last.H.at);
    console.log('worst hidden column and its neighbours:'); for (const l of st) console.log('  ' + l);
  }
  const cam = opt('cam', '');
  const p = cam ? { x: +cam.split(',')[0], y: +cam.split(',')[1], t: +cam.split(',')[2] } : opt('at', '') === 'H' && last.H.at ? { x: last.H.at[0], y: last.H.at[1], t: last.H.t } : last.A[0] ?? last.B[0];
  if (p) {
    await page.evaluate((p) => {
      const R = window.reclaimed;
      document.querySelectorAll('.hint, .toast').forEach((e) => e.remove());
      R.camera.target = [p.x + 0.5 + 0.5 * (p.y & 1), (p.y + 0.5) * 0.8660254, p.t];
      R.camera.zoom = Number(window.__zoom ?? 20);
    }, p);
    await new Promise((r) => setTimeout(r, 1000));
    await page.screenshot({ path: `${out}.png` });
    console.log('saved', `${out}.png`, p.x, p.y);
  }
} finally {
  await browser.close();
}
