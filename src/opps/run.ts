// ---- opps/run.ts --------------------------------------------------------------------------------------------------
// (round 120, `opportunities`; BACKLOG RN2-3) Slice A's strategic map: runsit's horde run driven as opportunities.
// (merge124) Its cards now come from the living engine (src/living/engine.ts) — the inspector's engine, dealer and
// oppcheck — over the run's world (the atlas world's WorldState: its fact layer seeded at the run's locus, living/seed.ts),
// with slice A's cards as living templates (living/horde.ts) and the run's conflict as the engine's stage. The old
// template path (opps/horde.ts, proposals made in code) is gone.
//
// What this keeps: the situation run (runsit/state.ts SituationRun: the clock, the host on its route, the pursuers, the
// town's fate and the finale's setup — "the town's fate and the run's endings work as today") and the turn: an area's
// play ends (the player's card resolves from how it came out) → the turn ends (the engine: crews' commitments due
// resolve, what was offered and not taken lapses with its consequence) → the next deal → at the edge the player commits
// crews (only what's available: "they must be available to your character") and plays one card (a way on: the leg, then
// its area) → …; arriving at the town is the climax: what's still running resolves, what's still offered lapses, the
// levy comes in if it can.
// What the world model keeps (the user, merge124: "update the world model so all this data lives in it"): the holdings —
// the hero, the levy and every agent with where it is (`at`, `march`), what it's committed to (Holdings.commitments, the
// turns left), its tags and effects — live in WorldState (saved in its snapshot), never here. Pure (no DOM, no GPU).

import { available, needsPlayer, type Bonus, type Commitment, type Holdings, type Opportunity, type Resolution, type Tier } from '../api/contracts/opportunity';
import type { Situation, SituationEnd } from '../api/contracts/situation';
import type { MemoryWorldState } from '../api/contracts/world-state';
import type { EntityId } from '../api/contracts/facts';
import { hashStr, rng } from '../runplan/rng';
import { SituationRun, LEVY_PACE, LEG_MIN, TRAVEL_PACE, along, delta, type AreaResult, type SituationMap, type V2 } from '../runsit/state';
import type { DealReport, Rejected } from './dealer';
import { LivingEngine, type EngineReport } from '../living/engine';
import { FactWorld } from '../living/world';
import { seedLocus } from '../living/seed';
import { armThreats, armyNow, DETOURS, holdArea, HORDE_HOOKS, HORDE_TEMPLATES, HordeStage, VETERANS, type Detour } from '../living/horde';
import { OPP_TUNE } from './tune';

export interface OppRunOptions {
  seed: number;
  /** the hero's id (the player agent's character) */
  hero: string;
  /** the run's world: the atlas world as it is (the level's WorldState, or a save) — the fact layer, the characters and
   *  the holdings live in it */
  world: MemoryWorldState;
  /** the validator run on every deal (gm/oppcheck.ts checkLiving): a problem is an error, never patched */
  check?: (r: EngineReport, e: LivingEngine) => string[];
}

export { VETERANS };

export class OppRun {
  readonly sr: SituationRun;
  readonly w: FactWorld;
  readonly engine: LivingEngine;
  readonly stage: HordeStage;
  /** the run's locus (its starting settlement) and its cast */
  readonly locus: EntityId;
  readonly cast: EntityId[];
  /** the last deal's report (the debug overlay), and every one */
  report: DealReport | null = null;
  readonly reports: DealReport[] = [];
  readonly log: string[] = [];
  /** the player's commitment while its leg and area play */
  playing: Commitment | null = null;
  climaxed = false;
  /** (RN2-7) the host's arrival as the GM wrote it, and as slice A sets it */
  readonly clockWas: number;

  constructor(sit: Situation, map: SituationMap, readonly o: OppRunOptions) {
    this.sr = new SituationRun(sit, map);
    armThreats(this.sr, OPP_TUNE.horde);
    this.clockWas = sit.threat.arrives;
    this.retime();
    this.w = new FactWorld(o.world);
    this.stage = new HordeStage(this.sr, () => OPP_TUNE.horde);
    // the locus (where the run starts: its settlement, else the nearest standing one) and its cast
    this.locus = this.locusOf();
    const seeded = seedLocus(this.w, this.locus, o.seed);
    this.cast = seeded.cast;
    this.stage.voice = seeded.voice;
    if (seeded.made) this.log.push(`the cast at ${this.w.name(this.locus)}: ${seeded.cast.map((id) => this.w.name(id)).join(', ')}`);
    this.recall();
    this.joinHero();
    this.stage.stage(this.w);
    this.engine = new LivingEngine(this.w, HORDE_TEMPLATES, undefined, this.locus, {
      stage: this.stage,
      tune: () => ({ ...OPP_TUNE.dealer }),
      onePerPlace: false,
      economy: false,
      rng: (key) => rng(hashStr(`${o.seed}:${sit.id}:${key}`))(),
      at: () => this.stage.at(),
      dist: (a, b) => Math.hypot(...delta(a, b, this.sr.map.world)),
      hooks: HORDE_HOOKS,
      clock: () => this.sr.clock,
    });
    this.dealt(this.engine.deal());
  }

