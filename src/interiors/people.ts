// The people who live in an interior: a small cast from the inhabitants' generator (src/inhabitants: the Rain World rig
// and its procedural animation), each a group of one driven as a puppet — the CPU walks them on the storeys' grids
// (A*, the stairs between storeys), sits them on the seats the furnishing made, sets them to work at the fire, at the
// window, round the table; the GPU animates them. When two are near and at rest they talk: short plain exchanges by
// role, as bubbles over them (speech.ts); the player taps one to talk (the dialog).
//
// What's missing from the generator for this (BACKLOG IT-rows; the future character generator's requirements):
// faces and hands (no eyes or mouths: a speaker shows only by gesture), sitting as a real pose (a puppet's root is
// lowered and its feet put forward — no hip or knee intent), per-person clothing beyond the gear slots, carrying a
// thing in the hands, per-creature (not per-group) orders, and lying down.
import type { InteriorPlan, Spot, V2, V3 } from '../api/contracts/interiors';
import type { SpeciesSpec } from '../api/contracts/inhabitants';
import type { DialogTree } from '../api/contracts/dialog';
import type { InhabitantsGpu } from '../inhabitants/system';
import type { Camera } from '../render/camera';
import type { WalkGrid } from './grid';
import type { ActiveInterior } from './install';
import type { InteriorSpeech, Talker } from './speech';

type Role = 'reeve' | 'guard' | 'cook' | 'clerk' | 'child' | 'elder';

interface CastMember extends Talker {
  role: Role;
  spec: SpeciesSpec;
  /** what they like to be doing: spot kinds and rooms, weighted */
  likes: { kind: Spot['kind']; room?: string; w: number }[];
  walk: number;
}

const biped = (id: string, seed: number, size: number, body: string, belly: string, accent: string, gear: SpeciesSpec['gear'], o: Partial<SpeciesSpec['proportions']> = {}): SpeciesSpec => ({
  id,
  traits: ['living'],
  plan: 'biped',
  seed,
  proportions: { size, ...o },
  palette: { body, belly, accent, eye: '#111111' },
  gear,
  behaviour: { kind: 'wander' },
  walk: 1.2,
  run: 3.5,
});

