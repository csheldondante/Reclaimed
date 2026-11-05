// (round 128m, onetown) Tests' fortress: the player editing a town with nothing on it yet (build/site.ts
// TownSite.plain: Townscaper's grid over the box), as the fortresses of rounds 128d-128l stood on a box of their own.
// The window is the world (oz 0). Only tests use it.
import type { FortressBox } from '../api/contracts/fortress';
import { TownSite } from '../build/site';
import { Fortress, type FortressIO } from './fortress';

export function fortressOn(box: FortressBox, io: Omit<FortressIO, 'oz' | 'changed'> & { ground(x: number, y: number): number; changed?: unknown; oz?: () => number }, seed = 7): Fortress {
  const site = TownSite.plain('test', { x0: box.origin[0], y0: box.origin[1], w: box.w, h: box.h }, (x, y) => io.ground(x, y), seed);
  return new Fortress(site, { ...io, oz: io.oz ?? (() => 0), changed: () => {} });
}
