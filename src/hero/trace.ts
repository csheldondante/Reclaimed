// ---- hero/trace.ts --------------------------------------------------------------
// (round 112, herosandbox) What crosses the hero contract's boundary, kept for debugging the interface: the calls
// the host makes on the hero (place, shift, claims), the hero's events (hurt, died), the units' blows on its actor
// (Actor.hurt) and the hero's calls on the units (hit, spawn, order …; the reads — query, get, all — counted, not
// listed). And the HeroIntent each frame, for the last seconds. The sandbox's inspector shows both; its feedback
// file carries both (docs/HEROES.md "Contract feedback").

import type { HeroIntent } from '../api/contracts/hero';
import type { Actor, Units } from '../api/contracts/units';

export interface BoundaryCall {
  /** seconds since the log began */
  t: number;
  /** who called whom: host → hero, hero → host (its units, its events), units → hero (its actor) */
  dir: 'host→hero' | 'hero→host' | 'units→hero';
  call: string;
  args: string;
}

export interface IntentSample {
  t: number;
  move: [number, number];
  goTo: [number, number] | null;
  attack: boolean;
  sprint: boolean;
  use: string[];
  talk: boolean;
  /** HeroIntent.input's keys, when a controller passes its own input through */
  input: string[] | null;
}

const fmt = (v: unknown): string => {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
  if (v && typeof v === 'object') return '{…}';
  return String(v);
};

/** units' reads: counted a second, not listed (a hero queries every frame) */
const READS = new Set(['query', 'get', 'all', 'byCharacter']);

export class BoundaryLog {
  readonly calls: BoundaryCall[] = [];
  readonly intents: IntentSample[] = [];
  /** reads of the units this last second, by method */
  reads: Record<string, number> = {};
  private readsNow: Record<string, number> = {};
  private t0 = performance.now();
  private readT = 0;
  /** a call was logged (the inspector redraws) */
  onCall: ((c: BoundaryCall) => void) | null = null;

  constructor(
    /** calls kept */
    private keep = 400,
    /** seconds of intents kept */
    private seconds = 10,
  ) {}

  get now(): number {
    return (performance.now() - this.t0) / 1000;
  }

  add(dir: BoundaryCall['dir'], call: string, ...args: unknown[]): void {
    const c = { t: this.now, dir, call, args: args.map(fmt).join(', ') };
    this.calls.push(c);
    if (this.calls.length > this.keep) this.calls.splice(0, this.calls.length - this.keep);
    this.onCall?.(c);
  }

  intent(it: HeroIntent): void {
    const t = this.now;
    this.intents.push({
      t,
      move: [it.move[0], it.move[1]],
      goTo: it.goTo ? [it.goTo[0], it.goTo[1]] : null,
      attack: !!it.attack,
      sprint: !!it.sprint,
      use: it.use ? [...it.use] : [],
      talk: !!it.talk,
      input: it.input && typeof it.input === 'object' ? Object.keys(it.input) : null,
    });
    let i = 0;
    while (i < this.intents.length && this.intents[i].t < t - this.seconds) i++;
    if (i) this.intents.splice(0, i);
    if (t - this.readT >= 1) {
      this.reads = this.readsNow;
      this.readsNow = {};
      this.readT = t;
    }
  }

  /** the calls of the last `s` seconds */
  since(s: number): BoundaryCall[] {
    const t = this.now - s;
    return this.calls.filter((c) => c.t >= t);
  }

  /** The units as a hero is given them: every call it makes on them logged (hero → host). */
  units(u: Units): Units {
    return new Proxy(u, {
      get: (target, key, recv) => {
        const v = Reflect.get(target, key, recv);
        if (typeof v !== 'function' || typeof key !== 'string') return v;
        return (...args: unknown[]) => {
          if (READS.has(key)) this.readsNow[key] = (this.readsNow[key] ?? 0) + 1;
          else if (key !== 'update' && key !== 'shift' && key !== 'watch') this.add('hero→host', `units.${key}`, ...args);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }

  /** The hero's actor as the units are given it: their blows logged (units → hero). */
  actor(a: Actor): Actor {
    return {
      id: a.id,
      faction: a.faction,
      position: () => a.position(),
      alive: () => a.alive(),
      hurt: (damage, by) => {
        this.add('units→hero', 'actor.hurt', damage, `${by.role}#${by.id}`);
        a.hurt(damage, by);
      },
    };
  }
}
