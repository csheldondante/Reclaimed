// Inspect (round 128d; the user: "Maybe an inspect to highlight a continuous section of structure and see its output
// input workers and stockpiles if applicable"): a tap on a block picks the structure it belongs to (the cells painted
// with one type that touch — FortressPlan's structures); it's drawn highlighted (pieces.ts PIECE_PICKED) and a compact
// card says what it is, from its StructureDef and the live ledger (the stores):
//   its type and size (blocks, levels high); how far it's built, if it isn't yet;
//   what it takes in and puts out a day (from its built blocks; made only once it's worked — nobody works yet: jobs come
//   in milestone 3, recipes in 4, so nothing is taken in);
//   its workers (assigned of its slots); its stock (a warehouse: what the stores hold, its room; barracks: the soldiers);
//   its power (the keep: a day from its built blocks, and what's stored).
// Pure, so the numbers are tested (inspect.test.ts) and the writing lint reads every line.
import type { Goods, PerBlock, Structure, StructureDef, StructureType } from '../api/contracts/fortress';
import { DEFS } from './defs';
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
  /** workers: those assigned (nobody yet: milestone 3) and its slots (jobs of its built blocks) */
  workers: number;
  slots: number;
  /** beds (houses, barracks), archers' posts (walls), goods it has room for (a warehouse) — of its built blocks */
  beds: number;
  posts: number;
  room: number;
  /** a warehouse: what the stores hold (the ledger); barracks: the soldiers */
  stock: Goods | null;
  soldiers: number | null;
  /** the keep: power a day from its built blocks, and what's stored */
  power: number | null;
  powerStored: number | null;
}

/** The facts on a structure (built: whether a block stands; stores: the ledger now). */
export function inspectFacts(
  plan: FortressPlan,
  s: Structure,
  built: (cell: number, level: number) => boolean,
  stores: Goods,
  defs: Record<StructureType, StructureDef> = DEFS,
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
    workers: 0,
    slots: (per.jobs ?? 0) * done,
    beds: (per.beds ?? 0) * done,
    posts: (per.posts ?? 0) * done,
    room: (per.storage ?? 0) * done,
    stock: s.type === 'warehouse' ? { log: stores.log ?? 0, stone: stores.stone ?? 0, grain: stores.grain ?? 0, weapons: stores.weapons ?? 0 } : null,
    soldiers: s.type === 'barracks' ? Math.floor(stores.soldiers ?? 0) : null,
    power,
    powerStored: power !== null ? Math.floor(stores.power ?? 0) : null,
  };
}

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
    lines.push(`In: ${goodsText(f.takes)}. Out: ${out === 'nothing' ? 'nothing yet' : `${out} a day once worked`}.`);
  }
  if (def.perBlock.jobs) lines.push(`Workers: ${f.workers} of ${f.slots}.${f.slots > 0 && f.workers === 0 ? ' Nobody works here yet.' : ''}`);
  if (def.perBlock.beds) lines.push(`Beds: ${f.beds}.`);
  if (def.perBlock.posts) lines.push(`Archers: 0 of ${f.posts} posts.`);
  if (f.stock) {
    const held = goodsText(f.stock);
    // (before any block stands: the room it will have)
    const room = f.built > 0 ? `Room for ${f.room}.` : `Room for ${(defs[f.type].perBlock.storage ?? 0) * f.blocks} once built.`;
    lines.push(`Holds ${held === 'nothing' ? 'nothing' : held}. ${room}`);
  }
  if (f.soldiers !== null) lines.push(`Soldiers: ${f.soldiers}.`);
  if (f.power !== null) lines.push(`Power: +${Math.round(f.power)} a day. ${f.powerStored} stored.`);
  return { title: `${name}: ${size}`, lines };
}
