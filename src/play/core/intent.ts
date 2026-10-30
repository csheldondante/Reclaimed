// (ported from GameplayGM runtimes/hoverbike/src/intent.ts @ experiment/slice 515fcd9, round 117: the play layer moved into Reclaimed)
// The generic intent layer (the user's spec, wiki design/gesture-intent-execution.md):
//
//   Layer A  gesture        what the thumb did (gestures.ts, controls.ts → units/common.ts Act)
//      │                     a unit reads it as …
//   Layer B  intent         what the player means: "slash on my left", "lunge that way",
//      │                     "fling this at him" — a few dimensions, never a full 3D aim
//      │  planner.plan(intent, scene, budget)
//      ▼
//            plan | miss     the least help that makes it plausible within the budget, or why
//      │                     not ("too far", "nothing that way"): a deserved miss stays a miss
//   Layer C  execution      the unit carries the plan out for real (the blade's sweep, the
//                            lunge's velocity, a throw through Reclaimed's physics); whether it
//                            connects is decided there, and logged beside the intent
//
// Each ability keeps its own planner and budget (the spec: share targeting and diagnostics
// "without forcing all of them into one identical assistance policy"); what's shared is this
// shape, the candidate list, the assist presets' names and the log. Pure: no DOM, no GPU.

export type V3 = [number, number, number];
export type V2 = [number, number];

/** What the player means (Layer B's input). Gesture semantics stay the unit's: this is only the meaning. */
export type Intent =
  /** a blow on one side of the way it's going (+1 left, −1 right): the bike's slash */
  | { kind: "strike-side"; side: 1 | -1 }
  /** a blow that way over the ground (unit vector): the knight's flick, a lunge */
  | { kind: "strike-way"; dir: V2 }
  /** throw a held or touched thing that way (2D) with a strength 0..1: the lich's fling */
  | { kind: "fling"; thing: number; dir: V2; power: number };

/** Something a plan may aim at: its feet, its velocity, how tall and wide (cells). */
export interface Candidate {
  id: number;
  at: V3;
  vel: V3;
  height: number;
  radius: number;
}

/** A planner's answer: a plan with how much of its budget it used (0 none, 1 all), or the nearest miss. */
export type Planned<P, M extends string = string> = { plan: P; assist: number; miss: null } | { plan: null; assist: 0; miss: M };

/** Layer B for one kind of intent: pure, its scene and budget its own. */
export interface Planner<I extends Intent, S, B, P, M extends string = string> {
  readonly name: string;
  plan(intent: I, scene: S, budget: B): Planned<P, M>;
}

/** How much the planners may help, by name (?assist=): the same input means the same thing under each. */
export type AssistLevel = "strict" | "moderate" | "forgiving";
export const ASSIST_LEVELS: AssistLevel[] = ["strict", "moderate", "forgiving"];

/** One intent's story: what was meant, what was planned (or why not), and what really happened. */
export interface IntentRecord {
  t: number;
  who: string;
  intent: Intent;
  planner: string;
  /** the plan's target, when there was one */
  target: number | null;
  assist: number;
  miss: string | null;
  /** Layer C's verdict, filled in when the action's over: did it connect */
  result: "pending" | "hit" | "missed";
}

/**
 * The record of intents and their outcomes (the spec: "record actual success/failure
 * separately from inferred intent"): the debug overlay shows the last, tests and the smoke
 * read them (window.__intents).
 */
export class IntentLog {
  readonly records: IntentRecord[] = [];
  constructor(private max = 64) {}

  /** a planned intent: its record, to settle once the action's over */
  add(who: string, intent: Intent, planner: string, p: Planned<unknown>, target: number | null, t = 0): IntentRecord {
    const r: IntentRecord = { t, who, intent, planner, target, assist: p.assist, miss: p.miss, result: "pending" };
    this.records.push(r);
    if (this.records.length > this.max) this.records.shift();
    return r;
  }
  settle(r: IntentRecord, hit: boolean): void {
    r.result = hit ? "hit" : "missed";
  }
  last(): IntentRecord | null {
    return this.records.at(-1) ?? null;
  }
  /** for the overlay: "slash L → #12 · help 30% · HIT" */
  static describe(r: IntentRecord): string {
    const i = r.intent;
    const what = i.kind === "strike-side" ? `slash ${i.side > 0 ? "L" : "R"}` : i.kind === "strike-way" ? "lunge" : `fling #${i.thing}`;
    const plan = r.miss ? `no plan: ${r.miss}` : r.target === null ? "→ that way" : `→ #${r.target} · help ${Math.round(r.assist * 100)}%`;
    return `${what} ${plan}${r.result === "pending" ? "" : ` · ${r.result.toUpperCase()}`}`;
  }
}

/** The shared log (one per page): every unit's planned intents. */
export const intents = new IntentLog();
