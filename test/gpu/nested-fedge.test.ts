// Nested scales lab, round 29 (docs/design/NESTED_SCALES.md "Round 29 plan"): the GPU's field mesh with the edge line
// read (?fedge=1, FLINE) against without, on real Dawn: GpuNest with level 1 drawn by the field mesh (warp 0), a ball
// carved at the flattest spot of its window (radius 5.3 and 20.7 columns), and a stroke (a trench at 27 degrees); the
// baked quads read back ONCE a scene (a test-only readback) and cut by a horizontal plane under the rim; the cut's
// distance to the true outline at that height (the ball's circle there), max and RMS in columns. The same cut of the
// CPU reference mesh (fieldsel.ts on the read-back columns, test/support/nested-fieldref.ts) beside it: the GPU follows
// the reference. Also each bake's GPU time back to back (fedge 0, 1, 0, 1) and the cells a column.
import { expect, it } from 'vitest';
import { testGpu } from './dawn';
import { GpuNest, PW, type Snapshot, type Win } from '../../src/nested/gpu/nest';
import { runsOf, solidInside, type FieldLevel, type FieldSpec, type Runs } from '../../src/nested/fieldsel';
import { cutAt, fmt, meshOf, stats, type V3 } from '../support/nested-fieldref';
import { rootHeight } from '../../src/nested/oracle';

const K = 8;
const N = 128;
/** the root column at the centre of the flattest 9 x 9 root block (oracle.ts rootHeight, which the GPU root mirrors),
 *  window-aligned so level 1's window (N columns) is chunk-aligned and inside the root */
const FLAT = (() => {
  let best = [128, 128];
  let bs = Infinity;
  for (let y = 16; y < 240; y += 2)
    for (let x = 16; x < 240; x += 2) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = -4; j <= 4; j++)
        for (let i = -4; i <= 4; i++) {
          const h = rootHeight(x + i, y + j, 256, 7);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
      if (hi - lo < bs) {
        bs = hi - lo;
        best = [x, y];
      }
    }
  return best;
})();

/** level L's baked field quads (the drawn bank; skirts left out), as global-column points */
function gpuQuads(s: Snapshot, L: number, w: Win): { quads: V3[][]; cand: number } {
  const f = new Float32Array(s.pg.buffer, s.pg.byteOffset, s.pg.length);
  const quads: V3[][] = [];
  let cand = 0;
  for (let cy = w.gy / 16; cy < (w.gy + w.n) / 16; cy++)
    for (let cx = w.gx / 16; cx < (w.gx + w.n) / 16; cx++) {
      const hp = s.page(24 + L, cx, cy, 0);
      if (hp < 0) continue;
      const bank = s.pg[hp * PW + 2] & 1;
      const nq = s.pg[hp * PW + 7 + bank];
      cand += s.pg[hp * PW + 4];
      for (let i = 0; i < nq; i++) {
        const p = s.page(24 + L, cx, cy, 1 + bank * 4096 + Math.floor(i / 783));
        const b = p * PW + 16 + (i % 783) * 16;
        const q: V3[] = [];
        let skirt = false;
        for (let v = 0; v < 4; v++) {
          const w0 = s.pg[b + v * 4];
          if ((w0 >>> 20) & 1) skirt = true;
          const t = s.pg[b + v * 4 + 1];
          const X = cx * 16 + (w0 & 1023) - 512;
          const Y = cy * 16 + ((w0 >>> 10) & 1023) - 512;
          q.push([X + 0.5 + (t & 0xffff) / 65535, Y + 0.5 + (t >>> 16) / 65535, f[b + v * 4 + 2]]);
        }
        if (!skirt) quads.push(q);
      }
    }
  return { quads, cand };
}
function levelOf(s: Snapshot, L: number, w: Win): FieldLevel {
  const cache = new Map<number, Runs>();
  return {
    ...w,
    runs(X, Y) {
      const key = (Y - w.gy) * w.n + (X - w.gx);
      let r = cache.get(key);
      if (!r) cache.set(key, (r = runsOf(s.records(L, X, Y), solidInside)));
      return r;
    },
  };
}
const topOf = (s: Snapshot, L: number, X: number, Y: number) => {
  const r = s.records(L, X, Y);
  for (let j = r.mat.length - 1; j >= 0; j--) if (r.mat[j] !== 0) return r.top[j];
  return NaN;
};

