// The fortress's defence against a wave (round 128l, m4: the attack wave, part B; DECISIONS round 128l "the attack
// wave": automatic posts — "Soldiers (archers once trained) man the walls and the gate on their own. Archers shoot from
// the wall-walk; swordsmen meet raiders at the gate. You defend by what you built.").
//  - Posts (`postsFor`, pure): when the rider's word comes (or the wave, if it comes first) the soldiers leave their
//    round. A third of them (at least one, when there are two or more) are swordsmen: they guard the inside of the wall
//    cell the raiders will go for (raid.ts raidGoal with the gates shut) — the units' own 'guard' job, so they close on
//    raiders on their side of the wall (AgentUnits.fightRules) and go back to their spot. The rest are archers: they walk
//    up onto the wall-walk beside that cell (a goal field) and stand there. With no wall, everyone guards the stores.
//  - Arrows: an archer up on the wall shoots the nearest raider in range every ARROW.every s. The arrow is the CPU's: a
//    straight flight of ARROW.speed; it hits if the raider is still within ARROW.hitR of where it was aimed when it lands
//    (a raider bashing a gate stands still; one running mostly isn't). What's drawn is a chip of wood thrown on the
//    same lob (the particles), dust where it lands on someone.
//  - After the wave every soldier goes back to its round (FortressCrowd.backToRoutine).
import type { UnitId, V2 } from '../api/contracts/units';
import type { FxName } from '../api/fx';
import { R } from '../units/agent-units';
import { G, type AgentUnits, type UnitRec } from '../units/agent-units';
import type { FortressCrowd } from './crowd';

type V3 = [number, number, number];

/** The archers' numbers (untuned). */
export const ARROW = {
  /** m: how far an archer shoots (across the ground) */
  range: 26,
  /** sim seconds between an archer's shots */
  every: 1.6,
  /** m/s along the line from the bow to the mark */
  speed: 28,
  /** what a hit takes off (a raider has RAID.raiderHealth 8) */
  damage: 2,
  /** m: a mark still this near where it was aimed when the arrow lands is hit */
  hitR: 1.2,
  /** the particles' fall (cells/s²: the chips' — particles.wgsl debris gravity, about) */
  gravity: 14,
};

/** How many of `n` soldiers are swordsmen at the gate (the rest archers): a third, at least one of two or more. */
export function swordsOf(n: number): number {
  if (n < 2) return 0;
  return Math.max(1, Math.floor(n / 3));
}

/** An arrow from `from` to `to`: its flight time, and the velocity of a chip thrown to land there under ARROW.gravity. */
export function arrowFlight(from: V3, to: V3): { t: number; vel: V3 } {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const t = Math.max(0.15, Math.hypot(dx, dy, dz) / ARROW.speed);
  return { t, vel: [dx / t, dy / t, dz / t + 0.5 * ARROW.gravity * t] };
}

/** Whether an arrow aimed at `aim` hits a mark now at `at`. */
export function arrowHits(aim: V3, at: V3): boolean {
  return Math.hypot(at[0] - aim[0], at[1] - aim[1]) <= ARROW.hitR && Math.abs(at[2] - aim[2]) < 2;
}

export interface DefenceIO {
  units: AgentUnits;
  life: FortressCrowd;
  burst(name: FxName, x: number, y: number, z: number, opts?: { count?: number; speed?: number; spread?: number; vel?: readonly [number, number, number] }): void;
  /** the raiders alive now */
  raiders(): UnitId[];
  /** (round 128p) the raiders' faction: an archer's mark asked of the GPU among theirs (AgentUnits.query) */
  raidFaction: string;
}

/** where the soldiers stand: the archers' point on the wall-walk and the swordsmen's inside the gate (or the stores) */
export interface Posts {
  archers: V2 | null;
  swords: V2;
}

interface Post {
  role: 'archer' | 'sword';
  /** sim seconds to its next shot */
  cool: number;
  /** up on the wall at its point: it shoots */
  up: boolean;
  /** (round 128p) where it stands up there (the GPU's arrival), and a mark being asked for */
  at?: V3;
  aiming?: boolean;
}

export class FortressDefence {
  readonly posted = new Map<UnitId, Post>();
  private posts: Posts | null = null;
  private arrows: { from: UnitId; mark: UnitId; aim: V3; t: number; landing?: boolean; done?: boolean }[] = [];
  readonly stats = { posted: 0, shots: 0, hits: 0 };

  constructor(private io: DefenceIO) {}

  /** whether a soldier is on its post (the raid's routine poses it) */
  takes(u: UnitRec): boolean {
    return u.v.job.kind === 'work' && this.posted.has(u.v.id);
  }

  /** an archer up on its post: its pose (drawing: the work pose) */
  step(u: UnitRec): void {
    const U = this.io.units;
    const p = this.posted.get(u.v.id);
    if (p?.up && p.cool > ARROW.every - 0.6) {
      U.regroup(u, R.working);
      u.v.state = 'swing';
    } else {
      U.regroup(u, G.stand);
      u.v.state = 'idle';
    }
  }

