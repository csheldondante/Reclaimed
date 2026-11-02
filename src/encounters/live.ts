// ---- encounters/live.ts ---------------------------------------------------------------------------------------------
// (round 126, `encounters`) An encounter played where the hero is: its bands spawned round the hero through the Units
// contract (riders at the spec's pace — AgentUnits honours SpawnOpts.speed now), driven each frame (the quarry run on,
// the people freed and led, the broken sent running), observed and judged by its rules (rules.ts), its result handed
// back. It knows the Units, the Followers and the Talk contracts and the hero's position and health; nothing of the run,
// the cards or the GPU. Window coordinates (x cells, y world units), as the world API's.
// The user (round 126): "the actual hero missions are still the race with a flag and not actually any of the in world
// things we discussed like chases or fights or scenes with conversations and combat."

import type { Band, EncounterResult, EncounterSpec } from '../api/contracts/encounter';
import type { Followers } from '../api/contracts/orders';
import type { UnitId, Units, V2, V3 } from '../api/contracts/units';
import { EncounterRules, type EncounterObs } from './rules';
import type { Talk } from './talk';

/** cells a pursuer can be from the hero and still be on its tail as it leaves (the run's pursuers after) */
const TAIL = 70;
/** a quarry is told on toward its escape every QUARRY_S, a stride of QUARRY_STRIDE cells (units walk a goal only near
 *  it: runsit's round-120 probe) */
const QUARRY_S = 0.5;
const QUARRY_STRIDE = 26;
/** cells to the haven's or the safety's point that count as there */
const THERE = 9;
/** cells off the speaker the hero is when the scene's talk opens */
const TALK_R = 22;
/** sight of what goes for the hero at once (cells): it has seen the hero already */
const SIGHT = 90;
const GUARD_SIGHT = 26;

export interface LiveHero {
  position(): V3;
  readonly health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
  /** cells/s: its cruise (riders' pace is a share of it) */
  cruise: number;
  /** the play hero's id (a scene's dread) */
  id: string;
}

export interface LiveDeps {
  units: Units;
  hero: () => LiveHero;
  followers: Followers;
  talk: Talk;
  /** a dry spot near p, kept inside the window */
  place: (p: V2) => V2;
  /** what the hero has to bargain with or back them down by */
  held: () => { goods: Record<string, number>; renown: number };
  pay: (goods: string, count: number) => void;
  /** a big line on the screen (a reply, the people freed) */
  say: (s: string) => void;
}

/** where it happens: the hero's way in, the way on (a unit vector), the hall's gate and the camp, if the area has them */
export interface LivePlaces {
  entry: V2;
  way: V2;
  haven?: V2;
  camp?: V2;
}

export class LiveEncounter {
  readonly rules: EncounterRules;
  readonly result: Promise<EncounterResult>;
  private resolve!: (r: EncounterResult) => void;
  t = 0;
  /** seconds since the talk ended (a scene's limit counts from the fight) */
  private since = 0;
  done = false;
  readonly ids: Record<Band['part'], UnitId[]> = { pursuers: [], foes: [], quarry: [], guards: [], people: [] };
  private startOf = new Map<UnitId, V2>();
  private quarryT = 0;
  private escapeAt: V2 | null = null;
  haven: V2 | null;
  camp: V2 | null;
  safety: V2 | null = null;
  private freed = false;
  private speaker: UnitId | null = null;
  private trader: UnitId | null = null;
  talking = false;
  /** a scene's answers as shown, by id (a check picks one by its index) */
  shown: string[] = [];
  readonly log: string[] = [];

