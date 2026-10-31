// Items — what a hero carries on a run, in slots, with mechanical effects (round 120, `runsit`; BACKLOG IT1).
// The user (round 120): "Having items along the run with interesting mechanical choices" / "Maybe the held item(s) a
// helmet, cape, shirt, pants, mount and maybe some assymetric options".
// Why slots: a slot holds one thing, so taking a find means giving something up (the horn or the bell in the hand) —
// the trade-off is the choice. Why effects as data: the run's rules apply them (src/runsit/items.ts, pure, unit-tested)
// and the GM can name them in a situation; how an item is drawn is the hero's business (pairs with IN20's segments).

/** where an item is worn or carried */
export type ItemSlot = 'held' | 'helmet' | 'cape' | 'shirt' | 'pants' | 'mount';
export const ITEM_SLOTS: readonly ItemSlot[] = ['held', 'helmet', 'cape', 'shirt', 'pants', 'mount'];

/** What an item does. Used items (`uses`) are spent; the rest hold while worn. */
export type ItemEffect =
  /** allies come to the hero when it's used (a horn): `count` of the faction the run names, `uses` times */
  | { kind: 'call-allies'; count: number; uses: number }
  /** the threat turns aside to where it's used for `seconds` (a lure, a bell rung), `radius` cells round the hero */
  | { kind: 'lure'; radius: number; seconds: number; uses: number }
  /** fire can't be set within `radius` cells of the hero (a ward) */
  | { kind: 'fire-ward'; radius: number }
  /** travel between areas takes this share of the time; pursuers close less (a fresh mount, a spare cell) */
  | { kind: 'pace'; mult: number }
  /** the hero takes this share of the damage it's dealt (a helmet, a mail shirt) */
  | { kind: 'guard'; mult: number };

export interface ItemDef {
  id: string;
  name: string;
  slot: ItemSlot;
  /** (asymmetric items) other slots it fills too: a great banner held that also takes the cape */
  also?: ItemSlot[];
  /** a line for the card: what it does, in the player's words */
  text: string;
  effects: ItemEffect[];
}

/** What the hero carries now: an item per slot (its id), and the uses left of what's spent. */
export interface Loadout {
  slots: Partial<Record<ItemSlot, string>>;
  uses: Record<string, number>;
}
