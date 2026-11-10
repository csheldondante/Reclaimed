// (trackA-liquids, DA-P5) Which liquid model the world runs: ?liquid=flow|pipes. The flow model (flow/, liquid.wgsl:
// runs in every gap of a column — under a deck, in a cave — momentum, arcing falls, water and lava as one kernel) is
// to be the one liquid (DESIGN §7); the pipes (water_flux/water_depth: one depth over each column's top) stay the
// default until the user approves the flow model on the phone. ?flow=1 is the flow lab's older spelling of
// ?liquid=flow. What depends on the choice reads it here: the level (installFlow), citygen (a deck claimed into the
// columns only when the water can run under it — BACKLOG CG15).

import { urlFlags } from '../flags';

export type LiquidModel = 'flow' | 'pipes';

export const LIQUID: LiquidModel = (() => {
  if (typeof location === 'undefined') return 'pipes';
  const p = urlFlags();
  const v = p.get('liquid');
  if (v !== null && v !== 'flow' && v !== 'pipes') throw new Error(`?liquid=${v}: flow or pipes`);
  if (p.get('flow') === '1') {
    if (v === 'pipes') throw new Error('?flow=1 with ?liquid=pipes: one or the other');
    return 'flow';
  }
  return (v as LiquidModel | null) ?? 'pipes';
})();
