// Round 88 sweep (the user, on the phone: "It still fails to make some unsupported structures wake up and fall
// though. So worth testing on a wider column and seeing if only parts of it fall"; "first step is fixing the
// floating rocks"). On the atlas level at the phone tier (q=low, the hybrid on, 412×915), structures are written
// into the window's columns — towers and slabs 3..16 columns across and 10..100 tall, banded with soil and
// concrete as the atlas's forms are, overhangs, arches, bridges — some by the camera (voxel chunks), some far from
// it (heightfield chunks); then cut partly and fully, by each tool (the break tool's events, the meteor tool, the
// world API's crater (a tank's, a hero's shot), a take, a dig, the heat beam, a great meteor). When it has all come
// down, the whole window's columns are read back and every run with something solid in it and no way to the ground
// is counted — a flood from the ground over the runs that overlap (this script's own, not the game's) — and must
// be none (any there before the sweep began are reported, and counted against it too).
//   node scripts/floatsweep.mjs [--url http://localhost:5271] [--only a,b] [--gif out.gif --gifcase name]
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
const url = opt('url', 'http://localhost:5271');
const gif = opt('gif', '');
const gifCase = opt('gifcase', 'wide-banded-taps');
const only = opt('only', '');
// (--where near|far: every case by the camera, or every one far from it)
const where = opt('where', '');
// (--linger s: each case looked at again that long after it settled — what floats later, and its column)
const linger = Number(opt('linger', 0));

// cases: shape, where (dx, dy from the camera's target: |d| > 40 is a heightfield chunk), how it's cut
// shape: tower {w, h, bands?: [[mat, every, thick]], mat}, slab {w, h, neck, neckH}, bridge {span, h, deck},
//        arm {w, h, reach}, arch {span, h}
// cut: {tool: 'smash'|'meteor'|'crater'|'take'|'dig'|'beam'|'tap'|'great', part: 'full'|'half'|'one'|'both', at: z above the ground}
const CASES = [];
for (const w of [3, 6, 10, 16])
  for (const h of [10, 40, 100]) CASES.push({ name: `tower-w${w}-h${h}`, shape: { kind: 'tower', w, h, mat: 'stone' }, cut: { tool: 'smash', part: 'full', at: 3 } });
