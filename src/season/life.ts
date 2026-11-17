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
  /** (season life) wagons and ships on the trade routes open */
  wagons: number;
  ships: number;
  /** the living town's quarry and clearing on (a quarry or lumber card started or built) */
  quarry: boolean;
  camp: boolean;
}

/** people a card brings (small numbers: hundreds a town at most) */
// (loop round 16, the owner: "increasing the number of towns people will make a huge difference" — the living town
// lab's own defaults are ~950 riders (citylife/params.ts: 600 commuters, 150 farmers, 60 quarrymen, 40 stone carts, 40
// woodcutters, 20 log carts, 40 builders); round 15's loop town began with 90. Now ~330 at a run's start and over 500
// once a few districts stand, all GPU riders: a town's own field hands and trade from the start, more with every
// district built (prosperity), more again for houses, farms and trade)
export const LIFE = {
  /** the town's own before anything's built, more for each houses card built, and for every district built */
  commuters: 240,
  perHouses: 80,
  perBuilt: 15,
  /** the town's own fields worked from the start, and more for each farms card */
  farmers: 40,
  perFarms: 40,
  /** builders: a few always, more for each district being built */
  builders: 20,
  perBuild: 15,
  quarrymen: 40,
  stoneCarts: 16,
  woodcutters: 30,
  logCarts: 12,
  /** trade before any route: carts come and go by the roads; a trade route open: its wagons; its ships, with a
   *  harbour built (one coming and going even before a route) */
  wagonsBase: 10,
  wagons: 14,
  shipsBase: 1,
  ships: 3,
} as const;

export function townLife(l: SeasonLedger): TownLife {
  const built = (id: string) => l.built.filter((b) => b === id).length;
  const going = (id: string) => l.projects.some((p) => p.card.id === id);
  const quarry = built('quarry') > 0 || going('quarry');
  const camp = built('lumber') > 0 || going('lumber');
  const building = l.projects.filter((p) => p.card.work.kind === 'district').length;
  return {
    commuters: LIFE.commuters + LIFE.perHouses * built('houses') + LIFE.perBuilt * l.built.length,
    farmers: LIFE.farmers + LIFE.perFarms * built('farms'),
    builders: LIFE.builders + LIFE.perBuild * building,
    quarrymen: quarry ? LIFE.quarrymen : 0,
    stoneCarts: quarry ? LIFE.stoneCarts : 0,
    woodcutters: camp ? LIFE.woodcutters : 0,
    logCarts: camp ? LIFE.logCarts : 0,
    wagons: LIFE.wagonsBase + LIFE.wagons * built('trade'),
    ships: built('harbour') > 0 ? LIFE.shipsBase + LIFE.ships * built('trade') : 0,
    quarry,
    camp,
  };
}
