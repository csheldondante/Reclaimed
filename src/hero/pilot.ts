// ---- hero/pilot.ts --------------------------------------------------------------
// (round 112, herosandbox; the user: "Don't we have pathfinding? Can't we build a traversal field for the hero agent
// and use that instead of input? Or steer along that?") A HeroController that drives a hero to a goal by steering
// along a traversal field (contracts/traversal.ts) made for the hero's own Mobility: each frame `move` is the field's
// way from where the hero stands, until it's there. The goal is a point or a function (a unit to follow: its field is
// made again as it moves). `fight`: it swings at hostile units within reach on the way.
// It plays the hero through the contract only — position(), mobility, `intent()` — so the sandbox's 🧭 autopilot and
// the headless test drive any hero that reads `move`. A hero that ignores move (the hoverbike game's, which read
// their own `input`) can't be piloted until it takes the pilot's direction through its input (docs/HEROES.md).

import type { Hero, HeroIntent, RunController } from '../api/contracts/hero';
import type { Traversal, TraversalField } from '../api/contracts/traversal';
import type { Units, V2 } from '../api/contracts/units';

export interface PilotOpts {
  /** cells from the goal it counts as there (default 1.5) */
  arrive?: number;
  /** swing at hostile units within this many cells (default: none) */
  fight?: number;
  /** run (HeroIntent.sprint) */
  sprint?: boolean;
  /** the field's radius (cells, default: the distance to the goal + 24, at least 48) */
  radius?: number;
}

export type PilotState = 'idle' | 'going' | 'there' | 'no way' | 'stuck';

export class Pilot implements RunController {
  state: PilotState = 'idle';
  field: TraversalField | null = null;
  /** ms the last field took */
  fieldMs = 0;
  fields = 0;
  onTap: ((sx: number, sy: number) => void) | null = null;
  private goal: V2 | (() => V2 | null) | null = null;
  private o: PilotOpts = {};
  private madeAt = 0;
  private lastProgress = 0;
  private best = Infinity;
  /** when the field last had no way from where the hero stands (0: it has one) */
  private noWaySince = 0;

  constructor(
    private hero: Hero,
    private traversal: Traversal,
    private units?: Units,
  ) {}

  /** Go to a point, or follow a moving one (null: stop). */
  to(goal: V2 | (() => V2 | null) | null, o: PilotOpts = {}): void {
    this.goal = goal;
    this.o = o;
    this.field = null;
    this.best = Infinity;
    this.noWaySince = 0;
    this.lastProgress = performance.now();
    this.state = goal ? 'going' : 'idle';
  }

  /** The window slid (a streamed world): a goal point moves with it, the field is made again (a moving goal moves itself). */
  shift(dx: number, dy: number): void {
    if (Array.isArray(this.goal)) this.goal = [this.goal[0] + dx, this.goal[1] + dy];
    this.field = null;
    this.best = Infinity;
    this.lastProgress = performance.now();
  }

  get active(): boolean {
    return this.state === 'going';
  }

  intent(): HeroIntent {
    const it: HeroIntent = { move: [0, 0], sprint: this.o.sprint };
    if (this.state !== 'going' || !this.goal) return it;
    const m = this.hero.mobility;
    if (!m) {
      this.state = 'no way';
      return it;
    }
    const g = typeof this.goal === 'function' ? this.goal() : this.goal;
    if (!g) {
      this.state = 'there';
      return it;
    }
    const p = this.hero.position();
    const at: V2 = [p[0], p[1]];
    const now = performance.now();
    // (a field for the goal: made again when the goal has moved on from it, or now and then while following)
    const f0 = this.field;
    if (!f0 || Math.hypot(f0.goal[0] - g[0], f0.goal[1] - g[1]) > 2 || (typeof this.goal === 'function' && now - this.madeAt > 1000)) {
      const d = Math.hypot(g[0] - at[0], g[1] - at[1]);
      this.field = this.traversal.field(g, m, { radius: this.o.radius ?? Math.max(48, Math.ceil(d + 24)) });
      this.fieldMs = this.field.ms;
      this.fields++;
      this.madeAt = now;
    }
    const f = this.field!;
    if (Math.hypot(g[0] - at[0], g[1] - at[1]) <= (this.o.arrive ?? 1.5)) {
      this.state = typeof this.goal === 'function' ? 'going' : 'there';
    } else {
      const dir = f.dir(at);
      if (!dir) {
        // (no way from here on this field: made again a few times first — a field made just after a window's slide
        // reads ground the mirror hasn't caught up with — then it's no way)
        if (!this.noWaySince) this.noWaySince = now;
        if (now - this.noWaySince > 2000) this.state = 'no way';
        else if (now - this.madeAt > 400) this.field = null;
        return it;
      }
      this.noWaySince = 0;
      it.move = dir;
      // (stuck: no nearer the goal for 3 s — a stride the field allows but the hero's own rules refuse)
      const c = f.cost(at) ?? Infinity;
      if (c < this.best - 0.5) {
        this.best = c;
        this.lastProgress = now;
      } else if (now - this.lastProgress > 3000 && typeof this.goal !== 'function') this.state = 'stuck';
    }
    const reach = this.o.fight;
    if (reach && this.units) it.attack = this.units.query(at, reach, { hostile: true }).some((u) => u.alive && u.faction !== this.hero.actor.faction);
    // (a fight holds it where it stands: no progress then is no sign of being stuck)
    if (it.attack) this.lastProgress = now;
    return it;
  }

  dispose(): void {
    this.to(null);
  }
}