  get sit(): Situation {
    return this.sr.sit;
  }
  /** the holdings: the world model's (WorldState.holdings) */
  get holdings(): Holdings {
    return this.w.holdings;
  }
  get turn(): number {
    return this.engine.turn;
  }
  get intel(): number {
    return this.stage.intel;
  }
  get rallied(): number {
    return this.stage.rallied;
  }
  /** the hold's harvest: open (ripe in the fields), taken (in), rotted */
  get harvest(): 'open' | 'rotted' | 'taken' {
    const v = this.w.facts.tag(this.stage.id('fields'), 'economy', 'harvest')?.value;
    return v === 'rotted' ? 'rotted' : v === 'in' ? 'taken' : 'open';
  }
  /** what's offered now */
  get offered(): Opportunity[] {
    return this.engine.offered.map((x) => x.opp);
  }
  get resolutions(): Resolution[] {
    return this.engine.resolutions;
  }
  /** every commitment made this run */
  get commitments(): Commitment[] {
    return [...this.engine.past, ...this.engine.offers].filter((x) => x.commitment).map((x) => x.commitment!);
  }
  /** what lapsed with a consequence */
  get expired(): { opp: Opportunity; text: string }[] {
    return this.engine.past.filter((x) => x.status === 'expired' && x.opp.onExpire).map((x) => ({ opp: x.opp, text: x.opp.onExpire!.text }));
  }

  /** where the run starts: its first area's settlement, else the nearest standing settlement to it */
  private locusOf(): EntityId {
    const a = this.sit.areas[0];
    if (a.settlement && this.w.settlement(a.settlement)) return a.settlement;
    const at = this.sr.map.areaAt(a);
    const best = this.w.ws.settlements.filter((s) => s.condition !== 'ruined' && s.condition !== 'abandoned').sort((x, y) => Math.hypot(...delta(at, x.at, this.sr.map.world)) - Math.hypot(...delta(at, y.at, this.sr.map.world)))[0];
    if (!best) throw new Error('opportunities: the world has no standing settlement for the run to start at');
    return best.id;
  }

  /** the hero as the player agent (its record's tags and effects with it) */
  private joinHero(): void {
    const h = this.w.holdings;
    const me = this.o.world.character(this.o.hero);
    let p = h.agents.find((a) => a.id === 'player');
    if (!p) h.agents.push((p = { id: 'player', kind: 'player', name: me?.name ?? this.o.hero, character: this.o.hero, count: 1, tags: [], statuses: [], at: { with: 'player' } }));
    p.name = me?.name ?? this.o.hero;
    p.character = this.o.hero;
    p.tags = [...(me?.tags ?? [])];
    delete p.committed;
    h.bonuses = h.bonuses.filter((b) => b.holder !== 'player');
    for (const b of me?.bonuses ?? []) h.bonuses.push({ ...b, holder: 'player' } as Bonus);
  }

  /** commitments an earlier run left under way (the hero fell before they came off): their conflict is over — the agents
   *  come back from where they went */
  private recall(): void {
    const h = this.w.holdings;
    for (const c of h.commitments ?? []) {
      for (const a of h.agents) if (a.committed === c.id) delete a.committed;
      this.log.push(`back from an earlier run: ${c.title} (${c.agents.join(', ')})`);
    }
    h.commitments = [];
  }

