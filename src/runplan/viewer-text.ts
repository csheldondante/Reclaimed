// (round 117, runplan) An outcome's effects as a line of text (the viewer and the level's run card).

import type { StageOutcome } from '../api/contracts/run';

/** an outcome's effects in a line (what the viewer shows under each choice) */
export function describe(o: StageOutcome): string {
  const parts: string[] = [];
  for (const a of o.effects.atlas ?? []) {
    const f = a.detail?.faction ? ` ${String(a.detail.faction).replace(/^f-/, '')}` : '';
    parts.push(`${a.kind}${f} ${a.kind === 'bury' ? `${a.magnitude} cells` : a.magnitude > 0 ? `+${a.magnitude}` : a.magnitude}${a.regions.length > 1 ? ` ×${a.regions.length} regions` : ''}`);
  }
  for (const c of o.effects.characters ?? []) {
    if (c.kind === 'gear' && c.add) parts.push(`gear: ${c.add.join(', ')}`);
    if (c.kind === 'status' && c.add) parts.push(`status: ${c.add.join(', ')}`);
    if (c.kind === 'meet') parts.push(`meet ${c.character.name}`);
    if (c.kind === 'die') parts.push(`${c.id} dies`);
  }
  return parts.join(' · ') || 'nothing lasting';
}
