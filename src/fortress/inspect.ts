// Inspect (round 128d; the user: "Maybe an inspect to highlight a continuous section of structure and see its output
// input workers and stockpiles if applicable"): a tap on a block picks the structure it belongs to (the cells painted
// with one type that touch — FortressPlan's structures); it's drawn highlighted (pieces.ts PIECE_PICKED) and a compact
// card says what it is, from its StructureDef and the live ledger (the stores):
//   its type and size (blocks, levels high); how far it's built, if it isn't yet;
//   what it takes in and puts out a day (from its built blocks, at most: with every job filled; recipes come in
//   milestone 4, so nothing is taken in); (milestone 3) what its workers have brought to the stores so far, a farm's
//   ripe grain;
//   its workers (the JobBoard's, live, of its slots); its stock (a warehouse: what the town's stores hold against their
//   room — the town's own and every warehouse's — and this one's part; barracks: the soldiers);
//   its power (the keep: a day from its built blocks, and what's stored).
// Pure, so the numbers are tested (inspect.test.ts) and the writing lint reads every line.
import type { Goods, PerBlock, Structure, StructureDef, StructureType } from '../api/contracts/fortress';
import { DEFS } from './defs';
import { roomOf } from './economy';
import type { FortressPlan } from './plan';
import { goodsText } from './words';

export interface InspectFacts {
  type: StructureType;
  /** blocks planned (built ones counted too) and built */
  blocks: number;
  built: number;
  /** how many levels high its tallest cell is */
  levels: number;
  /** cells it covers */
  cells: number;
  /** a day from its built blocks: what it makes once worked, what it takes in */
  makes: Goods;
  takes: Goods;
  /** workers: those the JobBoard gave it now, and its slots (jobs of its built blocks) */
  workers: number;
  slots: number;
  /** (milestone 3) what its workers have brought to the stores so far; a farm's ripe grain (null: not a farm) */
  brought: Goods;
  ripe: number | null;
  /** beds (houses, barracks), archers' posts (walls), goods it has room for (a warehouse) — of its built blocks */
  beds: number;
  posts: number;
  room: number;
  /**
   * (round 128d) a warehouse: the stores' room (milestone 3: the town's own and every warehouse's built blocks'). The
   * stores are the town's, one ledger — a warehouse doesn't hold goods of its own — so the card speaks of the stores
   * against their room, and this one's part of it (the user: "Holds 118 wood, 56 stone and 167 grain. Room for 50."
   * read as more than its room)
   */
  allRoom: number;
  /** a warehouse: what the stores hold (the ledger); barracks: the soldiers */
  stock: Goods | null;
  soldiers: number | null;
  /** the keep: power a day from its built blocks, and what's stored */
  power: number | null;
  powerStored: number | null;
}

/** (milestone 3) the economy now, for one structure (Fortress.status): its workers, what they brought, its ripe grain */
export interface InspectLive {
  workers?: number;
  brought?: Goods;
  ripe?: number;
}

/** The facts on a structure (built: whether a block stands; stores: the ledger now; live: the economy's numbers). */
export function inspectFacts(
  plan: FortressPlan,
  s: Structure,
  built: (cell: number, level: number) => boolean,
  stores: Goods,
  defs: Record<StructureType, StructureDef> = DEFS,
  live: InspectLive = {},
): InspectFacts {
  const def = defs[s.type];
  let blocks = 0;
  let done = 0;
  let levels = 0;
  for (const c of s.cells.keys())
    for (const L of plan.levels.each(c)) {
      blocks++;
      if (built(c, L)) done++;
      levels = Math.max(levels, L + 1);
    }
  const per: PerBlock = def.perBlock;
  const makes: Goods = {};
  for (const [k, v] of Object.entries(per.makes ?? {}) as [keyof Goods, number][]) makes[k] = v * done;
  const power = per.power ? plan.power(s, built) : null;
  return {
    type: s.type,
    blocks,
    built: done,
    levels,
    cells: s.cells.size,
    makes,
    takes: {},
    workers: live.workers ?? 0,
    slots: (per.jobs ?? 0) * done,
    brought: live.brought ?? {},
    ripe: s.type === 'farm' ? (live.ripe ?? 0) : null,
    beds: (per.beds ?? 0) * done,
    posts: (per.posts ?? 0) * done,
    room: (per.storage ?? 0) * done,
    allRoom: s.type === 'warehouse' ? roomOf(plan, built, defs) : 0,
    stock: s.type === 'warehouse' ? { log: stores.log ?? 0, stone: stores.stone ?? 0, ore: stores.ore ?? 0, grain: stores.grain ?? 0, weapons: stores.weapons ?? 0 } : null,
    soldiers: s.type === 'barracks' ? Math.floor(stores.soldiers ?? 0) : null,
    power,
    powerStored: power !== null ? Math.floor(stores.power ?? 0) : null,
  };
}

