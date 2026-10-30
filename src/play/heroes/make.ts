// ---- play/heroes/make.ts ----------------------------------------------------------------------------------------
// A hero by its controller's id (round 117): the library's entries (play/library.ts) and the modules that play them.

import type { ControllerInfo, Params } from '../../api/contracts/play';
import type { V2 } from '../../api/contracts/units';
import type { BikeParams } from '../controllers/hoverbike';
import type { LichParams } from '../controllers/lich';
import { library } from '../library';
import type { PlayWorld } from '../world';
import type { PlayHero } from './base';
import { BikeHero } from './bike';
import { LichHero } from './lich';

export type PlayHeroId = 'hoverbike' | 'lich';

export const heroes = (): readonly ControllerInfo[] => library.controllers();

export function makeHero(id: PlayHeroId, world: PlayWorld, at: V2, params?: Params): PlayHero {
  const info = library.get(id);
  if (!info) throw new Error(`play: no controller "${id}" (${heroes().map((h) => h.id).join(', ')})`);
  const p = { ...info.defaults, ...params };
  switch (id) {
    case 'hoverbike':
      return new BikeHero(world, at, p as unknown as BikeParams);
    case 'lich':
      return new LichHero(world, at, p as unknown as LichParams);
  }
}