interface Scene {
  name: string;
  /** the ground's spread over the outline's ring (columns): the cut is valid where it is under the depth */
  spread: number;
  /** distance of a cut point to the true outline at height zc (columns) */
  dev: (x: number, y: number, zc: number) => number | null;
  zc: number;
  box: [number, number, number, number];
}

async function runScene(fedge: boolean, kind: 'ball5' | 'ball20' | 'trench', log: string[]): Promise<{ gpu: ReturnType<typeof stats>; ref: ReturnType<typeof stats>; scene: Scene; cand: number; bakeMs: number[]; miss: number; cols: number }> {
  const g0 = await testGpu();
  const dev = g0.device;
  const g = new GpuNest(dev, K, 7, 2048, { syncGrow: true });
  g.detailAmp = 0;
  g.fieldOpt.edge = fedge;
  g.fieldOpt.warp = 0;
  g.enableField(1 << 1);
  g.root(256);
  // (level 1 over the flattest 9 x 9 root columns of the map: the cut below needs ground about flat round the outline)
  const w: Win = { gx: FLAT[0] * K - N / 2, gy: FLAT[1] * K - N / 2, n: N };
  if (!g.promote(1, w)) throw new Error(`promote refused: ${g.stats.error}`);
  for (let i = 0; i < 400 && g.fieldJob; i++) {
    g.stepField(w.gx + N / 2, w.gy + N / 2);
    await dev.queue.onSubmittedWorkDone();
  }
  expect(g.fieldJob).toBe(null);
  const s0 = await g.readAll();
  const r = kind === 'ball5' ? 5.3 : kind === 'ball20' ? 20.7 : 4;
  // the flattest spot: the least spread of the ground over the outline's ring, the centres on a grid over the window
  const ring = (cx: number, cy: number, half: number, ang: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let a = 0; a < 64; a++) {
      const th = (a / 64) * 2 * Math.PI;
      if (kind === 'trench') {
        // (along both walls)
        const t = (a / 63) * 2 - 1;
        for (const sd of [-1, 1]) out.push([cx + t * half * Math.cos(ang) - sd * r * Math.sin(ang), cy + t * half * Math.sin(ang) + sd * r * Math.cos(ang)]);
      } else out.push([cx + r * Math.cos(th), cy + r * Math.sin(th)]);
    }
    return out;
  };
  const ang = (27 * Math.PI) / 180;
  const half = 12;
  const reach = kind === 'trench' ? half + r + 4 : r + 4;
  let best = { cx: 0, cy: 0, spread: Infinity };
  for (let cy = w.gy + 8 + reach; cy < w.gy + N - 8 - reach; cy += 2)
    for (let cx = w.gx + 8 + reach; cx < w.gx + N - 8 - reach; cx += 2) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const [x, y] of ring(cx + 0.37, cy - 0.19, half, ang)) {
        const t = topOf(s0, 1, Math.floor(x), Math.floor(y));
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
      if (hi - lo < best.spread) best = { cx: cx + 0.37, cy: cy - 0.19, spread: hi - lo };
    }
  const { cx, cy } = best;
  const cz = topOf(s0, 1, Math.floor(cx), Math.floor(cy));
  let lowRim = Infinity;
  for (const [x, y] of ring(cx, cy, half, ang)) lowRim = Math.min(lowRim, topOf(s0, 1, Math.floor(x), Math.floor(y)));
  const zc = lowRim - 0.75;
  if (kind === 'trench') {
    g.strokeBegin();
    g.edit({ op: 'carve', radius: r / K, amount: 0, at: { level: 1, x: cx - half * Math.cos(ang) - w.gx, y: cy - half * Math.sin(ang) - w.gy, z: cz } });
    g.edit({ op: 'carve', radius: r / K, amount: 0, at: { level: 1, x: cx + half * Math.cos(ang) - w.gx, y: cy + half * Math.sin(ang) - w.gy, z: cz } });
    g.strokeEnd();
  } else g.edit({ op: 'carve', radius: r / K, amount: 0, at: { level: 1, x: cx - w.gx, y: cy - w.gy, z: cz } });
  await dev.queue.onSubmittedWorkDone();
  // (the bake's time alone, back to back: the whole window's field rebuilt, 3 times)
  const bakeMs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    g.rebakeLevel(1, true);
    await dev.queue.onSubmittedWorkDone();
    bakeMs.push(performance.now() - t0);
  }
  const s = await g.readAll();
  const Rc = Math.sqrt(r * r - (cz - zc) ** 2);
  const scene: Scene = {
    name: kind,
    spread: best.spread,
    zc,
    box: [Math.floor(cx - reach), Math.floor(cy - reach), Math.ceil(cx + reach), Math.ceil(cy + reach)],
    dev: (x, y) => {
      if (kind !== 'trench') return Math.hypot(x - cx, y - cy) - Rc;
      const along = (x - cx) * Math.cos(ang) + (y - cy) * Math.sin(ang);
      if (Math.abs(along) > half - 3) return null;
      return Math.abs(-(x - cx) * Math.sin(ang) + (y - cy) * Math.cos(ang)) - Rc;
    },
  };
  const inBox = (x: number, y: number) => x >= scene.box[0] && y >= scene.box[1] && x <= scene.box[2] && y <= scene.box[3];
  // (the cut's points within 1.5 columns of the true outline: the ground beyond the rim crosses the plane elsewhere on
  // these slopes, which is not the rim)
  const devs = (pts: [number, number][]) =>
    pts
      .filter(([x, y]) => inBox(x, y))
      .map(([x, y]) => scene.dev(x, y, zc))
      .filter((d): d is number => d !== null && Math.abs(d) < 1.5);
  const gq = gpuQuads(s, 1, w);
  // (columns of the box whose top record keeps an edge line in reach)
  let lined = 0;
  for (let Y = scene.box[1]; Y < scene.box[3]; Y++)
    for (let X = scene.box[0]; X < scene.box[2]; X++) {
      const rr = s.records(1, X, Y);
      const e = rr.edge[rr.edge.length - 1] ?? 0;
      if (e && Math.abs((((e >>> 18) & 4095) - 2048) / 1024) < 1.5) lined++;
    }
  console.log(`[fedge gpu] ${kind}: ${lined} columns of the box carry an edge line in reach on their top record`);
  const spec: FieldSpec = { own: levelOf(s, 1, w), parent: { lv: levelOf(s, 0, g.wins[0]!), k: K, zo: s.zOrigin(1) }, warp: 0, fade: 4, fedge };
  const ref = meshOf(spec, scene.box[0], scene.box[1], scene.box[2], scene.box[3], Math.floor(zc) - 3, Math.floor(zc) + 3);
  const out = { gpu: stats(devs(cutAt(gq.quads, zc))), ref: stats(devs(cutAt(ref.quads, zc))), scene, cand: gq.cand, bakeMs, miss: s.ctl[14], cols: (N / 16 + 0) ** 2 * 256 };
  log.push(`[fedge gpu] ${kind} r ${r}, fedge ${fedge ? 1 : 0}: ground spread over the outline ${best.spread.toFixed(2)}, cut ${(cz - zc).toFixed(2)} under the centre's top; GPU ${fmt(out.gpu)}; reference ${fmt(out.ref)}; candidate cells ${(gq.cand / out.cols).toFixed(2)} a column; whole-level rebuild ${bakeMs.map((m) => m.toFixed(1)).join(' / ')} ms; fieldMiss ${out.miss}`);
  console.log(log[log.length - 1]);
  g.destroy();
  return out;
}

it('nested field mesh: the edge line read on the GPU (round 29)', async () => {
  const log: string[] = [];
  for (const kind of ['ball5', 'ball20', 'trench'] as const)
    for (const fedge of [false, true, false, true]) {
      const o = await runScene(fedge, kind, log);
      expect(o.miss).toBe(0);
      expect(o.gpu.n).toBeGreaterThan(20);
      // (the GPU follows the reference on the same columns)
      expect(Math.abs(o.gpu.rms - o.ref.rms)).toBeLessThan(0.02);
    }
  console.log(log.join('\n'));
  const g0 = await testGpu();
  expect(g0.takeErrors()).toEqual([]);
}, 600_000);