  constructor(
    readonly spec: EncounterSpec,
    private d: LiveDeps,
    private at: LivePlaces,
  ) {
    this.rules = new EncounterRules(spec);
    this.result = new Promise((r) => (this.resolve = r));
    const [ux, uy] = at.way;
    this.camp = at.camp ?? (spec.camp !== undefined ? d.place([at.entry[0] + ux * spec.camp, at.entry[1] + uy * spec.camp]) : null);
    this.haven = at.haven ?? (spec.haven !== undefined ? d.place([at.entry[0] + ux * spec.haven, at.entry[1] + uy * spec.haven]) : null);
    if (spec.escape) this.escapeAt = [at.entry[0] + ux * (spec.escape.cells + 20), at.entry[1] + uy * (spec.escape.cells + 20)];
    for (const b of spec.bands) this.spawn(b);
    if (spec.scene && this.camp) {
      const s = spec.scene.speaker;
      this.speaker = d.units.spawn('raider', this.camp, null, { name: s.name, role: s.title, hostile: false, health: 4, sight: 0, colour: s.colour, job: { kind: 'guard', at: this.camp, radius: 1 } });
      this.ids.foes.push(this.speaker);
      const tp: V2 = d.place([this.camp[0] + at.way[0] * 3, this.camp[1] + at.way[1] * 3]);
      this.trader = d.units.spawn('trader', tp, null, { name: 'the trader', role: 'trader', hostile: false, health: 5, colour: '#e8c66a', job: { kind: 'guard', at: tp, radius: 1 } });
    }
    this.log.push(`${spec.kind}: ${spec.bands.map((b) => `${b.count} ${b.part} (${b.role}${b.pace ? ` at ${(b.pace * d.hero().cruise).toFixed(1)} c/s` : ''}) ${b.from} ${b.range.join('-')}`).join('; ')}`);
  }