  /** (round 128p) the archers on their posts: they hold them (AgentUnits.fightFlags) */
  archers(): UnitId[] {
    return [...this.posted].filter(([, p]) => p.role === 'archer').map(([id]) => id);
  }

  /** an archer never closes in to fight (it shoots); anyone else as the units' rules say */
  holds(id: UnitId): boolean {
    return this.posted.get(id)?.role === 'archer';
  }

  /** the soldiers to their posts (those already there stay; new soldiers join) */
  man(posts: Posts): void {
    const L = this.io.life;
    const U = this.io.units;
    const moved = !this.posts || !same(this.posts.archers, posts.archers) || !same(this.posts.swords, posts.swords);
    this.posts = posts;
    const soldiers = L.soldiers.filter((id) => U.get(id)?.alive);
    const swords = posts.archers ? swordsOf(soldiers.length) : soldiers.length;
    soldiers.forEach((id, i) => {
      const role: Post['role'] = i < swords ? 'sword' : 'archer';
      const had = this.posted.get(id);
      if (had && had.role === role && !moved) return;
      this.posted.set(id, { role, cool: ARROW.every * Math.random(), up: false });
      if (!had) this.stats.posted++;
      if (role === 'sword') U.order(id, { kind: 'guard', at: posts.swords, radius: 2 });
      else U.order(id, { kind: 'go', to: posts.archers! });
    });
  }

  /**
   * each frame (sim seconds): the archers up on the wall shoot; the arrows land. (Round 128p, DA-B22 (c)(4): an archer is
   * up when the GPU tells it arrived at its point on the wall-walk — where it stands then; its mark the nearest raider in
   * range, asked of the GPU when it shoots (a query of the raiders' faction); an arrow lands on its mark if the mark,
   * asked again then, stands where it was aimed — no unit's position read every frame)
   */
  update(dt: number): void {
    const U = this.io.units;
    const L = this.io.life;
    const raiders = new Set(this.io.raiders());
    for (const [id, p] of this.posted) {
      if (p.role !== 'archer') continue;
      const v = U.get(id);
      if (!v?.alive) {
        this.posted.delete(id);
        continue;
      }
      // (up: arrived at its point, on the wall-walk — over the ground the fortress first read there)
      if (!p.up) {
        const at = U.arrivedAt(id);
        if (at && at[2] > L.keptGround([at[0], at[1]]) + 1.5) {
          p.up = true;
          p.at = at;
          U.order(id, { kind: 'work', at: [at[0], at[1]], what: 'soldier' });
        }
      }
      if (!p.up || !p.at || p.aiming) continue;
      p.cool -= dt;
      if (p.cool > 0) continue;
      const from = p.at;
      p.aiming = true;
      void U.query([from[0], from[1]], ARROW.range, { faction: this.io.raidFaction }).then((near) => {
        p.aiming = false;
        const mark = near.find((r) => raiders.has(r.id) && r.at);
        if (!mark?.at || !this.posted.has(id)) {
          p.cool = 0.3;
          return;
        }
        p.cool = ARROW.every;
        this.shoot(id, from, mark.id, mark.at);
      });
    }
    for (const a of this.arrows) {
      if (a.landing) continue;
      a.t -= dt;
      if (a.t > 0) continue;
      a.landing = true;
      // (where it lands: the mark asked for there)
      void U.query([a.aim[0], a.aim[1]], 3, { faction: this.io.raidFaction }).then((near) => {
        a.done = true;
        const m = near.find((r) => r.id === a.mark);
        if (!m?.alive || !m.at || !arrowHits(a.aim, m.at)) return;
        this.stats.hits++;
        this.io.burst('dust', m.at[0], m.at[1], m.at[2] + 0.9, { count: 6, speed: 1.5, spread: 0.3 });
        U.hit(a.mark, ARROW.damage, a.from);
      });
    }
    this.arrows = this.arrows.filter((a) => !a.done);
  }

  private shoot(id: UnitId, from: V3, mark: UnitId, at: V3): void {
    this.stats.shots++;
    const f: V3 = [from[0], from[1], from[2] + 1.3];
    const aim: V3 = [at[0], at[1], at[2]];
    const { t, vel } = arrowFlight(f, [aim[0], aim[1], aim[2] + 0.8]);
    this.arrows.push({ from: id, mark, aim, t });
    this.io.burst('chips', f[0], f[1], f[2], { count: 2, speed: 0.2, spread: 0.05, vel });
  }

  /** the wave is over: every soldier back to its round */
  release(): void {
    for (const id of this.posted.keys()) this.io.life.backToRoutine(id);
    this.posted.clear();
    this.posts = null;
    this.arrows = [];
  }
}

function same(a: V2 | null, b: V2 | null): boolean {
  if (!a || !b) return a === b;
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1;
}
