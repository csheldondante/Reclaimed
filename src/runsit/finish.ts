// ---- runsit/finish.ts -------------------------------------------------------------------------------------------
// (round 120, `runsit`) A situation run's end written into the world state: the ending's Outcome (AtlasEvents and
// attitudes, through the same applyEffects a planned run uses), the target settlement's condition (a burned town is
// 'ruined': the next run's template won't send the dead for it again, and the settlements system realises it charred),
// the hero's history, the RunRecord. The world state is the one place the world changes between runs
// (contracts/world.ts WorldState) — this only calls it.
// The user (round 117): "Decisions should impact the world for the next run"; (round 120) "when possible make the
// gameplay actually modify the map during the session not with text between sessions" — the session's fire did the
// burning; this is what the next run reads of it.

import type { RunRecord } from '../api/contracts/run';
import type { Situation, SituationEnd } from '../api/contracts/situation';
import type { MemoryWorldState } from '../api/contracts/world-state';
import { applyEffects, HERO_NAMES } from '../runplan/consequences';
import type { SituationRun } from './state';

const END: Record<SituationEnd, RunRecord['end']> = { saved: 'won', evacuated: 'won', burned: 'lost', fell: 'lost' };

export function finishSituation(w: MemoryWorldState, r: SituationRun, hero: string): RunRecord {
  const sit: Situation = r.sit;
  if (!r.end) throw new Error('finishSituation: the run has not ended');
  const run = w.run;
  const ending = sit.endings[r.end];
  if (!w.character(hero)) w.applyCharacter({ kind: 'meet', character: { id: hero, name: HERO_NAMES[hero] ?? hero, role: hero, faction: null, hero: true, alive: true, region: sit.areas[0].region, motivation: 'see the run through' } }, run);
  const events = applyEffects(w, ending.outcome, run, `${sit.id}-${r.end}`);
  if (ending.settlement) {
    const s = w.settlements.find((x) => x.id === sit.target.settlement);
    if (s) s.condition = ending.settlement;
  }
  const deeds = [
    ...r.taken.map((id) => sit.choices.find((c) => c.id === id)!.text),
    ...r.path.filter((p) => sit.areas.find((a) => a.id === p.area)?.play.kind === 'deliver' && p.won).map(() => `carried the word: the levy marched`),
    ending.text,
  ];
  w.applyCharacter(r.end === 'fell' ? { kind: 'die', id: hero, text: `fell defending ${sit.target.name}` } : { kind: 'history', id: hero, text: `${sit.title}: ${ending.text}` }, run);
  w.applyCharacter({ kind: 'move', id: hero, region: r.area().region }, run);
  const rec: RunRecord = { run, hero, story: sit.id, end: END[r.end], deeds, events, path: r.path.map((p) => ({ stage: p.area, outcome: p.won ? 'won' : 'lost' })) };
  w.record(rec);
  return rec;
}
