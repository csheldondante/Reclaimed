// ---- run/run.ts ----------------------------------------------------------------
// A run of a SessionStory (round 83, docs/SYSTEMS.md system 11; contracts/run.ts `Run`). It keeps what has
// happened (the facts noted: talks, choices, places reached, kills, the sim's events), the flags, the items
// given, the attitudes and the clock; each fact re-checks every objective and happening:
//   hidden ──when holds──▶ shown ──done holds──▶ done (its outcome applied)
//                                └─failed.when holds──▶ failed (the failed outcome applied)
// An Outcome sets flags, shifts attitudes, gives items, unlocks dialog nodes, asks the game to spawn, ends the
// run, and turns its AtlasEvents into the world's (WorldState.apply, now: the atlas scale "when a story event
// fires"). `end` makes the RunRecord the world keeps.
//
//   const run = new StoryRun(validateStory(json), world, { hero: 'wanderer' })
//   run.hear(dialog)                          // a dialog's nodes and choices become facts and effects
//   run.note({ kind: 'reached', location: 'sluice' }); run.update(dt)   // the clock, for `time` conditions
//   run.onObjective.push((id, state) => …); run.end('won') → RunRecord

import type { AtlasEvent, Condition, Dialog, DialogTree, Outcome, Run, RunRecord, SessionStory, WorldState } from '../api/contracts';
import { validateStory } from './validate';

type ObjState = 'hidden' | 'shown' | 'done' | 'failed';

export interface RunOptions {
  /** who the player is (RunRecord.hero) */
  hero: string;
  /** the run's number (default the world's: its snapshot's `run`, the one to come) */
  run?: number;
}

export class StoryRun implements Run {
  readonly story: SessionStory;
  readonly number: number;
  onObjective: ((id: string, state: 'shown' | 'done' | 'failed') => void)[] = [];
  /** told every outcome as it's applied, and why (an objective's id, `dialog/node`, `happening N`): a game realises what it can (spawns, play-scale effects) */
  onOutcome: ((o: Outcome, cause: string) => void)[] = [];
  /** told when the run ends */
  onEnd: ((r: RunRecord) => void)[] = [];
  /** seconds since the run began (`time` conditions) */
  clock = 0;
  private facts: Condition[] = [];
  private flags = new Map<string, boolean>();
  private items = new Map<string, number>();
  private states = new Map<string, ObjState>();
  private fired = new Set<number>();
  private attitudes = new Map<string, number>();
  private unlocked = new Map<string, string>();
  private deeds: string[] = [];
  private events: AtlasEvent[] = [];
  private eventN = 0;
  private ended: RunRecord | null = null;
  private checking = false;

  constructor(
    story: SessionStory,
    private world: WorldState,
    private opts: RunOptions,
  ) {
    this.story = validateStory(story);
    this.number = opts.run ?? world.snapshot().run;
    for (const o of story.objectives) this.states.set(o.id, 'hidden');
    for (const c of story.cast) this.attitudes.set(c.id, c.disposition);
    this.timeEdges = this.collectTimes();
    // (objectives with nothing to wait for show at once; listeners added after construction miss that, so a
    // game reads objectives() once it has subscribed)
    this.check();
  }

  objectives(): { id: string; state: ObjState }[] {
    return this.story.objectives.map((o) => ({ id: o.id, state: this.states.get(o.id)! }));
  }

  /** an objective's text and location, by id (throws when there's none: a typo is the caller's bug) */
  objective(id: string): SessionStory['objectives'][number] {
    const o = this.story.objectives.find((x) => x.id === id);
    if (!o) throw new Error(`run: no objective "${id}" in story "${this.story.id}"`);
    return o;
  }

  flag(name: string): boolean {
    return this.flags.get(name) ?? false;
  }

  /** how many of `item` the player was given */
  has(item: string): number {
    return this.items.get(item) ?? 0;
  }

  /** a cast member's attitude toward the player now (−1..1: their disposition plus what's shifted it) */
  attitude(character: string): number {
    const a = this.attitudes.get(character);
    if (a === undefined) throw new Error(`run: no character "${character}" in story "${this.story.id}"`);
    return a;
  }

