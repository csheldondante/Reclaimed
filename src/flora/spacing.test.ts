// Round 125 (forest): the trees' jittered grid — spacing, density, the elder woods (src/flora/spacing.ts).
import { describe, expect, test } from 'vitest';
import { cellPos } from '../world/lattice';
import { ELDER_K, elderWood, SLOT_H, SLOT_W, slotAt, type Slot } from './spacing';

/** every slot of a kind in a world rectangle of columns, as world points */
function slots(kind: Slot, x0: number, y0: number, w: number, h: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (slotAt(x, y) === kind) out.push(cellPos(x, y));
  return out;
}
function nearest(ps: [number, number][]): number[] {
  return ps.map((p, i) => {
    let d = Infinity;
    for (let j = 0; j < ps.length; j++) if (j !== i) d = Math.min(d, Math.hypot(ps[j][0] - p[0], ps[j][1] - p[1]));
    return d;
  });
}
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

describe('tree slots', () => {
  test('one candidate a block, never two trees within ~3 cells, ~6-7 cells apart on average', () => {
    // (a stretch of world far from the origin, negative too: floor division)
    for (const [x0, y0] of [[-700, -400], [12000, 4800]]) {
      const ps = [...slots('tree', x0, y0, 140, 160), ...slots('elder', x0, y0, 140, 160)];
      const nn = nearest(ps);
      expect(Math.min(...nn)).toBeGreaterThanOrEqual(2.5);
      // (outside elder woods ~one a block)
      const blocks = (140 / SLOT_W) * (160 / SLOT_H);
      const trees = slots('tree', x0, y0, 140, 160).length;
      const elders = slots('elder', x0, y0, 140, 160).length;
      expect(trees + elders * ELDER_K * ELDER_K).toBeGreaterThan(blocks * 0.9);
      expect(trees + elders * ELDER_K * ELDER_K).toBeLessThanOrEqual(blocks);
      expect(mean(nn)).toBeGreaterThan(4.5);
      expect(mean(nn)).toBeLessThan(8);
    }
  });

  test('exactly one slot a block (outside elder super-blocks)', () => {
    for (let by = -6; by < 6; by++)
      for (let bx = -6; bx < 6; bx++) {
        let n = 0;
        let e = 0;
        for (let y = by * SLOT_H; y < (by + 1) * SLOT_H; y++)
          for (let x = bx * SLOT_W; x < (bx + 1) * SLOT_W; x++) {
            const s = slotAt(x, y);
            if (s === 'tree') n++;
            if (s === 'elder') e++;
          }
        expect(n + e).toBeLessThanOrEqual(1);
      }
  });

  test('elder woods: a patchwork over the world; inside one the elders stand ~7+ cells apart, ~14 on average', () => {
    let inWood = 0;
    const N = 160;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (elderWood(x * 9, y * 9) > 0.5) inWood++;
    const share = inWood / (N * N);
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.35);
    // the heart of a wood: find a column deep in one
    let at: [number, number] | null = null;
    const deep = (x: number, y: number) => [0, 20, 40, 60, 80].every((i) => [0, 22, 45, 67, 90].every((j) => elderWood(x + i, y + j) > 0.99));
    for (let y = 0; y < 6000 && !at; y += 13) for (let x = 0; x < 6000 && !at; x += 13) if (deep(x, y)) at = [x, y];
    expect(at).not.toBeNull();
    const [x0, y0] = at!;
    const el = slots('elder', x0, y0, 80, 90);
    expect(el.length).toBeGreaterThan(14);
    expect(slots('tree', x0, y0, 80, 90).length).toBeLessThan(el.length * 0.25);
    const nn = nearest(el);
    expect(Math.min(...nn)).toBeGreaterThanOrEqual(6);
    expect(mean(nn)).toBeGreaterThan(10);
  });
});
