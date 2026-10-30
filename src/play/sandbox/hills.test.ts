// Where to ride (round 118): the hilliest rideable spot, from heights alone.
import { describe, expect, it } from 'vitest';
import { findHills } from './hills';

const opts = { radius: 120, step: 6, climb: 1.5, least: 0.25, bounds: [512, 512] as [number, number], margin: 10 };

describe('findHills', () => {
  it('finds the rolling hills, not the flat and not the cliff', () => {
    // flat everywhere; rolling hills round (300, 200); a sheer cliff (a wall, not a hill) along x = 150
    const h = (x: number, y: number) => {
      const d = Math.hypot(x - 300, y - 200);
      const hills = d < 30 ? 4 * Math.sin(x * 0.35) * Math.cos(y * 0.3) * (1 - d / 30) : 0;
      const cliff = x > 150 && x < 152 && y > 150 && y < 250 ? 40 : 0;
      return 10 + hills + cliff;
    };
    const s = findHills(h, [220, 200], opts);
    expect(s).not.toBeNull();
    expect(Math.hypot(s!.at[0] - 300, s!.at[1] - 200)).toBeLessThan(25);
  });

  it('none on a plain', () => {
    expect(findHills(() => 5, [200, 200], opts)).toBeNull();
  });

  it('skips unread ground and water', () => {
    const h = (x: number, y: number) => (x < 200 ? null : 10 + Math.sin(x * 0.4) * 2);
    const s = findHills(h, [200, 200], { ...opts, dry: (_x, y) => y < 180 });
    expect(s).not.toBeNull();
    expect(s!.at[0]).toBeGreaterThanOrEqual(200);
    expect(s!.at[1]).toBeLessThan(180);
  });
});