  /**
   * (round 124, RN2-7) The slack after the hold: the GM's clock was set for runsit's run (on seed 1 the levy is won at
   * minute 9.0 with the host at the town at 9.1, so its cards could never matter). The host's arrival is moved out until
   * the levy, marching from the hold when it is won, can meet the host's road `holdSlack` minutes before the host gets
   * there. `holdSlack` at its minimum keeps the GM's clock.
   */
  private retime(): void {
    const T = OPP_TUNE.horde;
    const sit = this.sr.sit;
    const hold = holdArea(this.sr);
    if (!hold || T.holdSlack <= -2) return;
    const m = this.sr.map;
    const path = sit.choices.find((c) => c.from === sit.areas[0].id && c.to === hold.id);
    if (!path) return;
    const start = sit.areas[0];
    const held = start.minutes + LEG_MIN + Math.hypot(...delta(m.areaAt(start), m.areaAt(hold), m.world)) / TRAVEL_PACE + hold.minutes;
    const pts = sit.threat.route.map((r) => m.regionCentre(r));
    let best = Infinity;
    for (let t = 0.3; t <= 0.981; t += 0.02) {
      const march = Math.hypot(...delta(m.areaAt(hold), along(pts, t, m.world), m.world)) / LEVY_PACE;
      best = Math.min(best, (held + march + T.holdSlack) / t);
    }
    if (best > sit.threat.arrives) {
      this.log.push(`slack after the hold (RN2-7): the host at ${sit.target.name} at minute ${best.toFixed(1)} (the GM's ${sit.threat.arrives}); the hold won by about ${held.toFixed(1)}`);
      sit.threat.arrives = +best.toFixed(1);
    }
  }

  /** where the player is (world units) */
  at(): V2 {
    return this.stage.at();
  }

  /** where a free army is now: marching for the town from where it was freed (its own `march`), else with the player */
  armyNow(id: string): V2 {
    const a = this.holdings.agents.find((x) => x.id === id);
    return a ? armyNow(this.sr, a, this.at()) : this.at();
  }

  /** a deal's report for the overlay: the engine's own steps (eligibility, rests …) as the dealer's 'sense' */
  private dealt(r: EngineReport): DealReport {
    const rejected: Rejected[] = [
      ...r.notProposed.map((n): Rejected => ({ template: n.template, offer: '', place: '', title: n.title, step: 'sense', why: `${n.step}: ${n.why}` })),
      ...(r.dealer?.rejected ?? []),
    ];
    const score = (o: Opportunity) => r.dealer?.dealt.find((d) => d.opp.template === o.template && d.opp.offer === o.offer);
    const rep: DealReport = { turn: r.turn, dealt: r.dealt.map((x) => ({ opp: x.opp, score: score(x.opp)?.score ?? 0, parts: score(x.opp)?.parts ?? ({} as DealReport['dealt'][number]['parts']) })), rejected, guarantees: r.dealer?.guarantees ?? [], ms: r.ms };
    const problems = this.o.check?.(r, this.engine) ?? [];
    if (problems.length) throw new Error(`opportunities: the deal of turn ${r.turn} has ${problems.length} problems:\n${problems.join('\n')}`);
    this.report = rep;
    this.reports.push(rep);
    this.log.push(...this.engine.log.splice(0), ...this.stage.log.splice(0));
    this.log.push(`turn ${r.turn}: dealt ${r.dealt.map((d) => d.template).join(', ') || 'nothing'} (${r.ms} ms)`);
    return rep;
  }

  /** deal this turn again (a tuning slider moved; a held agent changed): what's offered this turn is dealt afresh */
  deal(): DealReport {
    this.stage.refresh(this.w);
    return this.dealt(this.engine.redeal());
  }

  opp(id: string): Opportunity {
    const o = this.offered.find((x) => x.id === id);
    if (!o) throw new Error(`opportunities: ${id} isn't offered`);
    return o;
  }

  /** the player's opportunities now, and the resource ones */
  get forPlayer(): Opportunity[] {
    return this.offered.filter((o) => needsPlayer(o));
  }
  get forResources(): Opportunity[] {
    return this.offered.filter((o) => !needsPlayer(o));
  }

  /** commitments still running (crews'), with the turns they have left */
  running(): { c: Commitment; turnsLeft: number }[] {
    return this.engine
      .running()
      .filter((x) => x.resolvesTurn !== undefined)
      .map((x) => ({ c: x.commitment!, turnsLeft: Math.max(0, x.resolvesTurn! - this.turn) }));
  }

  /** commit a crew's opportunity: its agents locked (in the world model), its costs spent, its tier rolled */
  commitResources(id: string): Commitment {
    const o = this.opp(id);
    if (needsPlayer(o)) throw new Error(`opportunities: ${id} needs the player: play() it`);
    if (this.sr.phase !== 'edge') throw new Error(`opportunities: commitments are made at an area's edge (phase ${this.sr.phase})`);
    const x = this.engine.commit(id);
    // (an army sent off stops its march: it is where its commitment is)
    for (const a of this.holdings.agents) if (x.commitment!.agents.includes(a.id)) delete a.march;
    this.flush();
    return x.commitment!;
  }

