// Round 90 (BACKLOG W2): the atlas's lakes realised on arrival — at many river and lake spots, every water wall
// counted (a wet column standing over a neighbour's level, wet or dry, by more than --step: seawallprobe.mjs's
// test, but a sheet over a fall — water no deeper than --sheet — isn't standing water) and each lake's water
// checked at its level. Exits 1 if any spot has a wall or a lake's water is off its level.
//   node scripts/lakeprobe.mjs [--url http://localhost:5311] [--n 8] [--spots "x,y;x,y"] [--out C:/Projects/shots88/lakes/probe]
//     --n       lakes to visit (the biggest, and ones with a river in and out), each at its middle and its outlet
//     --zoom z  a shot at this zoom on a shore column too (0: none)
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5311');
const out = opt('out', 'C:/Projects/shots88/lakes/probe');
const step = Number(opt('step', 3));
const sheet = Number(opt('sheet', 0.3));
const zoom = Number(opt('zoom', 0));
const wait = Number(opt('wait', 35000));
const extra = opt('extra', '');
const RH = Math.sqrt(3) / 2;
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let bad = 0;
try {
  // the lakes, from the atlas
  const p0 = await browser.newPage();
  p0.on('pageerror', (e) => console.log('pageerror', e.message));
  await p0.goto(`${url}/?skipmenu=1&tutorial=0&q=low&level=atlas${extra}`, { waitUntil: 'load' });
  await p0.waitForFunction(() => window.reclaimed?.atlas?.lakes && window.reclaimed?.stream, { timeout: 300000 });
  const info = await p0.evaluate(() => {
    const a = window.reclaimed.atlas;
    const L = a.lakes;
    const t = L.map((l) => l.texels).sort((x, y) => x - y);
    const q = (f) => t[Math.min(t.length - 1, Math.floor(f * t.length))] ?? 0;
    // settlements standing in a lake
    const n = a.p.n;
    let wetSites = 0;
    for (const s of a.settlement.sites) {
      const tx = Math.floor((s.x / a.worldW) * n) % n;
      const ty = Math.floor((s.y / a.worldH) * n) % n;
      if (a.lakeAt[ty * n + tx] & 0x8000) wetSites++;
    }
    return { count: L.length, texels: [q(0), q(0.5), q(0.9), q(1)], deep: L.filter((l) => l.depth > 10).length, withRiver: L.filter((l) => l.inflow > 0).length, wetSites, sites: a.settlement.sites.length, stats: a.riverStats, timings: a.timings['rivers (cpu)'], lakes: L };
  });
  const { lakes, ...rest } = info;
  console.log('atlas lakes', JSON.stringify(rest));
  await p0.close();
  const n = Number(opt('n', 8));
  let spots = [];
  if (opt('spots', '')) spots = opt('spots', '').split(';').map((s) => ({ at: s.split(',').map(Number), lake: null, what: 'given' }));
  else {
    // the W2 spot, then the biggest lakes and ones a river runs through
    spots.push({ at: [1040, 13551], lake: null, what: 'W2' });
    const big = lakes.slice().sort((a, b) => b.texels - a.texels);
    const riv = lakes.filter((l) => l.inflow > 0 && l.outflow >= 0).sort((a, b) => b.texels - a.texels);
    const pick = [];
    for (const l of [...big.slice(0, Math.ceil(n / 2)), ...riv]) if (pick.length < n && !pick.includes(l)) pick.push(l);
    for (const l of pick) {
      spots.push({ at: [Math.round(l.at[0]), Math.round(l.at[1] / RH)], lake: l, what: `lake ${l.id} middle` });
      spots.push({ at: [Math.round(l.outlet[0]), Math.round(l.outlet[1] / RH)], lake: l, what: `lake ${l.id} outlet` });
    }
  }
  let k = 0;
  for (const s of spots) {
    const p = await browser.newPage();
    p.on('pageerror', (e) => console.log('pageerror', e.message));
    p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text()));
    await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&level=atlas&at=${s.at.join(',')}${extra}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 300000 });
    await sleep(wait);
    const r = await p.evaluate(
      async (step, sheet, level) => {
        const R = window.reclaimed;
        const W = R.core.dims.w;
        const H = R.core.dims.h;
        const w = new Float32Array((await R.readBuffer('water')).buffer);
        const sf = new Uint32Array((await R.readBuffer('surface')).buffer);
        // (the ground's top: the surface and the loose ground drifted on it — terrainshape.wgsl groundTopR)
        const drift = (await R.core.readTexture(R.world.drift)).data;
        const z = (i) => (sf[i] & 0xffff) / 256 + drift[i * 4];
        // (what each wet column is: a lake's (in one, Atlas.lakeAt, at its level), a river's (riverFlow), or other water)
        const rf = (await R.core.readTexture(R.world.riverFlow)).data;
        const A = R.atlas;
        const an = A.p.n;
        const org = R.stream.origin;
        const lakeOf = (i) => {
          const x = i % W;
          const y = (i - x) / W;
          const tx = ((Math.floor(((org[0] + x + 0.5) / A.worldW) * an) % an) + an) % an;
          const ty = ((Math.floor((((org[1] + y + 0.5) * Math.sqrt(3)) / 2 / A.worldH) * an) % an) + an) % an;
          const v = A.lakeAt[ty * an + tx];
          return v ? A.lakes[(v & 0x7fff) - 1] : null;
        };
        const kind = (i) => {
          const l = lakeOf(i);
          if (l && Math.abs(z(i) + w[i] + oz - l.level) < 1) return 'lake';
          return rf[i * 4 + 2] > 0 ? 'river' : 'other';
        };
        const by = { lake: 0, river: 0, other: 0 };
        const oz = R.stream.oz;
        const walls = [];
        let wet = 0;
        let atLevel = 0;
        let nearLevel = 0;
        let shore = null;
        for (let y = 1; y < H - 1; y++)
          for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            if (w[i] <= 0.05) continue;
            wet++;
            const lv = z(i) + w[i];
            if (level !== null && Math.abs(lv + oz - level) < 0.35) atLevel++;
            if (level !== null && Math.abs(lv + oz - level) < 3) nearLevel++;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const j = (y + dy) * W + x + dx;
              const nl = z(j) + Math.max(w[j], 0);
              if (w[j] <= 0.05 && !shore && level !== null && Math.abs(lv + oz - level) < 0.35 && Math.abs(x - W / 2) < W / 4 && Math.abs(y - H / 2) < H / 4) shore = [x, y, lv];
              // (into a fall's sheet: the lip of a fall, not a wall)
              if (lv - nl > step && w[i] > sheet && !(w[j] > 0.1 && w[j] <= sheet) && ++by[kind(i)]) walls.push([x, y, +(lv + oz).toFixed(1), +(nl + oz).toFixed(1), +w[i].toFixed(1), +w[j].toFixed(1)]);
            }
          }
        const byLv = {};
        for (const q of walls) byLv[Math.round(q[2])] = (byLv[Math.round(q[2])] || 0) + 1;
        return { by, W, H, oz, wet, atLevel, nearLevel, walls: walls.length, byLv, shore, first: walls[0] ?? null, some: walls.filter((_, i) => i % Math.max(1, Math.floor(walls.length / 10)) === 0).slice(0, 10) };
      },
      step,
      sheet,
      s.lake ? s.lake.level : null,
    );
    // (a lake's water at its level: most of what's wet near its level is at it)
    const off = s.lake && s.what.endsWith('middle') && r.atLevel < 0.8 * r.nearLevel;
    // (--lakesonly: only a lake's walls fail — the rivers' own are counted, not judged)
    if ((argv.includes('--lakesonly') ? r.by.lake : r.walls) || off) bad++;
    console.log(`${s.what} @${s.at.join(',')}${s.lake ? ` level ${s.lake.level} (${s.lake.texels} texels, ${s.lake.depth} deep)` : ''}:`, JSON.stringify(r), r.walls ? 'WALLS' : '', off ? 'OFF LEVEL' : '');
    await p.screenshot({ path: `${out}-${k}-zdef.png` });
    const q = r.first ? [r.first[0], r.first[1], r.first[2] - r.oz] : r.shore;
    if (zoom > 0 && q) {
      await p.evaluate(
        (zz, q) => {
          const R = window.reclaimed;
          R.camera.target = [q[0], q[1] * (Math.sqrt(3) / 2), q[2]];
          R.camera.zoom = zz;
        },
        zoom,
        q,
      );
      await sleep(3000);
      await p.screenshot({ path: `${out}-${k}-z${zoom}.png` });
    }
    await p.close();
    k++;
  }
} finally {
  await browser.close();
}
console.log(bad ? `FAIL: ${bad} spots` : 'ok: no walls, lakes at their level');
process.exit(bad ? 1 : 0);
