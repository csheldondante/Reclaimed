// Nested scales lab, round 32 step A (docs/design/NESTED_SCALES.md "As built (round 32, step A)"): the cliff rule
// (src/nested/exp/cliffrule.ts) on a synthetic 16 m heightfield with a plateau ending in a curved 80 m cliff (a bay with
// two inside corners, a bump with two outside corners), a long 70 deg slope over four coarse cells up to a 200 m block,
// a ridge with a col (a saddle), a pit, and gentle rolling ground. Sanity and invariants; numbers are printed and only
// bounded. With RA_PICS=1 it also draws the pictures (src/nested/exp/cliffview.ts) into local/nested/rA-*.png.
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import {
  COARSE_M,
  COARSE_U,
  KIND_BOTTOM,
  KIND_SHEET,
  KIND_SPLIT,
  KIND_TOP,
  NBX,
  NBY,
  UPM,
  cellBound,
  cellOf,
  defaultParams,
  deriveRules,
  fineTop,
  notchAt,
  preTop,
  sheetAt,
  type CliffParams,
  type Field,
  type Rules,
} from '../../src/nested/exp/cliffrule';
import { render, type View } from '../../src/nested/exp/cliffview';

export const NXC = 40;
export const NYC = 32;

function sstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
/** the synthetic terrain, metres */
export function terrain(x: number, y: number): number {
  let z = 20 + 2.5 * Math.sin(x / 37) * Math.cos(y / 53) + 1.5 * Math.sin((x + y) / 23);
  // plateau at 100 m: a curved rim, a bay (inside corners), a bump (outside corners); a 4 m wide edge
  const dMain = y - (300 + 40 * Math.sin(x / 90));
  const dBay = Math.min(x - 120, 200 - x, 380 - y);
  const dBump = Math.min(x - 430, 520 - x, y - 196);
  const dP = Math.max(Math.min(dMain, -dBay), dBump);
  z = z + (100 - z) * sstep(-2, 2, dP);
  // the east block: a 70 deg slope (rise 2.75 per metre) from y = 130 to 200 m, a sharp side wall at x = 544
  const zE = 20 + Math.max(0, Math.min(180, (y - 130) * 2.75));
  z = Math.max(z, z + (zE - z) * sstep(-2, 2, x - 544));
  // a ridge along y = 200, 80 m high, 24 m wide, with a col (30 m) at x = 152 (a cell centre: a saddle cell)
  const rh = (80 - 50 * Math.exp(-(((x - 152) / 10) ** 2))) * sstep(40, 50, x) * sstep(250, 240, x);
  z = Math.max(z, 20 + rh * Math.max(0, 1 - Math.abs(y - 200) / 12));
  // a pit 40 m deep, radius 12 m, at a cell centre
  const r = Math.hypot(x - 360, y - 168);
  z -= 40 * sstep(13, 11, r);
  // brush carves (round 32 step A, the owner's addition), stored like any other shape as cell means: a sphere bowl of
  // radius 40 m centred at ground level (20 m), and a trench 48 m wide, 40 m deep, at 27 deg to the grid
  const rb = Math.hypot(x - BOWL[0], y - BOWL[1]);
  if (rb < 40) z = Math.min(z, 20 - Math.sqrt(1600 - rb * rb));
  const ux = x - TRENCH[0];
  const uy = y - TRENCH[1];
  const along = ux * TRENCH_DIR[0] + uy * TRENCH_DIR[1];
  const across = -ux * TRENCH_DIR[1] + uy * TRENCH_DIR[0];
  if (Math.abs(across) < 24 && along > 0 && along < 260) z = Math.min(z, 20 - 40);
  return z;
}
export const BOWL = [120, 90];
export const TRENCH = [250, 40];
export const TRENCH_DIR = [Math.cos((27 * Math.PI) / 180), Math.sin((27 * Math.PI) / 180)];
export function makeField(): Field {
  const h = new Int32Array(NXC * NYC);
  const S = 8;
  for (let cy = 0; cy < NYC; cy++)
    for (let cx = 0; cx < NXC; cx++) {
      let s = 0;
      for (let j = 0; j < S; j++)
        for (let i = 0; i < S; i++) s += terrain(cx * COARSE_M + ((i + 0.5) * COARSE_M) / S, cy * COARSE_M + ((j + 0.5) * COARSE_M) / S);
      h[cy * NXC + cx] = Math.round((s / (S * S)) * UPM);
    }
  return { nx: NXC, ny: NYC, h };
}

