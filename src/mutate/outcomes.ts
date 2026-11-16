// The mutators as outcome kinds of the template engine (living/dsl.ts HELPERS: "a small library of named helpers").
// A template's outcome names them like any helper:
//
//   { helper: 'mutate', args: ['flooded', '$town'] }                       // kind, where (a bound entity)
//   { helper: 'mutate', args: ['burned', '$town', 0.6, 7] }                // strength 0..1, seed
//   { helper: 'mutate', args: ['captured', '$town', 1, 1, '$rival'] }      // by: who holds it now
//   { helper: 'mutate', args: ['vassal', '$town', 1, 1, '$lord', 3] }      // tribute a season
//   { helper: 'sign', args: ['ashfall', '$home', 0.7, 3] }                 // strength (0: off), seasons it lasts
//
// The facts are written on the template's own world (`c.w`) with the opportunity as their cause — so a dry run's diff
// shows them and nothing else happens. A real resolution then hands the physical side to `mutators.apply` / `.sign`
// with the fact event's id (the land, the lots, the map; written at once where loaded, on arrival where not).
import { HELPERS, ref, type Ctx } from '../living/dsl';
import { ROW_H } from '../world/lattice';
import { recordMutation, recordSign } from './facts';
import { MUTATORS, SIGNS, mutators, type MutationSpec, type MutatorKind, type SignKind } from './index';

type Arg = string | number;

function mutate(c: Ctx, [kind, at, strength, seed, by, tribute]: Arg[]): void {
  if (!MUTATORS.some((m) => m.kind === kind)) throw new Error(`template: no mutator ${String(kind)}`);
  const id = ref(c, String(at));
  // FIXED-CITY (BACKLOG MU-27): a mutation's area is a settlement's centre and reach
  const s = c.w.settlementOf(id);
  if (!s) throw new Error(`template: mutate ${String(kind)} — ${id} is not in a settlement`);
  const holder = by !== undefined ? ref(c, String(by)) : undefined;
  const spec: MutationSpec = {
    kind: kind as MutatorKind,
    place: s.id,
    ...(typeof strength === 'number' ? { strength } : {}),
    ...(typeof seed === 'number' ? { seed } : {}),
    ...(holder !== undefined ? { by: holder } : {}),
    ...(typeof tribute === 'number' ? { tribute } : {}),
    cause: c.cause,
  };
  const fact = recordMutation(c.w, { kind: spec.kind, place: s.id, cell: [Math.round(s.at[0]), Math.round(s.at[1] / ROW_H)], radius: s.radius, strength: Math.min(1, Math.max(0, spec.strength ?? 1)), by: holder, tribute: spec.tribute }, { cause: c.cause });
  if (!c.dry && mutators.ready) mutators.apply({ ...spec, fact });
}

function sign(c: Ctx, [kind, at, strength, seasons]: Arg[]): void {
  if (!SIGNS.some((s) => s.kind === kind)) throw new Error(`template: no sign ${String(kind)}`);
  const id = ref(c, String(at));
  // FIXED-CITY (BACKLOG MU-27): the sign lands on the settlement the bound entity is in
  const place = c.w.settlementOf(id)?.id ?? id;
  const on = (typeof strength === 'number' ? strength : 1) > 0;
  recordSign(c.w, kind as SignKind, place, on, c.cause);
  if (c.dry || !mutators.ready) return;
  // (the engine records the tag on its own bound world too: the same tag set twice is one tag)
  const now = mutators.record().season ?? 0;
  mutators.sign({ kind: kind as SignKind, place, strength: typeof strength === 'number' ? strength : 1, ...(typeof seasons === 'number' ? { until: now + seasons } : {}), cause: c.cause });
}

/** Register the outcome kinds (idempotent). The level does it when the mutators attach; a test or the inspector may too. */
export function registerMutatorOutcomes(): void {
  HELPERS.mutate = { effect: mutate, text: (_c, a) => `mutate ${a.join(' ')}` };
  HELPERS.sign = { effect: sign, text: (_c, a) => `sign ${a.join(' ')}` };
}

registerMutatorOutcomes();
