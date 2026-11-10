// (round 128r, Track A "Next season") A season realised in the live window (docs/SYSTEMS.md: the atlas-scale outcome
// realised now for the window — "state realisation: ruin, overgrowth and flood applied" — and played as the
// showcase). Each change goes through its owner: the fortress's plan and blocks (markStarted, markBuilt, lowerTo,
// setWear), the plants' grow, the live flood (terrain/basin.ts: one fill, still water held at a level). Nothing here
// decides an outcome: the ledger did (season/ledger.ts); this only says when, within the showcase, each change lands.
//
// `prepare` does what needs the GPU's answer before anything is shown: each flood's fill (its level, its floor) and
// which structures it covers (their wear 'flooded'). Then every step is a plain write, so skipping applies the rest at
// once, in order, and the world ends the same.
import type { ShowStep } from '../api/contracts/simtiers';
import type { Wear } from '../api/contracts/structures';
import type { SeasonChange, SeasonResult } from './ledger';

/** a flood found in the window (terrain/basin.ts Basin) */
export interface SeasonBasin {
  readonly level: number;
  readonly floor: number;
  raise(level: number): void;
  lower(level: number): void;
  submerged(entries: readonly { col: readonly [number, number]; structure: number }[]): Promise<Set<number>>;
  destroy(): void;
}

/** the owners a season writes through */
export interface SeasonWorld {
  scaffold(cell: number, level: number): void;
  stand(cell: number, level: number): void;
  lowerTo(structure: number, storeys: number): void;
  setWear(structure: number, wear: Wear): void;
  grow(x: number, y: number, r: number): void;
  basin(x: number, y: number, level?: number): Promise<SeasonBasin>;
  /** each structure's cells' window columns (what a flood is asked to cover) */
  columns(): { col: [number, number]; structure: number }[];
  /** where a change is (window world), for the camera; null: nowhere to look */
  where(c: SeasonChange): [number, number] | null;
}

/** steps of a rising or falling flood (a held level each; the last exactly the level) */
export const FLOOD_STEPS = 12;

export interface Realised {
  steps: ShowStep[];
  /** where to look at a fraction of the showcase (the change last applied before it, or the next one) */
  focus(t: number): [number, number] | null;
  /** the structures the floods covered (their wear: flooded) */
  flooded: number[];
}

/** The floods' fills and what they cover, then the steps. `floods`: the basins held from earlier seasons, by card. */
export async function prepare(r: SeasonResult, world: SeasonWorld, floods: Map<string, SeasonBasin>): Promise<Realised> {
  const steps: { at: number; apply: () => void; where: [number, number] | null }[] = [];
  const flooded: number[] = [];
  for (const c of r.changes) {
    const where = world.where(c);
    if (c.kind === 'scaffold') steps.push({ at: c.at, where, apply: () => world.scaffold(c.cell, c.level) });
    else if (c.kind === 'stand') steps.push({ at: c.at, where, apply: () => world.stand(c.cell, c.level) });
    else if (c.kind === 'wear')
      steps.push({
        at: c.at,
        where,
        apply: () => {
          world.lowerTo(c.structure, c.storeys);
          world.setWear(c.structure, c.wear);
        },
      });
    else if (c.kind === 'grow') steps.push({ at: c.at, where, apply: () => world.grow(c.x, c.y, c.r) });
    else if (c.kind === 'flood') {
      if (floods.has(c.card)) throw new Error(`season: ${c.card} floods twice`);
      const b = await world.basin(c.x, c.y, c.level);
      floods.set(c.card, b);
      // (the level the fill found is the outcome's: the ledger's AtlasEvent and history mark carry it)
      for (const e of r.atlas) if (e.kind === 'flood' && e.cause.ref === c.card && e.level === undefined) e.level = b.level;
      for (const e of r.story) if (e.what === 'flooded' && e.cause?.startsWith(c.card) && e.level === undefined) e.level = b.level;
      const covered = [...(await b.submerged(world.columns()))].sort((x, y) => x - y);
      flooded.push(...covered);
      for (let k = 1; k <= FLOOD_STEPS; k++) {
        const f = k / FLOOD_STEPS;
        const lv = k === FLOOD_STEPS ? b.level : b.floor + (b.level - b.floor) * f;
        steps.push({ at: c.at + (c.until - c.at) * f, where: [c.x, c.y], apply: () => b.raise(lv) });
      }
      covered.forEach((id, k) => steps.push({ at: c.at + (c.until - c.at) * ((k + 1) / (covered.length + 1)), where: null, apply: () => world.setWear(id, 'flooded') }));
    } else if (c.kind === 'drain') {
      const b = floods.get(c.card);
      if (!b) throw new Error(`season: ${c.card} drains a flood that isn't standing`);
      floods.delete(c.card);
      for (let k = 1; k <= FLOOD_STEPS; k++) {
        const f = k / FLOOD_STEPS;
        const last = k === FLOOD_STEPS;
        const lv = b.level - (b.level - b.floor) * f;
        steps.push({
          at: c.at + (c.until - c.at) * f,
          where,
          apply: () => {
            b.lower(last ? -Infinity : lv);
            if (last) b.destroy();
          },
        });
      }
    }
  }
  const order = steps.map((s, i) => [s, i] as const).sort((a, b) => a[0].at - b[0].at || a[1] - b[1]).map(([s]) => s);
  const looks = order.filter((s) => s.where);
  return {
    steps: order.map(({ at, apply }) => ({ at, apply })),
    focus: (t) => {
      let pick: (typeof looks)[number] | undefined;
      for (const s of looks) if (s.at <= t) pick = s;
      return (pick ?? looks[0])?.where ?? null;
    },
    flooded,
  };
}