function rules(over: Partial<CliffParams> = {}): Rules {
  return deriveRules(makeField(), { ...defaultParams(), ...over });
}
function splits(R: Rules): [number, number][] {
  const out: [number, number][] = [];
  for (let cy = 0; cy < R.f.ny; cy++) for (let cx = 0; cx < R.f.nx; cx++) if (cellOf(R, cx, cy).kind === KIND_SPLIT) out.push([cx, cy]);
  return out;
}
function fineTops(R: Rules, cx: number, cy: number, eroded: boolean): Int32Array {
  const N = 1 << R.p.fineLevel;
  const t = new Int32Array(N * N);
  for (let iy = 0; iy < N; iy++)
    for (let ix = 0; ix < N; ix++) t[iy * N + ix] = (eroded ? fineTop : preTop)(R, cx * N + ix, cy * N + iy);
  return t;
}
const KIND_NAME = ['sheet', 'top (ridge crest / rim)', 'bottom (pit / foot)', 'split'];

describe('nested cliff rule (round 32 step A)', () => {
  const R = rules();
  const N = 1 << R.p.fineLevel;

  it('exercises every kind and fallback', () => {
    const count = [0, 0, 0, 0];
    let saddle = 0;
    let diag = 0;
    for (const c of R.cells) {
      count[c.kind]++;
      if (c.kind === KIND_SPLIT && c.saddle) saddle++;
      if (c.kind === KIND_SPLIT && c.a !== 0 && c.b !== 0) diag++;
    }
    console.log(`kinds: ${count.map((n, k) => `${KIND_NAME[k]} ${n}`).join(', ')}; split by saddle fallback ${saddle}; split with a diagonal direction ${diag}`);
    // named places
    const ridge = cellOf(R, 6, 12); // x 96..112, y 192..208: the ridge crest
    const col = cellOf(R, 9, 12); // the col
    const pit = cellOf(R, 22, 10);
    console.log(`ridge crest (6,12): ${KIND_NAME[ridge.kind]}; col (9,12): ${KIND_NAME[col.kind]} saddle=${col.saddle} dir (${col.a},${col.b}); pit (22,10): ${KIND_NAME[pit.kind]}`);
    for (const [name, x, y] of [
      ['bay inside corner W', 120, 380],
      ['bay inside corner E', 200, 380],
      ['bump outside corner W', 430, 196],
      ['bump outside corner E', 520, 196],
    ] as [string, number, number][]) {
      const cx = Math.floor(x / COARSE_M);
      const cy = Math.floor(y / COARSE_M);
      const ks: string[] = [];
      for (let j = -1; j <= 0; j++)
        for (let i = -1; i <= 0; i++) {
          const c = cellOf(R, cx + i, cy + j);
          ks.push(`(${cx + i},${cy + j}) ${KIND_NAME[c.kind]}${c.kind === KIND_SPLIT ? ` dir (${c.a},${c.b}) F ${c.F}` : ''}`);
        }
      console.log(`${name}: ${ks.join('; ')}`);
    }
    expect(count[KIND_SHEET]).toBeGreaterThan(0);
    expect(count[KIND_TOP]).toBeGreaterThan(0);
    expect(count[KIND_BOTTOM]).toBeGreaterThan(0);
    expect(count[KIND_SPLIT]).toBeGreaterThan(0);
    expect(ridge.kind).toBe(KIND_TOP);
    expect(pit.kind).toBe(KIND_BOTTOM);
    expect(saddle).toBeGreaterThan(0);
    expect(diag).toBeGreaterThan(0);
  });

  it('split cells: tops only H or L (before erosion), L <= h <= H', () => {
    for (const [cx, cy] of splits(R)) {
      const c = cellOf(R, cx, cy);
      expect(c.L).toBeLessThanOrEqual(c.h);
      expect(c.H).toBeGreaterThanOrEqual(c.h);
      const t = fineTops(R, cx, cy, false);
      for (const v of t) expect(v === c.H || v === c.L).toBe(true);
    }
  });

  it('the up level meets a sheet hi neighbour', () => {
    let n = 0;
    let worst = 0;
    let worstFlat = 0;
    for (const [cx, cy] of splits(R)) {
      const c = cellOf(R, cx, cy);
      const k = c.hiN;
      const nb = cellOf(R, cx + NBX[k], cy + NBY[k]);
      if (nb.kind === KIND_SPLIT) continue;
      n++;
      // the neighbour's sheet along the shared edge, at fine column centres
      for (let i = 0; i < N; i++) {
        const along = 2 * i + 1 - N;
        const px = NBX[k] !== 0 ? -NBX[k] * N : along;
        const py = NBY[k] !== 0 ? -NBY[k] * N : along;
        const s = sheetAt(nb, px, py, N);
        worst = Math.max(worst, Math.abs(s - c.H));
        if (Math.abs(nb.ctrl[0] - nb.ctrl[8]) + Math.abs(nb.ctrl[2] - nb.ctrl[6]) === 0) worstFlat = Math.max(worstFlat, Math.abs(s - c.H));
      }
      // exact at the edge midpoint (the sheet's edge value toward an unjoined cell is its own height)
      expect(sheetAt(nb, NBX[k] !== 0 ? -NBX[k] * N : 0, NBY[k] !== 0 ? -NBY[k] * N : 0, N)).toBe(c.H);
    }
    console.log(`split cells with a sheet hi neighbour: ${n}; up level vs the sheet along the shared edge: worst ${worst} units (${(worst / UPM).toFixed(2)} m); on level sheets ${worstFlat}`);
    expect(n).toBeGreaterThan(0);
  });

  it('the conservative bound never under-estimates (every level, every split cell, erosion on and off)', () => {
    for (const erode of [false, true]) {
      const Q = rules({ erode });
      let checked = 0;
      let slackSum = 0;
      for (const [cx, cy] of splits(Q)) {
        const t = fineTops(Q, cx, cy, true);
        for (let l = 0; l <= Q.p.fineLevel; l++) {
          const s = N >> l;
          for (let jy = 0; jy < 1 << l; jy++)
            for (let jx = 0; jx < 1 << l; jx++) {
              let mx = -1e9;
              let mn = 1e9;
              for (let iy = jy * s; iy < jy * s + s; iy++)
                for (let ix = jx * s; ix < jx * s + s; ix++) {
                  mx = Math.max(mx, t[iy * N + ix]);
                  mn = Math.min(mn, t[iy * N + ix]);
                }
              const b = cellBound(Q, cx, cy, l, jx, jy);
              if (b.max < mx || b.min > mn) throw new Error(`bound fails at (${cx},${cy}) l ${l} (${jx},${jy}): ${b.min}..${b.max} vs ${mn}..${mx}`);
              if (b.max !== mx) slackSum++;
              checked++;
            }
        }
      }
      console.log(`bound (erode ${erode}): ${checked} nodes checked, none under; ${((100 * slackSum) / checked).toFixed(1)} % of nodes say "could be up" while all descendants are down (the march's wasted descents)`);
    }
  });

  it('is deterministic', () => {
    const A = rules({ erode: true });
    const B = rules({ erode: true });
    expect(JSON.stringify(A.cells.map((c) => [c.kind, c.H, c.L, c.a, c.b, c.theta, c.dTheta, Array.from(c.ctrl)]))).toBe(
      JSON.stringify(B.cells.map((c) => [c.kind, c.H, c.L, c.a, c.b, c.theta, c.dTheta, Array.from(c.ctrl)])),
    );
    for (const [cx, cy] of splits(A).slice(0, 10)) {
      expect(Array.from(fineTops(A, cx, cy, true))).toEqual(Array.from(fineTops(B, cx, cy, true)));
      for (let z = 0; z < 200 * UPM; z += 37) expect(notchAt(A, cx * N + 5, cy * N + 9, z)).toEqual(notchAt(B, cx * N + 5, cy * N + 9, z));
    }
  });

  it('the children mean vs h, and the stored correction (reported, bounded)', () => {
    const rows: string[] = [];
    const rels: number[] = [];
    for (const [label, over] of [
      ['closed-form theta (no residual)', { exact: false }],
      ['with the stored dTheta', { exact: true }],
      ['dTheta + erosion', { exact: true, erode: true }],
      ['no residual, mask off', { exact: false, maskP: 0 }],
      ['no residual, no raggedness (the closed form alone)', { exact: false, ampL: [0, 0, 0, 0, 0, 0, 0] }],
      ['no residual, independent (not zero-sum) offsets', { exact: false, zeroSum: false }],
    ] as [string, Partial<CliffParams>][]) {
      const Q = rules(over);
      let sum2 = 0;
      let worst = 0;
      let worstRel = 0;
      let n = 0;
      let dts = 0;
      let dtMax = 0;
      for (const [cx, cy] of splits(Q)) {
        const c = cellOf(Q, cx, cy);
        const t = fineTops(Q, cx, cy, !!over.erode);
        let s = 0;
        for (const v of t) s += v;
        const err = s / (N * N) - c.h;
        sum2 += err * err;
        worst = Math.max(worst, Math.abs(err));
        worstRel = Math.max(worstRel, Math.abs(err) / (c.H - c.L));
        dts += Math.abs(c.dTheta);
        dtMax = Math.max(dtMax, Math.abs(c.dTheta));
        n++;
        // exact up to ties: columns with equal scores flip together (integer scores), so the count can overshoot
        // (the 12-bit tie-break can still collide: 2 columns' worth)
        if (over.exact && !over.erode) expect(Math.abs(err)).toBeLessThanOrEqual((2 * (c.H - c.L)) / (N * N));
      }
      rows.push(
        `${label}: ${n} split cells, mean - h RMS ${Math.sqrt(sum2 / n).toFixed(2)} units, worst ${worst.toFixed(2)} units (${(worst / UPM).toFixed(3)} m, ${(100 * worstRel).toFixed(2)} % of H-L); |dTheta| mean ${(dts / n / 4096).toFixed(1)} max ${(dtMax / 4096).toFixed(1)} (w units = half-columns x direction; /4 = fine columns along the dominant axis)`,
      );
      rels.push(worstRel);
    }
    console.log(rows.join('\n'));
    // only bounded: a mean can never leave [L, H]
    for (const r of rels) expect(r).toBeLessThan(1);
  });

  it('notches stay below the top layer and never change tops', () => {
    const cell = COARSE_U >> R.p.fineLevel;
    const unit = cell; // every level keeps its own top cell; the finest level's is the smallest
    let air = 0;
    let probes = 0;
    for (const [cx, cy] of splits(R)) {
      const r = cellOf(R, cx, cy);
      for (let k = 0; k < 64; k++) {
        const gx = cx * N + ((k * 37) % N);
        const gy = cy * N + ((k * 11) % N);
        const top = preTop(R, gx, gy);
        for (let z = r.L; z < r.H; z += cell) {
          probes++;
          const nz = notchAt(R, gx, gy, z);
          if (nz) {
            air++;
            expect(top).toBe(r.H);
            expect(nz[1]).toBeLessThanOrEqual(r.H - unit);
          }
        }
      }
    }
    console.log(`notch probes ${probes}: air ${air} (${((100 * air) / probes).toFixed(2)} % of all up/down column z under H; only faces within depth of a lower column can open)`);
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

export const VIEWS: Record<string, View> = {
  // (round 1's far view had target z 50: its bottom rows met the map's south border at ground height and drew the
  // border's cut as a strip of faces; aimed a little higher, the border is out of frame)
  far: { eye: [300, -170, 190], target: [330, 280, 75], fovDeg: 55, w: 960, h: 640 },
  near: { eye: [262, 205, 72], target: [262, 312, 60], fovDeg: 50, w: 960, h: 640 },
  above: { eye: [300, 240, 235], target: [300, 318, 95], fovDeg: 55, w: 960, h: 640 },
  // the carves: into the bowl from its south rim, along the trench from its west end, and both from above
  bowl: { eye: [120, 42, 34], target: [120, 110, -8], fovDeg: 60, w: 960, h: 640 },
  trench: { eye: [232, 31, 50], target: [393, 113, -10], fovDeg: 55, w: 960, h: 640 },
  carves: { eye: [210, -10, 300], target: [230, 95, 0], fovDeg: 60, w: 960, h: 640 },
};

const all = (x: number) => [0, x, x, x, x, x, x];
/** the same share and depth 1..4 at every level */
const dramatic = (pct: number): Partial<CliffParams> => ({ notchPctL: all(pct), notchDepthL: all(4) });
/** per-level caps: 8 m 5 % depth <= 1, 4 m 10 % <= 2, 2 m and finer 15 % <= 4 */
const tame: Partial<CliffParams> = { notchPctL: [0, 5, 10, 15, 15, 15, 15], notchDepthL: [0, 1, 2, 4, 4, 4, 4] };

describe.skipIf(!process.env.RA_PICS)('nested cliff rule pictures', () => {
  it('draws local/nested/rA-*.png', () => {
    mkdirSync('local/nested', { recursive: true });
    const only = process.env.RA_ONLY;
    const jobs: [string, string, Partial<CliffParams>][] = [];
    const P = process.env.RA_PREFIX ?? 'rA2';
    for (const v of ['far', 'near', 'above', 'bowl', 'trench', 'carves']) jobs.push([`${P}-${v}-dramatic15`, v, dramatic(15)]);
    jobs.push([`${P}-near-dramatic30`, 'near', dramatic(30)]);
    jobs.push([`${P}-near-tame`, 'near', tame]);
    jobs.push([`${P}-bowl-tame`, 'bowl', tame]);
    jobs.push([`${P}-near-nonotch`, 'near', dramatic(0)]);
    jobs.push([`${P}-near-tame-erode`, 'near', { ...tame, erode: true }]);
    const lines: string[] = [];
    for (const [name, v, over] of jobs) {
      if (only && !name.includes(only)) continue;
      const Q = rules(over);
      const t0 = performance.now();
      const pic = render(Q, VIEWS[v]);
      const ms = performance.now() - t0;
      writeFileSync(`local/nested/${name}.png`, png(pic.rgb, pic.w, pic.h));
      const line = `${name}: steps/px mean ${pic.meanSteps.toFixed(1)} max ${pic.maxSteps} capped ${pic.capped}; shadow rays (sunward hits) mean ${pic.meanShadowSteps.toFixed(1)} max ${pic.maxShadowSteps}; ${(ms / 1000).toFixed(1)} s`;
      console.log(line);
      lines.push(line);
    }
    writeFileSync(`local/nested/${P}-steps${only ? '-' + only : ''}.txt`, lines.join('\n') + '\n');
  }, 1_800_000);
});
