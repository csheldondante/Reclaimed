// (trackA-seasonlife, docs/design/SEASON_LOOP.md "Season life") What the town's people do, from the season's ledger:
// the living town's job counts and its works switched on (citylife's one input, its parameters). Pure: the ledger in,
// the counts out; the season loop passes them to the living town after each season (season/loop.ts host.life).
import type { SeasonLedger } from './ledger';

export interface TownLife {
  commuters: number;
  farmers: number;
  builders: number;
  quarrymen: number;
  stoneCarts: number;
  woodcutters: number;
  logCarts: number;
  /** the living town's quarry and clearing on (a quarry or lumber card started or built) */
  quarry: boolean;
  camp: boolean;
}

/** people a card brings (small numbers: hundreds a town at most) */
export const LIFE = {
  /** the town's own before anything's built, and more for each houses card built */
  commuters: 80,
  perHouses: 60,
  perFarms: 30,
  /** builders: a few always, more for each district being built */
  builders: 10,
  perBuild: 15,
  quarrymen: 40,
  stoneCarts: 16,
  woodcutters: 30,
  logCarts: 12,
} as const;

export function townLife(l: SeasonLedger): TownLife {
  const built = (id: string) => l.built.filter((b) => b === id).length;
  const going = (id: string) => l.projects.some((p) => p.card.id === id);
  const quarry = built('quarry') > 0 || going('quarry');
  const camp = built('lumber') > 0 || going('lumber');
  const building = l.projects.filter((p) => p.card.work.kind === 'district').length;
  return {
    commuters: LIFE.commuters + LIFE.perHouses * built('houses'),
    farmers: LIFE.perFarms * built('farms'),
    builders: LIFE.builders + LIFE.perBuild * building,
    quarrymen: quarry ? LIFE.quarrymen : 0,
    stoneCarts: quarry ? LIFE.stoneCarts : 0,
    woodcutters: camp ? LIFE.woodcutters : 0,
    logCarts: camp ? LIFE.logCarts : 0,
    quarry,
    camp,
  };
}