  /** a band in, round the hero (or the camp) */
  private spawn(b: Band): void {
    const H = this.d.hero();
    const p = H.position();
    const me: V2 = [p[0], p[1]];
    const [ux, uy] = this.at.way;
    const perp: V2 = [-uy, ux];
    const speed = b.pace ? b.pace * H.cruise : undefined;
    for (let i = 0; i < b.count; i++) {
      const k = b.count > 1 ? i / (b.count - 1) - 0.5 : 0;
      const r = b.range[0] + ((i * 0.618) % 1) * (b.range[1] - b.range[0]);
      let q: V2;
      if (b.from === 'behind') q = [me[0] - ux * r + perp[0] * k * 8, me[1] - uy * r + perp[1] * k * 8];
      else if (b.from === 'ahead') q = [me[0] + ux * r + perp[0] * k * 10, me[1] + uy * r + perp[1] * k * 10];
      else {
        const c = b.from === 'camp' ? this.camp! : me;
        const a = (2 * Math.PI * i) / b.count + 0.4;
        q = [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
      }
      const at = this.d.place(q);
      const faction = b.faction;
      let id: UnitId;
      if (b.part === 'quarry') {
        // (a hostile rider that notices nothing: it runs, and swings only at what rides alongside — riders are a hostile
        // kind on the GPU: units/agent-units.ts RIDER_MIN)
        id = this.d.units.spawn(b.role, at, faction, { hostile: true, sight: 0, speed, health: b.health, role: b.role, job: { kind: 'go', to: this.stride(at) } });
        this.startOf.set(id, at);
      } else if (b.part === 'people') {
        id = this.d.units.spawn('captive', at, null, { hostile: false, sight: 0, health: b.health, role: 'captive', colour: '#e8e0c8', job: { kind: 'guard', at, radius: 1 } });
      } else if (b.part === 'guards') {
        id = this.d.units.spawn(b.role, at, faction, { hostile: true, sight: GUARD_SIGHT, speed, health: b.health, role: b.role, job: { kind: 'guard', at: this.camp!, radius: 10 } });
      } else if (!b.hostile) {
        // (a scene's band: standing round the camp until the talk goes one way or the other)
        id = this.d.units.spawn(b.role, at, faction, { hostile: false, sight: 0, health: b.health, role: b.role, job: { kind: 'guard', at, radius: 1 } });
      } else {
        id = this.d.units.spawn(b.role, at, faction, { hostile: true, sight: SIGHT, speed, health: b.health, role: b.role, job: { kind: 'attack', target: 'hero' } });
      }
      this.ids[b.part].push(id);
    }
  }

  /** the quarry's next stride toward its escape */
  private stride(from: V2): V2 {
    const e = this.escapeAt!;
    const l = Math.hypot(e[0] - from[0], e[1] - from[1]);
    if (l <= QUARRY_STRIDE) return e;
    return [from[0] + ((e[0] - from[0]) / l) * QUARRY_STRIDE, from[1] + ((e[1] - from[1]) / l) * QUARRY_STRIDE];
  }

  private alive(ids: UnitId[]): UnitId[] {
    return ids.filter((id) => this.d.units.get(id)?.alive);
  }
  private me(): V2 {
    const p = this.d.hero().position();
    return [p[0], p[1]];
  }
  private dist(id: UnitId, p: V2): number {
    const u = this.d.units.get(id)!;
    return Math.hypot(u.at[0] - p[0], u.at[1] - p[1]);
  }

  /** what is seen this step */
  observe(): EncounterObs {
    const H = this.d.hero();
    const me = this.me();
    const o: EncounterObs = { t: this.spec.kind === 'scene' ? this.since : this.t, heroAlive: H.alive, health: H.health / H.maxHealth };
    const foes = [...this.ids.foes, ...this.ids.guards];
    if (foes.length) o.foes = { alive: this.alive(foes).length, total: foes.length };
    const pur = this.alive(this.ids.pursuers);
    o.pursuers = { alive: pur.length, nearest: pur.length ? Math.min(...pur.map((id) => this.dist(id, me))) : Infinity };
    if (this.ids.quarry.length) {
      const q = this.alive(this.ids.quarry);
      const esc = this.spec.escape!;
      o.quarry = { alive: q.length, total: this.ids.quarry.length, escaped: q.some((id) => this.dist(id, this.startOf.get(id)!) >= esc.cells || this.dist(id, me) >= esc.far) };
    }
    if (this.ids.people.length) {
      const P = this.alive(this.ids.people);
      const safe = this.safety ? P.filter((id) => this.dist(id, this.safety!) < THERE + 4).length : 0;
      o.people = { freed: this.freed, alive: P.length, safe, total: this.ids.people.length };
    }
    if (this.haven) o.atHaven = Math.hypot(this.haven[0] - me[0], this.haven[1] - me[1]) < THERE;
    return o;
  }

  /** Each frame, after the hero stepped. */
  update(dt: number): void {
    if (this.done) return;
    this.t += dt;
    if (this.rules.status.state === 'talk') {
      if (!this.talking && this.speaker !== null && this.dist(this.speaker, this.me()) < TALK_R) void this.openTalk();
      if (!this.d.hero().alive) this.finish();
      return;
    }
    this.since += dt;
    const me = this.me();
    // the quarry runs on
    if (this.ids.quarry.length) {
      this.quarryT += dt;
      if (this.quarryT >= QUARRY_S) {
        this.quarryT = 0;
        for (const id of this.alive(this.ids.quarry)) {
          const u = this.d.units.get(id)!;
          this.d.units.order(id, { kind: 'go', to: this.stride([u.at[0], u.at[1]]) });
        }
      }
    }
    const o = this.observe();
    // the people freed once their guards are down or broken: they follow the hero, and riders come for them
    if (this.spec.escort && !this.freed && this.rules.guardsClear(o) && this.camp && Math.hypot(this.camp[0] - me[0], this.camp[1] - me[1]) < 14) this.free();
    const wasBroken = this.rules.broke;
    const st = this.rules.step(o);
    if (!wasBroken && this.rules.broke) this.rout('they break and run!');
    if (st.state === 'ended') this.finish();
  }

  private free(): void {
    this.freed = true;
    const people = this.alive(this.ids.people);
    this.d.followers.recruit(people);
    this.d.followers.order({ kind: 'follow', distance: 3 });
    const c = this.camp!;
    const [ux, uy] = this.at.way;
    const s = this.spec.escort!;
    // safety off to the side of the road (the hills), the riders in from beyond the camp
    this.safety = this.d.place([c[0] - uy * s.safety, c[1] + ux * s.safety]);
    const b = s.pursuers;
    for (let i = 0; i < b.count; i++) {
      const r = b.range[0] + (i / Math.max(1, b.count)) * (b.range[1] - b.range[0]);
      const at = this.d.place([c[0] + ux * r + uy * (i - b.count / 2) * 3, c[1] + uy * r - ux * (i - b.count / 2) * 3]);
      this.ids.pursuers.push(this.d.units.spawn(b.role, at, b.faction, { hostile: true, sight: SIGHT, speed: b.pace ? b.pace * this.d.hero().cruise : undefined, health: b.health, role: b.role, job: { kind: 'attack', target: 'hero' } }));
    }
    this.d.say(`${people.length} freed: lead them out!`);
    this.log.push(`freed ${people.length} at t ${this.t.toFixed(1)}; ${b.count} ${b.role} come`);
  }

  /** the rest of the foes run from the hero */
  private rout(line: string): void {
    const me = this.me();
    const ids = this.alive([...this.ids.foes, ...this.ids.guards, ...this.ids.pursuers]);
    for (const id of ids) this.d.units.order(id, { kind: 'flee', from: me });
    if (line) this.d.say(line);
    this.log.push(`routed ${ids.length} at t ${this.t.toFixed(1)}`);
  }

  private async openTalk(): Promise<void> {
    const sc = this.spec.scene!;
    this.talking = true;
    const held = { ...this.d.held(), hero: this.d.hero().id };
    const answers = this.rules.answers(held);
    this.shown = answers.map((a) => a.id);
    const pick = await this.d.talk.ask(sc.speaker, sc.line, answers.map((a) => a.text));
    if (this.done) return;
    // (closed unanswered: they take it as a no)
    const a = answers[pick ?? answers.findIndex((x) => x.id === 'fight')];
    const r = this.rules.choose(a.id, held);
    this.log.push(`scene: ${a.id} → ${r.then}`);
    if (r.then === 'bargain') this.d.pay(a.cost!.goods, a.cost!.count);
    await this.d.talk.tell(sc.speaker, r.reply);
    this.talking = false;
    if (this.done) return;
    if (r.then === 'fight') {
      for (const id of this.alive(this.ids.foes)) {
        this.d.units.setHostile(id, true);
        this.d.units.order(id, { kind: 'attack', target: 'hero' });
      }
    } else {
      this.rout('');
      this.finish();
    }
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    const st = this.rules.status;
    const H = this.d.hero();
    const me = this.me();
    const res = st.state === 'ended' ? st.result : { tier: 'disaster' as const, won: false, heroDied: !H.alive, why: 'the hero fell' };
    const tail = this.alive(this.ids.pursuers).filter((id) => this.dist(id, me) < TAIL).length;
    // (it's over: what still stands stops coming at the hero — a beaten hero gets away, a won fight's rest run)
    if (H.alive) this.rout('');
    const r: EncounterResult = { ...res, seconds: this.t, pursuers: res.won ? tail : 0 };
    this.log.push(`ended ${r.tier}: ${r.why} at t ${this.t.toFixed(1)}`);
    this.resolve(r);
  }

  /** the banner's line now */
  line(): string {
    const s = this.spec;
    const o = this.observe();
    if (this.rules.status.state === 'talk') return `${s.title}: ${this.talking ? 'they talk' : 'ride up to them'}`;
    switch (s.kind) {
      case 'flee': {
        const n = o.pursuers!.alive;
        const near = Number.isFinite(o.pursuers!.nearest) ? `${o.pursuers!.nearest.toFixed(0)} cells back` : '';
        return this.haven ? `✉ Carry the word: ${n} on your tail ${near} · the gate ${this.toHaven().toFixed(0)} cells` : `⇢ Lose them: ${n} on your tail ${near}`;
      }
      case 'chase':
        return `⇉ Run them down: ${o.quarry!.alive} of ${o.quarry!.total} running`;
      case 'escort':
        return this.freed ? `☞ Lead them out: ${o.people!.alive} with you, ${o.people!.safe} safe` : `⛓ Break the guards: ${o.foes!.alive} of ${o.foes!.total} stand`;
      default:
        return `⚔ ${s.title}: ${o.foes?.alive ?? 0} of ${o.foes?.total ?? 0} stand`;
    }
  }

  private toHaven(): number {
    const me = this.me();
    return Math.hypot(this.haven![0] - me[0], this.haven![1] - me[1]);
  }

  /** where the screen's arrow points: the haven, the safety, else the nearest enemy */
  pointAt(): V2 | null {
    if (this.haven) return this.haven;
    if (this.freed && this.safety) return this.safety;
    if (this.rules.status.state === 'talk' && this.speaker !== null) return this.unitAt(this.speaker);
    return this.nearest(this.spec.kind === 'chase' ? this.ids.quarry : [...this.ids.foes, ...this.ids.guards, ...this.ids.pursuers]);
  }

  private unitAt(id: UnitId): V2 | null {
    const u = this.d.units.get(id);
    return u ? [u.at[0], u.at[1]] : null;
  }

  private nearest(ids: UnitId[]): V2 | null {
    const me = this.me();
    let best: V2 | null = null;
    let bd = Infinity;
    for (const id of this.alive(ids)) {
      const u = this.d.units.get(id)!;
      const dd = Math.hypot(u.at[0] - me[0], u.at[1] - me[1]);
      if (dd < bd) (bd = dd), (best = [u.at[0], u.at[1]]);
    }
    return best;
  }

  /**
   * (a check's autopilot, never the game's) where a player would go now and whether to swing: a flee rides away from
   * the nearest pursuer (toward the haven, or the way on); a fight goes at the nearest foe; a chase at the nearest quarry;
   * an escort breaks the guards, then leads the people to safety (slow enough for them to keep up).
   */
  aim(me: V2): { at: V2; fight: boolean; slow?: boolean } | null {
    const s = this.spec;
    if (this.rules.status.state === 'talk') return this.speaker !== null ? { at: this.unitAt(this.speaker) ?? me, fight: false, slow: true } : null;
    if (s.kind === 'flee') {
      const t = this.haven ?? [me[0] + this.at.way[0] * 60, me[1] + this.at.way[1] * 60];
      return { at: t, fight: false };
    }
    if (s.kind === 'chase') {
      const q = this.nearest(this.ids.quarry);
      return q ? { at: q, fight: true } : null;
    }
    if (s.kind === 'escort' && this.freed && this.safety) {
      // (a pursuer near the people first; else to safety, waiting for them)
      const P = this.alive(this.ids.people).map((id) => this.unitAt(id)!);
      const cx = P.reduce((a, p) => a + p[0], 0) / Math.max(1, P.length);
      const cy = P.reduce((a, p) => a + p[1], 0) / Math.max(1, P.length);
      const threat = this.alive(this.ids.pursuers).map((id) => this.unitAt(id)!).find((p) => Math.hypot(p[0] - cx, p[1] - cy) < 14);
      if (threat) return { at: threat, fight: true };
      return { at: this.safety, fight: false, slow: Math.hypot(cx - me[0], cy - me[1]) > 6 };
    }
    const f = this.nearest(s.kind === 'escort' && !this.freed && this.rules.guardsClear(this.observe()) ? [] : [...this.ids.foes, ...this.ids.guards, ...this.ids.pursuers]);
    if (f) return { at: f, fight: true };
    return this.camp ? { at: this.camp, fight: false } : null;
  }

  /** the orders the hero can give now (an escort's people) */
  orders(): { label: string; f: () => void }[] {
    if (!this.freed) return [];
    return [
      { label: '☞ Follow me', f: () => this.d.followers.order({ kind: 'follow', distance: 3 }) },
      { label: '✋ Hold here', f: () => this.d.followers.order({ kind: 'hold', at: this.me() }) },
    ];
  }

  /** the window slid */
  shift(dx: number, dy: number): void {
    const mv = (p: V2 | null): V2 | null => (p ? [p[0] + dx, p[1] + dy] : null);
    this.haven = mv(this.haven);
    this.camp = mv(this.camp);
    this.safety = mv(this.safety);
    this.escapeAt = mv(this.escapeAt);
    this.at = { ...this.at, entry: mv(this.at.entry)! };
    for (const [id, p] of this.startOf) this.startOf.set(id, [p[0] + dx, p[1] + dy]);
  }

  /** its units gone */
  dispose(): void {
    this.done = true;
    for (const ids of Object.values(this.ids)) for (const id of ids) this.d.units.remove(id);
    if (this.trader !== null) this.d.units.remove(this.trader);
  }
}
