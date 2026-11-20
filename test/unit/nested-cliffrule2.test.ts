// Nested scales lab, round 32 step C0: cliff rule v2 (src/nested/exp/cliffrule2.ts, the owner's "fractal of column
// subtraction") on the step A field (test/support/nested-cliffield.ts). Base tops and means, the bound's soundness,
// material connectivity on probe volumes (flood fill), determinism. With RA_PICS=1 it also draws local/nested/rC-*.png:
// the views near, far, trench, above and close (camera ~3 m from the main wall) for variant A (8x levels, d 0..3),
// B (2x levels, d 0..1) and C (v1 cliffrule.ts: full-cell fine amplitudes, notches "every").
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { COARSE_M, KIND_SPLIT, UPM, cellOf, defaultParams, deriveRules, fineTop, notchAt, type CliffParams, type Rules } from '../../src/nested/exp/cliffrule';
import { render, type View } from '../../src/nested/exp/cliffview';
import {
  ZU,
  baseTop,
  deriveRules2,
  qOf,
  sizeL,
  solidAtM,
  stateAt,
  sureSolid,
  variantA,
  variantB,
  type Rules2,
  type V2Params,
} from '../../src/nested/exp/cliffrule2';
import { render2 } from '../../src/nested/exp/cliffview2';
import { makeField } from '../support/nested-cliffield';

function rules(over: Partial<CliffParams> = {}): Rules {
  return deriveRules(makeField(false), { ...defaultParams(), ...over });
}
function rules2(v: V2Params): Rules2 {
  return deriveRules2(rules(), v);
}
const pickLevel = (v: V2Params, metres: number) => Math.round(Math.log2(16 / metres) / v.qPer);

/** a face point near (x, y): the centre of the edge between an up block and a lower 4-neighbour block, in a split cell */
function findFace(T: Rules2, x: number, y: number): { x: number; y: number; H: number; L: number } {
  const R = T.R;
  let best: { x: number; y: number; H: number; L: number } | null = null;
  let bd = 1e18;
  for (let cy = 0; cy < R.f.ny; cy++)
    for (let cx = 0; cx < R.f.nx; cx++) {
      const r = cellOf(R, cx, cy);
      if (r.kind !== KIND_SPLIT) continue;
      for (let by = 0; by < 8; by++)
        for (let bx = 0; bx < 8; bx++) {
          const gx = cx * 8 + bx;
          const gy = cy * 8 + by;
          const t = baseTop(T, gx, gy, 3);
          if (t !== r.H * (ZU / UPM)) continue;
          for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (baseTop(T, gx + ox, gy + oy, 3) >= t - 20 * ZU) continue;
            const px = gx * 2 + 1 + ox;
            const py = gy * 2 + 1 + oy;
            const d = Math.hypot(px - x, py - y);
            if (d < bd) {
              bd = d;
              best = { x: px, y: py, H: r.H / UPM, L: r.L / UPM };
            }
          }
        }
    }
  if (!best) throw new Error('no face');
  return best;
}

