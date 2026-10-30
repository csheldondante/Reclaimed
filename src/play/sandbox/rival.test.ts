// The sandbox's rival rider (round 118): it laps its circle, so there's always a rider to hook onto.
import { expect, it } from 'vitest';
import { BIKE_DEFAULTS } from '../controllers/hoverbike';
import { LAP, Rival } from './rival';

it('laps a circle round where it was put, at about its pace', () => {
  const r = new Rival('r', [200, 200], BIKE_DEFAULTS, () => 2, [512, 512]);
  let far = 0;
  let near = Infinity;
  let angle = 0;
  let last = Math.atan2(r.b.y - 200, r.b.x - 200);
  for (let i = 0; i < 600; i++) {
    r.step(1 / 60);
    if (i < 120) continue;
    const d = Math.hypot(r.b.x - 200, r.b.y - 200);
    far = Math.max(far, d);
    near = Math.min(near, d);
    const a = Math.atan2(r.b.y - 200, r.b.x - 200);
    angle += Math.atan2(Math.sin(a - last), Math.cos(a - last));
    last = a;
  }
  expect(far).toBeLessThan(LAP.radius + 10);
  expect(near).toBeGreaterThan(LAP.radius - 10);
  // (round, counter-clockwise: over half a lap in the 8 s measured)
  expect(angle).toBeGreaterThan(Math.PI);
  expect(r.vehicle().vel[0] ** 2 + r.vehicle().vel[1] ** 2).toBeGreaterThan(15 ** 2);
});
