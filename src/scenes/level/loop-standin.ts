// (loop-skeleton; docs/design/LOOP_SKELETON.md "Mutations") A STAND-IN for the world mutators (branch `mutators`,
// src/mutate/index.ts), behind the loop's copy of their contract (season/mutation.ts). Deleted at that merge.
// What it does, with what this branch already has and nothing new: `apply` records the change at once (the list is the
// world's state here); a flood's or a burn's reveal pushes the world's own events over the place for SPAN seconds (the
// water edit event; the ignite event) — the stand-in's only look, and it is a reveal, not the end state written at
// once as the real mutators do. Melted, buried and whole-place changes (founded, captured, …) change nothing in the
// world here: the loop tags the place on the map and says "stand-in" on screen. `restore` keeps the list only: no
// water or fire is put back after a reload.
import type { Applied, MutationAsk, MutationKind, Mutators } from '../../season/mutation';
import { EventKind } from '../../sim/globals';
import { OP } from '../../sim/edit-ops';
import type { WorldCore } from '../world-core';

/** seconds a stand-in reveal plays over */
export const SPAN = 3;
/** world events pushed over the span, and a flood event's strength (edit.wgsl: 0.02 cells of water a unit, at the centre) */
const STEPS = 24;
const FLOOD_STRENGTH = 8;

export function standinMutators(core: Pick<WorldCore, 'globals'>): Mutators {
  let applied: MutationAsk[] = [];
  return {
    list: (): MutationKind[] => ['flooded', 'burned', 'melted', 'buried', 'founded', 'destroyed', 'abandoned', 'captured', 'vassal'],
    apply(ask: MutationAsk): Applied {
      applied.push(ask);
      const area = ask.area;
      if (!area) return {};
      return {
        play: () => {
          let progress = 0;
          const [x, y] = area.at;
          const done = new Promise<void>((res) => {
            let k = 0;
            const step = () => {
              k++;
              progress = k / STEPS;
              if (ask.kind === 'flooded') core.globals.events.push({ kind: EventKind.Edit, x, y, z: OP.WATER * 32, radius: area.radius, strength: FLOOD_STRENGTH * ask.strength });
              if (ask.kind === 'burned') {
                // (alight at a point of the place a step, round it: the fire spreads by its own rules)
                const a = k * 2.399;
                const r = area.radius * Math.sqrt(k / STEPS) * 0.8;
                core.globals.events.push({ kind: EventKind.Ignite, x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, radius: 3, strength: 0.9 * ask.strength });
              }
              if (k >= STEPS) res();
              else setTimeout(step, (SPAN * 1000) / STEPS);
            };
            step();
          });
          return {
            get progress() {
              return progress;
            },
            done,
          };
        },
      };
    },
    record: () => applied,
    restore: (r) => {
      applied = Array.isArray(r) ? (r as MutationAsk[]) : [];
    },
  };
}