/** the hall's people (a town hall: its reeve, a guard, the cook, a clerk, a child, an old woman upstairs) */
export const CAST: CastMember[] = [
  { id: 'maren', name: 'Maren', title: 'the reeve', role: 'reeve', colour: '#c9a46a', walk: 1.0,
    spec: biped('int-maren', 21, 0.92, '#4a4038', '#d8b89a', '#2a221c', [{ slot: 'cape', colour: '#5a1e1a' }, { slot: 'hood', colour: '#3a2a20' }], { girth: 1.1 }),
    likes: [{ kind: 'sit', room: 'hall', w: 5 }, { kind: 'sit', room: 'chamber', w: 2 }, { kind: 'stand', w: 1 }, { kind: 'gather', w: 2 }] },
  { id: 'tobin', name: 'Tobin', title: 'a guard', role: 'guard', colour: '#9fb0c4', walk: 1.3,
    spec: biped('int-tobin', 33, 0.98, '#3a4048', '#c8a080', '#20242a', [{ slot: 'weapon', colour: '#b8bcc4' }, { slot: 'shield', colour: '#6a3a22' }], { girth: 1.2 }),
    likes: [{ kind: 'stand', w: 4 }, { kind: 'gather', w: 2 }, { kind: 'sit', room: 'kitchen', w: 1 }] },
  { id: 'hesta', name: 'Hesta', title: 'the cook', role: 'cook', colour: '#d88a5a', walk: 1.2,
    spec: biped('int-hesta', 45, 0.86, '#7a5a3a', '#e0b090', '#3a2a1e', [{ slot: 'pack', colour: '#8a7a5a' }], { girth: 1.25 }),
    likes: [{ kind: 'work', w: 6 }, { kind: 'sit', room: 'kitchen', w: 2 }, { kind: 'gather', w: 1 }] },
  { id: 'wil', name: 'Wil', title: 'the clerk', role: 'clerk', colour: '#8fbf8a', walk: 1.1,
    spec: biped('int-wil', 57, 0.88, '#3a4a3a', '#d0b090', '#1e2a1e', [{ slot: 'hood', colour: '#2e3e2a' }], { girth: 0.9, legs: 1.05 }),
    likes: [{ kind: 'sit', room: 'chamber', w: 4 }, { kind: 'sit', room: 'hall', w: 2 }, { kind: 'stand', w: 1 }] },
  { id: 'pim', name: 'Pim', title: 'the cook’s boy', role: 'child', colour: '#e6d27a', walk: 1.5,
    spec: biped('int-pim', 69, 0.58, '#6a5a4a', '#e8c0a0', '#3a2a20', [], { head: 1.25 }),
    likes: [{ kind: 'stand', w: 3 }, { kind: 'sit', w: 2 }, { kind: 'gather', w: 2 }, { kind: 'work', w: 1 }] },
  { id: 'ada', name: 'Old Ada', title: 'who keeps the stores', role: 'elder', colour: '#b9a0c8', walk: 0.75,
    spec: biped('int-ada', 81, 0.8, '#4a3a4a', '#d8b8a8', '#2a202a', [{ slot: 'cape', colour: '#3a2e3e' }, { slot: 'hood', colour: '#2a222e' }], { girth: 1.0 }),
    likes: [{ kind: 'sit', room: 'sleeping', w: 3 }, { kind: 'sit', room: 'stores', w: 2 }, { kind: 'stand', w: 2 }, { kind: 'sit', w: 1 }] },
];

/** short plain exchanges, by who's talking with whom (roles: a ‹›any) */
const EXCHANGES: { a: Role | '*'; b: Role | '*'; lines: [0 | 1, string][] }[] = [
  { a: 'reeve', b: 'guard', lines: [[0, 'Any word from the east road?'], [1, 'None. Two carts are late.'], [0, 'Send a rider at first light.']] },
  { a: 'reeve', b: 'cook', lines: [[0, 'How much grain is left?'], [1, 'Enough for a month. Less if the carts don’t come.'], [0, 'Then we ration from tomorrow.']] },
  { a: 'reeve', b: 'clerk', lines: [[0, 'Did the mill pay its tithe?'], [1, 'Half of it. They say the river was low.'], [0, 'Write it down. We’ll ask again in spring.']] },
  { a: 'cook', b: 'child', lines: [[0, 'Pim! Fetch more wood.'], [1, 'Again?'], [0, 'The fire won’t feed itself.']] },
  { a: 'guard', b: 'child', lines: [[1, 'Can I hold the sword?'], [0, 'When you can lift it.'], [1, 'I can lift it!']] },
  { a: 'elder', b: 'cook', lines: [[0, 'Rats in the barley again.'], [1, 'I’ll put the cat up there.'], [0, 'The cat is afraid of them.']] },
  { a: 'elder', b: 'child', lines: [[0, 'Stay off the stairs, little one.'], [1, 'I wasn’t running.'], [0, 'You were.']] },
  { a: 'clerk', b: 'guard', lines: [[0, 'Who came through the gate today?'], [1, 'A tinker and two pilgrims.'], [0, 'Pilgrims? This time of year?']] },
  { a: 'elder', b: 'reeve', lines: [[0, 'The roof over the stores leaks.'], [1, 'I know. I’ll send someone.'], [0, 'You said that last week.']] },
  { a: '*', b: '*', lines: [[0, 'Cold tonight.'], [1, 'Colder tomorrow, I think.']] },
  { a: '*', b: '*', lines: [[0, 'Did you hear the bells last night?'], [1, 'Bells? There are no bells here.'], [0, 'That’s what worries me.']] },
];

