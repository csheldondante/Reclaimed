// ---- runplay/rules.ts -------------------------------------------------------------------------------------------
// (round 119, `runplay`) A run's stage as play: what kind of play each planned encounter becomes for this hero, its
// numbers, when it's won or lost, and which of the stage's planned outcomes that picks. The user (round 119): "I need
// to actually play a generated run and try it out." Round 117: "A fast bike need races and chases. A combat soldier
// needs fun fights. A force of nature needs spectacle and power fantasy."
// Pure (no DOM, no GPU): the rules are unit-tested in Node (test/unit/runplay-rules.test.ts); stage.ts plays them in
// the level. Why separate: the win/lose rules and the outcome mapping are what a run's consequences hang on — they
// must be right without a browser, and the live stage can change how it looks without touching them.

import { fun, type ControllerProfile } from '../api/contracts/play';
import type { EncounterKind, RunRecord, RunStage, StageOutcome } from '../api/contracts/run';

/** what the stage is to play */
export type StageKind =
  /** a course of gates over crests, rival riders to beat to the finish line */
  | 'race'
  /** a rider to run down before it gets away or the clock runs out */
  | 'chase'
  /** a pack of raiders to cut down */
  | 'fight'
  /** a fort's towers to bring down before the clock runs out (its garrison fights back) */
  | 'smash'
  /** gates against the clock, no rivals (a ride to a cairn, to a meeting: explore and talk stand in as this) */
  | 'trial';

export interface StageSpec {
  kind: StageKind;
  /** one line, what to do (the banner) */
  goal: string;
  /** seconds on the stage's clock (the stage is lost past it) */
  limit: number;
  /** seconds a player who plays it well takes (the run's clock counts a stage at its planned minutes up to this, more past it) */
  par: number;
  /** race / trial: gates (the last the finish line), cells between them; rivals and their pace (a share of the hero's cruise) */
  gates?: number;
  spacing?: number;
  rivals?: number;
  rivalPace?: number;
  /** chase: the quarry's pace (a share of the hero's cruise), its head start (cells), how close catches it (cells), how far loses it */
  quarry?: { pace: number; lead: number; catch: number; lose: number };
  /** fight / smash: raiders, their health */
  foes?: number;
  foeHealth?: number;
  /** smash: towers, their height (cells), how many must fall */
  towers?: number;
  towerHeight?: number;
  need?: number;
  /** a stand-in for play this hero doesn't have yet (the knight's delve as a fight), said on the banner */
  standIn?: string;
}

/** a hero fast enough to race and chase (cells/s at the top: the bike 46, the lich 7) */
const FAST = 20;

/** The play a planned encounter becomes for a hero (by its profile: what it can do). */
export function stageKind(enc: EncounterKind, p: ControllerProfile): { kind: StageKind; standIn?: string } {
  const fast = p.speed.top >= FAST;
  const breaks = p.destruction >= 0.5;
  switch (enc) {
    case 'race':
      return fast ? { kind: 'race' } : { kind: 'trial', standIn: 'too slow to race: the course against the clock' };
    case 'chase':
      return fast ? { kind: 'chase' } : { kind: 'fight', standIn: 'too slow to chase: the raiders turn to fight' };
    case 'spectacle':
    case 'destruction':
      return breaks ? { kind: 'smash' } : { kind: 'fight', standIn: 'nothing to smash with: a fight' };
    case 'fight':
    case 'horde':
    case 'rescue':
      return { kind: 'fight' };
    case 'delve':
      return { kind: 'fight', standIn: 'no delving yet (the knight, PL5): a fight at the cave mouth' };
    case 'explore':
      return { kind: 'trial', standIn: 'exploring as a ride to the cairns' };
    case 'talk':
      return { kind: 'trial', standIn: 'no talk yet: ride to the meeting before the moment passes' };
  }
}

/** The stage's numbers for this hero (finales half again as big). */
export function stageSpec(stage: Pick<RunStage, 'encounter' | 'next'>, p: ControllerProfile): StageSpec {
  const { kind, standIn } = stageKind(stage.encounter, p);
  const finale = stage.next.length === 0;
  const big = finale ? 1.5 : 1;
  const cruise = Math.max(p.speed.cruise, 1);
  switch (kind) {
    case 'race': {
      const gates = Math.round(6 * (finale ? 1.34 : 1));
      const spacing = Math.max(40, Math.min(90, cruise * 2.2));
      const rivals = finale ? 3 : 2;
      // (the rivals can't boost: at 0.88 of the hero's cruise a clean ride beats them, a crash or a wrong turn doesn't)
      // (par: a good ride, not flat ground at cruise — round 119's playthrough rode 5 of 6 gates in 53 s over real hills
      // and a river; the clock half again and some)
      const par = ((gates * spacing) / cruise) * 2.5;
      return { kind, goal: `Beat ${rivals} riders through ${gates} gates to the finish`, limit: Math.round(par * 1.6 + 30), par, gates, spacing, rivals, rivalPace: 0.88 };
    }
    case 'trial': {
      const gates = Math.round(4 * big);
      const spacing = Math.max(24, Math.min(80, cruise * 2.5));
      const par = (gates * spacing) / cruise;
      return { kind, goal: `Reach ${gates} markers before the clock runs out`, limit: Math.round(par * 2 + 15), par, gates, spacing, standIn };
    }
    case 'chase': {
      const par = 25;
      return { kind, goal: 'Run the raider down before he gets away', limit: Math.round(50 * big), par, quarry: { pace: 0.75, lead: 40, catch: 4, lose: 150 }, standIn };
    }
    case 'fight': {
      const pack = fun(p).find((f) => f.kind === 'pack');
      const foes = Math.max(4, Math.min(10, Math.round((pack && pack.kind === 'pack' ? pack.size : 5) * big)));
      return { kind, goal: `Cut down ${foes} raiders`, limit: Math.round(120 * big), par: 15 + foes * 5, foes, foeHealth: 3, standIn };
    }
    case 'smash': {
      // (round 119's first playthrough: towers of 9 took the lich's slams a chunk at a time — one down in 100 s; four of 6,
      // felled at half their height, went in ~20 s with the autopilot: a wrecking ball's afternoon, a clock to beat)
      const towers = finale ? 5 : 4;
      return { kind, goal: `Bring down the fort's ${towers} towers before the bell`, limit: Math.round(100 * big), par: 20 + towers * 12, towers, towerHeight: 6, need: towers, foes: finale ? 6 : 4, foeHealth: 3, standIn };
    }
  }
}

