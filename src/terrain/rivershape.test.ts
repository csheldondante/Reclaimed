import { describe, expect, it } from 'vitest';
import { incisionFor, shapeLevels, smooth, upstreamFirst, CASCADE_STEP, type RiverCourse } from './rivershape';

/** a river down a staircase grid line: nodes on a 45-degree zigzag (the texel grid's corners), into the sea */
function zigzag(n: number, fallPer: number): RiverCourse {
  const c: RiverCourse = {
    x: new Float32Array(n), y: new Float32Array(n), level: new Float32Array(n), width: new Float32Array(n).fill(4),
    next: new Int32Array(n), still: new Uint8Array(n), acc: new Float32Array(n), worldW: 4096, worldH: 4096,
  };
  for (let k = 0; k < n; k++) {
    c.x[k] = 100 + k * 8;
    c.y[k] = 100 + (k % 2) * 8;
    c.level[k] = 200 - k * fallPer;
    c.next[k] = Math.min(k + 1, n - 1);
    c.acc[k] = k + 1;
  }
  c.still[n - 1] = 1;
  c.level[n - 1] = 90;
  return c;
}

describe('rivershape', () => {
  it('orders upstream first and finds cycles', () => {
    const o = upstreamFirst(Int32Array.from([1, 2, 2]));
    expect([...o]).toEqual([0, 1, 2]);
    expect(() => upstreamFirst(Int32Array.from([1, 0]))).toThrow(/cycle/);
  });
  it('smooths the grid zigzag and keeps the ends', () => {
    const c = zigzag(12, 0.1);
    const ends = [c.x[0], c.y[0], c.x[11], c.y[11]];
    const dev = () => { let m = 0; for (let k = 1; k < 11; k++) m = Math.max(m, Math.abs(c.y[k] - 104)); return m; };
    expect(dev()).toBe(4);
    smooth(c, 3, 0.5, 5);
    expect(dev()).toBeLessThan(1.5);
    expect([c.x[0], c.y[0], c.x[11], c.y[11]]).toEqual(ends);
  });
  it('never moves a node further than maxMove', () => {
    const c = zigzag(12, 0.1);
    const y0 = Float32Array.from(c.y);
    smooth(c, 20, 1, 2);
    for (let k = 0; k < 12; k++) expect(Math.abs(c.y[k] - y0[k])).toBeLessThanOrEqual(2 + 1e-4);
  });
  it('incises gently sloping rivers under their ground, tapered to the sea', () => {
    const c = zigzag(20, 0.2);
    const before = Float32Array.from(c.level);
    const s = shapeLevels(c);
    expect(s.cascaded).toBe(0);
    expect(before[0] - c.level[0]).toBeCloseTo(incisionFor(4), 4);
    // the node before the mouth: at least a quarter of the incision (one hop of INCISE_RAMP), held no higher than upstream
    expect(before[18] - c.level[18]).toBeGreaterThanOrEqual(incisionFor(4) / 4 - 1e-4);
    expect(before[18] - c.level[18]).toBeLessThanOrEqual(incisionFor(4));
    expect(c.level[19]).toBe(90);
  });
  it('makes steep reaches a staircase of falls and only ever falls', () => {
    const c = zigzag(30, 1.0);
    const s = shapeLevels(c);
    expect(s.cascaded).toBeGreaterThan(20);
    expect(s.falls).toBeGreaterThan(4);
    for (let k = 0; k < 29; k++) expect(c.level[k + 1]).toBeLessThanOrEqual(c.level[k]);
    // treads are flat: most steps are 0 or a whole step
    let flat = 0;
    for (let k = 0; k < 27; k++) { const d = c.level[k] - c.level[k + 1]; if (d < 1e-4) flat++; else expect(d).toBeGreaterThanOrEqual(CASCADE_STEP - 0.01); }
    expect(flat).toBeGreaterThan(10);
  });
  it('a confluence takes the lower of its tributaries and keeps falling', () => {
    // two sources (0, 1) into 2, then 3 into the sea (4)
    const c = zigzag(5, 0.5);
    c.next = Int32Array.from([2, 2, 3, 4, 4]);
    c.level = Float32Array.from([150, 140, 139.5, 139, 90]);
    shapeLevels(c);
    expect(c.level[2]).toBeLessThanOrEqual(Math.min(c.level[0], c.level[1]));
    expect(c.level[3]).toBeLessThanOrEqual(c.level[2]);
  });
  it('never sinks under the lake it runs into', () => {
    const c = zigzag(6, 0.05);
    c.level[5] = c.level[4] - 0.01;
    shapeLevels(c);
    expect(c.level[4]).toBeGreaterThanOrEqual(c.level[5]);
  });
});
