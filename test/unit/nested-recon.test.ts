// Nested scales lab, round 30 (docs/design/NESTED_SCALES.md "As built (round 30)"): a CPU-only numbers experiment. A
// shape stored at one level with no finer data: how close is the 8x finer child level to the true shape, by what each
// parent column stores (src/nested/exp/recon.ts)? Prints a table and writes it to local/nested/r30-recon.md. Asserts only
// sanity (the smooth control is close in every variant, A keeps each parent's mean, fixed point keeps it in integers),
// never which variant wins.
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  MAX_SLOPE,
  NC,
  NP16,
  SHAPES,
  VERTICAL_DEG,
  band,
  childTruth,
  errOf,
  flags,
  gradients,
  lines,
  quantChildren,
  quantGrid,
  reconA,
  reconC,
  reconLine,
  restrictGrid,
  type Err,
  type Grid,
} from '../../src/nested/exp/recon';

const f2 = (x: number) => x.toFixed(2);
const row = (name: string, e: Err) => `| ${name} | ${f2(e.rms)} | ${f2(e.max)} | ${e.over2} |`;

describe('nested scales round 30: reconstruction from parent data only', () => {
  it('measures every shape x variant', () => {
    const md: string[] = [];
    md.push('# Round 30: child reconstruction from parent data only');
    md.push('');
    md.push(`Parents 16 m (E: 32 m), children 2 m, window ${NP16} x ${NP16} parents. Errors in metres over the band (children`);
    md.push('within 32 m of the feature, 48 m off the border). over2 = children with error > 2 m.');
    md.push("B/D: each side filled from the nearest unflagged cells on that side (any cell on it where the 5 x 5 has none); B'/D': from any cell on that side (round 24's rule). m: the block's mean restored (sin^2 bump).");
    md.push(`C/E gradient clamp |grad| <= ${MAX_SLOPE.toFixed(3)} (70 deg). D: tilt >= ${VERTICAL_DEG} deg counts as vertical (= B).`);
    md.push('');
    const fixedRows: string[] = [];
    for (let si = 0; si < SHAPES.length; si++) {
      const s = SHAPES[si];
      const T = childTruth(s);
      const P16 = restrictGrid(T, 8);
      const P32 = restrictGrid(T, 16);
      const mask = band(s);
      const A16 = reconA(P16, 8);
      const A32 = reconA(P32, 16);
      const g16 = gradients(s, P16.n, P16.w);
      const g32 = gradients(s, P32.n, P32.w);
      const C16 = reconC(P16, g16.gx, g16.gy, 2, NC);
      const C32 = reconC(P32, g32.gx, g32.gy, 2, NC);
      const res: [string, Err][] = [
        ['A  PPM (16 m)', errOf(A16, T, mask)],
        ['C  Hermite h+grad (16 m)', errOf(C16, T, mask)],
      ];
      const flagInfo: string[] = [];
      // the parents whose children have an A error over 2 m (anywhere off the border), and whether the flag finds them
      const need: number[] = [];
      for (let py = 3; py < NP16 - 3; py++)
        for (let px = 3; px < NP16 - 3; px++) {
          let mx = 0;
          for (let b = 0; b < 8; b++) for (let a = 0; a < 8; a++) {
            const i = (py * 8 + b) * NC + px * 8 + a;
            mx = Math.max(mx, Math.abs(A16.v[i] - T.v[i]));
          }
          if (mx > 2) need.push(py * NP16 + px);
        }
      const bandParents = new Set<number>();
      for (let i = 0; i < mask.length; i++) if (mask[i]) bandParents.add(Math.floor(Math.floor(i / NC) / 8) * NP16 + Math.floor((i % NC) / 8));
      let Dm16: Grid | null = null;
      let Bm16: Grid | null = null;
      for (const thr of [16, 8]) {
        const fl = flags(P16, thr);
        const ln = lines(P16, fl, s);
        const B = reconLine(P16, 8, fl, ln, { normal: false, mean: false });
        const Bm = reconLine(P16, 8, fl, ln, { normal: false, mean: true });
        const D = reconLine(P16, 8, fl, ln, { normal: true, mean: false });
        const Dm = reconLine(P16, 8, fl, ln, { normal: true, mean: true });
        if (thr === 16) {
          Bm16 = Bm;
          Dm16 = Dm;
        }
        res.push([`B  line (flag > ${thr} m)`, errOf(B, T, mask)]);
        res.push([`Bm line + mean (flag > ${thr} m)`, errOf(Bm, T, mask)]);
        res.push([`D  line + normal (flag > ${thr} m)`, errOf(D, T, mask)]);
        res.push([`Dm line + normal + mean (flag > ${thr} m)`, errOf(Dm, T, mask)]);
        res.push([`B' line, any-cell fill (flag > ${thr} m)`, errOf(reconLine(P16, 8, fl, ln, { normal: false, mean: false, anyCell: true }), T, mask)]);
        res.push([`D' line + normal, any-cell fill (flag > ${thr} m)`, errOf(reconLine(P16, 8, fl, ln, { normal: true, mean: false, anyCell: true }), T, mask)]);
        let nf = 0;
        let nfb = 0;
        let nl = 0;
        for (let i = 0; i < fl.length; i++) {
          nf += fl[i];
          if (fl[i] && bandParents.has(i)) nfb++;
          if (ln[i]) nl++;
        }
        const miss = need.filter((p) => !fl[p]).length;
        flagInfo.push(
          `flag > ${thr} m: ${nf} of ${fl.length} parents flagged (${((100 * nf) / fl.length).toFixed(1)}%; ${nfb} of ${bandParents.size} band parents, ${((100 * nfb) / bandParents.size).toFixed(1)}%), ${nl} keep a line; parents with an A child error > 2 m: ${need.length}, not flagged (misses): ${miss}`,
        );
      }
      res.push(['E  Hermite h+grad (32 m)', errOf(C32, T, mask)]);
      res.push(['E  A PPM (32 m)', errOf(A32, T, mask)]);
      md.push(`## ${si + 1}. ${s.name}`);
      md.push('');
      md.push('| variant | RMS m | max m | over2 |');
      md.push('|---|---|---|---|');
      for (const [n, e] of res) md.push(row(n, e));
      md.push('');
      md.push(`band: ${res[0][1].n} children. ${flagInfo.join('. ')}.`);
      md.push('');

      // sanity: A keeps each parent's mean (float)
      let worst = 0;
      for (let py = 0; py < NP16; py++)
        for (let px = 0; px < NP16; px++) {
          let sum = 0;
          for (let b = 0; b < 8; b++) for (let a = 0; a < 8; a++) sum += A16.v[(py * 8 + b) * NC + px * 8 + a];
          worst = Math.max(worst, Math.abs(sum / 64 - P16.v[py * NP16 + px]));
        }
      expect(worst).toBeLessThan(1e-6);
      if (si === SHAPES.length - 1) for (const [, e] of res) expect(e.rms).toBeLessThan(0.5);

      // fixed point on shape 1 (small bowl) and shape 5 (gentle hill)
      if (si === 0 || si === 4) {
        const fl = flags(P16, 16);
        const ln = lines(P16, fl, s);
        const base: Record<string, Err> = { A: errOf(A16, T, mask), Bm: errOf(Bm16!, T, mask), Dm: errOf(Dm16!, T, mask), C: errOf(C16, T, mask) };
        for (const scale of [8, 64, 1024]) {
          const Pq = quantGrid(P16, scale);
          const outs: [string, Grid, boolean][] = [
            ['A', reconA(Pq, 8), true],
            ['Bm', reconLine(Pq, 8, fl, ln, { normal: false, mean: true }), true],
            ['Dm', reconLine(Pq, 8, fl, ln, { normal: true, mean: true }), true],
            ['C', reconC(Pq, g16.gx, g16.gy, 2, NC), false],
          ];
          for (const [name, g, enforce] of outs) {
            const q = quantChildren(g, Pq, 8, scale, enforce);
            const e = errOf(q.g, T, mask);
            const b0 = base[name];
            // with the remainder handed out, every block sums exactly to 64 x its integer parent
            if (enforce) {
              for (let py = 0; py < NP16; py += 7)
                for (let px = 0; px < NP16; px += 7) {
                  let sum = 0;
                  for (let b = 0; b < 8; b++) for (let a = 0; a < 8; a++) sum += Math.round(q.g.v[(py * 8 + b) * NC + px * 8 + a] * scale);
                  expect(sum).toBe(64 * Math.round(Pq.v[py * NP16 + px] * scale));
                }
            }
            fixedRows.push(
              `| ${si + 1} | 1/${scale} | ${name} | ${f2(e.rms)} (${e.rms - b0.rms >= 0 ? '+' : ''}${(e.rms - b0.rms).toFixed(4)}) | ${f2(e.max)} (${e.max - b0.max >= 0 ? '+' : ''}${(e.max - b0.max).toFixed(4)}) | ${enforce ? 'yes' : 'no (reported only)'} | ${q.maxRem} / ${q.meanRem.toFixed(2)} |`,
            );
          }
        }
      }
    }
    md.push('## Fixed point (parents and children rounded to integers of the unit; flag > 16 m)');
    md.push('');
    md.push('Added error in brackets vs the float run of the same variant. Remainder: k^2 x parent - sum(rounded children), in units, max / mean over blocks, before handing out (largest remainder, one unit a child).');
    md.push('');
    md.push('| shape | unit m | variant | RMS m (added) | max m (added) | sum kept exact | remainder max / mean |');
    md.push('|---|---|---|---|---|---|---|');
    md.push(...fixedRows);
    md.push('');
    const text = md.join('\n');
    console.log(text);
    mkdirSync('local/nested', { recursive: true });
    writeFileSync('local/nested/r30-recon.md', text);
  }, 600_000);
});