/** What the stage sees each frame (only the fields of its kind). */
export interface Observation {
  /** seconds since it began */
  t: number;
  heroAlive: boolean;
  /** race/trial: gates the hero has passed; the best rival's (fractional: toward its next); a rival crossed the finish */
  gate?: number;
  rivalGate?: number;
  rivalDone?: boolean;
  /** chase: cells to the quarry */
  quarry?: number;
  /** fight/smash: raiders still up */
  foesLeft?: number;
  /** smash: towers down */
  down?: number;
}

export type StageStatus =
  | { state: 'playing' }
  | { state: 'won'; how: 'finished' | 'caught' | 'cleared' | 'smashed' }
  | { state: 'lost'; how: 'died' | 'clock' | 'beaten' | 'escaped' };

/** Won, lost or still playing, by the stage's rules. Death first; then the stage's own win; then the clock. */
export function judge(s: StageSpec, o: Observation): StageStatus {
  if (!o.heroAlive) return { state: 'lost', how: 'died' };
  switch (s.kind) {
    case 'race':
    case 'trial':
      if ((o.gate ?? 0) >= (s.gates ?? 0)) return { state: 'won', how: 'finished' };
      if (s.kind === 'race' && o.rivalDone) return { state: 'lost', how: 'beaten' };
      break;
    case 'chase':
      if (o.quarry !== undefined && o.quarry <= s.quarry!.catch) return { state: 'won', how: 'caught' };
      if (o.quarry !== undefined && o.quarry > s.quarry!.lose) return { state: 'lost', how: 'escaped' };
      break;
    case 'fight':
      if (o.foesLeft === 0) return { state: 'won', how: 'cleared' };
      break;
    case 'smash':
      if ((o.down ?? 0) >= (s.need ?? 0)) return { state: 'won', how: 'smashed' };
      break;
  }
  if (o.t > s.limit) return { state: 'lost', how: 'clock' };
  return { state: 'playing' };
}

/**
 * The stage's planned outcome for how it went, and how the run goes on. The plan's convention (contracts/run.ts
 * RunStage.outcomes): the first is the hoped-for one, the last how it goes wrong; one may end the run 'captured'.
 * - won: the first.
 * - lost on the clock, beaten, or the quarry got away: the last that isn't a capture; the run goes on (the world
 *   remembers it) — or, at a finale, ends 'fled': the hero lived and the stand was lost. Why not the plan's 'lost':
 *   that is the GM's failure rule for a death (consequences.ts failureRules: the hero dies, the dead may take the map),
 *   and a race lost at the line isn't a death.
 * - the hero fell: taken, if the stage has a capture (raiders with a threat behind them drag the hero off); else the
 *   worst outcome and the run ends 'lost' — death is the GM's failure rule 'lost' (consequences.ts failureRules).
 */
export function outcomeFor(stage: Pick<RunStage, 'id' | 'outcomes'>, st: StageStatus): { outcome: StageOutcome; runEnd: RunRecord['end'] | null } {
  const os = stage.outcomes;
  if (!os.length) throw new Error(`runplay: stage ${stage.id} has no outcomes`);
  if (st.state === 'playing') throw new Error(`runplay: stage ${stage.id} is still being played`);
  const worst = [...os].reverse().find((o) => o.ends !== 'captured') ?? os[os.length - 1];
  const after = (o: StageOutcome) => (o.ends === 'continue' ? null : o.ends);
  if (st.state === 'won') return { outcome: os[0], runEnd: after(os[0]) };
  if (st.how === 'died') {
    const taken = os.find((o) => o.ends === 'captured');
    if (taken) return { outcome: taken, runEnd: 'captured' };
    return { outcome: worst, runEnd: 'lost' };
  }
  const end = after(worst);
  return { outcome: worst, runEnd: end === 'lost' ? 'fled' : end };
}
