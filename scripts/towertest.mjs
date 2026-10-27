// Round 87 regression (the user, on the phone: "the collapse didn't work for me on mobile at all. I was able to
// completely destroy the base of a tower and it stayed standing"). On the atlas level at the phone tier (q=low,
// the hybrid on, 412×915), towers of different widths, heights and materials are built (the world API), then
// undercut the way a player does it: the sandbox's tool picked (editor().select, as a tap on its button) and the
// screen tapped at the tower's foot (the real pointer path: pick, smash / meteor). Each must come down: a piece
// spawned within LIMIT ms of the tap that freed it (the meteor: of its landing), and the tower's top lower after.
//   node scripts/towertest.mjs [--url http://localhost:5263] [--q low] [--only a,b] [--gif C:/Projects/shots86/tall-tower.gif --gifcase tall]
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
const url = opt('url', 'http://localhost:5263');
const q = opt('q', 'low');
const gif = opt('gif', '');
const gifCase = opt('gifcase', 'tall');
const LIMIT = Number(opt('limit', 200));
const CASES = [
  { name: 'spire', mat: 'stone', radius: 2.5, height: 40, tool: 'smash' },
  { name: 'wide', mat: 'stone', radius: 4.5, height: 70, tool: 'smash' },
  { name: 'concrete', mat: 'concrete', radius: 2.5, height: 30, tool: 'smash' },
  { name: 'meteor', mat: 'stone', radius: 3, height: 50, tool: 'meteor' },
  // to the window's top and on above it (Streamer.outside, the band)
  { name: 'tall', mat: 'stone', radius: 3, height: 'top', tool: 'smash' },
];
const only = opt('only', '');
const cases = only ? CASES.filter((c) => only.split(',').includes(c.name)) : CASES;
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let fails = 0;
let pageErrors = 0;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    pageErrors++;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=${q}&level=atlas`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await sleep(12000);
  // (round 92: 12 apart round the camera — the streamer is on: 16 apart took the last past its reach, and it slid)
  let side = -24;
  for (const c of cases) {
    // build it beside the camera's target, look at it
    const at = await p.evaluate(
      async (c, side) => {
        const R = window.reclaimed;
        // (round 92: the streamer left on, as on the phone; the towers stay within its reach)
        const t = R.api.terrain;
        await t.refresh();
        const [cx, cy] = R.camera.target;
        const x = cx + side;
        const y = cy;
        const z = t.heightAt(x, y);
        const zMax = R.core.dims.zMax;
        const h = c.height === 'top' ? zMax - z + 30 : c.height;
        for (let k = 0; k < Math.ceil(h / 4); k++) t.build(x, y, c.mat, { radius: c.radius, layers: 4 });
        R.camera.target = [x, y, z + 8];
        R.camera.zoom = 7;
        // (round 92: the streamer is on — a slide in z, the camera over a tall tower, moves window z: oz kept)
        return { x, y, z, zMax, oz: R.stream.oz };
      },
      c,
      side,
    );
    side += 12;
    await sleep(5000);
    // (the tall one: a generated spire goes on above the window — what's outside its columns, drawn by the band)
    if (c.height === 'top')
      console.log(
        'above the window:',
        await p.evaluate(async (a) => {
          const R = window.reclaimed;
          const t = R.api.terrain;
          await t.refresh();
          const S = R.stream;
          const { w, zMax } = R.core.dims;
          const ROW_H = Math.sqrt(3) / 2;
          // (the build stops 2 under the window's top: those columns are run up to it, as a slide cuts a column
          // that goes on — and on above it, outside)
          const slots = new Uint32Array((await R.readBuffer('layers')).buffer);
          const f32 = new Float32Array(slots.buffer);
          const pk = R.core.packed;
          const dev = R.core.host.gpu.device;
          let n = 0;
          for (let cy = Math.floor(a.y / ROW_H) - 6; cy <= Math.floor(a.y / ROW_H) + 6; cy++)
            for (let cx = Math.floor(a.x) - 6; cx <= Math.floor(a.x) + 6; cx++) {
              const ci = Math.floor(cy / 16) * pk.chunksX + Math.floor(cx / 16);
              const k = pk.chunkTable[ci * 2 + 1];
              const base = pk.chunkTable[ci * 2] + ((cy % 16) * 16 + (cx % 16)) * k;
              let last = -1;
              for (let s = 0; s < k; s++) if (slots[(base + s) * 4 + 1] !== 0) last = s;
              if (last < 0 || f32[(base + last) * 4 + 1] < zMax - 3 || (slots[(base + last) * 4 + 2] & 255) !== 1) continue;
              f32[(base + last) * 4 + 1] = zMax;
              for (const b of [R.core.world.layers, R.core.world.layersNext]) if (b) dev.queue.writeBuffer(b, (base + last) * 16, slots, (base + last) * 4, 4);
              S.outside[cy * w + cx].push({ z0: S.oz + zMax, z1: S.oz + zMax + 24, mat: 1 });
              n++;
            }
          S.refreshBand();
          return n;
        }, at),
        'columns',
      );
    const top0 = await p.evaluate(async (a) => {
      await window.reclaimed.api.terrain.refresh();
      return window.reclaimed.api.terrain.heightAt(a.x, a.y) + window.reclaimed.stream.oz - a.oz;
    }, at);
    // the tool, as its button would pick it; taps at the tower's foot (its near side, a cell up)
    await p.evaluate((tool) => window.reclaimed.editor().select(tool), c.tool);
    const tapAt = () => p.evaluate((a) => window.reclaimed.camera.project(a.x, a.y, a.z + 1.5 - (window.reclaimed.stream.oz - a.oz)), at);
    const b0 = await p.evaluate(() => window.reclaimed.integrity().stats.bodies);
    let spawnedMs = null;
    let taps = 0;
    const shots = [];
    const grab = async () => {
      if (gif && c.name === gifCase) shots.push(await p.screenshot({ type: 'png' }));
    };
    await grab();
    const deadline = Date.now() + (c.tool === 'meteor' ? 4000 : 9000);
    while (spawnedMs === null && Date.now() < deadline) {
      const [sx, sy] = await tapAt();
      await p.mouse.click(sx, sy);
      taps++;
      const t0 = await p.evaluate(() => performance.now());
      // (the meteor flies 1.6 s before it lands)
      const wait = c.tool === 'meteor' ? 1600 + LIMIT + 400 : LIMIT + 400;
      const got = await p.evaluate(
        (b0, wait) =>
          new Promise((done) => {
            const t0 = performance.now();
            const f = () => {
              const I = window.reclaimed.integrity();
              if (I.stats.bodies > b0) return done(I.timing.spawnedAt);
              if (performance.now() - t0 > wait) return done(null);
              requestAnimationFrame(f);
            };
            f();
          }),
        b0,
        wait,
      );
      await grab();
      if (got !== null) spawnedMs = Math.round(got - t0 - (c.tool === 'meteor' ? 1600 : 0));
      if (c.tool === 'meteor') break;
    }
    const tEnd = Date.now() + 5000;
    while (Date.now() < tEnd) {
      await grab();
      if (!gif || c.name !== gifCase) await sleep(500);
    }
    const after = await p.evaluate(async (a) => {
      await window.reclaimed.api.terrain.refresh();
      const I = window.reclaimed.integrity();
      return { top: window.reclaimed.api.terrain.heightAt(a.x, a.y) + window.reclaimed.stream.oz - a.oz, falling: I.falling.list.length, stats: I.stats, tiers: window.reclaimed.stream.stats.tiers };
    }, at);
    // (a structure the smash wakes is the physics voxels' — it comes down there, not as a piece: it must be down)
    const physicsDown = c.mat !== 'stone' && after.top < at.z + 5;
    const above = c.height === 'top' ? await p.evaluate((a) => {
      const R = window.reclaimed;
      const ROW_H = Math.sqrt(3) / 2;
      const cy = Math.round(a.y / ROW_H - 0.5);
      const cx = Math.round(a.x - 0.5 - 0.5 * (cy & 1));
      // (how far over the window's top its runs above still reach: 24 before, less what it fell)
      const top = R.stream.oz + R.core.dims.zMax;
      return Math.max(0, ...R.stream.outside[cy * R.core.dims.w + cx].filter((iv) => iv.z0 >= top - 1e-3).map((iv) => iv.z1 - top));
    }, at) : 0;
    // (the tall one still goes on to the window's top after its fall: what's above it must have come down)
    const ok = ((spawnedMs !== null && spawnedMs <= LIMIT) || physicsDown) && (c.height === 'top' ? above < 21 && (after.tiers === 0 || after.top < top0 - 3) : after.top < top0 - 3);
    if (c.height === 'top') console.log('above the window over its middle now reaches', above, '(24 before)');
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.mat} r${c.radius} h${c.height} by ${c.tool}: ${taps} tap(s), piece in ${spawnedMs} ms (limit ${LIMIT}), top ${top0?.toFixed(1)} → ${after.top?.toFixed(1)} (window top ${at.zMax}), falling now ${after.falling}, slides in z ${after.tiers}; stats ${JSON.stringify(after.stats)}`);
    if (shots.length) {
      const enc = GIFEncoder();
      for (const s of shots) {
        const png = PNG.sync.read(Buffer.from(s));
        const pal = quantize(png.data, 256);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 80 });
      }
      enc.finish();
      fs.writeFileSync(gif, enc.bytes());
      console.log('saved', gif, shots.length, 'frames');
    }
    await p.evaluate(() => window.reclaimed.editor().select('wind'));
    await sleep(1500);
  }
} finally {
  await browser.close();
}
console.log(fails || pageErrors ? `towertest: ${fails} failed, ${pageErrors} page errors` : 'towertest: all passed');
process.exit(fails || pageErrors ? 1 : 0);