  /** where to open a tree: its last unlocked node (Outcome.unlock), or its start */
  entry(tree: DialogTree): string {
    return this.unlocked.get(tree.id) ?? tree.start;
  }

  get over(): boolean {
    return this.ended !== null;
  }

  /** Something happened: kept, and every objective and happening checked again. */
  note(fact: Condition): void {
    if (this.ended) return;
    this.facts.push(fact);
    this.check();
  }

  /** Each frame (or less often): the clock, for `time` conditions. */
  update(dt: number): void {
    if (this.ended) return;
    const before = this.clock;
    this.clock += dt;
    // (only when a `time` condition may have just come true: the rest waits for facts)
    if (this.timeEdges.some((t) => t > before && t <= this.clock)) this.check();
  }
  private timeEdges: number[];

  /** every condition of a list holds (AND; an empty list does) */
  all(conds: readonly Condition[]): boolean {
    return conds.every((c) => this.holds(c));
  }

  /** A dialog's nodes and choices become this run's facts and effects. */
  hear(dialog: Dialog): void {
    dialog.onNode.push((tree, node) => {
      const n = tree.nodes[node];
      // (the node's effects before the fact: a `talked` condition sees what saying it changed)
      if (n.effects) this.apply(n.effects, `${tree.id}/${node}`);
      this.note({ kind: 'talked', character: tree.speaker, node });
    });
    dialog.onChoice.push((tree, node, choice) => {
      const c = tree.nodes[node].choices[choice];
      if (!c) throw new Error(`run: dialog "${tree.id}" node "${node}" has no choice ${choice}`);
      const who = this.story.cast.find((x) => x.id === tree.speaker)?.name ?? tree.speaker;
      this.deeds.push(`told ${who}: "${c.text}"`);
      if (c.effects) this.apply(c.effects, `${tree.id}/${node}#${choice}`);
      this.note({ kind: 'chose', dialog: tree.id, node, choice });
    });
  }

  end(how: RunRecord['end']): RunRecord {
    if (this.ended) return this.ended;
    for (const o of this.story.objectives) if (this.states.get(o.id) === 'shown') this.deeds.push(`left undone: ${o.text}`);
    const r: RunRecord = { run: this.number, hero: this.opts.hero, story: this.story.id, end: how, deeds: [...this.deeds], events: [...this.events] };
    this.ended = r;
    this.world.record(r);
    for (const cb of this.onEnd) cb(r);
    return r;
  }

  /** Does a condition hold now. */
  holds(c: Condition): boolean {
    switch (c.kind) {
      case 'any':
        return c.of.some((x) => this.holds(x));
      case 'flag':
        return this.flag(c.flag) === (c.value ?? true);
      case 'has':
        return this.has(c.item) >= (c.count ?? 1);
      case 'objective':
        return this.states.get(c.id) === c.state;
      case 'time':
        return this.clock >= c.after;
      case 'talked':
        return this.facts.some((f) => f.kind === 'talked' && f.character === c.character && (c.node === undefined || f.node === c.node));
      case 'chose':
        return this.facts.some((f) => f.kind === 'chose' && f.dialog === c.dialog && f.node === c.node && f.choice === c.choice);
      case 'reached':
        return this.facts.some((f) => f.kind === 'reached' && f.location === c.location && (c.room === undefined || f.room === c.room));
      case 'event':
        return this.facts.some((f) => f.kind === 'event' && f.event === c.event && (c.location === undefined || f.location === c.location));
      case 'killed': {
        let n = 0;
        for (const f of this.facts)
          if (f.kind === 'killed' && (c.character === undefined || f.character === c.character) && (c.unitKind === undefined || f.unitKind === c.unitKind)) n += f.count ?? 1;
        return n >= (c.count ?? 1);
      }
    }
  }