/** what each says when the player talks to them */
function treeFor(c: CastMember): DialogTree {
  const hello: Record<Role, string> = {
    reeve: 'You’re in the town hall. I’m Maren, the reeve. If you need something from this town, you ask me.',
    guard: 'Keep your hands where I can see them. This is the reeve’s hall.',
    cook: 'Mind the fire. If you’re hungry, there’s soup. If you’re not, you’re in my way.',
    clerk: 'I keep the town’s books. Every sack of grain, every coin. Do you owe us anything?',
    child: 'Are you a traveller? Have you seen the sea? I’ve never seen the sea.',
    elder: 'Eh? Speak up. I keep the stores upstairs. Nobody takes a thing without asking me.',
  };
  return {
    id: `int-${c.id}`,
    speaker: c.id,
    start: 'hi',
    nodes: {
      hi: { text: hello[c.role], choices: [{ text: 'What’s happening in town?', to: 'news' }, { text: 'Goodbye.' }] },
      news: { text: c.role === 'child' ? 'The carts are late and the grown-ups are worried. I’m not worried.' : 'The carts from the east road are late. Nobody knows why yet.', choices: [{ text: 'Goodbye.' }] },
    },
  };
}

/** a seat's height over the floor, by what makes it */
const SEAT: Record<string, number> = { chair: 0.42, throne: 0.5, bench: 0.44, stool: 0.46, bed: 0.48, bedroll: 0.12 };

interface Leg {
  storey: number;
  pts: V3[];
}

interface Person {
  c: CastMember;
  group: number;
  /** where (plan frame, z the floor or the stair under it), facing */
  at: V3;
  heading: number;
  storey: number;
  route: Leg[];
  leg: number;
  seg: number;
  segT: number;
  /** what they're doing now */
  doing: 'walk' | 'rest' | 'idle';
  spot: Spot | null;
  restFor: number;
  pose: 'stand' | 'sit' | 'talk' | 'sittalk';
  talkWith: Person | null;
  height: number;
}

export interface PeopleStats {
  people: number;
  talks: number;
  lines: number;
  routes: number;
  failedRoutes: number;
}

export class InteriorPeople {
  people: Person[] = [];
  private time = 0;
  private nextTalk = 3;
  private convo: { a: Person; b: Person; lines: [0 | 1, string][]; i: number; t: number } | null = null;
  private taken = new Set<Spot>();
  stats: PeopleStats = { people: 0, talks: 0, lines: 0, routes: 0, failedRoutes: 0 };
  private onTap = (e: PointerEvent) => this.tap(e);

  constructor(private life: InhabitantsGpu, private it: ActiveInterior, private speech: InteriorSpeech, private camera: Camera, count = 5) {
    const plan = it.plan;
    const cast = CAST.slice(0, Math.max(1, Math.min(CAST.length, count)));
    cast.forEach((c, k) => {
      const sp = life.define(c.spec);
      // where they start: a storey by who they are (Ada upstairs), a free spot of theirs, or the room's middle
      const storey = c.role === 'elder' && plan.storeys.length > 1 ? Math.min(plan.storeys.length - 1, 1 + (k % (plan.storeys.length - 1))) : 0;
      const st = plan.storeys[storey];
      const spot = this.pick(c, storey) ?? null;
      const at: V3 = spot ? [spot.from[0], spot.from[1], st.z] : [st.rooms[0].centre[0], st.rooms[0].centre[1], st.z];
      const w = it.toWindow([at[0], at[1]], at[2]);
      const group = life.spawnGroup(sp, [w[0], w[1]], 1, { spread: 0, seed: 101 + k });
      const p: Person = { c, group, at, heading: 0, storey, route: [], leg: 0, seg: 0, segT: 0, doing: 'idle', spot: null, restFor: 0, pose: 'stand', talkWith: null, height: life.rig(sp).height };
      this.people.push(p);
      if (spot) this.arrive(p, spot);
    });
    this.stats.people = this.people.length;
    window.addEventListener('pointerup', this.onTap);
  }

