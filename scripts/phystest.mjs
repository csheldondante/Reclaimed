// Physics voxels (docs/PHYSICS.md): drops a few bodies in the sandbox near
// the camera's target and screenshots them falling, landing and settling;
// prints each body's live voxels and height range. --scene picks a setup.
//
//   node scripts/phystest.mjs [--url http://localhost:5178] [--out phys] [--scene drop|beam|heat|fine|mesh]
//     [--extra "&mesh=1"] [--zoom 3] [--shots 0.3,1,2.5,5]
import puppeteer from 'puppeteer-core';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5178');
const out = opt('out', 'phys');
const scene = opt('scene', 'drop');
const extra = opt('extra', '');
const zoom = Number(opt('zoom', '3'));
const one = opt('one', 'stone,3,3,10,3');
const perf = opt('perf', '0') === '1';
const blastAt = Number(opt('blast', '5000'));
const shots = opt('shots', '0.3,1,2.5,5').split(',').map(Number);
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
      console.log('console.error:', m.text().slice(0, 1500));
      failed = true;
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.35${perf ? '&perf=1' : ''}${extra}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 5000));
  const setup = await page.evaluate(
    async (scene, zoom, one, blastAt) => {
      const R = window.reclaimed;
      document.querySelectorAll('.hint, .toast').forEach((e) => e.remove());
      const [x, y] = R.camera.target;
      R.camera.zoom *= zoom;
      const P = R.phys;
      const made = [];
      if (scene === 'drop') {
        made.push(await P.drop('stone', 3, 3, 10, x - 6, y, 3));
        made.push(await P.drop('steel', 16, 2, 2, x + 2, y - 4, 8, 10, 0, 0));
        made.push(await P.spawn(P.shapes.table(5, 1), x + 3, y + 5, 0.2));
        made.push(await P.drop('brick', 4, 4, 4, x + 3, y + 5, 12, 20, 15, 0));
      } else if (scene === 'beam') {
        // a steel beam across two stone posts, and a heavy block dropped on it
        made.push(await P.drop('stone', 2, 2, 6, x - 7, y, 0.1));
        made.push(await P.drop('stone', 2, 2, 6, x + 7, y, 0.1));
        made.push(await P.drop('steel', 18, 2, 1, x, y, 6.3));
        made.push(await P.drop('concrete', 4, 3, 3, x, y, 14));
      } else if (scene === 'one') {
        const [m, w, d, h, above] = one.split(',');
        made.push(await P.drop(m, +w, +d, +h, x, y, +above));
      } else if (scene === 'cut') {
        // the beam tool held on a steel beam lying on two stone blocks (scripted below)
        made.push(await P.drop('stone', 3, 4, 3, x - 6, y, 0.05));
        made.push(await P.drop('stone', 3, 4, 3, x + 6, y, 0.05));
        made.push(await P.drop('steel', 18, 2, 2, x, y, 3.3));
      } else if (scene === 'ruin' || scene === 'dig') {
        // a block dropped on the map's nearest ruin (it wakes on the hit)
        const core = R.core;
        const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
        const P2 = core.packed;
        let best = null;
        for (let yy = 0; yy < core.dims.h; yy++)
          for (let xx = 0; xx < core.dims.w; xx++) {
            const k = P2.chunkTable[(Math.floor(yy / 16) * P2.chunksX + Math.floor(xx / 16)) * 2 + 1];
            const base = P2.chunkTable[(Math.floor(yy / 16) * P2.chunksX + Math.floor(xx / 16)) * 2] + ((yy % 16) * 16 + (xx % 16)) * k;
            for (let q = 0; q < k; q++) {
              const m = slots[(base + q) * 4 + 2] & 255;
              if (slots[(base + q) * 4 + 1] === 0) break;
              if (m !== 11 && m !== 5) continue;
              const wx = xx + 0.5 + 0.5 * (yy & 1);
              const wy = (yy + 0.5) * 0.8660254;
              const d = Math.hypot(wx - x, wy - y);
              if (!best || d < best[2]) best = [wx, wy, d];
            }
          }
        R.camera.target[0] = best[0];
        R.camera.target[1] = best[1];
        if (scene === 'ruin') made.push(await P.drop('concrete', 4, 4, 4, best[0], best[1], 10));
        else {
          // the ruin woken, then the ground dug out from under it: nothing should hang in the air
          await R.scene.wake(best[0], best[1], -1, 4);
          let k = 0;
          const t = setInterval(() => {
            R.globals.events.push({ kind: 5, x: best[0], y: best[1], z: 2 * 32 + 512, radius: 6, strength: 1 });
            k++;
            if (k > 20) clearInterval(t);
          }, 100);
        }
      } else if (scene === 'fall') {
        // concrete falling: a pillar toppling over and a slab dropped on its edge
        made.push(await P.drop('concrete', 3, 3, 14, x - 5, y, 0.2, 0, 12, 0));
        made.push(await P.drop('concrete', 12, 6, 2, x + 6, y + 2, 16, 30, 35, 10));
        made.push(await P.drop('brick', 5, 5, 5, x - 2, y - 9, 18, 20, 20, 0));
      } else if (scene === 'fine') {
        // mixed resolution (round 49): a steel bar of half-cell voxels across two
        // stone posts with a half-cell brick dropped on it, a half-cell concrete
        // block falling hard, and a whole-cell slab beside it for comparison
        made.push(await P.drop('stone', 2, 2, 4, x - 5, y, 0.1));
        made.push(await P.drop('stone', 2, 2, 4, x + 5, y, 0.1));
        made.push(await P.drop('steel', 24, 2, 2, x, y, 4.2, 0, 0, 0, 0.5));
        made.push(await P.drop('brick', 6, 6, 6, x, y, 12, 0, 0, 0, 0.5));
        made.push(await P.drop('concrete', 8, 8, 8, x - 4, y + 8, 14, 20, 30, 0, 0.5));
        made.push(await P.drop('concrete', 8, 4, 2, x + 5, y + 8, 14, 20, 30, 0));
      } else if (scene === 'mesh') {
        // meshes over bodies (round 49): a steel beam mesh (half-cell lattice)
        // across two posts with a block dropped on it, a concrete rock and a
        // brick crate dropped hard beside them
        const M = R.phys.meshes;
        made.push(await P.drop('stone', 2, 2, 4, x - 5, y, 0.1));
        made.push(await P.drop('stone', 2, 2, 4, x + 5, y, 0.1));
        made.push(await P.dropMesh(M.box(20, 12, 1, 1, 0.5), 0.5, x, y, 4.2));
        made.push(await P.drop('concrete', 3, 3, 3, x, y, 12));
        made.push(await P.dropMesh(M.rock(5, 2.2, 2, 3), 0.5, x - 4, y + 8, 12, 20, 30, 0));
        made.push(await P.dropMesh(M.box(11, 3, 3, 3, 0.5), 0.5, x + 5, y + 8, 14, 20, 30, 10));
      } else if (scene === 'stress') {
        // many bodies at once: the solver's cost
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          const kinds = [['steel', 14, 2, 2], ['stone', 4, 4, 4], ['concrete', 8, 4, 2], ['brick', 6, 2, 5]];
          const [m, w, d, h] = kinds[k % 4];
          made.push(await P.drop(m, w, d, h, x + Math.cos(a) * 14, y + Math.sin(a) * 14, 2 + (k % 6) * 2, k * 37));
        }
      } else if (scene === 'heat') {
        made.push(await P.drop('steel', 18, 2, 2, x, y, 4.1));
      } else if (scene === 'melt') {
        // the beam held on bare ground for 4 s: it melts a pit, the lava runs and sets
        const col = await P.column(x, y);
        const top = col[col.length - 1].z1;
        R.scene.lava.beam = { at: [x, y, top], radius: 1.6, power: 9000 };
        setTimeout(() => (R.scene.lava.beam = null), 4000);
      } else if (scene === 'quench') {
        // a lava pool melted by the beam, then water poured on it: steam
        const col = await P.column(x, y);
        R.scene.lava.beam = { at: [x, y, col[col.length - 1].z1], radius: 2, power: 9000 };
        setTimeout(() => (R.scene.lava.beam = null), 3000);
        let k = 0;
        setTimeout(() => {
          const t = setInterval(() => {
            R.globals.events.push({ kind: 5, x, y, z: 3 * 32 + (k++ === 0 ? 512 : 0), radius: 3, strength: 1 });
            if (k > 40) clearInterval(t);
          }, 50);
        }, 3500);
      } else if (scene === 'volcano') {
        // a vent on open ground, a steel beam and a pond near it
        R.scene.lava.addVent(x, y, 20);
        made.push(await P.drop('steel', 10, 2, 2, x + 4, y - 6, 0.2));
        R.globals.events.push({ kind: 5, x: x - 8, y: y + 4, z: 3 * 32 + 512, radius: 3, strength: 3 });
      } else if (scene === 'meteor') {
        // a meteor on open ground, with blocks round it to be thrown and crumbled
        made.push(await P.drop('concrete', 4, 4, 4, x + 4, y + 2, 0.2));
        made.push(await P.drop('stone', 3, 3, 6, x - 12, y + 6, 0.2));
        made.push(await P.drop('steel', 10, 2, 2, x + 10, y - 9, 0.2));
        const col = await P.column(x, y);
        const top = col[col.length - 1].z1;
        R.scene.meteors.push({ from: [x - 45, y + 35, top + 110], to: [x, y, top + 0.5], t: 0, dur: 1.6 });
      } else if (scene === 'slam') {
        // a wide slab dropped flat on sand: the dust and the air it shoves out
        made.push(await P.drop('concrete', 10, 10, 2, x, y, 10));
        made.push(await P.drop('stone', 3, 3, 8, x - 11, y + 3, 6, 0, 30, 0));
        made.push(await P.drop('brick', 5, 5, 3, x - 4, y - 9, 14, 20));
        // the most air any wind texel was shoved by, and how many shoved
        window.__puff = { max: 0, n: 0 };
        const poll = setInterval(async () => {
          const a = new Uint32Array((await R.core.readBuffer('physPuff')).buffer);
          let m = 0, n = 0;
          for (const v of a) if (v) { n++; m = Math.max(m, v); }
          if (m > window.__puff.max) window.__puff = { max: m / 1000, n };
        }, 30);
        setTimeout(() => clearInterval(poll), 3000);
      } else if (scene === 'sand') {
        // sand poured on a slab and a table: it should lie on them, not fall through
        made.push(await P.drop('concrete', 8, 8, 2, x - 5, y, 0.2));
        made.push(await P.spawn(P.shapes.table(5, 1), x + 5, y, 0.2));
        setTimeout(() => {
          const ev = R.globals.events;
          ev.push({ kind: 5, x: x - 5, y, z: 10 * 32 + 3 + 512, radius: 3, strength: 3 });
          ev.push({ kind: 5, x: x + 5, y, z: 10 * 32 + 3 + 512, radius: 3, strength: 3 });
        }, 1500);
        // then the slab blown away: its sand should fall, not float
        if (blastAt > 0) setTimeout(() => P.physics.blast([x - 5, y, 15], 6, 12), blastAt);
      }
      window.__made = made.filter(Boolean).map((b) => b.id);
      window.__at = [x, y];
      return { at: [x, y], made: made.map((b) => b && { id: b.id, n: b.dims[0] * b.dims[1] * b.dims[2] }) };
    },
    scene,
    zoom,
    one,
    blastAt,
  );
  console.log('setup', JSON.stringify(setup));
  const report = () =>
    page.evaluate(async (scene) => {
      const P = window.reclaimed.phys.physics;
      const X = await P.readPositions();
      let frags = 0;
      for (let i = 0; i < Math.min(P.used, 8192); i++) if (X[i * 8 + 3] >= 0) frags++;
      return [`fragments: ${frags}`].concat(P.bodies.filter((b) => scene === 'ruin' || scene === 'dig' || window.__made.includes(b.id)).map((b) => {
        let n = 0;
        let lo = Infinity;
        let hi = -Infinity;
        let hot = 0;
        for (let i = b.offset; i < b.offset + b.dims[0] * b.dims[1] * b.dims[2]; i++) {
          if (X[i * 8 + 3] < 0) continue;
          n++;
          lo = Math.min(lo, X[i * 8 + 2]);
          hi = Math.max(hi, X[i * 8 + 2]);
          hot = Math.max(hot, X[i * 8 + 7]);
        }
        let pin = 0;
        for (let i = b.offset; i < b.offset + b.dims[0] * b.dims[1] * b.dims[2]; i++) if (X[i * 8 + 3] === 0) pin++;
        return `${b.model?.id ?? 'map'}${b.size !== 1 ? ` (${b.size})` : ''}: ${n} live${pin ? ` (${pin} pinned)` : ''}, z ${lo.toFixed(2)}..${hi.toFixed(2)}${hot > 1 ? `, max temp ${hot.toFixed(0)}` : ''}`;
      }));
    }, scene);
  let t = 0;
  // --gif out.gif: the first --frames × 80 ms after setup, the middle of the view
  const gif = opt('gif', '');
  if (gif) {
    const { GIFEncoder, quantize, applyPalette } = gifenc;
    const enc = GIFEncoder();
    const clip = { x: 350, y: 175, width: 700, height: 500 };
    for (let i = 0, n = Number(opt('frames', '40')); i < n; i++) {
      const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png', clip })));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 80 });
      await new Promise((r) => setTimeout(r, 80));
    }
    enc.finish();
    fs.writeFileSync(gif, enc.bytes());
    console.log('saved', gif);
  }
  for (const s of shots) {
    if (scene === 'cut' && t === 0) {
      // the tool, as a player uses it: select it, hold the mouse on the beam's middle, sweep across it
      await new Promise((r) => setTimeout(r, 800));
      const xy = await page.evaluate(async () => {
        const R = window.reclaimed;
        R.scene.editor.select('beam');
        // the steel's middle voxel, top row
        const P = R.phys.physics;
        const b = P.bodies[window.__made[2]];
        const X = await P.readPositions();
        const i = b.offset + Math.floor(b.dims[0] / 2) + b.dims[0] * b.dims[1];
        return R.camera.project(X[i * 8], X[i * 8 + 1], X[i * 8 + 2] + 0.5);
      });
      await page.mouse.move(xy[0], xy[1]);
      await page.mouse.down();
      // (a drag, not a tap: the beam is a held tool)
      for (let k = 1; k <= 6; k++) await page.mouse.move(xy[0] + k * 2, xy[1]);
      await page.mouse.move(xy[0], xy[1]);
      await new Promise((r) => setTimeout(r, (s - t) * 1000));
    } else if (scene === 'gbeam' && t === 0) {
      // the beam tool held on bare ground, as a player does: it melts a pit
      const xy = await page.evaluate(async () => {
        const R = window.reclaimed;
        R.scene.editor.select('beam');
        const [x, y] = window.__at;
        const c = await R.phys.column(x, y);
        return R.camera.project(x, y, c[c.length - 1].z1);
      });
      await page.mouse.move(xy[0], xy[1]);
      await page.mouse.down();
      for (let k = 1; k <= 6; k++) await page.mouse.move(xy[0] + k * 2, xy[1]);
      await page.mouse.move(xy[0], xy[1]);
      await new Promise((r) => setTimeout(r, (s - t) * 1000));
    } else if (scene === 'heat') {
      // the beam held on the middle of the steel, aimed like the tool's pick:
      // at the highest live voxel near the target, re-aimed every 0.2 s
      const until = Date.now() + (s - t) * 1000;
      while (Date.now() < until) {
        await page.evaluate(async () => {
          const R = window.reclaimed;
          const P = R.phys.physics;
          const X = await P.readPositions();
          // (the bar slides on sloping sand: aim at its middle, top row, wherever it is)
          const b = P.bodies[window.__made[0]];
          const [w, d, h] = b.dims;
          let i = b.offset + Math.floor(w / 2) + w * (d * (h - 1));
          if (X[i * 8 + 3] < 0) i = b.offset + Math.floor(w / 2);
          if (X[i * 8 + 3] < 0) return;
          P.beam = { at: [X[i * 8], X[i * 8 + 1], X[i * 8 + 2] + 0.5], dir: [0, 0, -1], radius: 1.5, power: 1500 };
        });
        await new Promise((r) => setTimeout(r, 200));
      }
    } else await new Promise((r) => setTimeout(r, (s - t) * 1000));
    t = s;
    await page.screenshot({ path: `${out}-${scene}-${String(s).replace('.', '_')}s.png` });
    if ((scene === 'cut' || scene === 'gbeam') && s === shots[shots.length - 2]) await page.mouse.up();
    console.log(`t=${s}s`, (await report()).join(' | '));
    if (scene === 'melt' || scene === 'volcano' || scene === 'quench' || scene === 'gbeam' || scene === 'meteor')
      console.log(
        '  lava',
        await page.evaluate(async () => {
          const [x, y] = window.__at;
          const R = window.reclaimed;
          const L = new Float32Array((await R.core.readBuffer('lava')).buffer);
          let n = 0, vol = 0, tMax = 0, gMax = 0;
          for (let i = 0; i < L.length; i += 4) {
            if (L[i] > 0.02) { n++; vol += L[i]; tMax = Math.max(tMax, L[i + 1]); }
            gMax = Math.max(gMax, L[i + 2]);
          }
          const c = await R.phys.column(x, y);
          return `cols ${n}, volume ${vol.toFixed(1)}, hottest ${tMax.toFixed(0)}, ground heat ${gMax.toFixed(0)} | centre ${c.map((v) => `${v.z0.toFixed(2)}-${v.z1.toFixed(2)} m${v.mat}`).join(', ')}`;
        }),
      );
    if (scene === 'dig')
      console.log(
        '  pinned:',
        await page.evaluate(async () => {
          const R = window.reclaimed;
          const P = R.phys.physics;
          const X = await P.readPositions();
          const out = [];
          for (const b of P.bodies)
            for (let i = b.offset; i < b.offset + b.dims[0] * b.dims[1] * b.dims[2] && out.length < 4; i++)
              if (X[i * 8 + 3] === 0) {
                const c = await R.phys.column(X[i * 8], X[i * 8 + 1]);
                out.push(`z${X[i * 8 + 2].toFixed(2)} over ${c.slice(-2).map((v) => `${v.z0.toFixed(2)}-${v.z1.toFixed(2)} m${v.mat}`).join(',')}`);
              }
          return out.join(' | ');
        }),
      );
    if (scene === 'slam') console.log('  puff', await page.evaluate(() => JSON.stringify(window.__puff)));
    if (scene === 'sand')
      for (const dx of [-5, 5])
        console.log(
          `  column x${dx > 0 ? '+' : ''}${dx}:`,
          await page.evaluate(async (dx) => {
            const [x, y] = window.__at;
            const c = await window.reclaimed.phys.column(x + dx, y);
            return c.map((v) => `${v.z0.toFixed(2)}-${v.z1.toFixed(2)} m${v.mat}`).join(', ');
          }, dx),
        );
    if (scene === 'cut') console.log('  beam', await page.evaluate(() => JSON.stringify(window.reclaimed.phys.physics.beam)), await page.evaluate(() => JSON.stringify(window.reclaimed.scene.beamAt)));
  }
  if (perf) {
    const ms = await page.evaluate(async () => {
      const prof = window.reclaimed.core.host.profiler;
      const sums = {};
      for (let k = 0; k < 120; k++) {
        await new Promise((r) => requestAnimationFrame(r));
        for (const [n, v] of prof.passMs) sums[n] = (sums[n] ?? 0) + v / 120;
      }
      return Object.entries(sums).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, v]) => `${n} ${v.toFixed(2)}`).join(', ');
    });
    console.log('GPU ms:', ms);
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
