// The game's trait rules (LW1, slice 1: healing vs necromancy). Each is a TraitModule: a small GPU kernel and its data
// table (contracts/traits.ts). The engine (src/traits) knows none of them; this file is the game's choice of rules and
// numbers. Adding a rule is adding a module here (or anywhere) and registering it — no other module changes.

import { DAMAGE_TYPES, STATUSES, traitMask, type DamageType, type StatusName, type TraitModule, type TraitName, type TraitsApi } from '../../api/contracts/traits';
import { packTable } from '../../traits/registry';
import { MAT } from '../../world/materials';
import healWgsl from './heal.wgsl?raw';
import holyHarmWgsl from './holy_harm.wgsl?raw';
import raiseWgsl from './raise.wgsl?raw';
import typedDamageWgsl from './typed_damage.wgsl?raw';
import statusWgsl from './status.wgsl?raw';
import capsWgsl from './caps.wgsl?raw';
import lookWgsl from './look.wgsl?raw';

/** units.wgsl / prelude.wgsl CAP_* (the engine's verbs) */
export const CAP = { noBurn: 1, noDrown: 2, rooted: 4, flee: 8 } as const;
/** units.wgsl LOOK_* */
export const LOOK = { halo: 0x1000000, sparks: 0x2000000, corpse: 0x4000000 } as const;

const m = (ts: TraitName[]) => ({ u: traitMask(ts) });

/** heal: restoration heals the living (not the undead, not constructs), glowing while it does. */
export function healModule(o: { needs?: TraitName[]; barred?: TraitName[]; glow?: number } = {}): TraitModule {
  return { name: 'heal', wgsl: healWgsl, order: 100, table: packTable([[m(o.needs ?? ['living']), m(o.barred ?? ['undead', 'construct'])], [o.glow ?? 0.4]]) };
}

/** holy_harm: "healing on undead harms" — `per` hit points taken for each the field would heal. */
export function holyHarmModule(o: { needs?: TraitName[]; spared?: TraitName[]; per?: number; sparks?: number } = {}): TraitModule {
  return { name: 'holy_harm', wgsl: holyHarmWgsl, order: 100, table: packTable([[m(o.needs ?? ['undead']), m(o.spared ?? [])], [o.per ?? 1.5, o.sparks ?? 0.35]]) };
}

/** raise: the dead living rise as undead in the raiser's group, keeping their kind (role, gear). */
export function raiseModule(o: { needs?: TraitName[]; barred?: TraitName[]; gains?: TraitName[]; loses?: TraitName[]; hop?: number; health?: number } = {}): TraitModule {
  return {
    name: 'raise',
    wgsl: raiseWgsl,
    order: 90,
    table: packTable([
      [m(o.needs ?? ['living']), m(o.barred ?? ['undead', 'construct']), m(o.gains ?? ['undead']), m(o.loses ?? ['living'])],
      [o.hop ?? 5, o.health ?? 0.6],
    ]),
  };
}

/** A resist row: the traits it applies to (all of them), and a multiplier per damage type (default 1). */
export interface ResistRow {
  traits: TraitName[];
  times: Partial<Record<DamageType, number>>;
}
/** The slice's resist table: fire passes the fire_immune by; the undead don't feel necrotic (it mends them) and life
 *  burns them; constructs feel neither life nor necrotic. */
export const RESISTS: ResistRow[] = [
  { traits: ['fire_immune'], times: { fire: 0 } },
  { traits: ['undead'], times: { necrotic: -0.5, life: 2 } },
  { traits: ['construct'], times: { necrotic: 0, life: 0 } },
  { traits: ['petrified'], times: { fire: 0, physical: 0.25 } },
];
export function typedDamageModule(rows: ResistRow[] = RESISTS): TraitModule {
  if (rows.length > 8) throw new Error('typed_damage: 8 rows at most');
  const t: (number | { u: number })[][] = [];
  for (const r of rows) {
    t.push([m(r.traits)]);
    t.push(DAMAGE_TYPES.map((d) => r.times[d] ?? 1));
  }
  return { name: 'typed_damage', wgsl: typedDamageWgsl, order: 110, table: packTable(t) };
}

/** status: who is immune to which status (the undead and constructs know no fear; constructs don't turn to stone). */
export function statusModule(immune: Partial<Record<StatusName, TraitName[]>> = { frightened: ['undead', 'construct'], petrified: ['construct'] }): TraitModule {
  return { name: 'status', wgsl: statusWgsl, order: 80, table: packTable(STATUSES.map((s) => [m(immune[s] ?? [])])) };
}

/** caps: the engine's verbs from the traits (the derived capabilities). */
export function capsModule(rows: { any: TraitName[]; caps: number }[] = [
  { any: ['fire_immune', 'petrified'], caps: CAP.noBurn },
  { any: ['undead', 'construct', 'petrified'], caps: CAP.noDrown },
  { any: ['petrified'], caps: CAP.rooted },
  { any: ['frightened'], caps: CAP.flee },
]): TraitModule {
  return { name: 'caps', wgsl: capsWgsl, order: 900, table: packTable(rows.map((r) => [m(r.any), { u: r.caps }])) };
}

/** look: what the draw shows from the traits, in priority order (the first tint wins; effects add up). */
export function lookModule(rows: { any: TraitName[]; torso?: number; head?: number; fx?: number }[] = [
  { any: ['petrified'], torso: MAT.Stone, head: MAT.Stone },
  { any: ['corpse'], torso: MAT.Ash, fx: LOOK.corpse },
  { any: ['undead'], torso: MAT.Leaves, head: MAT.Bone },
  { any: ['healing'], fx: LOOK.halo | (MAT.Flower << 16) },
  { any: ['harmed'], fx: LOOK.sparks },
]): TraitModule {
  return { name: 'look', wgsl: lookWgsl, order: 910, table: packTable(rows.map((r) => [m(r.any), { u: (r.torso ?? 0) | ((r.head ?? 0) << 8) }, { u: r.fx ?? 0 }])) };
}

/** The slice's rules, registered. Returns their names. */
export function registerSlice(t: TraitsApi): string[] {
  const mods = [statusModule(), raiseModule(), healModule(), holyHarmModule(), typedDamageModule(), capsModule(), lookModule()];
  for (const mod of mods) t.register(mod);
  return mods.map((x) => x.name);
}