  private flush(): void {
    this.log.push(...this.engine.log.splice(0), ...this.stage.log.splice(0));
  }

  /**
   * Play a player opportunity: the forced one where the hero is (its area plays now), or a way on (the leg, then its
   * area). Committing the player: the turn's one.
   */
  play(id: string): { travel: boolean } {
    const o = this.opp(id);
    if (!needsPlayer(o) || !o.challenge) throw new Error(`opportunities: ${id} isn't a player opportunity`);
    if (this.playing) throw new Error('opportunities: the player is committed already');
    if (o.template !== 'outriders' && this.sr.phase !== 'edge') throw new Error(`opportunities: a way on is taken at an area's edge (phase ${this.sr.phase})`);
    if (o.template === 'outriders' && (this.sr.phase !== 'area' || this.sr.at !== o.challenge.area)) throw new Error('opportunities: the outriders are played where they find you');
    const x = this.engine.commit(id);
    this.playing = x.commitment!;
    this.log.push(`played ${o.title}`);
    this.flush();
    if (o.template === 'outriders') return { travel: false };
    if (this.sr.offers.length) this.sr.take(null);
    let choice = o.offer;
    if ((DETOURS as readonly string[]).includes(o.template)) {
      // (a detour: its area (staged at this edge) made part of the situation, off the road, leading on to where this
      // area leads)
      const from = this.sr.area();
      const area = this.stage.detours.get(o.challenge.area);
      if (!area) throw new Error(`opportunities: the detour ${o.template} has no area ${o.challenge.area}`);
      const on = this.sit.choices.filter((c) => c.from === from.id && !c.to.startsWith('d-'));
      this.sit.areas.push(area);
      choice = `c-${area.id}`;
      this.sit.choices.push({ id: choice, from: from.id, to: area.id, text: o.title, effects: [] });
      for (const c of on) this.sit.choices.push({ ...structuredClone(c), id: `${c.id}@${area.id}`, from: area.id });
      // (its ways on, staged for the next edge)
      this.stage.stage(this.w);
      void (o.template as Detour);
    }
    this.sr.choose(choice);
    return { travel: true };
  }

  /** the leg's travel done: the next area (the town: the climax first) */
  arrive(): void {
    this.sr.arrive();
    // (the clock moved: what was waiting by the minute and wasn't taken has gone)
    this.engine.expire((x) => x.opp.expires.minute !== undefined && this.sr.clock >= x.opp.expires.minute);
    this.flush();
    if (this.sr.area().play.kind === 'town') this.climax();
  }

  /** an area's play is over: the player's card resolves from it, the turn ends, the next deal */
  areaDone(r: AreaResult): void {
    const p = this.playing;
    if (!p) throw new Error('opportunities: areaDone with no player commitment');
    const a = this.sr.area();
    this.sr.areaDone(r);
    const tier: Tier = r.heroDied ? 'disaster' : r.won ? (a.play.kind === 'flee' && (r.pursuers ?? 1) === 0 ? 'triumph' : 'success') : 'failure';
    this.engine.resolve(p.id, tier);
    this.playing = null;
    const levy = this.holdings.agents.find((x) => x.id === 'levy');
    if (levy && this.sr.reinforce) {
      // (the levy is an army agent: it marches for the town from the hold — its march is its own, in the world model —
      // and comes in only if it isn't committed elsewhere: climax)
      levy.march = { from: this.sr.map.areaAt(a), since: this.sr.clock };
      this.sr.reinforce = null;
      this.levyRecord(levy.character);
    }
    this.flush();
    if ((this.sr.phase as string) === 'ended') return;
    this.endTurn();
  }

  /** the run ended in the finale (or the hero fell) */
  finish(end: SituationEnd, seconds = 0): void {
    // (a levy that came into the town before the end of a town that held: its survivors are veterans)
    const levy = this.holdings.agents.find((a) => a.kind === 'army');
    const rf = this.sr.reinforce;
    if (end === 'saved' && levy && rf && rf.arrives <= this.sr.clock + seconds / 60) {
      if (!levy.tags.includes('veteran')) levy.tags.push('veteran');
      if (!this.holdings.bonuses.some((b) => b.holder === levy.id && b.why === VETERANS.why)) this.holdings.bonuses.push({ ...VETERANS, holder: levy.id });
      this.log.push(`${levy.name} stood at ${this.sit.target.name}: veterans`);
    }
    if (this.playing) {
      this.engine.resolve(this.playing.id, end === 'fell' ? 'disaster' : end === 'burned' ? 'failure' : 'success');
      this.playing = null;
    }
    this.sr.finish(end, seconds);
    this.settlePlaces();
    this.stage.unstage(this.w);
    this.flush();
  }

