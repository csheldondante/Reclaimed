// Round 86: how long the rock takes to react (the user: "There is a large lag from a meteor to when the material is
// destroyed … The actual column has a long delay and then converts to voxels before collapsing"). On the atlas
// level, a stone spire built (the world API), then:
//   meteor — the level's meteor landing at its foot (reclaimed.meteorNow when the build has it, else its crater
//            event pushed as the level's impact does);
//   cut    — a bowl through its middle (the world API's terrain.crater).
// Measured from the moment of the event, frame by frame (rAF): the crater's middle column lower on the GPU (a
// one-column readback a frame), the field mesh's chunk there rebuilt (its record's built hash), the first body
// spawned (integrity stats.bodies), the first body moving; frame times over the 4 s after. --gif out: a GIF of each
// (screenshots a frame apart) instead of the timings.
//   node scripts/latencyprobe.mjs [--url http://localhost:5263] [--q low] [--gif C:/Projects/shots86/after]
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
const extra = opt('extra', '');
const only = opt('only', 'meteor,cut,great').split(',');
const radius = Number(opt('radius', 1.6));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=900,700'],
  defaultViewport: { width: 900, height: 700, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let failed = false;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=${q}&level=atlas${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await sleep(12000);
  // page helpers: a column's top on the GPU (one column read back), the mesh chunk's built hash there
  await p.evaluate(() => {
    const R = window.reclaimed;
    const ROW_H = Math.sqrt(3) / 2;
    const dev = R.core.host.gpu.device;
    const cellOf = (x, y) => {
      const cy = Math.max(0, Math.round(y / ROW_H - 0.5));
      const cx = Math.max(0, Math.round(x - 0.5 - 0.5 * (cy & 1)));
      return [cx, cy];
    };
    // (writes into the layers counted, and the GPU's mesh passes summed, over a watch)
    const q = dev.queue;
    const wb = q.writeBuffer.bind(q);
    window.__writes = 0;
    q.writeBuffer = (b, ...rest) => {
      if (b === R.core.world.layers) window.__writes++;
      return wb(b, ...rest);
    };
    window.__probe = {
      cellOf,
      async gpuTop(x, y) {
        const [cx, cy] = cellOf(x, y);
        const pk = R.core.packed;
        const ci = Math.floor(cy / 16) * pk.chunksX + Math.floor(cx / 16);
        const k = pk.chunkTable[ci * 2 + 1];
        const base = pk.chunkTable[ci * 2] + ((cy % 16) * 16 + (cx % 16)) * k;
        const st = dev.createBuffer({ size: k * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const enc = dev.createCommandEncoder();
        enc.copyBufferToBuffer(R.core.world.layers, base * 16, st, 0, k * 16);
        dev.queue.submit([enc.finish()]);
        await st.mapAsync(GPUMapMode.READ);
        const u = new Uint32Array(st.getMappedRange().slice(0));
        const f = new Float32Array(u.buffer);
        st.destroy();
        let top = 0;
        for (let s = 0; s < k; s++) if (u[s * 4 + 1] !== 0) top = f[s * 4 + 1];
        return top;
      },
      async meshHash(x, y) {
        const fm = R.renderer.fieldMesh;
        const [nx] = fm.chunkGrid;
        const c = Math.floor(y / (32 * ROW_H)) * nx + Math.floor(x / 32);
        const st = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const enc = dev.createCommandEncoder();
        enc.copyBufferToBuffer(fm.state, (16 + c * 13 + 4) * 4, st, 0, 16);
        dev.queue.submit([enc.finish()]);
        await st.mapAsync(GPUMapMode.READ);
        const u = new Uint32Array(st.getMappedRange().slice(0));
        st.destroy();
        return u[1];
      },
      falling() {
        const I = R.integrity?.();
        if (!I) return false;
        if (I.falling) return I.falling.list.some((b) => b.vz < -0.05);
        return I.bodies.list.some((b) => !b.asleep && b.vz < -0.05);
      },
      bodies() {
        return R.integrity?.()?.stats.bodies ?? 0;
      },
    };
  });
  const spire = (side) =>
    p.evaluate(async (side, radius) => {
      const R = window.reclaimed;
      R.stream.auto = false;
      const t = R.api.terrain;
      await t.refresh();
      const [cx, cy] = R.camera.target;
      const x = cx + side;
      const y = cy;
      const z = t.heightAt(x, y);
      for (let k = 0; k < 30; k++) t.build(x, y, 'stone', { radius, layers: 1 });
      R.camera.target = [x, y, z + 10];
      R.camera.zoom = 9;
      return { x, y, z };
    }, side, radius);
  const fire = (name, a) =>
    p.evaluate(
      async (name, a) => {
        const R = window.reclaimed;
        const t = R.api.terrain;
        await t.refresh();
        const top = t.heightAt(a.x, a.y);
        if (name === 'cut') {
          a.cx = a.x;
          a.cy = a.y;
          a.cz = a.z + (top - a.z) * 0.45;
          t.crater(a.x, a.y, { radius: (a.r ?? 1.6) > 2 ? a.r * 1.5 : 1.6, z: a.cz });
        } else if (name === 'meteor') {
          a.cx = a.x + 4;
          a.cy = a.y;
          if (R.meteorNow) R.meteorNow(a.cx, a.cy, a.z + 1);
          else R.core.globals.events.push({ kind: 5, x: a.cx, y: a.cy, z: 13 * 32 + 512, radius: 30, strength: a.z + 1 });
        } else {
          // the atlas's great meteor (the touch button's), at the window cell under the spire's foot
          a.cx = a.x;
          a.cy = a.y;
          const [gx, gy] = window.__probe.cellOf(a.x, a.y);
          R.coarse.meteor(gx, gy);
        }
        window.__t0 = performance.now();
        return a;
      },
      name,
      a,
    );
  const watch = (a, before) =>
    p.evaluate(
      (a, before) =>
        new Promise((done) => {
          const P = window.__probe;
          const t0 = window.__t0;
          const out = { deleted: null, meshed: null, spawned: null, falling: null, ft: [] };
          const b0 = P.bodies();
          window.__writes = 0;
          const prof = window.reclaimed.core.host.profiler;
          prof.resetTotals?.();
          let maxWrites = 0;
          let lastW = 0;
          let last = performance.now();
          let pending = 0;
          const f = (now) => {
            out.ft.push(now - last);
            maxWrites = Math.max(maxWrites, window.__writes - lastW);
            lastW = window.__writes;
            last = now;
            const at = now - t0;
            if ((out.deleted === null || out.meshed === null) && pending < 3) {
              pending++;
              P.gpuTop(a.cx, a.cy).then((top) => {
                pending--;
                if (out.deleted === null && top < before.top - 0.5) out.deleted = Math.round(at);
              });
              P.meshHash(a.cx, a.cy).then((h) => {
                if (out.meshed === null && h !== before.hash) out.meshed = Math.round(at);
              });
            }
            if (out.spawned === null && P.bodies() > b0) out.spawned = Math.round(at);
            if (out.falling === null && P.falling()) out.falling = Math.round(at);
            if (at < 4000) requestAnimationFrame(f);
            else {
              const s = [...out.ft].sort((x, y) => x - y);
              out.p50 = +s[Math.floor(0.5 * (s.length - 1))].toFixed(1);
              out.p95 = +s[Math.floor(0.95 * (s.length - 1))].toFixed(1);
              out.worst = +s[s.length - 1].toFixed(1);
              out.frames = s.length;
              delete out.ft;
              out.stats = window.reclaimed.integrity?.()?.stats;
              out.editLiveMs = window.reclaimed.editLiveMs?.();
              out.layerWrites = window.__writes;
              out.fallingNow = (window.reclaimed.integrity?.()?.falling?.list ?? []).map((b) => [b.cols.length, +b.dz.toFixed(2), +b.vz.toFixed(2), +b.age.toFixed(1)]);
              out.maxWritesFrame = maxWrites;
              const mesh = {};
              for (const [k, v] of prof.totalMs ?? []) if (k.includes('fieldmesh')) mesh[k] = +v.toFixed(1);
              for (const [k, v] of prof.maxMs ?? []) if (k.includes('fieldmesh-sample') || k.includes('fieldmesh-verts')) mesh['max ' + k] = +v.toFixed(2);
              out.mesh = mesh;
              out.timing = window.reclaimed.integrity?.()?.timing;
              done(out);
            }
          };
          requestAnimationFrame(f);
        }),
      a,
      before,
    );
  let side = -14;
  for (const name of only) {
    const a = await spire(side);
    a.r = radius;
    side += 14;
    await sleep(6000);
    // (the crater's middle as it'll be: measured before)
    const probeAt = name === 'meteor' ? { cx: a.x + 4, cy: a.y } : { cx: a.x, cy: a.y };
    const before = await p.evaluate(async (c) => ({ top: await window.__probe.gpuTop(c.cx, c.cy), hash: await window.__probe.meshHash(c.cx, c.cy) }), probeAt);
    if (gif) {
      const enc = GIFEncoder();
      const shots = [];
      shots.push(await p.screenshot({ type: 'png' }));
      await fire(name, a);
      const t0 = Date.now();
      while (Date.now() - t0 < 4500) shots.push(await p.screenshot({ type: 'png' }));
      for (const s of shots) {
        const png = PNG.sync.read(Buffer.from(s));
        const pal = quantize(png.data, 256);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: Math.round(4500 / shots.length) });
      }
      enc.finish();
      fs.writeFileSync(`${gif}-${name}.gif`, enc.bytes());
      console.log('saved', `${gif}-${name}.gif`, shots.length, 'frames');
      await sleep(3000);
      continue;
    }
    const at = await fire(name, a);
    const r = await watch(at, before);
    console.log(name, JSON.stringify({ q, ...r, before }));
    await sleep(2000);
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