  /** a free spot this person likes (weighted), anywhere in the building (or on `storey`) */
  private pick(c: CastMember, storey?: number, rnd = Math.random): Spot | null {
    const plan = this.it.plan;
    const all: { s: Spot; w: number }[] = [];
    plan.storeys.forEach((st, l) => {
      if (storey !== undefined && l !== storey) return;
      for (const s of st.spots) {
        if (this.taken.has(s) || s.kind === 'sleep') continue;
        const room = st.rooms[s.room]?.purpose;
        let w = 0;
        for (const lk of c.likes) if (lk.kind === s.kind && (!lk.room || lk.room === room)) w = Math.max(w, lk.w);
        if (w > 0) all.push({ s, w });
      }
    });
    const sum = all.reduce((a, x) => a + x.w, 0);
    let r = rnd() * sum;
    for (const x of all) if ((r -= x.w) <= 0) return x.s;
    return all[0]?.s ?? null;
  }

  private storeyOf(s: Spot): number {
    return this.it.plan.storeys.findIndex((st) => st.spots.includes(s));
  }

  /** a route from where p is to spot s (its `from`), up or down the stairs as needed; null: no way */
  private routeTo(p: Person, s: Spot): Leg[] | null {
    const plan: InteriorPlan = this.it.plan;
    const grids: WalkGrid[] = this.it.grids;
    const to = this.storeyOf(s);
    const legs: Leg[] = [];
    let l = p.storey;
    let from: V2 = [p.at[0], p.at[1]];
    const flat = (st: number, a: V2, b: V2): boolean => {
      const path = grids[st].path(a, b);
      if (!path) return false;
      const z = plan.storeys[st].z;
      legs.push({ storey: st, pts: path.map((q) => [q[0], q[1], z] as V3) });
      return true;
    };
    while (l !== to) {
      const up = to > l;
      const stair = up ? plan.storeys[l].stairs[0] : plan.storeys[l - 1].stairs[0];
      if (!stair) return null;
      const on = up ? stair.foot : stair.top;
      const off = up ? stair.top : stair.foot;
      if (!flat(l, from, [on[0], on[1]])) return null;
      legs[legs.length - 1].pts.push([on[0], on[1], on[2]]);
      // the flight: along its line, z from floor to floor
      legs.push({ storey: up ? l : l - 1, pts: [[on[0], on[1], on[2]], [off[0], off[1], off[2]]] });
      l = up ? l + 1 : l - 1;
      from = [off[0], off[1]];
    }
    if (!flat(l, from, [s.from[0], s.from[1]])) return null;
    return legs;
  }

  private go(p: Person, s: Spot): boolean {
    const r = this.routeTo(p, s);
    this.stats.routes++;
    if (!r) {
      this.stats.failedRoutes++;
      return false;
    }
    if (p.spot) this.taken.delete(p.spot);
    this.taken.add(s);
    p.spot = s;
    p.route = r;
    p.leg = 0;
    p.seg = 0;
    p.segT = 0;
    p.doing = 'walk';
    p.pose = 'stand';
    return true;
  }

  private arrive(p: Person, s: Spot): void {
    this.taken.add(s);
    p.spot = s;
    p.storey = this.storeyOf(s);
    p.doing = 'rest';
    p.restFor = 9 + Math.random() * 16;
    p.heading = s.face;
    const st = this.it.plan.storeys[p.storey];
    if (s.kind === 'sit' || s.kind === 'sleep') {
      const prop = s.prop !== undefined ? st.props[s.prop]?.prop : undefined;
      p.at = [s.at[0], s.at[1], st.z + (prop ? SEAT[prop] ?? 0.44 : 0.44)];
      p.pose = 'sit';
    } else {
      p.at = [s.from[0], s.from[1], st.z];
      p.pose = 'stand';
    }
  }