  /** where the agents are when the run ends (the world model keeps it): an army on the march came to the town (or is
   *  stationed at the hold); the rest are with the player. A commitment still under way (the hero fell) stays. */
  private settlePlaces(): void {
    const town = this.sit.target.settlement;
    const hold = holdArea(this.sr)?.settlement;
    for (const a of this.holdings.agents) {
      if (a.kind === 'player' || a.committed) continue;
      if (a.march) {
        const there = this.w.settlement(town) ? town : hold;
        if (there) a.at = { settlement: there };
        delete a.march;
      }
    }
  }

  /** the turn's end: crews due come off, what wasn't taken lapses, the next deal (the detours from the new edge staged) */
  private endTurn(): void {
    this.stage.refresh(this.w);
    this.dealt(this.engine.advance());
  }

  /** the levy's record's tags and effects (a veteran levy stays one, run to run) */
  private levyRecord(character?: string): void {
    const a = this.holdings.agents.find((x) => x.id === 'levy');
    const rec = character ? this.o.world.character(character) : undefined;
    if (!a || !rec || !rec.alive) return;
    for (const t of rec.tags ?? []) if (!a.tags.includes(t)) a.tags.push(t);
    for (const b of rec.bonuses ?? []) if (!this.holdings.bonuses.some((x) => x.holder === a.id && x.why === b.why)) this.holdings.bonuses.push({ ...b, holder: a.id } as Bonus);
    this.log.push(`${a.name} comes with its record: ${(rec.tags ?? []).join(', ') || 'no tags'}`);
  }

  /**
   * The climax: the hero is at the town. What's still running resolves now (its roll was made at commitment), what's
   * offered and not taken lapses, the supplies feed the warned town's defenders, and an army that isn't committed comes
   * in from where it is if it can be there in time.
   */
  climax(): void {
    if (this.climaxed) return;
    this.climaxed = true;
    for (const { c } of this.running()) this.engine.resolve(c.id);
    this.engine.expire(() => true);
    const T = OPP_TUNE.horde;
    this.sr.provisioned = Math.floor((this.holdings.goods.supplies ?? 0) * T.perSupply) + this.stage.rallied;
    const levy = this.holdings.agents.find((x) => x.kind === 'army' && !x.committed && available(this.holdings).includes(x));
    const hold = this.sit.areas.find((a) => a.play.kind === 'deliver');
    if (levy?.march && hold && hold.play.kind === 'deliver') {
      const town = this.sr.map.areaAt(this.sr.area());
      const arrives = levy.march.since + Math.hypot(...delta(levy.march.from, town, this.sr.map.world)) / LEVY_PACE;
      if (arrives - this.sr.clock <= T.levyMarch) {
        this.sr.reinforce = { faction: hold.play.sends.faction, role: hold.play.sends.role, count: levy.count, arrives };
        this.log.push(`climax: ${levy.name} (${levy.count}) comes in at minute ${arrives.toFixed(1)}`);
      } else this.log.push(`climax: ${levy.name} is too far to come in (minute ${arrives.toFixed(1)})`);
    }
    this.flush();
    this.log.push(`climax at minute ${this.sr.clock.toFixed(1)}: the host at ${this.sit.target.name} at ${this.sr.hordeArrives().toFixed(1)}; ${this.sr.provisioned} more defenders fed; ${this.sr.thinned} of the host cut down`);
  }

  /** the agents the run leaves with their records (for finish: the world remembers their tags) */
  named(): { id: string; character: string; name: string; kind: string; count: number; tags: string[]; bonuses: Holdings['bonuses'] }[] {
    const all = new Map<string, { id: string; character: string; name: string; kind: string; count: number; tags: string[]; bonuses: Holdings['bonuses'] }>();
    for (const a of this.holdings.agents) if (a.character) all.set(a.id, { id: a.id, character: a.character, name: a.name, kind: a.kind, count: a.count, tags: a.tags, bonuses: this.holdings.bonuses.filter((b) => b.holder === a.id) });
    return [...all.values()];
  }

  /** agents gained and since lost entirely (an army wiped out): their records die */
  lostNamed(): string[] {
    const here = new Set(this.holdings.agents.map((a) => a.character));
    const out: string[] = [];
    for (const r of this.resolutions) for (const e of r.outcome.effects) if (e.kind === 'agent' && e.agent.character && !here.has(e.agent.character)) out.push(e.agent.character);
    return out;
  }
}
