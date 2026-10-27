// Round 88: the floating-rock judge (fracture.ts analyseRock) against the ground truth (floatingRuns), on the CPU
// alone — no browser. A small world of stone ground gets random towers (3..16 across, 10..100 tall, banded with
// soil, sand and concrete), slabs on necks, bridges and arms; then random cuts (spheres taken out, as the break
// tool's and the meteor's are). After each cut what analyseRock is given (the cut columns, then the columns of what
// fell or crumbled, until nothing more goes) must leave no run with something solid and no way to the ground.
// Round 92 (what holds rock up: fracture.ts ROCK): named cases first — a big top on a thin leg falls, a wide top on a
// wide leg stands, a long cantilever snaps near its root and a short one stands, an off-centre top tips, a waist cut
// part way round falls when little is left and stands when much is, a banded tower's soil band bears less, a natural
// cave's roof stands when a hole is cut beside it.
//   node scripts/rockcpu.mjs [--seed 1] [--trials 40] [--cuts 30] [--judge /@fs/C:/path/to/old/fracture.ts] [--only name,...]
import { createServer } from 'vite';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const sopt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
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
  const times = [];

  /** a world of stone ground 10..12 deep (flat: `flat`), and its tools */
  const makeWorld = (flat = false) => {
    const g = new Lay.ColumnGrid({ w: W, h: H, zMax: Z });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g.push(x, y, 0, flat ? 10 : 10 + Math.floor(rnd() * 3), MAT.Stone);
    const pk = Lay.packColumns(g, 14);
    const world = new F.WorldVox(pk, pk.slots);
    const col = (x, y) => Lay.readColumn(pk, pk.slots, x, y);
    const write = (x, y, c) => {
      const { base, k } = Lay.columnSlots(pk, x, y);
      if (c.length > k) return false;
      pk.slots.set(Lay.packColumn(c, k), base * 4);
      return true;
    };
    /** column (x, y) less [z0, z1) */
    const cutCol = (x, y, z0, z1) => {
      const out = [];
      for (const iv of col(x, y)) {
        if (iv.z1 <= z0 || iv.z0 >= z1) out.push(iv);
        else {
          if (iv.z0 < z0) out.push({ ...iv, z1: z0 });
          if (iv.z1 > z1) out.push({ ...iv, z0: z1 });
        }
      }
      write(x, y, out);
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
    /** a sphere taken out: the cut columns */
    const sphere = (wx, wy, cz, r) => {
      const seeds = [];
      for (const [x, y] of disc(wx, wy, r + 0.5)) {
        const [px, py] = L.cellPos(x, y);
        const d = Math.hypot(px - wx, py - wy);
        const hz = Math.sqrt(Math.max(0, r * r - d * d));
        if (hz < 0.3) continue;
        cutCol(x, y, Math.max(2, cz - hz), cz + hz);
        seeds.push([x, y]);
      }
      return seeds;
    };
    /**
     * the integrity system's passes from these seeds: what falls is taken away (it landed elsewhere), what
     * crumbles too, their columns judged again. What fell (cells), how many pieces and crumbled runs.
     */
    const judge = (seeds, judgeF = J) => {
      let fell = 0;
      let pieces = 0;
      let crumbled = 0;
      const fellAt = [];
      for (let pass = 0; pass < 50 && seeds.length; pass++) {
        const t0 = performance.now();
        const res = judgeF.analyseRock(world, seeds);
        times.push(performance.now() - t0);
        const next = [];
        const take = (rp, into) => {
          for (const pc of rp) {
            for (const iv of pc.ivs) {
              cutCol(pc.x, pc.y, iv.z0, iv.z1);
              if (into) into.push([pc.x, pc.y, iv.z0, iv.z1]);
              fell += into ? iv.z1 - iv.z0 : 0;
            }
            next.push([pc.x, pc.y]);
          }
        };
        for (const p of res.pieces) {
          take(p, fellAt);
          pieces++;
        }
        if (res.crumbleRuns.length) {
          take(res.crumbleRuns, null);
          crumbled += res.crumbleRuns.length;
        }
        seeds = next;
      }
      return { fell, pieces, crumbled, fellAt };
    };
    return { world, col, write, put, top, disc, sphere, cutCol, judge };
  };

  // ---- named cases (round 92) ----
  const only = sopt('only', '');
  const CASES = {
    // a big top (radius 6, 12 thick) on a leg of 3 columns, 20 tall: the leg's columns go on through the top
    'thin-leg': () => {
      const w = makeWorld(true);
      const [cx, cy] = [32, 28];
      const leg = w.disc(cx, cy, 1.0);
      for (const [x, y] of leg) w.put(x, y, 10, 44, MAT.Stone);
      for (const [x, y] of w.disc(cx, cy, 6)) w.put(x, y, 32, 44, MAT.Stone);
      const r = w.judge(leg);
      return { ok: r.fell > 800, say: `${leg.length}-column leg: ${r.fell.toFixed(0)} cells fell (${r.pieces} pieces)` };
    },
    // the same top on a leg of radius 3.5 (37 columns): stands
    'wide-leg': () => {
      const w = makeWorld(true);
      const [cx, cy] = [32, 28];
      const leg = w.disc(cx, cy, 3.5);
      for (const [x, y] of leg) w.put(x, y, 10, 44, MAT.Stone);
      for (const [x, y] of w.disc(cx, cy, 6)) w.put(x, y, 32, 44, MAT.Stone);
      const r = w.judge(leg);
      return { ok: r.fell === 0 && r.crumbled === 0, say: `${leg.length}-column leg: ${r.fell.toFixed(0)} cells fell, ${r.crumbled} crumbled` };
    },
    // an arm 3 thick, 3 wide reaching 22 from a wall: it snaps near its root (what falls starts within 6 of the wall)
    cantilever: () => {
      const w = makeWorld(true);
      const wall = [];
      for (const [x, y] of w.disc(14, 28, 4)) w.put(x, y, 10, 50, MAT.Stone), wall.push([x, y]);
      const arm = [];
      for (let wx = 14; wx <= 18 + 22; wx += 0.5) for (const [x, y] of w.disc(wx, 28, 1.5)) w.put(x, y, 40, 43, MAT.Stone), arm.push([x, y]);
      const r = w.judge(arm);
      const nearest = r.fellAt.length ? Math.min(...r.fellAt.map(([x, y]) => L.cellPos(x, y)[0])) - 18 : Infinity;
      return { ok: r.fell > 100 && nearest <= 6, say: `arm 22 out: ${r.fell.toFixed(0)} cells fell, the break ${nearest.toFixed(1)} from the wall` };
    },
    // the same arm 6 out: stands
    'short-arm': () => {
      const w = makeWorld(true);
      for (const [x, y] of w.disc(14, 28, 4)) w.put(x, y, 10, 50, MAT.Stone);
      const arm = [];
      for (let wx = 14; wx <= 18 + 6; wx += 0.5) for (const [x, y] of w.disc(wx, 28, 1.5)) w.put(x, y, 40, 43, MAT.Stone), arm.push([x, y]);
      const r = w.judge(arm);
      return { ok: r.fell === 0 && r.crumbled === 0, say: `arm 6 out: ${r.fell.toFixed(0)} cells fell, ${r.crumbled} crumbled` };
    },
    // a top (radius 5, 4 thick) off to one side of its leg (radius 2.5): its weight the leg bears, its centre past it — it tips
    'off-centre': () => {
      const w = makeWorld(true);
      const leg = w.disc(28, 28, 2.5);
      for (const [x, y] of leg) w.put(x, y, 10, 34, MAT.Stone);
      for (const [x, y] of w.disc(34, 28, 5)) w.put(x, y, 30, 34, MAT.Stone);
      const r = w.judge(leg);
      return { ok: r.fell > 200, say: `${leg.length}-column leg, top centred 6 off: ${r.fell.toFixed(0)} cells fell` };
    },
    // the same top centred: stands
    'centred-top': () => {
      const w = makeWorld(true);
      const leg = w.disc(28, 28, 2.5);
      for (const [x, y] of leg) w.put(x, y, 10, 34, MAT.Stone);
      for (const [x, y] of w.disc(28, 28, 5)) w.put(x, y, 30, 34, MAT.Stone);
      const r = w.judge(leg);
      return { ok: r.fell === 0 && r.crumbled === 0, say: `${leg.length}-column leg, top centred: ${r.fell.toFixed(0)} cells fell` };
    },
    // a tower (radius 5, 60 tall) cut part way round at its waist by spheres from three sides, a core of a few columns left: it falls
    'neck-deep': () => {
      const w = makeWorld(true);
      for (const [x, y] of w.disc(32, 28, 5)) w.put(x, y, 10, 70, MAT.Stone);
      const seeds = [];
      for (let a = 0; a < 6; a++) seeds.push(...w.sphere(32 + Math.cos((a / 6) * 6.283) * 5.2, 28 + Math.sin((a / 6) * 6.283) * 5.2, 20, 4.2));
      const core = w.disc(32, 28, 5).filter(([x, y]) => w.col(x, y).length === 1).length;
      const r = w.judge(seeds);
      return { ok: r.fell > 2000, say: `${core} columns left whole at the waist: ${r.fell.toFixed(0)} cells fell` };
    },
    // the same tower nicked on one side: stands
    'neck-nick': () => {
      const w = makeWorld(true);
      for (const [x, y] of w.disc(32, 28, 5)) w.put(x, y, 10, 70, MAT.Stone);
      const seeds = w.sphere(37, 28, 20, 3);
      const core = w.disc(32, 28, 5).filter(([x, y]) => w.col(x, y).length === 1).length;
      const r = w.judge(seeds);
      return { ok: r.fell === 0, say: `${core} columns left whole at the waist: ${r.fell.toFixed(0)} cells fell` };
    },
    // a tower with a band of sand at its waist, the same nick: the sand bears less — it falls
    'neck-sand': () => {
      const w = makeWorld(true);
      for (const [x, y] of w.disc(32, 28, 5)) w.put(x, y, 10, 70, MAT.Stone), w.put(x, y, 14, 16, MAT.Sand);
      const seeds = w.sphere(37, 28, 20, 3);
      const r = w.judge(seeds);
      return { ok: r.fell > 2000, say: `banded with sand under the cut: ${r.fell.toFixed(0)} cells fell` };
    },
    // (round 96) a top (radius 5, 6 thick) on a leg of 13 columns 30 tall: slender — it buckles
    'slender-leg': () => {
      const w = makeWorld(true);
      const leg = w.disc(32, 28, 2);
      for (const [x, y] of leg) w.put(x, y, 10, 46, MAT.Stone);
      for (const [x, y] of w.disc(32, 28, 5)) w.put(x, y, 40, 46, MAT.Stone);
      const r = w.judge(leg);
      return { ok: r.fell > 300, say: `${leg.length}-column leg 30 tall: ${r.fell.toFixed(0)} cells fell` };
    },
    // the same top on the same leg 3 tall: stubby — it holds
    'stubby-leg': () => {
      const w = makeWorld(true);
      const leg = w.disc(32, 28, 2);
      for (const [x, y] of leg) w.put(x, y, 10, 19, MAT.Stone);
      for (const [x, y] of w.disc(32, 28, 5)) w.put(x, y, 13, 19, MAT.Stone);
      const r = w.judge(leg);
      return { ok: r.fell === 0 && r.crumbled === 0, say: `${leg.length}-column leg 3 tall: ${r.fell.toFixed(0)} cells fell` };
    },
    // a big top (radius 6, 12 thick) on legs from an eighth to a half of its footprint, 22 tall: under a quarter falls
    'quarter-rule': () => {
      const out = [];
      let ok = true;
      for (const lr of [2.2, 2.8, 3.4, 4.2]) {
        const w = makeWorld(true);
        const leg = w.disc(32, 28, lr);
        const top = w.disc(32, 28, 6);
        for (const [x, y] of leg) w.put(x, y, 10, 44, MAT.Stone);
        for (const [x, y] of top) w.put(x, y, 32, 44, MAT.Stone);
        const r = w.judge(leg);
        const share = leg.length / top.length;
        out.push(`${(share * 100).toFixed(0)}%: ${r.fell > 500 ? 'fell' : 'stood'}`);
        if ((share < 0.22 && r.fell < 500) || (share > 0.3 && r.fell > 0)) ok = false;
      }
      return { ok, say: out.join(', ') };
    },
    // a cave (radius 10, 6 tall) under 20 of rock, a hole cut through its wall: its roof stands
    'cave-roof': () => {
      const w = makeWorld(true);
      for (const [x, y] of w.disc(32, 28, 26)) w.put(x, y, 10, 40, MAT.Stone);
      for (const [x, y] of w.disc(32, 28, 10)) w.cutCol(x, y, 12, 18);
      const seeds = w.sphere(43, 28, 15, 2.5);
      const r = w.judge(seeds);
      return { ok: r.fell === 0 && r.crumbled === 0, say: `cave 20 across: ${r.fell.toFixed(0)} cells fell, ${r.crumbled} crumbled` };
    },
  };
  for (const [name, f] of Object.entries(CASES)) {
    if (only && !only.split(',').includes(name)) continue;
    const r = f();
    if (!r.ok) fails++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${name}: ${r.say}`);
  }
  times.length = 0;

  // ---- the random sweep (round 88) ----
  const trials = only ? 0 : opt('trials', 40);
  const cutsPer = opt('cuts', 30);
  let pieces = 0;
  let crumbled = 0;
  for (let t = 0; t < trials; t++) {
    const w = makeWorld();
    const { world, put, top, disc } = w;
    // structures
    const n = 3 + Math.floor(rnd() * 4);
    for (let s = 0; s < n; s++) {
      const cx = 8 + rnd() * (W - 16);
      const cy = 8 + rnd() * (H * 0.866 - 16);
      const kind = Math.floor(rnd() * 4);
      const wd = 3 + Math.floor(rnd() * 14);
      const h = 10 + Math.floor(rnd() * 90);
      const mat = rnd() < 0.2 ? MAT.Concrete : rnd() < 0.5 ? MAT.Sandstone : MAT.Stone;
      const band = rnd() < 0.5 ? [rnd() < 0.5 ? MAT.Soil : MAT.Concrete, 5 + Math.floor(rnd() * 10)] : null;
      const tower = (x, y, z0, z1) => {
        put(x, y, z0, z1, mat);
        if (band) for (let z = z0 + band[1]; z < z1 - 1; z += band[1]) put(x, y, z, z + 1, band[0]);
      };
      if (kind === 0) for (const [x, y] of disc(cx, cy, wd / 2)) tower(x, y, top(x, y), 12 + h);
      if (kind === 1) {
        const nh = 6 + Math.floor(rnd() * 14);
        for (const [x, y] of disc(cx, cy, 1 + rnd() * 2)) tower(x, y, top(x, y), 12 + nh);
        for (const [x, y] of disc(cx, cy, wd / 2)) put(x, y, 12 + nh, 12 + nh + 2 + Math.floor(rnd() * 4), mat);
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
      const res = w.judge(w.sphere(wx, wy, cz, r));
      pieces += res.pieces;
      crumbled += res.crumbled;
      const fl = F.floatingRuns(world).floating;
      if (fl.length > before) {
        fails++;
        console.log(`FAIL trial ${t} cut ${c} (at ${wx.toFixed(1)}, ${wy.toFixed(1)}, z ${cz.toFixed(1)}, r ${r.toFixed(1)}): ${fl.length - before} floating`, JSON.stringify(fl.slice(0, 4)));
        break;
      }
    }
  }
  const slow = times.map((t, i) => [t, i]).sort((a, b) => b[0] - a[0]).slice(0, 6);
  if (argv.includes("--slow")) console.log("slowest calls (ms, index):", JSON.stringify(slow.map(([t, i]) => [+t.toFixed(1), i])));
  times.sort((a, b) => a - b);
  const p50 = times.length ? times[Math.floor(times.length / 2)] : 0;
  const worst = times.length ? times[times.length - 1] : 0;
  if (trials) console.log(`rockcpu: ${trials} worlds × ${cutsPer} cuts: ${pieces} pieces fell, ${runsLabel(crumbled)} crumbled, the judge ${p50.toFixed(2)} ms typical, ${worst.toFixed(1)} ms slowest (${times.length} calls); ${fails ? fails + ' FAILED' : 'none left floating'}`);
  else console.log(fails ? `rockcpu: ${fails} FAILED` : 'rockcpu: all passed');
} finally {
  await server.close();
}
function runsLabel(n) {
  return `${n} runs`;
}
process.exit(fails ? 1 : 0);
