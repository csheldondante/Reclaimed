// A shot's launch velocity (PQ9, the cannonball tool; PQ3, the engine's meteor): the velocity of the given speed that
// carries a body from one point to another under gravity alone, by the flatter of the two arcs. Pure.

export type V3 = [number, number, number];

/**
 * The velocity of size `speed` (cells/s) from `from` that passes through `to` under gravity `g` (cells/s², down z), the
 * flatter arc. Null: out of range at that speed (no speed is added to reach it).
 */
export function launch(from: V3, to: V3, speed: number, g: number): V3 | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const R = Math.hypot(dx, dy);
  const v2 = speed * speed;
  if (R < 1e-6) {
    // (straight down or up: down at once, up only as far as the speed carries)
    if (dz <= 0) return [0, 0, -speed];
    return v2 >= 2 * g * dz ? [0, 0, speed] : null;
  }
  const disc = v2 * v2 - g * (g * R * R + 2 * dz * v2);
  if (disc < 0) return null;
  const tan = (v2 - Math.sqrt(disc)) / (g * R);
  const cos = 1 / Math.sqrt(1 + tan * tan);
  const vh = speed * cos;
  return [(dx / R) * vh, (dy / R) * vh, speed * cos * tan];
}

/** the cells of a ball of radius r (cells) round storage column (x, y), cell z */
export function ballCells(x: number, y: number, z: number, r: number, mat: number): { x: number; y: number; z: number; mat: number }[] {
  const c: { x: number; y: number; z: number; mat: number }[] = [];
  for (let k = -r; k <= r; k++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j + k * k <= r * r + 1) c.push({ x: x + i, y: y + j, z: Math.round(z) + k, mat });
  return c;
}