/** goods counted in the stores (not soldiers, not power) */
const STORED = ['log', 'stone', 'ore', 'grain', 'weapons'] as const;

/** The card: a title and a few plain lines (docs/WRITING.md). */
export function inspectCard(f: InspectFacts, defs: Record<StructureType, StructureDef> = DEFS): { title: string; lines: string[] } {
  const def = defs[f.type];
  const name = def.one.charAt(0).toUpperCase() + def.one.slice(1);
  const size =
    def.form === 'yard'
      ? `${f.cells} ${f.cells === 1 ? 'cell' : 'cells'}`
      : `${f.blocks} ${f.blocks === 1 ? 'block' : 'blocks'}, ${f.levels} ${f.levels === 1 ? 'level' : 'levels'} high`;
  const lines: string[] = [];
  if (f.built < f.blocks) lines.push(f.built === 0 ? 'Not built yet.' : `${f.built} of ${f.blocks} blocks built.`);
  const out = goodsText(f.makes);
  if (out !== 'nothing' || def.perBlock.makes) {
    // (milestone 3: at most — with every job filled; the farm's grain grows whoever works it)
    lines.push(`In: ${goodsText(f.takes)}. Out: ${out === 'nothing' ? 'nothing yet' : `up to ${out} a day`}.`);
    if (f.type === 'quarry' && out !== 'nothing') lines.push(`Some of the stone is ore.`);
  }
  if (def.perBlock.jobs) lines.push(`Workers: ${f.workers} of ${f.slots}.${f.slots > 0 && f.workers === 0 ? ' Nobody works here yet.' : ''}`);
  if (f.ripe !== null && f.built > 0) lines.push(`Ripe grain in the fields: ${Math.floor(f.ripe)}.`);
  const brought = goodsText(f.brought);
  if (brought !== 'nothing') lines.push(`Brought to the stores so far: ${brought}.`);
  if (def.perBlock.beds) lines.push(`Beds: ${f.beds}.`);
  if (def.perBlock.posts) lines.push(`Archers: 0 of ${f.posts} posts.`);
  if (f.stock) {
    // (the stores are the town's: what they hold against all the warehouses' room, then this one's part — round 128d)
    const held = goodsText(f.stock);
    const total = STORED.reduce((n, k) => n + Math.round(f.stock![k] ?? 0), 0);
    lines.push(held === 'nothing' ? "The town's stores are empty." : `The town's stores hold ${total} goods: ${held}.`);
    if (f.built > 0) {
      lines.push(`The stores have room for ${f.allRoom} goods. This one gives ${f.room} of it.`);
      if (total > f.allRoom) lines.push(`The stores hold ${total - f.allRoom} more than that.`);
    } else lines.push(`This one gives room for ${(defs[f.type].perBlock.storage ?? 0) * f.blocks} more goods once built.`);
  }
  if (f.soldiers !== null) lines.push(`Soldiers: ${f.soldiers}.`);
  if (f.power !== null) lines.push(`Power: +${Math.round(f.power)} a day. ${f.powerStored} stored.`);
  return { title: `${name}: ${size}`, lines };
}