  /** objectives and happenings until nothing more changes (an outcome can set what another waits for) */
  private check(): void {
    if (this.checking) return;
    this.checking = true;
    try {
      for (let changed = true, guard = 0; changed && !this.ended; guard++) {
        if (guard > 64) throw new Error(`run: story "${this.story.id}" doesn't settle (objectives keep changing each other)`);
        changed = false;
        for (const o of this.story.objectives) {
          const st = this.states.get(o.id)!;
          if (st === 'hidden' && this.all(o.when)) {
            this.set(o.id, 'shown');
            changed = true;
          } else if (st === 'shown' && o.failed && this.all(o.failed.when)) {
            this.set(o.id, 'failed');
            this.deeds.push(`failed: ${o.text}`);
            this.apply(o.failed.outcome, o.id);
            changed = true;
          } else if (st === 'shown' && this.all(o.done)) {
            this.set(o.id, 'done');
            this.deeds.push(`done: ${o.text}`);
            this.apply(o.outcome, o.id);
            changed = true;
          }
          if (this.ended) return;
        }
        this.story.happenings.forEach((h, i) => {
          if (this.fired.has(i) || this.ended || !this.all(h.when)) return;
          this.fired.add(i);
          this.apply(h.effects, `happening ${i}`);
          changed = true;
        });
      }
    } finally {
      this.checking = false;
    }
  }

  private set(id: string, state: 'shown' | 'done' | 'failed'): void {
    this.states.set(id, state);
    for (const cb of this.onObjective) cb(id, state);
  }

  private apply(o: Outcome, cause: string): void {
    const atlas = [...(o.atlas ?? [])];
    for (const [k, v] of Object.entries(o.flags ?? {})) this.flags.set(k, v);
    for (const g of o.give ?? []) this.items.set(g.item, this.has(g.item) + (g.count ?? 1));
    for (const a of o.attitude ?? []) {
      if (a.character !== undefined) this.attitudes.set(a.character, Math.max(-1, Math.min(1, this.attitude(a.character) + a.delta)));
      if (a.faction !== undefined) {
        // (a faction's attitude is the world's: an AtlasEvent in the region where it happened)
        atlas.push({ kind: 'faction-attitude', regions: [this.regionOf(cause)], magnitude: a.delta, detail: { faction: a.faction }, cause: { by: 'story' } });
        this.deeds.push(`${a.delta > 0 ? 'won over' : 'turned against them'}: ${a.faction} (${a.delta > 0 ? '+' : ''}${a.delta})`);
      }
    }
    for (const u of o.unlock ?? []) this.unlocked.set(u.dialog, u.node);
    for (const e of atlas) {
      const ev: AtlasEvent = { ...e, id: `${this.story.id}:${this.number}:${this.eventN++}`, run: this.number, cause: { ...e.cause, ref: e.cause.ref ?? cause } };
      this.world.apply(ev);
      this.events.push(ev);
    }
    for (const cb of this.onOutcome) cb(o, cause);
    if (o.endRun) this.end(o.endRun);
    // (what changed may hold now: checked by the loop that applied it, or here for a dialog's effects)
    this.check();
  }

  /** the region an outcome happened in: its objective's location's, the speaker's, else the story's first place's */
  private regionOf(cause: string): number {
    const loc = (id: string | undefined) => this.story.locations.find((l) => l.id === id);
    const o = this.story.objectives.find((x) => x.id === cause);
    const tree = this.story.dialogs.find((d) => cause.startsWith(`${d.id}/`));
    const speaker = tree && this.story.cast.find((c) => c.id === tree.speaker);
    const l = loc(o?.location) ?? loc(speaker?.location) ?? this.story.locations[0];
    if (!l) throw new Error(`run: story "${this.story.id}" has no locations (a faction's attitude needs a region)`);
    return l.region;
  }

  private collectTimes(): number[] {
    const out: number[] = [];
    const scan = (cs: readonly Condition[] | undefined): void =>
      cs?.forEach((c) => (c.kind === 'time' ? out.push(c.after) : c.kind === 'any' ? scan(c.of) : undefined));
    for (const o of this.story.objectives) {
      scan(o.when);
      scan(o.done);
      scan(o.failed?.when);
    }
    for (const h of this.story.happenings) scan(h.when);
    for (const d of this.story.dialogs) for (const n of Object.values(d.nodes)) for (const c of n.choices) scan(c.requires);
    return out;
  }
}