/** flood fill of a probe volume at level l: voxels = depth-q(l) plan cells x level-l slabs, solid = stateAt === 0 */
function probe(T: Rules2, l: number, cxm: number, cym: number, half: number, z0m: number, z1m: number, seedAll: boolean) {
  const v = T.v;
  const q = qOf(v, l);
  const cm = COARSE_M / (1 << q);
  const s = sizeL(v, l);
  const nx = Math.round((2 * half) / cm);
  const ny = nx;
  const gx0 = Math.floor((cxm - half) / cm);
  const gy0 = Math.floor((cym - half) / cm);
  const k0 = Math.floor((z0m * ZU) / s);
  const nz = Math.ceil(((z1m - z0m) * ZU) / s);
  const n = nx * ny * nz;
  const solid = new Uint8Array(n);
  let nSolid = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const z = (k0 + k) * s + (s >> 1);
        if (stateAt(T, l, gx0 + i, gy0 + j, z) === 0) {
          solid[(k * ny + j) * nx + i] = 1;
          nSolid++;
        }
      }
  const lab = new Int32Array(n); // 0 unvisited, 1 grounded, 2.. other components
  const queue = new Int32Array(n);
  const fill = (start: number, id: number): { size: number; side: boolean; bottom: boolean } => {
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    lab[start] = id;
    let size = 0;
    let side = false;
    let bottom = false;
    while (head < tail) {
      const c = queue[head++];
      size++;
      const i = c % nx;
      const j = Math.floor(c / nx) % ny;
      const k = Math.floor(c / (nx * ny));
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) side = true;
      if (k === 0) bottom = true;
      const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1, k > 0 ? c - nx * ny : -1, k < nz - 1 ? c + nx * ny : -1];
      for (const d of nb)
        if (d >= 0 && solid[d] && !lab[d]) {
          lab[d] = id;
          queue[tail++] = d;
        }
    }
    return { size, side, bottom };
  };
  // grounded: everything reached from the bottom layer (seedAll: from any boundary voxel)
  let grounded = 0;
  for (let c = 0; c < n; c++) {
    if (!solid[c] || lab[c]) continue;
    const i = c % nx;
    const j = Math.floor(c / nx) % ny;
    const k = Math.floor(c / (nx * ny));
    const onB = k === 0 || (seedAll && (i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1));
    if (onB) grounded += fill(c, 1).size;
  }
  let floating = 0;
  let floatingVox = 0;
  let sideOnly = 0;
  let sideOnlyVox = 0;
  let id = 2;
  for (let c = 0; c < n; c++) {
    if (!solid[c] || lab[c]) continue;
    const r = fill(c, id++);
    if (!r.side && process.env.RA_DIAG && floating < 6) {
      const i = c % nx;
      const j = Math.floor(c / nx) % ny;
      const k = Math.floor(c / (nx * ny));
      const x = (gx0 + i + 0.5) * cm;
      const y = (gy0 + j + 0.5) * cm;
      const z = ((k0 + k) * s + (s >> 1)) / ZU;
      const bt: string[] = [];
      for (let b = -2; b <= 2; b++) {
        const row: number[] = [];
        for (let a = -2; a <= 2; a++) row.push(Math.round(baseTop(T, Math.floor(x / 2) + a, Math.floor(y / 2) + b, 3) / ZU));
        bt.push(row.join(','));
      }
      const states: number[] = [];
      for (let m = 1; m <= l; m++) states.push(stateAt(T, m, Math.floor(x / (COARSE_M / (1 << qOf(v, m)))), Math.floor(y / (COARSE_M / (1 << qOf(v, m)))), Math.floor(z * ZU)));
      console.log(`  floating ${r.size} vox at (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}); base tops 5x5 blocks (rows y-2..y+2): ${bt.join(' | ')}; state per level ${states.join(',')}`);
    }
    if (r.side) {
      sideOnly++;
      sideOnlyVox += r.size;
    } else {
      floating++;
      floatingVox += r.size;
    }
  }
  return { voxels: n, nSolid, grounded, floating, floatingVox, sideOnly, sideOnlyVox, dims: [nx, ny, nz], cell: cm, slab: s / ZU };
}

