// ---- opps/finish.ts -----------------------------------------------------------------------------------------------
// (round 120, `opportunities`; BACKLOG RN2-5) An opportunity run's end written into the world state: the situation's
// end as today (runsit/finish.ts: the ending's outcome, the town's condition, the hero's history, the RunRecord), and
// then the named agents the run leaves — their tags and bonuses kept on their CharacterRecords so a later run's
// holdings start with them (the user, round 120: "Yes I think that we want them to persist"). A levy wiped out dies.

import type { RunRecord } from '../api/contracts/run';
import type { Bonus, BonusRecord } from '../api/contracts/opportunity';
import type { MemoryWorldState } from '../api/contracts/world-state';
import { finishSituation } from '../runsit/finish';
import type { OppRun } from './run';

export function finishOpps(w: MemoryWorldState, r: OppRun, hero: string): RunRecord {
  const rec = finishSituation(w, r.sr, hero);
  const run = rec.run;
  const region = r.sr.area().region;
  for (const a of r.named()) {
    if (a.character === hero) {
      // (the hero's record is finishSituation's; only its tags and bonuses are added here)
      if (w.character(hero)) w.applyCharacter({ kind: 'tags', id: hero, add: a.tags, bonuses: a.bonuses.map(record) }, run);
      continue;
    }
    w.applyCharacter({ kind: 'meet', character: { id: a.character, name: a.name, role: a.kind, faction: null, hero: false, alive: true, region, motivation: 'serve' } }, run);
    w.applyCharacter({ kind: 'tags', id: a.character, add: a.tags, bonuses: a.bonuses.map(record) }, run);
    w.applyCharacter({ kind: 'history', id: a.character, text: `${r.sit.title}: came back ${a.count} strong${a.tags.length ? `, ${a.tags.join(', ')}` : ''}` }, run);
  }
  for (const c of r.lostNamed()) {
    if (!w.character(c)) w.applyCharacter({ kind: 'meet', character: { id: c, name: c, role: 'army', faction: null, hero: false, alive: true, region, motivation: 'serve' } }, run);
    w.applyCharacter({ kind: 'die', id: c, text: `lost in ${r.sit.title}` }, run);
  }
  return rec;
}

const record = (b: Bonus): BonusRecord => {
  const { holder: _h, ...rest } = b;
  return rest as BonusRecord;
};
