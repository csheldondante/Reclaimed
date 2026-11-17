// (card-table, docs/design/FACTORY.md) The goods of the factory game: named piles in the town's stock
// (`holdings.goods`, one number per id), beside the old pools. Raw goods are dug, felled, cut and harvested; made goods
// come out of a building's recipe. Materials stays a good of its own ("building stock") so old packs still load.
// A pack may declare more goods (`goods` at the top of the pack); their words come with it.
import { POOLS, type Pool } from './ledger';
import { POOL_ICON, POOL_NAME } from './words';

export interface GoodDef {
  id: string;
  name: string;
  icon: string;
  /** a colour for chips and marks on the board */
  colour: string;
  made: boolean;
}

/** the factory game's goods, raw first (src/packs/check.ts BASE_GOODS holds the same ids: a test keeps them equal) */
export const FACTORY_GOODS: readonly GoodDef[] = [
  { id: 'wood', name: 'Wood', icon: '🪵', colour: '#a0703c', made: false },
  { id: 'stone', name: 'Stone', icon: '🪨', colour: '#a4a39b', made: false },
  { id: 'ore', name: 'Ore', icon: '⛏', colour: '#8a6a5a', made: false },
  { id: 'grain', name: 'Grain', icon: '🌾', colour: '#d8b54a', made: false },
  { id: 'planks', name: 'Planks', icon: '🪚', colour: '#c89a5a', made: true },
  { id: 'iron', name: 'Iron', icon: '🔩', colour: '#9fb2c2', made: true },
  { id: 'bread', name: 'Bread', icon: '🍞', colour: '#e0a35a', made: true },
  { id: 'tools', name: 'Tools', icon: '🔨', colour: '#c8c0a8', made: true },
  { id: 'weapons', name: 'Weapons', icon: '🗡', colour: '#d0d4dc', made: true },
];

/** goods a pack declared at load (their words) */
const extra = new Map<string, GoodDef>();
export function declareGoods(defs: readonly { id: string; name: string; icon?: string; made?: boolean }[]): void {
  for (const d of defs) if (!FACTORY_GOODS.some((g) => g.id === d.id)) extra.set(d.id, { id: d.id, name: d.name, icon: d.icon ?? '◆', colour: '#c8c0a8', made: !!d.made });
}

export const isPool = (k: string): k is Pool => (POOLS as readonly string[]).includes(k);
export function goodDef(k: string): GoodDef | undefined {
  return FACTORY_GOODS.find((g) => g.id === k) ?? extra.get(k);
}
/** a pool's or a good's name: "Magic", "Bread" */
export function goodName(k: string): string {
  return isPool(k) ? POOL_NAME[k] : (goodDef(k)?.name ?? k.charAt(0).toUpperCase() + k.slice(1));
}
/** a pool's or a good's icon */
export function goodIcon(k: string): string {
  return isPool(k) ? POOL_ICON[k] : (goodDef(k)?.icon ?? '◆');
}
/** every good id known now (the base goods and the declared ones), in the order the stock bar shows them */
export function goodIds(): string[] {
  return [...FACTORY_GOODS.map((g) => g.id), ...extra.keys()];
}
