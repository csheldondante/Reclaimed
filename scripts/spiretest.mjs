// Spires of sediment in rain (Q16, round 49): rain storms over the valley at
// speed, then every column standing over all six of its neighbours; the
// counts, the tallest few and their stacks (planted or not), and a shot of
// the tallest.
//
//   node scripts/spiretest.mjs [--url http://localhost:5181] [--seconds 60] [--storms 4]
//     [--speed 4] [--out spire] [--level valley] [--on veg|green] [--tower N] [--storms 0]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5181');
const seconds = Number(opt('seconds', 60));
const storms = Number(opt('storms', 4));
const speed = Number(opt('speed', 4));
const out = opt('out', 'spire');
const level = opt('level', 'valley');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) {
      failed = true;
      console.log('console.error:', m.text().slice(0, 800));
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&speed=${speed}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 3000));
  // the spires now: columns over all six neighbours by more than 2.5 and 4 cells
  const survey = () =>
    page.evaluate(async () => {
      const R = window.reclaimed;
      const { readColumn } = await import('/src/world/layout.ts');
      const { MATERIALS, MatState } = await import('/src/world/materials.ts');
      const loose = (m) => MATERIALS[m]?.state === MatState.Granular;
      const core = R.core;
      const { w, h } = core.dims;
      const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
      const veg = new Float32Array((await core.readBuffer('veg')).buffer);
      const top = new Float32Array(w * h);
      const cols = [];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const c = readColumn(core.packed, slots, x, y);
          cols.push(c);
          top[y * w + x] = c.length ? c[c.length - 1].z1 : 0;
        }
      const nb = (x, y) => {
        const o = y & 1;
        return [[x - 1, y], [x + 1, y], [x - 1 + o, y - 1], [x + o, y - 1], [x - 1 + o, y + 1], [x + o, y + 1]];
      };
      let n25 = 0;
      let n4 = 0;
      const spikes = [];
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          // (loose ground on top: built things stand over their neighbours by design;
          // over all but one neighbour, so a spire two columns wide counts)
          const c = cols[y * w + x];
          if (!c.length || !loose(c[c.length - 1].mat)) continue;
          const t = top[y * w + x];
          const over = nb(x, y).map(([a, b]) => t - top[b * w + a]).sort((a, b) => a - b)[1];
          if (over > 2.5) n25++;
          if (over > 4) n4++;
          if (over > 1.2) spikes.push({ x, y, over, t, veg: veg[y * w + x], stack: cols[y * w + x].slice(-5).map((iv) => `${iv.mat}:${iv.z0.toFixed(1)}-${iv.z1.toFixed(1)}`).join(' ') });
        }
      spikes.sort((a, b) => b.over - a.over);
      return { n25, n4, spikes: spikes.slice(0, 8) };
    });
  // --tower N: N planted columns each given a narrow tower 8 cells over its
  // ground, soil under thin alternating silt and dust (what rain lays down);
  // their heights are tracked below
  const towers = Number(opt('tower', '0'));
  const tw = towers
    ? await page.evaluate(async (n) => {
        const R = window.reclaimed;
        const { columnSlots, readColumn, writeSlot } = await import('/src/world/layout.ts');
        const { MAT, MATERIALS, MatState } = await import('/src/world/materials.ts');
        const core = R.core;
        const { w, h } = core.dims;
        const dev = core.host.gpu.device;
        const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
        const veg = new Float32Array((await core.readBuffer('veg')).buffer);
        const out = [];
        for (let k = 0; k < n; k++) {
          // loose-topped columns spread over the middle of the map
          let x = Math.floor(w * (0.3 + 0.4 * ((k * 0.618) % 1)));
          let y = Math.floor(h * (0.3 + 0.4 * ((k * 0.382 + 0.5) % 1)));
          let c = readColumn(core.packed, slots, x, y);
          for (let t = 0; t < 200 && !(c.length && MATERIALS[c[c.length - 1].mat].state === MatState.Granular); t++) {
            x = (x + 3) % w;
            c = readColumn(core.packed, slots, x, y);
          }
          const { base, k: K } = columnSlots(core.packed, x, y);
          const top = c[c.length - 1].z1;
          const col = c.map((iv) => [iv.z0, iv.z1, iv.mat]);
          let z = top;
          col.push([z, z + 6, MAT.Soil]);
          z += 6;
          while (col.length < K) {
            const m = col.length % 2 ? MAT.Silt : MAT.Drift;
            col.push([z, z + 0.08, m]);
            z += 0.08;
          }
          const data = new Uint32Array(K * 4);
          col.slice(0, K).forEach(([a, b, m], s) => writeSlot(data, s, a, b, m));
          dev.queue.writeBuffer(R.world.layers, base * 16, data);
          veg[y * w + x] = 3;
          out.push({ x, y, ground: top, z });
        }
        dev.queue.writeBuffer(R.world.veg, 0, veg);
        dev.queue.writeBuffer(R.world.vegNext, 0, veg);
        return out;
      }, towers)
    : [];
  const towerTops = () =>
    page.evaluate(async (tw) => {
      const R = window.reclaimed;
      const { readColumn } = await import('/src/world/layout.ts');
      const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
      return tw.map((t) => {
        const c = readColumn(R.core.packed, slots, t.x, t.y);
        return (c[c.length - 1].z1 - t.ground).toFixed(2);
      });
    }, tw);
  if (towers) console.log('towers', JSON.stringify(tw.map((t) => [t.x, t.y, +(t.z - t.ground).toFixed(2)])));
  const before = await survey();
  console.log('before', before.n25, '>2.5,', before.n4, '>4');
  const at = await page.evaluate(async (storms, onVeg, tw) => {
    const R = window.reclaimed;
    const { w, h } = R.core.dims;
    const made = [];
    // (with towers: the storms over them)
    if (tw.length) {
      for (let k = 0; k < storms; k++) {
        const t = tw[k % tw.length];
        made.push(!!R.weather.spawn(t.x + 0.5 + 0.5 * (t.y & 1), (t.y + 0.5) * 0.8660254));
      }
      return made;
    }
    // --on green: the whole map planted first (as late in a level), then storms anywhere
    if (onVeg === 'green') {
      const full = new Float32Array(w * h).fill(2.5);
      R.core.host.gpu.device.queue.writeBuffer(R.world.veg, 0, full);
      R.core.host.gpu.device.queue.writeBuffer(R.world.vegNext, 0, full);
    }
    // --on veg: over the planted ground (roots hold slopes there: the suspect)
    if (onVeg === 'veg') {
      const veg = new Float32Array((await R.core.readBuffer('veg')).buffer);
      const planted = [];
      for (let i = 0; i < w * h; i++) if (veg[i] > 1.2) planted.push(i);
      for (let k = 0; k < storms && planted.length; k++) {
        const i = planted[Math.floor(((k + 0.5) / storms) * planted.length)];
        const x = i % w;
        const y = Math.floor(i / w);
        made.push(!!R.weather.spawn(x + 0.5, (y + 0.5) * 0.8660254));
      }
      return { planted: planted.length, made };
    }
    for (let k = 0; k < storms; k++) {
      const x = w * (0.3 + 0.4 * ((k % 2) + 0.5) / 2) + (k * 13) % 20;
      const y = h * 0.866 * (0.3 + 0.4 * (Math.floor(k / 2) + 0.5) / Math.max(1, Math.ceil(storms / 2)));
      made.push(!!R.weather.spawn(x, y));
    }
    return made;
  }, storms, opt('on', ''), tw);
  console.log('storms', JSON.stringify(at));
  for (let t = 0; t < seconds; t += 20) {
    await new Promise((r) => setTimeout(r, Math.min(20, seconds - t) * 1000));
    const s = await survey();
    if (towers) console.log('  towers over their ground', (await towerTops()).join(' '));
    console.log(`t=${Math.min(t + 20, seconds)}s`, s.n25, '>2.5,', s.n4, '>4; tallest', s.spikes.slice(0, 4).map((p) => `(${p.x},${p.y}) +${p.over.toFixed(1)} veg ${p.veg.toFixed(2)} [${p.stack}]`).join(' | '));
    if (t + 20 >= seconds && s.spikes.length) {
      const p = s.spikes[0];
      await page.evaluate((p) => {
        const R = window.reclaimed;
        document.querySelectorAll('.hint, .toast').forEach((e) => e.remove());
        R.camera.target = [p.x + 0.5 + 0.5 * (p.y & 1), (p.y + 0.5) * 0.8660254, p.t];
        R.camera.zoom = 26;
      }, p);
      await new Promise((r) => setTimeout(r, 800));
      await page.screenshot({ path: `${out}.png` });
      console.log('saved', `${out}.png`);
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
