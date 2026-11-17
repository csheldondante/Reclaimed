// (loop round 16; DECISIONS 2026-11-17 and round 128p) A quiet world while the game is played: the land's background
// processes and their particles are asleep, and wake only for what needs them.
//
// The owner: "the terrain and simulation is cool and a strength but it often during play shows up as noise and should
// probably be frozen except in reaction to specific events like magma flows." The fortress-play ruling (round 128p)
// already said seeds, pollen fluff, petals and the grow tap's glow and sparkles are off in play.
//
// What is asleep by default (Simulation.paused, by system name): the succession and its wilting (ecology, wilt), the
// climate and the snow cover, moisture, contamination, sediment, oil, the sandbox's lava (sim/lava.ts: not the fronts'
// lava, which is the flow model's), the structure pass and fire. And the particles of plants (petals, seeds, glow) and of
// fire (ParticleSystem.plants, fire). Leaves, dust, smoke bursts, birds and the town's life run as before.
//
// What wakes them is a hold: a key, the systems it needs, and either a time it lasts or until it is released:
//   - hold(key, 'all')         every system and particle (the between-seasons time-lapse)
//   - hold(key, what)          those named (a live fire, a lava front: fire, structure and fire's particles)
//   - wake(key, what, seconds) the same, let go after a time (a spell cast: the growth rune, a fire cast)
//   - an Ignite event in a tick wakes fire and its particles at once, in that tick (Simulation.eventTaps run before the
//     systems encode): a fire lit by anything is never lost to a sleeping fire pass. (loop round 17) It is held while
//     the fire burns: where it was lit is looked at every few seconds (BurningNear: a small async read of the fire
//     field), and let go when nothing burns there — was 90 s from the last Ignite.
// Where they run is still the chunks' sleep (sim/sleep.ts): a woken system runs only on awake chunks, which events wake.
//
// The water is not put to sleep here: its draw lists for land streamed in are made by its own step, which already idles
// on sleeping chunks (flow/liquid.ts phone-idle). Natural storms are the weather's (scenes/level/weather-set.ts quiet).
import type { Simulation } from './simulation';
import { EventKind } from './globals';

/** the systems asleep in a quiet world unless a hold wakes them */
export const QUIET_SYSTEMS = ['ecology', 'wilt', 'climate', 'cover', 'moisture', 'contamination', 'sediment', 'oil', 'lava', 'structure', 'fire'] as const;
export type QuietSystem = (typeof QUIET_SYSTEMS)[number];
/** what a hold wakes: systems by name, and the plants' and fire's particles */
export interface QuietWhat {
  systems?: readonly QuietSystem[];
  plants?: boolean;
  fireParticles?: boolean;
}
/** what a fire needs: the fire pass, the structure (timber brought down) and the flames' particles */
export const FIRE_WAKE: QuietWhat = { systems: ['fire', 'structure'], fireParticles: true };
/** what growth needs: the succession and the wilting, and (it is the spell's own sign) the growing glow */
export const GROW_WAKE: QuietWhat = { systems: ['ecology', 'wilt', 'moisture'], plants: true };
/** (loop round 17: "while burning", not 90 s) every CHECK_S after the first FIRST_S an Ignite's fire is looked at
 *  where it was lit (`burning`: a small async read of the fire field round those points); the hold goes when none burns */
const FIRST_S = 4;
const CHECK_S = 3;
/** the most points watched (the latest kept), and how near a new one must be to count as the same fire (cells) */
const MAX_FIRES = 8;
const SAME_FIRE = 12;

/** whether anything burns round these window points (the fire field read there, a few chunks round each) */
export type BurningNear = (at: readonly (readonly [number, number])[]) => Promise<boolean>;