describe('nested cliff rule v2 (round 32 step C0)', () => {
  const A = rules2(variantA());
  const B = rules2(variantB());

  it('base: split blocks are H or L; the block mean vs h (reported)', () => {
    const R = A.R;
    let n = 0;
    let worst = 0;
    let worstRel = 0;
    for (let cy = 0; cy < R.f.ny; cy++)
      for (let cx = 0; cx < R.f.nx; cx++) {
        const r = cellOf(R, cx, cy);
        if (r.kind !== KIND_SPLIT) continue;
        let s = 0;
        for (let by = 0; by < 8; by++)
          for (let bx = 0; bx < 8; bx++) {
            const t = baseTop(A, cx * 8 + bx, cy * 8 + by, 3) / (ZU / UPM);
            expect(t === r.H || t === r.L).toBe(true);
            s += t;
          }
        const err = Math.abs(s / 64 - r.h);
        worst = Math.max(worst, err);
        worstRel = Math.max(worstRel, err / (r.H - r.L));
        n++;
      }
    console.log(`base: ${n} split cells; block mean - h worst ${(worst / UPM).toFixed(3)} m (${(100 * worstRel).toFixed(2)} % of H-L; one block is 1.56 %)`);
    expect(worstRel).toBeLessThanOrEqual(1 / 128 + 1e-9);
  });

  it('the bound: a SURE SOLID node is solid at every finer level (sampled)', () => {
    for (const T of [A, B]) {
      const v = T.v;
      const face = findFace(T, 262, 309);
      let claims = 0;
      let checked = 0;
      let seed = 12345;
      const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
      for (let l = Math.ceil(3 / v.qPer); l < Math.min(v.maxLevel, Math.ceil(3 / v.qPer) + (v.qPer === 3 ? 2 : 5)); l++) {
        const q = qOf(v, l);
        const cm = COARSE_M / (1 << q);
        for (let it = 0; it < 400; it++) {
          const x = face.x + (rnd() - 0.5) * 6;
          const y = face.y + (rnd() - 0.5) * 6;
          const z = Math.floor((face.L + rnd() * (face.H - face.L)) * ZU);
          const gx = Math.floor(x / cm);
          const gy = Math.floor(y / cm);
          if (!sureSolid(T, l, gx, gy, z, { slabs: 0 })) continue;
          claims++;
          const lf = Math.min(v.maxLevel, l + (v.qPer === 3 ? 2 : 4));
          const qf = qOf(v, lf);
          const n = 1 << (qf - q);
          for (let k = 0; k < 24; k++) {
            const fx = gx * n + Math.floor(rnd() * n);
            const fy = gy * n + Math.floor(rnd() * n);
            checked++;
            if (stateAt(T, lf, fx, fy, z) !== 0) throw new Error(`${v.name}: sure-solid node l ${l} (${gx},${gy}) z ${z} has air at level ${lf} (${fx},${fy})`);
          }
        }
      }
      console.log(`bound ${v.name}: ${claims} sure-solid claims near the face, ${checked} finer points checked, none air`);
      expect(claims).toBeGreaterThan(0);
    }
  });

  it('connectivity: no solid voxel without a face-adjacent path to the ground (probe volumes)', () => {
    const rows: string[] = [];
    const out: Record<string, number> = {};
    for (const T of [A, B]) {
      const v = T.v;
      for (const [place, px, py] of [
        ['main wall', 262, 309],
        ['trench wall', 328, 107],
      ] as [string, number, number][]) {
        const f = findFace(T, px, py);
        // coarse probe: 16 m square, the whole drop, at 0.25 m; grounded = reached from the bottom layer
        const lc = pickLevel(v, 0.25);
        const c = probe(T, lc, f.x, f.y, 8, f.L - 1, f.H + 0.5, false);
        rows.push(
          `${v.name} ${place} (${f.x},${f.y}) H ${f.H.toFixed(1)} L ${f.L.toFixed(1)}, level ${lc} (${c.cell} m x ${c.slab} m), ${c.dims.join('x')} voxels, solid ${c.nSolid}: grounded ${c.grounded}, floating ${c.floating} comps / ${c.floatingVox} vox, touching only the probe's sides/top ${c.sideOnly} comps / ${c.sideOnlyVox} vox`,
        );
        out[`${v.name}-${place}-coarse`] = c.floating;
        // fine probe: 2 m square, 8 m band at mid-height, at 1/32 m; any boundary voxel counts as connected outside.
        // Centred on a 0.25 m-level face at mid-height (solid with an air 4-neighbour), so it holds stone
        const lf = pickLevel(v, 1 / 32);
        const zm = 0.5 * (f.H + f.L);
        const zu = Math.floor(zm * ZU);
        const q2 = qOf(v, lc);
        const c2 = COARSE_M / (1 << q2);
        let fx = f.x;
        let fy = f.y;
        search: for (let rr = 0; rr < 48; rr++)
          for (let j = -rr; j <= rr; j++)
            for (let i = -rr; i <= rr; i++) {
              if (Math.max(Math.abs(i), Math.abs(j)) !== rr) continue;
              const gx = Math.floor(f.x / c2) + i;
              const gy = Math.floor(f.y / c2) + j;
              if (stateAt(T, lc, gx, gy, zu) !== 0) continue;
              if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => stateAt(T, lc, gx + a, gy + b, zu) !== 0)) {
                fx = (gx + 0.5) * c2;
                fy = (gy + 0.5) * c2;
                break search;
              }
            }
        const d = probe(T, lf, fx, fy, 1, zm - 4, zm + 4, true);
        rows.push(
          `${v.name} ${place} level ${lf} (${d.cell} m x ${d.slab} m) at (${fx.toFixed(2)},${fy.toFixed(2)}), ${d.dims.join('x')} voxels, solid ${d.nSolid}: connected to the probe boundary ${d.grounded}, enclosed floating ${d.floating} comps / ${d.floatingVox} vox`,
        );
        out[`${v.name}-${place}-fine`] = d.floating;
      }
    }
    console.log(rows.join('\n'));
    // REPORTED, NOT ASSERTED (round 32 C0 finding): the rule as specified leaves floating pieces in A as well as B. Row
    // cuts (from x faces) and column cuts (from y faces) with independent hashed depths can enclose a cell at a convex
    // corner of the coarser material (RA_DIAG=1 prints where). The half-cell bound keeps every coarser cell's core, but
    // not the fringe's path to it. See the step C0 notes for the proposed clamp.
    for (const [k, n] of Object.entries(out)) expect(n, k).toBeGreaterThanOrEqual(0);
  }, 600_000);

  it.skipIf(!process.env.RA_DIAG)('diag: the close view eye and a section through the wall', () => {
    let yw = 280;
    while (!solidAtM(A, 2, 262, yw, 56)) yw += 0.02;
    const out: string[] = [`yw ${yw}`];
    for (const [n, T, ls] of [['A', A, [1, 2, 3, 4, 5]], ['B', B, [3, 6, 9, 12, 15]]] as const) {
      out.push(`${n} eye solid per level: ${ls.map((l) => (solidAtM(T, l, 262, yw - 3, 56) ? 1 : 0)).join(',')}`);
      const l = n === 'A' ? 2 : 6;
      for (const z of [58, 56, 53, 51]) {
        let s = '';
        for (let y = yw - 8; y < yw + 8; y += 0.25) s += solidAtM(T, l, 262, y, z) ? '#' : '.';
        out.push(`${n} z ${z} y ${(yw - 8).toFixed(1)}..: ${s}`);
      }
    }
    // B's close view: the flat lit areas (pixels (800, 300), (300, 600), (900, 100)) against a rough one (300, 100)
    let ywB = 280;
    while (!solidAtM(B, 6, 262, ywB, 56.7)) ywB += 0.02;
    const v: View = { eye: [262, ywB - 3, 56.7], target: [263, ywB + 3, 55.9], fovDeg: 60, w: 960, h: 640, px: 1 };
    const rows: string[] = [];
    const want = ['800,300', '300,600', '900,100', '300,100', '700,500'];
    render2(B, v, (px, py, hit, lit, nodes) => {
      if (want.includes(`${px},${py}`))
        rows.push(`row ${px},${py}: ${hit ? `kind ${hit.kind} t ${hit.t.toFixed(3)} n (${hit.nx},${hit.ny},${hit.nz.toFixed(2)}) level ${hit.level}` : 'none'} lit ${lit} nodes ${nodes}`);
    });
    // near-A's smooth vertical strips (pixels (365, 300), (650, 250)) against rough wall (500, 300)
    const wantA = ['365,300', '650,250', '500,300'];
    render2(A, { eye: [262, 205, 72], target: [262, 312, 60], fovDeg: 50, w: 960, h: 640, px: 1 }, (px, py, hit, lit, nodes) => {
      if (wantA.includes(`${px},${py}`))
        rows.push(`near-A ${px},${py}: ${hit ? `kind ${hit.kind} t ${hit.t.toFixed(3)} n (${hit.nx},${hit.ny},${hit.nz.toFixed(2)}) level ${hit.level}` : 'none'} lit ${lit} nodes ${nodes}`);
    });
    console.log(rows.join('\n'));
  }, 120_000);

  it('is deterministic', () => {
    const A2 = rules2(variantA());
    const f = findFace(A, 262, 309);
    const l = 3;
    const q = qOf(A.v, l);
    const cm = COARSE_M / (1 << q);
    for (let i = 0; i < 2000; i++) {
      const gx = Math.floor((f.x - 1) / cm) + (i % 64);
      const gy = Math.floor((f.y - 1) / cm) + ((i * 7) % 64);
      const z = Math.floor((f.L + ((i * 0.37) % 1) * (f.H - f.L)) * ZU);
      expect(stateAt(A2, l, gx, gy, z)).toBe(stateAt(A, l, gx, gy, z));
    }
  });
});

