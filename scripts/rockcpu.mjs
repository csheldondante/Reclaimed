// Round 88: the floating-rock judge (fracture.ts analyseRock) against the ground truth (floatingRuns), on the CPU
// alone — no browser. A small world of stone ground gets random towers (3..16 across, 10..100 tall, banded with
// soil, sand and concrete), slabs on necks, bridges and arms; then random cuts (spheres taken out, as the break
// tool's and the meteor's are). After each cut what analyseRock is given (the cut columns, then the columns of what
// fell or crumbled, until nothing more goes) must leave no run with something solid and no way to the ground.
//   node scripts/rockcpu.mjs [--seed 1] [--trials 40] [--cuts 30] [--judge /@fs/C:/path/to/old/fracture.ts]
import { createServer } from 'vite';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let fails = 0;
try {
  const F = await server.ssrLoadModule('/src/game/fracture.ts');
  // (--judge <path to another fracture.ts>: its analyseRock judged against this one's ground truth — e.g. round 87's)
  const ji = argv.indexOf('--judge');
  const J = ji >= 0 ? await server.ssrLoadModule(argv[ji + 1]) : F;
  const Lay = await server.ssrLoadModule('/src/world/layout.ts');
  const { MAT } = await server.ssrLoadModule('/src/world/materials.ts');
  const L = await server.ssrLoadModule('/src/world/lattice.ts');
  let seed = opt('seed', 1);
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const W = 64;
  const H = 64;
  const Z = 128;
  const trials = opt('trials', 40);
  const cutsPer = opt('cuts', 30);
  let pieces = 0;
  let crumbled = 0;
  let maxMs = 0;
  for (let t = 0; t < trials; t++) {
    const g = new Lay.ColumnGrid({ w: W, h: H, zMax: Z });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g.push(x, y, 0, 10 + Math.floor(rnd() * 3), MAT.Stone);
    const pk = Lay.packColumns(g, 14);
    const world = new F.WorldVox(pk, pk.slots);
    const col = (x, y) => Lay.readColumn(pk, pk.slots, x, y);
    const write = (x, y, c) => {
      const { base, k } = Lay.columnSlots(pk, x, y);
      if (c.length > k) return false;
      pk.slots.set(Lay.packColumn(c, k), base * 4);
      return true;
    };
    const put = (x, y, z0, z1, mat) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      z1 = Math.min(z1, Z - 1);
      if (z1 <= z0) return;
      const c = [];
      for (const iv of col(x, y)) {
        if (iv.z1 <= z0 || iv.z0 >= z1) c.push(iv);
        else {
          if (iv.z0 < z0) c.push({ ...iv, z1: z0 });
          if (iv.z1 > z1) c.push({ ...iv, z0: z1 });
        }
      }
      c.push({ z0, z1, mat });
      c.sort((a, b) => a.z0 - b.z0);
      const m = [];
      for (const iv of c) {
        const l = m[m.length - 1];
        if (l && l.mat === iv.mat && Math.abs(l.z1 - iv.z0) < 1e-4) l.z1 = iv.z1;
        else m.push({ ...iv });
      }
      write(x, y, m);
    };
    const top = (x, y) => {
      const c = col(x, y);
      return c.length ? c[c.length - 1].z1 : 0;
    };
    const disc = (wx, wy, r) => {
      const out = [];
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const [px, py] = L.cellPos(x, y);
          if (Math.hypot(px - wx, py - wy) <= r) out.push([x, y]);
        }
      return out;
    };
    // structures
    const n = 3 + Math.floor(rnd() * 4);
    for (let s = 0; s < n; s++) {
      const cx = 8 + rnd() * (W - 16);
      const cy = 8 + rnd() * (H * 0.866 - 16);
      const kind = Math.floor(rnd() * 4);
      const w = 3 + Math.floor(rnd() * 14);
      const h = 10 + Math.floor(rnd() * 90);
      const mat = rnd() < 0.2 ? MAT.Concrete : rnd() < 0.5 ? MAT.Sandstone : MAT.Stone;
      const band = rnd() < 0.5 ? [rnd() < 0.5 ? MAT.Soil : MAT.Concrete, 5 + Math.floor(rnd() * 10)] : null;
      const tower = (x, y, z0, z1) => {
        put(x, y, z0, z1, mat);
        if (band) for (let z = z0 + band[1]; z < z1 - 1; z += band[1]) put(x, y, z, z + 1, band[0]);
      };
      if (kind === 0) for (const [x, y] of disc(cx, cy, w / 2)) tower(x, y, top(x, y), 12 + h);
      if (kind === 1) {
        const nh = 6 + Math.floor(rnd() * 14);
        for (const [x, y] of disc(cx, cy, 1 + rnd() * 2)) tower(x, y, top(x, y), 12 + nh);
        for (const [x, y] of disc(cx, cy, w / 2)) put(x, y, 12 + nh, 12 + nh + 2 + Math.floor(rnd() * 4), mat);
      }
      if (kind === 2 || kind === 3) {
        const span = 6 + rnd() * 14;
        const hh = 10 + Math.floor(rnd() * 30);
        for (const dx of kind === 2 ? [-span / 2, span / 2] : [-span / 2]) for (const [x, y] of disc(cx + dx, cy, 1.8)) tower(x, y, top(x, y), 12 + hh);
        for (let wx = cx - span / 2; wx <= cx + span / 2; wx += 0.5) for (const [x, y] of disc(wx, cy, 1.5)) put(x, y, 12 + hh - 3, 12 + hh, mat);
      }
    }
    // (what this world starts with that floats — a structure written over another's cut — doesn't count)
    const before = F.floatingRuns(world).floating.length;
    for (let c = 0; c < cutsPer; c++) {
      const wx = rnd() * W;
      const wy = rnd() * H * 0.866;
      const r = 1.5 + rnd() * 4;
      const cz = 11 + rnd() * 60;
      let seeds = [];
      for (const [x, y] of disc(wx, wy, r + 0.5)) {
        const [px, py] = L.cellPos(x, y);
        const d = Math.hypot(px - wx, py - wy);
        const hz = Math.sqrt(Math.max(0, r * r - d * d));
        if (hz < 0.3) continue;
        const z0 = Math.max(2, cz - hz);
        const z1 = cz + hz;
        write(x, y, (() => {
          const out = [];
          for (const iv of col(x, y)) {
            if (iv.z1 <= z0 || iv.z0 >= z1) out.push(iv);
            else {
              if (iv.z0 < z0) out.push({ ...iv, z1: z0 });
              if (iv.z1 > z1) out.push({ ...iv, z0: z1 });
            }
          }
          return out;
        })());
        seeds.push([x, y]);
      }
      // the integrity system's passes: what falls is taken away (it landed elsewhere), its columns judged again
      for (let pass = 0; pass < 50 && seeds.length; pass++) {
        const t0 = performance.now();
        const res = J.analyseRock(world, seeds);
        maxMs = Math.max(maxMs, performance.now() - t0);
        const next = [];
        const take = (rp) => {
          for (const pc of rp) {
            const cut = pc.ivs.map((iv) => ({ z0: iv.z0, z1: iv.z1 }));
            const out = [];
            for (const iv of col(pc.x, pc.y)) if (!cut.some((k) => Math.abs(k.z0 - iv.z0) < 1e-4 && Math.abs(k.z1 - iv.z1) < 1e-4)) out.push(iv);
            write(pc.x, pc.y, out);
            next.push([pc.x, pc.y]);
          }
        };
        for (const p of res.pieces) {
          take(p);
          pieces++;
        }
        if (res.crumbleRuns.length) {
          take(res.crumbleRuns);
          crumbled += res.crumbleRuns.length;
        }
        seeds = next;
      }
      const fl = F.floatingRuns(world).floating;
      if (fl.length > before) {
        fails++;
        console.log(`FAIL trial ${t} cut ${c} (at ${wx.toFixed(1)}, ${wy.toFixed(1)}, z ${cz.toFixed(1)}, r ${r.toFixed(1)}): ${fl.length - before} floating`, JSON.stringify(fl.slice(0, 4)));
        break;
      }
    }
  }
  console.log(`rockcpu: ${trials} worlds × ${cutsPer} cuts: ${pieces} pieces fell, ${crumbled} runs crumbled, slowest judge ${maxMs.toFixed(1)} ms; ${fails ? fails + ' FAILED' : 'none left floating'}`);
} finally {
  await server.close();
}
process.exit(fails ? 1 : 0);
