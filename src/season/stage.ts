// (round 128r, Track A "Next season") A structure's stage: what Track B draws for it (docs/handoff/CROSS_TRACK_CONTRACT.md
// "Stage field"). Derived, never stored: up to built from its blocks (the plan's, the Town's standing ones, the
// fortress's begun set — ST18's stored progress is blocks standing over blocks planned); past built from its wear
// (what history left on it: structures/purpose.ts markWear, the same rule a generated town is worn by). One source each,
// so the stage can't disagree with what stands or with the marks.
import type { Wear } from '../api/contracts/structures';

export type StructureStage = 'planned' | 'building' | 'built' | 'damaged' | 'ruined' | 'overgrown';

/** the stage a wear means (past built) */
export function wearStage(w: Wear): StructureStage {
  return w === 'ruined' ? 'ruined' : w === 'overgrown' ? 'overgrown' : 'damaged';
}

/**
 * A structure's stage: its wear if history marked it; else planned (nothing begun or standing), building (some begun or
 * standing), built (every planned block stands). `progress`: standing / planned.
 */
export function stageOf(s: { wear?: Wear }, blocks: { planned: number; standing: number; begun: number }): { stage: StructureStage; progress: number } {
  const progress = blocks.planned ? blocks.standing / blocks.planned : 1;
  if (s.wear) return { stage: wearStage(s.wear), progress };
  if (blocks.planned > 0 && blocks.standing >= blocks.planned) return { stage: 'built', progress };
  if (blocks.standing > 0 || blocks.begun > 0) return { stage: 'building', progress };
  return { stage: 'planned', progress };
}
