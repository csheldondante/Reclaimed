// Round 100 (hitchrec): fracture.ts analyse (the structures' judge) against another copy of it, on the CPU alone —
// random worlds of stone ground with brick, concrete, steel and canvas towers, slabs, arms and floaters (fractional
// ends too), random boxes; every result must be the same (JSON). For an allocation change that mustn't change what
// it finds.
//   git show origin/places:src/game/fracture.ts > src/game/fracture_base_tmp.ts   (the old copy beside it: its imports resolve; don't commit it)
//   node scripts/fracturesame.mjs [--base /src/game/fracture_base_tmp.ts] [--trials 200] [--seed 1]
import { createServer } from 'vite';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let fails = 0;
try {
  const F = await server.ssrLoadModule('/src/game/fracture.ts');
  const B = await server.ssrLoadModule(opt('base', '/src/game/fracture_base_tmp.ts'));
  const Lay = await server.ssrLoadModule('/src/world/layout.ts');
  const { MAT } = await server.ssrLoadModule('/src/world/materials.ts');
  let seed = Number(opt('seed', 1));
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const trials = Number(opt('trials', 200));
  const mats = [MAT.Brick, MAT.Concrete, MAT.Steel, MAT.Canvas, MAT.Sand, MAT.Soil];
  let found = 0;
  const t = { a: 0, b: 0 };
  for (let tr = 0; tr < trials; tr++) {
    const W = 48;
    const H = 48;
    const Z = 96;
    const g = new Lay.ColumnGrid({ w: W, h: H, zMax: Z });
    const tops = new Float64Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const z = 8 + Math.floor(rnd() * 3);
        g.push(x, y, 0, z, MAT.Stone);
        tops[y * W + x] = z;
      }
    // (structures: a box of a material, standing or floating, fractional ends sometimes)
    for (let s = 0; s < 14; s++) {
      const x0 = Math.floor(rnd() * W);
      const y0 = Math.floor(rnd() * H);
      const w = 1 + Math.floor(rnd() * 8);
      const d = 1 + Math.floor(rnd() * 8);
      const mat = mats[Math.floor(rnd() * mats.length)];
      const lift = rnd() < 0.3 ? 2 + Math.floor(rnd() * 10) : 0;
      const hgt = 1 + rnd() * 30;
      const frac = rnd() < 0.5;
      for (let y = y0; y < Math.min(H, y0 + d); y++)
        for (let x = x0; x < Math.min(W, x0 + w); x++) {
          const z0 = tops[y * W + x] + lift;
          const z1 = Math.min(Z - 1, z0 + (frac ? hgt : Math.round(hgt)));
          if (z1 <= z0 + 0.1) continue;
          g.push(x, y, z0, z1, mat);
          tops[y * W + x] = z1;
        }
    }
    const pk = Lay.packColumns(g, 14);
    const wf = new F.WorldVox(pk, pk.slots);
    const wb = new B.WorldVox(pk, pk.slots);
    for (let k = 0; k < 4; k++) {
      const bx0 = Math.floor(rnd() * W * 0.6) - 4;
      const by0 = Math.floor(rnd() * H * 0.6) - 4;
      const bx1 = bx0 + 8 + Math.floor(rnd() * W);
      const by1 = by0 + 8 + Math.floor(rnd() * H);
      let t0 = performance.now();
      const a = F.analyse(wf, bx0, by0, bx1, by1);
      t.a += performance.now() - t0;
      t0 = performance.now();
      const b = B.analyse(wb, bx0, by0, bx1, by1);
      t.b += performance.now() - t0;
      const ja = JSON.stringify(a);
      const jb = JSON.stringify(b);
      found += a.bodies.length + a.crumble.length;
      if (ja !== jb) {
        fails++;
        if (fails < 4) console.log(`DIFF trial ${tr} box ${bx0},${by0},${bx1},${by1}\n new ${ja.slice(0, 300)}\n old ${jb.slice(0, 300)}`);
      }
    }
  }
  console.log(`${fails ? 'FAIL' : 'SAME'}: ${trials * 4} analyses, ${found} bodies+crumbs found; ms new ${t.a.toFixed(0)} old ${t.b.toFixed(0)}`);
} finally {
  await server.close();
}
process.exit(fails ? 1 : 0);