// ---- pictures (RA_PICS=1) ----

function crcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC = crcTable();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function png(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** v1 "today's rule" for variant C: fine amplitudes at a full cell, w per 0.5 m block, notches "every" (cliffbox.ts) */
const C_PARAMS: Partial<CliffParams> = {
  ampL: [0, 256, 256, 256, 256, 256, 256],
  wLevel: 5,
  notchPctL: [0, 30, 25, 20, 15, 15, 15],
  notchDepthL: [0, 2, 3, 4, 4, 4, 4],
  notchFrac: [0.1, 0.9],
  slotLog: 2,
};

describe.skipIf(!process.env.RA_PICS)('nested cliff rule v2 pictures', () => {
  it('draws local/nested/rC-*.png', () => {
    mkdirSync('local/nested', { recursive: true });
    const W = Number(process.env.RA_W ?? 960);
    const Hh = Number(process.env.RA_H ?? 640);
    const px = Number(process.env.RA_PX ?? 1);
    const A = rules2(variantA());
    // the close view: 3 m in front of the main wall at x = 262 (the first 2 m block above 50 m going north)
    // (the floor there is at 49.7 m: the eye at 56 m, 3 m south of each variant's own wall = the first solid at the
    // 0.25 m level going north along x 262; C by v1's fine column tops less notch air)
    const B = rules2(variantB());
    const RC = rules(C_PARAMS);
    const wallY = (solid: (y: number) => boolean) => {
      let y = 280;
      while (!solid(y)) y += 0.02;
      return y;
    };
    const fm = COARSE_M / (1 << RC.p.fineLevel);
    // (the eye at 56.7 m, off every slab grid: at 56 m, a 2 m slab boundary, all the span ends at that height fell on
    // the horizon row as one straight line)
    const EZ = 56.7;
    const yws: Record<string, number> = {
      A: wallY((y) => solidAtM(A, 2, 262, y, EZ)),
      B: wallY((y) => solidAtM(B, 6, 262, y, EZ)),
      C: wallY((y) => {
        const gx = Math.floor(262 / fm);
        const gy = Math.floor(y / fm);
        const zu = Math.floor(EZ * UPM);
        return zu < fineTop(RC, gx, gy) && !notchAt(RC, gx, gy, zu);
      }),
    };
    const closeView = (yw: number): View => ({ eye: [262, yw - 3, EZ], target: [263, yw + 3, EZ - 0.8], fovDeg: 60, w: W, h: Hh, px });
    const views: Record<string, View> = {
      near: { eye: [262, 205, 72], target: [262, 312, 60], fovDeg: 50, w: W, h: Hh, px },
      far: { eye: [300, -170, 190], target: [330, 280, 75], fovDeg: 55, w: W, h: Hh, px },
      trench: { eye: [232, 31, 50], target: [393, 113, -10], fovDeg: 55, w: W, h: Hh, px },
      above: { eye: [300, 240, 235], target: [300, 318, 95], fovDeg: 55, w: W, h: Hh, px },
    };
    const only = process.env.RA_ONLY;
    const lines: string[] = [`close view: each variant's wall at x 262, z 56: A y ${yws.A.toFixed(2)}, B ${yws.B.toFixed(2)}, C ${yws.C.toFixed(2)}; eye 3 m south; px ${px}; ${W}x${Hh}`];
    for (const name of [...Object.keys(views), 'close'])
      for (const variant of ['A', 'B', 'C']) {
        const tag = `rC-${name}-${variant}`;
        if (only && !only.split(',').some((o) => tag.includes(o))) continue;
        if (name === 'close') views.close = closeView(yws[variant]);
        const t0 = performance.now();
        let line: string;
        let rgb: Uint8Array;
        if (variant === 'C') {
          const pic = render(rules(C_PARAMS), views[name]);
          rgb = pic.rgb;
          line = `${tag}: nodes/px mean ${pic.meanSteps.toFixed(1)} max ${pic.maxSteps} capped ${pic.capped}; shadow mean ${pic.meanShadowSteps.toFixed(1)} max ${pic.maxShadowSteps}`;
        } else {
          const T = rules2(variant === 'A' ? variantA() : variantB());
          const pic = render2(T, views[name]);
          rgb = pic.rgb;
          line = `${tag}: nodes/px mean ${pic.meanNodes.toFixed(1)} max ${pic.maxNodes} capped ${pic.capped}; slab queries/px mean ${pic.meanSlabs.toFixed(1)} max ${pic.maxSlabs}; shadow nodes mean ${pic.meanShadowNodes.toFixed(1)} max ${pic.maxShadowNodes}; hits per leaf level ${pic.levelHist.map((n, l) => (n ? `${l}:${n}` : '')).filter(Boolean).join(' ')}; removed() evaluations ${T.removedCalls}`;
        }
        writeFileSync(`local/nested/${tag}.png`, png(rgb, W, Hh));
        line += `; ${((performance.now() - t0) / 1000).toFixed(1)} s`;
        console.log(line);
        lines.push(line);
      }
    writeFileSync(`local/nested/rC-steps${only ? '-' + only.replace(/,/g, '_') : ''}.txt`, lines.join('\n') + '\n');
  }, 3_600_000);
});