CASES.push({ name: 'tower-w10-half', shape: { kind: 'tower', w: 10, h: 40, mat: 'stone' }, cut: { tool: 'smash', part: 'half', at: 3 } });
CASES.push({ name: 'tower-w16-half', shape: { kind: 'tower', w: 16, h: 60, mat: 'stone' }, cut: { tool: 'smash', part: 'half', at: 4 } });
CASES.push({ name: 'banded-w8', shape: { kind: 'tower', w: 8, h: 50, mat: 'stone', bands: [['soil', 9, 1], ['concrete', 13, 2]] }, cut: { tool: 'smash', part: 'full', at: 3 } });
CASES.push({ name: 'banded-w14', shape: { kind: 'tower', w: 14, h: 70, mat: 'sandstone', bands: [['soil', 7, 1], ['sand', 11, 1]] }, cut: { tool: 'smash', part: 'full', at: 3 } });
CASES.push({ name: 'concrete-w6', shape: { kind: 'tower', w: 6, h: 30, mat: 'concrete' }, cut: { tool: 'smash', part: 'full', at: 3 } });
CASES.push({ name: 'stone-on-concrete', shape: { kind: 'tower', w: 8, h: 40, mat: 'stone', bands: [['concrete', 1000, 6]], bandAt: 2 }, cut: { tool: 'smash', part: 'full', at: 4 } });
CASES.push({ name: 'slab-w16-neck3', shape: { kind: 'slab', w: 16, h: 4, neck: 3, neckH: 12, mat: 'stone' }, cut: { tool: 'smash', part: 'full', at: 4 } });
CASES.push({ name: 'slab-w12-neck1-take', shape: { kind: 'slab', w: 12, h: 3, neck: 1, neckH: 8, mat: 'stone', neckMat: 'sandstone' }, cut: { tool: 'take', part: 'full', at: 0 } });
CASES.push({ name: 'bridge-one', shape: { kind: 'bridge', span: 12, h: 18, deck: 3, mat: 'stone' }, cut: { tool: 'smash', part: 'one', at: 3 } });
CASES.push({ name: 'bridge-both', shape: { kind: 'bridge', span: 14, h: 18, deck: 3, mat: 'stone' }, cut: { tool: 'smash', part: 'both', at: 3 } });
CASES.push({ name: 'arch', shape: { kind: 'arch', span: 12, h: 20, mat: 'sandstone' }, cut: { tool: 'smash', part: 'both', at: 3 } });
CASES.push({ name: 'arm-dig', shape: { kind: 'arm', w: 4, h: 20, reach: 9, mat: 'stone' }, cut: { tool: 'dig', part: 'full', at: 0 } });
CASES.push({ name: 'tower-meteor', shape: { kind: 'tower', w: 6, h: 40, mat: 'stone' }, cut: { tool: 'meteor', part: 'full', at: 1 } });
CASES.push({ name: 'tower-crater-api', shape: { kind: 'tower', w: 10, h: 40, mat: 'stone' }, cut: { tool: 'crater', part: 'full', at: 1 } });
CASES.push({ name: 'wide-banded-taps', shape: { kind: 'tower', w: 12, h: 45, mat: 'stone', bands: [['soil', 8, 1]] }, cut: { tool: 'tap', part: 'full', at: 2 }, near: true });
CASES.push({ name: 'tower-beam', shape: { kind: 'tower', w: 3, h: 20, mat: 'stone' }, cut: { tool: 'beam', part: 'full', at: 2 }, near: true });
CASES.push({ name: 'great-meteor', shape: { kind: 'tower', w: 8, h: 40, mat: 'stone', bands: [['soil', 9, 1]] }, cut: { tool: 'great', part: 'full', at: 0 } });
const cases = only ? CASES.filter((c) => only.split(',').includes(c.name)) : CASES;

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
  protocolTimeout: 900000,
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
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&hybrid=1&level=atlas`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimed?.integrity?.(), { timeout: 240000 });
  await sleep(30000);
  // the helpers: the window's columns read and written, the ground-truth scan
  await p.evaluate(async () => {
    const R = window.reclaimed;
    // (round 92: the streamer left on, as on the phone — the camera stays within its reach; a slide moves the sites:
    // they're counted, stream.stats.slides)
    const { MATERIALS, MatState, MAT } = await import('/src/world/materials.ts');
    const L = await import('/src/world/lattice.ts');
    const pk = R.core.packed;
    const { w: W, h: H, zMax } = R.core.dims;
    const slotOf = (x, y) => {
      const ci = Math.floor(y / 16) * pk.chunksX + Math.floor(x / 16);
      const k = pk.chunkTable[ci * 2 + 1];
      return [pk.chunkTable[ci * 2] + ((y % 16) * 16 + (x % 16)) * k, k];
    };
    const F = {
      W,
      H,
      zMax,
      MAT,
      slots: null,
      async snap() {
        const f = await R.readBuffer('layers');
        F.slots = new Uint32Array(f.buffer, f.byteOffset, f.byteLength / 4);
        F.f32 = new Float32Array(F.slots.buffer, F.slots.byteOffset, F.slots.length);
      },
      col(x, y) {
        const [b, k] = slotOf(x, y);
        const out = [];
        for (let s = 0; s < k; s++) {
          const o = (b + s) * 4;
          if (F.slots[o + 1] === 0) break;
          out.push({ z0: F.f32[o], z1: F.f32[o + 1], mat: F.slots[o + 2] & 255, aux: (F.slots[o + 2] >>> 8) & 255 });
        }
        return out;
      },
      top(x, y) {
        const c = F.col(x, y);
        return c.length ? c[c.length - 1].z1 : 0;
      },
      /** column (x, y) with [z0, z1) of mat in it (what was there replaced), written to the GPU */
      put(x, y, z0, z1, mat) {
        if (x < 0 || y < 0 || x >= W || y >= H) return false;
        z1 = Math.min(z1, zMax - 0.5);
        if (z1 <= z0) return true;
        const col = [];
        for (const iv of F.col(x, y)) {
          if (iv.z1 <= z0 || iv.z0 >= z1) col.push(iv);
          else {
            if (iv.z0 < z0) col.push({ ...iv, z1: z0 });
            if (iv.z1 > z1) col.push({ ...iv, z0: z1 });
          }
        }
        col.push({ z0, z1, mat, aux: 15 << 4 });
        col.sort((a, b) => a.z0 - b.z0);
        // touching runs of one material: one
        const m = [];
        for (const iv of col) {
          const l = m[m.length - 1];
          if (l && l.mat === iv.mat && Math.abs(l.z1 - iv.z0) < 1e-4) l.z1 = iv.z1;
          else m.push({ ...iv });
        }
        const [b, k] = slotOf(x, y);
        if (m.length > k) return false;
        const data = new Uint32Array(k * 4);
        const df = new Float32Array(data.buffer);
        m.forEach((iv, s) => {
          df[s * 4] = iv.z0;
          df[s * 4 + 1] = iv.z1;
          data[s * 4 + 2] = (iv.mat & 255) | ((iv.aux ?? 0) << 8);
        });
        F.slots.set(data, b * 4);
        const dev = R.core.host.gpu.device;
        for (const buf of [R.core.world.layers, R.core.world.layersNext]) if (buf) dev.queue.writeBuffer(buf, b * 16, data);
        return true;
      },
      /** the cells whose centres lie within r of world point (wx, wy) */
      disc(wx, wy, r) {
        const out = [];
        const [c0x, c0y] = L.cellAt(wx - r - 1, wy - r - 1);
        const [c1x, c1y] = L.cellAt(wx + r + 1, wy + r + 1);
        for (let y = Math.max(0, c0y); y <= Math.min(H - 1, c1y); y++)
          for (let x = Math.max(0, c0x); x <= Math.min(W - 1, c1x); x++) {
            const [px, py] = L.cellPos(x, y);
            if (Math.hypot(px - wx, py - wy) <= r) out.push([x, y, px, py]);
          }
        return out;
      },
      cellPos: L.cellPos,
      cellAt: L.cellAt,
      /**
       * The ground truth: the window's runs (touching intervals, anything but air and liquid), a flood from every
       * run on the window's floor and every run of the edge columns through runs of neighbouring columns that
       * overlap by half a cell in what holds sideways (solid, plants) — what's left with something solid floats.
       */
      async scan() {
        await F.snap();
        const state = (m) => MATERIALS[m]?.state;
        const side = (m) => state(m) === MatState.Solid || state(m) === MatState.Vegetation;
        const runs = new Array(W * H);
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            const rs = [];
            let last = null;
            for (const iv of F.col(x, y)) {
              const st = state(iv.mat);
              if (st === MatState.Empty || st === MatState.Liquid || st === undefined) {
                last = null;
                continue;
              }
              if (last && iv.z0 <= last.z1 + 0.02) {
                last.z1 = Math.max(last.z1, iv.z1);
                last.ivs.push(iv);
              } else rs.push((last = { x, y, z0: iv.z0, z1: iv.z1, ivs: [iv], ok: false }));
            }
            runs[y * W + x] = rs;
          }
        const q = [];
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++)
            for (const r of runs[y * W + x])
              if (r.z0 < 1e-3 || x === 0 || y === 0 || x === W - 1 || y === H - 1) {
                r.ok = true;
                q.push(r);
              }
        // (round 92: touching face to face — by half a cell, or half the thinner one's thickness: fracture.ts touch)
        const touch = (p0, p1, q0, q1) => {
          const o = Math.min(p1, q1) - Math.max(p0, q0);
          return o > 1e-3 && o >= Math.min(0.5, 0.5 * Math.min(p1 - p0, q1 - q0));
        };
        const holds = (a, b) => {
          if (Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) <= 1e-3) return false;
          for (const i of a.ivs) if (side(i.mat)) for (const j of b.ivs) if (side(j.mat) && touch(i.z0, i.z1, j.z0, j.z1)) return true;
          return false;
        };
        for (let h = 0; h < q.length; h++) {
          const r = q[h];
          for (let k = 0; k < 6; k++) {
            const [nx, ny] = L.nbr(r.x, r.y, k);
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            for (const o of runs[ny * W + nx])
              if (!o.ok && holds(o, r)) {
                o.ok = true;
                q.push(o);
              }
          }
        }
        const out = [];
        for (const rs of runs)
          for (const r of rs) {
            const solid = r.ivs.find((iv) => state(iv.mat) === MatState.Solid);
            if (!r.ok && solid) {
              const [px, py] = L.cellPos(r.x, r.y);
              out.push({ x: r.x, y: r.y, px: +px.toFixed(1), py: +py.toFixed(1), z0: +r.z0.toFixed(2), z1: +r.z1.toFixed(2), mat: MATERIALS[solid.mat].name });
            }
          }
        return out;
      },
      /** quiet: nothing falling, nothing waiting to be judged */
      quiet() {
        const I = R.integrity();
        return !I.falling.list.length && !(I.watches?.length) && !I.rockSeeds.size && !I.dirty.length && !I.busy && !R.core.globals.events.length;
      },
    };
    window.__fs = F;
  });
  const settle = async (ms = 20000) => {
    const t0 = Date.now();
    let quietSince = 0;
    while (Date.now() - t0 < ms) {
      const q = await p.evaluate(() => window.__fs.quiet());
      if (q) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince > 2500) return Date.now() - t0;
      } else quietSince = 0;
      await sleep(250);
    }
    return null;
  };
  const before = await p.evaluate(() => window.__fs.scan());
  console.log(`before the sweep: ${before.length} floating run(s)${before.length ? ': ' + JSON.stringify(before.slice(0, 8)) : ''}`);
  const target = await p.evaluate(() => window.reclaimed.camera.target.slice(0, 2));
  // sites: near (within the hybrid's 40 of the focus) and far (heightfield chunks)
  const far = [];
  for (let r = 70; r <= 110; r += 40) for (let a = 0; a < 12; a++) far.push([Math.cos((a / 12) * Math.PI * 2) * r, Math.sin((a / 12) * Math.PI * 2) * r * 0.9]);
  const near = [[-18, 0], [18, 0], [0, 20]];
  let fi = 0;
  let ni = 0;
  const results = [];
  for (const c of cases) {
    const isNear = where ? where === 'near' : !!c.near;
    const off = isNear ? near[ni++ % near.length] : far[fi++ % far.length];
    const site = [target[0] + off[0], target[1] + off[1]];
    // build it
    const built = await p.evaluate(
      async (c, site) => {
        const F = window.__fs;
        const R = window.reclaimed;
        await F.snap();
        const s = c.shape;
        const MAT = F.MAT;
        const m = MAT[s.mat[0].toUpperCase() + s.mat.slice(1)];
        const [sx, sy] = site;
        const foot = [];
        const R0 = s.kind === 'tower' || s.kind === 'arm' ? s.w / 2 : s.kind === 'slab' ? s.w / 2 : s.span / 2 + 3;
        for (const [x, y] of F.disc(sx, sy, R0 + 2)) foot.push(F.top(x, y));
        const G = Math.max(...foot);
        let bad = 0;
        const banded = (x, y, z0, z1) => {
          if (!F.put(x, y, z0, z1, m)) bad++;
          for (const [bm, every, thick] of s.bands ?? []) {
            const mm = MAT[bm[0].toUpperCase() + bm.slice(1)];
            for (let z = G + (s.bandAt ?? every); z + thick <= z1 - 1; z += every) if (z >= z0) F.put(x, y, z, z + thick, mm);
          }
        };
        const zTop = Math.min(G + (s.h ?? 0), F.zMax - 2);
        const cells = [];
        if (s.kind === 'tower') for (const [x, y] of F.disc(sx, sy, s.w / 2)) banded(x, y, F.top(x, y) > G + 1 ? G : Math.min(F.top(x, y), G), zTop), cells.push([x, y]);
        if (s.kind === 'slab') {
          const nm = s.neckMat ? MAT[s.neckMat[0].toUpperCase() + s.neckMat.slice(1)] : m;
          const nk = s.neck <= 1 ? [F.cellAt(sx, sy)] : F.disc(sx, sy, s.neck / 2);
          for (const [x, y] of nk) F.put(x, y, Math.min(F.top(x, y), G), G + s.neckH, nm), cells.push([x, y]);
          for (const [x, y] of F.disc(sx, sy, s.w / 2)) F.put(x, y, G + s.neckH, G + s.neckH + s.h, m), cells.push([x, y]);
        }
        if (s.kind === 'bridge' || s.kind === 'arch') {
          const pil = s.kind === 'arch' ? 2.5 : 1.8;
          for (const dx of [-s.span / 2, s.span / 2]) for (const [x, y] of F.disc(sx + dx, sy, pil)) banded(x, y, Math.min(F.top(x, y), G), G + s.h), cells.push([x, y]);
          // the deck (an arch: thicker over the pillars, thin in the middle)
          for (let wx = sx - s.span / 2; wx <= sx + s.span / 2; wx += 0.5)
            for (const [x, y, px] of F.disc(wx, sy, 1.6)) {
              const t = s.kind === 'arch' ? 2 + 4 * Math.pow(Math.abs(px - sx) / (s.span / 2), 2) : s.deck;
              F.put(x, y, G + s.h - t, G + s.h, m);
              cells.push([x, y]);
            }
        }
        if (s.kind === 'arm') {
          for (const [x, y] of F.disc(sx, sy, s.w / 2)) banded(x, y, Math.min(F.top(x, y), G), G + s.h), cells.push([x, y]);
          for (let wx = sx; wx <= sx + s.w / 2 + s.reach; wx += 0.5) for (const [x, y] of F.disc(wx, sy, 1.2)) F.put(x, y, G + s.h - 3, G + s.h, m), cells.push([x, y]);
        }
        // (the chunks there: voxels or a heightfield — the hybrid's choice now)
        const hy = R.hybrid ?? null;
        return { G, zTop, bad, n: cells.length };
      },
      c,
      site,
    );
    await sleep(600);
    const s = c.shape;
    const G = built.G;
    // cut it
    const cutInfo = await p.evaluate(
      async (c, site, G) => {
        const F = window.__fs;
        const R = window.reclaimed;
        const s = c.shape;
        const [sx, sy] = site;
        const z = G + c.cut.at;
        const ev = R.core.globals.events;
        const smash = (x, y, z, r = 2.5) => ev.push({ kind: 5, x, y, z: 12 * 32, radius: r, strength: z });
        // the cross-section to cut: centres and its radius
        let parts = [];
        if (s.kind === 'tower') parts = [[sx, sy, s.w / 2 + 0.8]];
        if (s.kind === 'slab') parts = [[sx, sy, Math.max(0.6, s.neck / 2) + 0.8]];
        if (s.kind === 'arm') parts = [[sx, sy, s.w / 2 + 0.8]];
        if (s.kind === 'bridge' || s.kind === 'arch') {
          const pil = (s.kind === 'arch' ? 2.5 : 1.8) + 0.8;
          parts = c.cut.part === 'one' ? [[sx - s.span / 2, sy, pil]] : [[sx - s.span / 2, sy, pil], [sx + s.span / 2, sy, pil]];
        }
        let n = 0;
        const t = c.cut.tool;
        if (t === 'smash') {
          for (const [cx, cy, r] of parts)
            for (let dy = -r; dy <= r + 1e-6; dy += 1.6)
              for (let dx = -r; dx <= r + 1e-6; dx += 1.6) {
                if (Math.hypot(dx, dy) > r + 0.8) continue;
                if (c.cut.part === 'half' && dx > 0) continue;
                smash(cx + dx, cy + dy, z);
                n++;
              }
        } else if (t === 'meteor') {
          R.meteorNow(sx + s.w / 2 + 3, sy, z);
          n = 1;
        } else if (t === 'crater') {
          R.api.terrain.crater(sx + s.w / 2 + 1, sy, { radius: 4, z });
          n = 1;
        } else if (t === 'take') {
          // the neck taken from its top to the ground, a take at a time (each the whole top interval: the slab first)
          const [x, y] = F.cellAt(sx, sy);
          const [px, py] = F.cellPos(x, y);
          for (let k = 0; k < 3; k++) await R.api.terrain.take(px, py, 100);
          n = 3;
        } else if (t === 'dig') {
          R.api.terrain.dig(sx, sy, { radius: s.w / 2 + 0.6, layers: 6 });
          n = 1;
        } else if (t === 'great') {
          R.coarse.meteor(sx + 20, sy, 30);
          n = 1;
        }
        return { n };
      },
      c,
      site,
      G,
    );
    // the player's own taps (the break tool, the heat beam): through the pointer, the camera on it
    const shots = [];
    const grab = async () => {
      if (gif && c.name === gifCase) shots.push(await p.screenshot({ type: 'png' }));
    };
    if (c.cut.tool === 'tap' || c.cut.tool === 'beam') {
      await p.evaluate((site, G) => {
        const R = window.reclaimed;
        R.camera.target = [site[0], site[1], G + 10];
        R.camera.zoom = 6;
      }, site, G);
      await sleep(2500);
      await grab();
      await p.evaluate((tool) => window.reclaimed.editor().select(tool === 'tap' ? 'smash' : 'beam'), c.cut.tool);
      // taps round the tower's foot until the whole cross-section is gone (as a player does: on what's left)
      const R0 = s.w / 2;
      if (c.cut.tool === 'tap') {
        const pts = [];
        for (let dy = -R0; dy <= R0; dy += 1.7) for (let dx = -R0; dx <= R0; dx += 1.7) if (Math.hypot(dx, dy) <= R0 + 0.5) pts.push([dx, dy]);
        // (the pick finds what's in front: the editor's own path — a press at the projection of each point)
        for (const [dx, dy] of pts) {
          const xy = await p.evaluate((site, G, dx, dy, at) => window.reclaimed.camera.project(site[0] + dx, site[1] + dy, G + at), site, G, dx, dy, c.cut.at);
          await p.mouse.click(xy[0], xy[1]);
          await sleep(120);
          await grab();
        }
      } else {
        const xy = await p.evaluate((site, G, at) => window.reclaimed.camera.project(site[0], site[1] - 1.5, G + at), site, G, c.cut.at);
        await p.mouse.move(xy[0], xy[1]);
        await p.mouse.down();
        for (let k = 0; k < 24; k++) {
          await sleep(250);
          await p.mouse.move(xy[0] + ((k % 3) - 1) * 4, xy[1]);
        }
        await p.mouse.up();
      }
      await p.evaluate(() => window.reclaimed.editor().select('wind'));
    }
    const t0 = Date.now();
    if (shots.length || (gif && c.name === gifCase)) while (Date.now() - t0 < 6000) await grab();
    const settled = await settle(c.cut.tool === 'great' ? 40000 : 25000);
    // (did the cut reach the ground: the site's middle column now, as runs)
    const mid = await p.evaluate(async (site) => {
      const F = window.__fs;
      await F.snap();
      const [x, y] = F.cellAt(site[0], site[1]);
      return F.col(x, y).map((iv) => `${iv.z0.toFixed(1)}-${iv.z1.toFixed(1)}:${iv.mat}`).join(' ');
    }, site);
    const out = await p.evaluate(async () => {
      const F = window.__fs;
      const I = window.reclaimed.integrity();
      return { floating: await F.scan(), stats: { ...I.stats }, slides: window.reclaimed.stream.stats.slides + window.reclaimed.stream.stats.tiers };
    });
    // what floats round this site (and anywhere new)
    const mine = out.floating.filter((f) => Math.hypot(f.px - site[0], f.py - site[1]) < 40);
    const ok = mine.length === 0;
    if (!ok) fails++;
    results.push({ name: c.name, ok, mine: mine.length });
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${c.name} at (${site.map((v) => v.toFixed(0)).join(', ')}) ${isNear ? 'near' : 'far'}: ground ${G.toFixed(1)}, top ${built.zTop.toFixed(1)}, ${built.n} cells${built.bad ? `, ${built.bad} unwritten` : ''}; cut ${c.cut.tool} ${c.cut.part} (${cutInfo.n}); settled ${settled === null ? 'NO' : settled + ' ms'}; floating here ${mine.length}${mine.length ? ' ' + JSON.stringify(mine.slice(0, 4)) : ''}; window ${out.floating.length}; pieces ${out.stats.bodies}, crumbled ${out.stats.crumbled}, rereads ${out.stats.rereads ?? '-'}, slides ${out.slides}, last pass ${out.stats.lastMs.toFixed(1)} ms; middle now [${mid}]`,
    );
    if (linger) {
      await sleep(linger * 1000);
      const later = (await p.evaluate(() => window.__fs.scan())).filter((f) => Math.hypot(f.px - site[0], f.py - site[1]) < 40);
      const col = later.length ? await p.evaluate((x, y) => window.__fs.col(x, y).map((iv) => `${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}:${iv.mat}`).join(' '), later[0].x, later[0].y) : '';
      console.log(`  ${linger} s later: floating here ${later.length}${later.length ? ` e.g. ${JSON.stringify(later[0])} in [${col}]` : ''}`);
      if (later.length) fails++;
    }
    if (shots.length) {
      const enc = GIFEncoder();
      for (const sh of shots) {
        const png = PNG.sync.read(Buffer.from(sh));
        const pal = quantize(png.data, 256);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 90 });
      }
      enc.finish();
      fs.writeFileSync(gif, enc.bytes());
      console.log('saved', gif, shots.length, 'frames');
    }
  }
  await settle(15000);
  const end = await p.evaluate(() => window.__fs.scan());
  console.log(`after the sweep: ${end.length} floating run(s) in the window`);
  // (grouped by where they are, each group's first column as it is)
  const groups = new Map();
  for (const f of end) {
    const k = `${Math.round(f.px / 20) * 20},${Math.round(f.py / 20) * 20}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  for (const [k, fs] of groups) {
    const col = await p.evaluate((x, y) => window.__fs.col(x, y).map((iv) => `${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}:${iv.mat}`).join(' '), fs[0].x, fs[0].y);
    console.log(`  near ${k}: ${fs.length} run(s), ${[...new Set(fs.map((f) => f.mat))].join('/')}, e.g. ${JSON.stringify(fs[0])} in [${col}]`);
  }
  if (end.length) fails++;
} finally {
  await browser.close();
}
console.log(fails || pageErrors ? `floatsweep: ${fails} failed, ${pageErrors} page errors` : 'floatsweep: all passed');
process.exit(fails || pageErrors ? 1 : 0);