  update(dt: number, shown: number): void {
    this.time += dt;
    for (const p of this.people) {
      if (p.doing === 'walk') this.walk(p, dt);
      else if (p.doing === 'rest' && !p.talkWith) {
        p.restFor -= dt;
        if (p.restFor <= 0) {
          const s = this.pick(p.c);
          // (got up: stands at its way in, then off)
          if (s && s !== p.spot) {
            if (p.spot && p.pose === 'sit') p.at = [p.spot.from[0], p.spot.from[1], this.it.plan.storeys[p.storey].z];
            if (!this.go(p, s)) p.restFor = 3;
          } else p.restFor = 5;
        }
      }
    }
    this.talks(dt);
    // the puppets: where they are, in the window
    for (const p of this.people) {
      const [x, y, z] = this.it.toWindow([p.at[0], p.at[1]], p.at[2]);
      const st = this.it.plan.storeys[p.storey];
      const sat = p.pose === 'sit' || p.pose === 'sittalk';
      const floor = sat ? this.it.toWindow([0, 0], st.z)[2] : z;
      this.life.drive(p.group, { kind: 'puppet', at: [x, y, z], heading: p.heading, pose: p.pose, floor });
    }
    this.shown = shown;
    this.speech.update(dt);
  }

  private walk(p: Person, dt: number): void {
    let left = p.c.walk * dt;
    while (left > 0 && p.doing === 'walk') {
      const leg = p.route[p.leg];
      if (!leg) {
        this.arrive(p, p.spot!);
        return;
      }
      p.storey = leg.storey;
      const a = leg.pts[p.seg], b = leg.pts[p.seg + 1];
      if (!b) {
        p.leg++;
        p.seg = 0;
        p.segT = 0;
        continue;
      }
      const L = Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] - a[2]) * 0.5) || 1e-3;
      const step = Math.min(left, (1 - p.segT) * L);
      p.segT += step / L;
      left -= step;
      p.at = [a[0] + (b[0] - a[0]) * p.segT, a[1] + (b[1] - a[1]) * p.segT, a[2] + (b[2] - a[2]) * p.segT];
      p.heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (p.segT >= 1 - 1e-6) {
        p.seg++;
        p.segT = 0;
      }
    }
    // (on the flight's upper storey once past its middle)
    const leg = p.route[p.leg];
    if (leg && leg.pts.length === 2 && Math.abs(leg.pts[1][2] - leg.pts[0][2]) > 1) {
      const zs = this.it.plan.storeys.map((s) => s.z);
      let best = 0;
      zs.forEach((z, i) => p.at[2] >= z - 0.2 && (best = i));
      p.storey = best;
    }
  }

  /** the storey a talk is going on (-1: none) — the shots go there */
  talkingStorey(): number {
    return this.convo ? this.convo.a.storey : -1;
  }

  /** (set by the scene: the storey shown, -1 on the street — no one inside is seen then) */
  shown = -1;

  private head(p: Person): V3 | null {
    if (p.storey !== this.shown) return null;
    const [x, y, z] = this.it.toWindow([p.at[0], p.at[1]], p.at[2]);
    const sat = p.pose === 'sit' || p.pose === 'sittalk';
    return [x, y, z + (sat ? p.height * 0.75 : p.height * 1.25) + 0.55];
  }

  private talks(dt: number): void {
    const c = this.convo;
    if (c) {
      c.t -= dt;
      if (c.t <= 0) {
        if (c.i >= c.lines.length) {
          for (const p of [c.a, c.b]) {
            p.talkWith = null;
            p.pose = p.pose === 'sittalk' ? 'sit' : p.pose === 'talk' ? 'stand' : p.pose;
            p.restFor = Math.min(p.restFor, 4 + Math.random() * 6);
          }
          this.convo = null;
          this.nextTalk = 4 + Math.random() * 5;
          return;
        }
        const [who, line] = c.lines[c.i++];
        const sp = who === 0 ? c.a : c.b;
        const ls = who === 0 ? c.b : c.a;
        sp.pose = sp.pose === 'sit' || sp.pose === 'sittalk' ? 'sittalk' : 'talk';
        ls.pose = ls.pose === 'sittalk' ? 'sit' : ls.pose === 'talk' ? 'stand' : ls.pose;
        const secs = 1.6 + line.length * 0.055;
        this.speech.say(sp.c, line, () => this.head(sp), secs);
        this.stats.lines++;
        c.t = secs + 0.25;
      }
      return;
    }
    this.nextTalk -= dt;
    if (this.nextTalk > 0) return;
    this.nextTalk = 2;
    // two at rest on one storey, near each other (or within the same room)
    const rest = this.people.filter((p) => p.doing === 'rest' && !p.talkWith);
    let best: [Person, Person, number] | null = null;
    for (let i = 0; i < rest.length; i++)
      for (let j = i + 1; j < rest.length; j++) {
        const a = rest[i], b = rest[j];
        if (a.storey !== b.storey) continue;
        const d = Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
        if (d < 4.5 && (!best || d < best[2])) best = [a, b, d];
      }
    if (!best) {
      // nobody near anyone: someone goes to someone (a word with them)
      const w = this.people.filter((p) => p.doing === 'rest' && p.pose === 'stand');
      const a = w[Math.floor(Math.random() * w.length)];
      const b = a && this.people.filter((p) => p !== a && p.doing === 'rest')[0];
      if (a && b && b.spot) {
        const st = this.it.plan.storeys[b.storey];
        const near = st.spots.filter((s) => !this.taken.has(s) && s.kind !== 'sleep' && Math.hypot(s.from[0] - b.at[0], s.from[1] - b.at[1]) < 3.5);
        if (near.length) this.go(a, near[0]);
      }
      return;
    }
    const [a, b] = best;
    const pool = EXCHANGES.filter((e) => (e.a === a.c.role && e.b === b.c.role) || (e.a === b.c.role && e.b === a.c.role));
    const any = EXCHANGES.filter((e) => e.a === '*');
    const list = pool.length && Math.random() < 0.8 ? pool : any;
    const ex = list[Math.floor(Math.random() * list.length)];
    const swap = ex.a !== '*' && ex.a !== a.c.role;
    const [pa, pb] = swap ? [b, a] : [a, b];
    // they face each other
    pa.heading = Math.atan2(pb.at[1] - pa.at[1], pb.at[0] - pa.at[0]);
    pb.heading = Math.atan2(pa.at[1] - pb.at[1], pa.at[0] - pb.at[0]);
    pa.talkWith = pb;
    pb.talkWith = pa;
    this.convo = { a: pa, b: pb, lines: ex.lines, i: 0, t: 0.3 };
    this.stats.talks++;
  }

  /** the player taps a person (near their head on screen): talk with them */
  private tap(e: PointerEvent): void {
    if (this.speech.talking) return;
    let best: Person | null = null;
    let bd = 34;
    for (const p of this.people) {
      const h = this.head(p);
      if (!h) continue;
      const [x, y] = this.camera.project(h[0], h[1], h[2] - p.height * 0.6);
      const d = Math.hypot(x - e.clientX, y - e.clientY);
      if (d < bd) (bd = d), (best = p);
    }
    if (!best) return;
    const p = best;
    const was = p.pose;
    p.talkWith = p;
    p.pose = was === 'sit' ? 'sittalk' : 'talk';
    void this.speech.talk(p.c, treeFor(p.c)).then(() => {
      p.talkWith = null;
      p.pose = was;
    });
  }

  dispose(): void {
    window.removeEventListener('pointerup', this.onTap);
    for (const p of this.people) this.life.remove(p.group);
    this.speech.dispose();
  }
}
