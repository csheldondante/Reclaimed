// (round 121, herolab) A synthetic SightWorld for the camera's Node tests: flat ground at 0 and boxes on it.
import type { SightWorld } from '../../api/contracts/camera';

/** a flat world at height 0 with walls: boxes [x0, y0, x1, y1, height] */
export function boxWorld(boxes: [number, number, number, number, number][], size = 128): SightWorld {
  const top = (x: number, y: number) => {
    let h = 0;
    for (const [x0, y0, x1, y1, bh] of boxes) if (x >= x0 && x < x1 && y >= y0 && y < y1) h = Math.max(h, bh);
    return h;
  };
  return {
    solid: (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? null : [{ z0: -2, z1: top(x, y) }]),
    top,
    ceiling: 64,
    bounds: [size, size],
  };
}

