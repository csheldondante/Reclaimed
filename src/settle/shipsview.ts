// The sailing ships as the player sees them (round 120, `cities`; BACKLOG STR32): each frame, the fleet's ships near the
// camera (settle/ships.ts Fleet: a pure function of the time) drawn as moving pieces (structures/gpu.ts setMoving: a
// few pieces rewritten in place, the town's static pieces untouched). One concern: showing where the fleet says the
// ships are; where they sail is ships.ts'.
import type { V2 } from '../api/contracts/units';
import type { StructureStyleId } from '../api/contracts/structures';
import type { StructureGpu } from '../structures/gpu';
import { MOVING_CAP } from '../structures/gpu';
import { shipPieces } from '../structures/pieces';
import type { Fleet } from './ships';

export interface ShipsIO {
  sg: StructureGpu;
  /** world (atlas units) → the window's */
  toWindow(at: V2): V2;
  oz(): number;
  /** the camera's point (window units) */
  focus(): V2;
  /** the simulation's time (s): ?speed= runs the ships faster too */
  time(): number;
  /** the sea's level (world z) */
  sea: number;
  style: StructureStyleId;
}

/** how far from the camera a ship is drawn (window units) */
const REACH = 900;

export class ShipsView {
  readonly stats = { ships: 0, shown: 0, ms: 0 };

  constructor(private io: ShipsIO, private fleet: Fleet) {
    this.stats.ships = fleet.count;
  }

  update(): void {
    const t0 = performance.now();
    const t = this.io.time();
    const [fx, fy] = this.io.focus();
    const oz = this.io.oz();
    const near = [];
    for (const s of this.fleet.at(t, this.io.sea)) {
      const [x, y] = this.io.toWindow([s.at[0], s.at[1]]);
      const d = Math.hypot(x - fx, y - fy);
      if (d > REACH) continue;
      // (a slow bob and roll on the swell: the hull's waterline at the sea)
      near.push({ d, b: { ...s, at: [x, y, s.at[2] - oz + 0.08 * Math.sin(t * 0.9 + s.seed * 20)] as [number, number, number] } });
    }
    near.sort((a, b) => a.d - b.d);
    const shown = near.slice(0, MOVING_CAP).map((n) => n.b);
    this.io.sg.setMoving(shipPieces(shown, this.io.style));
    this.stats.shown = shown.length;
    this.stats.ms = +(performance.now() - t0).toFixed(2);
  }
}