export class QuietWorld {
  private holds = new Map<string, { what: QuietWhat | 'all'; until: number | null }>();
  /** what is awake now (scripts, the census) */
  awake: { systems: string[]; plants: boolean; fireParticles: boolean } = { systems: [], plants: false, fireParticles: false };
  private key = '';
  /** (loop round 17) the points fires were lit at while the ignite hold is on, when the last was, the last look */
  private fires: [number, number][] = [];
  private litAt = 0;
  private lookedAt = 0;
  private looking = false;

  constructor(
    private sim: Simulation,
    private burning: BurningNear,
  ) {
    sim.eventTaps.push((sent) => {
      const lit = sent.filter((e) => e.kind === EventKind.Ignite);
      if (!lit.length) return;
      for (const e of lit) {
        if (this.fires.some(([x, y]) => Math.hypot(x - e.x, y - e.y) < SAME_FIRE)) continue;
        this.fires.push([e.x, e.y]);
        if (this.fires.length > MAX_FIRES) this.fires.shift();
      }
      this.litAt = performance.now() / 1000;
      this.hold('ignite', FIRE_WAKE);
    });
    this.apply();
  }

  /** the window slid: the watched fires' points move with the land */
  shift(dx: number, dy: number): void {
    this.fires = this.fires.map(([x, y]) => [x - dx, y - dy]);
  }

  /** woken until released */
  hold(key: string, what: QuietWhat | 'all'): void {
    this.holds.set(key, { what, until: null });
    this.apply();
  }
  /** woken for `seconds` (a new wake of the same key extends it) */
  wake(key: string, what: QuietWhat | 'all', seconds: number): void {
    const until = performance.now() / 1000 + seconds;
    const was = this.holds.get(key);
    this.holds.set(key, { what, until: was?.until != null ? Math.max(was.until, until) : until });
    this.apply();
  }
  release(key: string): void {
    if (this.holds.delete(key)) this.apply();
  }
  has(key: string): boolean {
    return this.holds.has(key);
  }

  /** each frame: timed holds let go */
  update(): void {
    const now = performance.now() / 1000;
    let gone = false;
    for (const [k, h] of this.holds)
      if (h.until !== null && h.until <= now) {
        this.holds.delete(k);
        gone = true;
      }
    if (gone) this.apply();
    // (a fire lit: looked at every CHECK_S once it has had FIRST_S to catch; let go when nothing burns where it was lit)
    if (this.holds.has('ignite') && !this.looking && now - this.litAt > FIRST_S && now - this.lookedAt > CHECK_S) {
      this.looking = true;
      this.lookedAt = now;
      const asked = this.litAt;
      void this.burning(this.fires).then(
        (b) => {
          this.looking = false;
          if (b || this.litAt !== asked) return;
          console.log(`[quiet] the fire is out (${this.fires.length} place(s) looked at)`);
          this.fires = [];
          this.release('ignite');
        },
        (e) => {
          this.looking = false;
          throw e;
        },
      );
    }
  }

  private apply(): void {
    const sys = new Set<string>();
    let plants = false;
    let fire = false;
    for (const { what } of this.holds.values()) {
      if (what === 'all') {
        for (const s of QUIET_SYSTEMS) sys.add(s);
        plants = fire = true;
        continue;
      }
      for (const s of what.systems ?? []) sys.add(s);
      plants ||= !!what.plants;
      fire ||= !!what.fireParticles;
    }
    for (const s of QUIET_SYSTEMS) {
      if (sys.has(s)) this.sim.paused.delete(s);
      else this.sim.paused.add(s);
    }
    this.sim.particles.plants = plants;
    this.sim.particles.fire = fire;
    this.awake = { systems: [...sys], plants, fireParticles: fire };
    const key = `${[...sys].sort().join(',')}|${plants}|${fire}`;
    if (key !== this.key) {
      this.key = key;
      console.log(`[quiet] awake: ${sys.size ? [...sys].join(', ') : 'none'}${plants ? ', plant particles' : ''}${fire ? ', fire particles' : ''} (holds: ${[...this.holds.keys()].join(', ') || 'none'})`);
    }
  }
}
