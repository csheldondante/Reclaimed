// ---- opps/run.ts --------------------------------------------------------------------------------------------------
// (round 120, `opportunities`; BACKLOG RN2-3) Slice A's strategic map: runsit's horde run driven as opportunities.
// The situation's own state machine (runsit/state.ts SituationRun) keeps the clock, the host on its route, the
// pursuers, the town's fate and the finale's setup — the "town's fate and the run's endings work as today" — and this
// keeps what the opportunity loop adds: the holdings (the player, the levy as an army agent, supplies), the deal each
// turn (dealer.ts over horde.ts's proposals), commitments and their resolution, expiry and its penalties, the
// conflict's operations (delay, hasten, thin) applied to the situation, and at the climax everything still out settled.
// Pure (no DOM, no GPU): the Node playthrough (test/unit/opps.test.ts) and the level (level-opps.ts) drive the same code.
//
// A turn: an area's play ends (its player commitment resolves from how it came out) → the turn ends (resource
// commitments due resolve, what was offered and not taken expires with its penalty) → the next deal → at the edge the
// player commits resource opportunities (only what's available: the user's "they must be available to your
// character") and plays one player opportunity (a way on: the leg, then its area) → …; arriving at the town is the
// climax: what's still running resolves, what's still offered expires, the levy comes in if it can.

import { available, commit, type Bonus, emptyHoldings, needsPlayer, resolve, type Commitment, type Holdings, type Opportunity, type Resolution, type Tier } from '../api/contracts/opportunity';
import type { Situation, SituationEnd } from '../api/contracts/situation';
import type { CharacterRecord } from '../api/contracts/run';
import { hashStr, rng } from '../runplan/rng';
import { SituationRun, LEVY_PACE, LEG_MIN, TRAVEL_PACE, along, delta, type AreaResult, type SituationMap, type V2 } from '../runsit/state';
import { deal, type DealReport } from './dealer';
import { VETERANS, armThreats, detourArea, distOn, DETOURS, holdArea, hordeProposals, type Detour, type HordeView } from './horde';
import { OPP_TUNE } from './tune';

export interface OppRunOptions {
  seed: number;
  /** the hero's id (the player agent's character) */
  hero: string;
  /** the characters the world remembers (their tags and bonuses come with them: a veteran levy stays one) */
  character?: (id: string) => CharacterRecord | undefined;
  /** the validator run on every deal (gm/oppcheck.ts): a problem is an error, never patched */
  check?: (r: DealReport, h: Holdings) => string[];
}

/** what a levy that has stood in a fight comes back with (the ford's tag effect gives the same) */
export { VETERANS };

/** where an army is when it isn't committed: since when, from where (it marches for the town from there) */
interface March {
  at: V2;
  since: number;
}

export class OppRun {
  readonly sr: SituationRun;
  holdings: Holdings;
  turn = 0;
  /** what's offered now (the last deal's, less what was committed) */
  offered: Opportunity[] = [];
  readonly commitments: Commitment[] = [];
  readonly resolutions: Resolution[] = [];
  readonly expired: { opp: Opportunity; text: string }[] = [];
  /** the last deal's report (the debug overlay) */
  report: DealReport | null = null;
  readonly reports: DealReport[] = [];
  readonly log: string[] = [];
  /** the player's commitment while its leg and area play */
  playing: Commitment | null = null;
  harvest: HordeView['harvest'] = 'open';
  readonly taken = new Set<string>();
  private recent: { template: string; place: string; turn: number }[] = [];
  private march = new Map<string, March>();
  private n = 0;
  climaxed = false;
  /** (round 124) when each template at a place was first offered (its expiry counts from there) */
  private seen = new Map<string, { turn: number; minute: number }>();
  /** what the lookout has taught (the ford's odds), and the freed who stand with the town */
  intel = 0;
  rallied = 0;
  /** (RN2-7) the host's arrival as the GM wrote it, and as slice A sets it */
  readonly clockWas: number;

  constructor(sit: Situation, map: SituationMap, readonly o: OppRunOptions) {
    this.sr = new SituationRun(sit, map);
    armThreats(this.sr, OPP_TUNE.horde);
    this.clockWas = sit.threat.arrives;
    this.retime();
    this.holdings = emptyHoldings();
    const me = o.character?.(o.hero);
    this.holdings.agents.push({ id: 'player', kind: 'player', name: me?.name ?? o.hero, character: o.hero, count: 1, tags: [...(me?.tags ?? [])], statuses: [], at: { with: 'player' } });
    for (const b of me?.bonuses ?? []) this.holdings.bonuses.push({ ...b, holder: 'player' } as Bonus);
    this.deal();
  }

  get sit(): Situation {
    return this.sr.sit;
  }

  /**
   * (round 124, RN2-7) The slack after the hold: the GM's clock was set for runsit's run (the straight road in time, the
   * hold's way late — on seed 1 the levy is won at minute 9.0 with the host at the town at 9.1, so its opportunities
   * could never matter). The host's arrival is moved out until the levy, marching from the hold when it is won, can
   * meet the host's road `holdSlack` minutes before the host gets there. The straight road is then early (the finale
   * still brings the host in within HORDE_CAP_S); the hold's way has a turn or two to spend. `holdSlack` at its minimum
   * keeps the GM's clock.
   */
  private retime(): void {
    const T = OPP_TUNE.horde;
    const sit = this.sr.sit;
    const hold = holdArea(this.sr);
    if (!hold || T.holdSlack <= -2) return;
    const m = this.sr.map;
    const path = this.sr.sit.choices.find((c) => c.from === sit.areas[0].id && c.to === hold.id);
    if (!path) return;
    const start = sit.areas[0];
    const held = start.minutes + LEG_MIN + Math.hypot(...delta(m.areaAt(start), m.areaAt(hold), m.world)) / TRAVEL_PACE + hold.minutes;
    const pts = sit.threat.route.map((r) => m.regionCentre(r));
    let need = 0;
    let best = Infinity;
    for (let t = 0.3; t <= 0.981; t += 0.02) {
      const march = Math.hypot(...delta(m.areaAt(hold), along(pts, t, m.world), m.world)) / LEVY_PACE;
      best = Math.min(best, (held + march + T.holdSlack) / t);
    }
    need = best;
    if (need > sit.threat.arrives) {
      this.log.push(`slack after the hold (RN2-7): the host at ${sit.target.name} at minute ${need.toFixed(1)} (the GM's ${sit.threat.arrives}); the hold won by about ${held.toFixed(1)}`);
      sit.threat.arrives = +need.toFixed(1);
    }
  }

  /** (round 124) when a template at a place was first offered; now, if it hasn't been */
  firstSeen(key: string): { turn: number; minute: number } {
    return this.seen.get(key) ?? { turn: this.turn, minute: this.sr.clock };
  }

  /** the key an opportunity's expiry counts from */
  private seenKey(o: Opportunity): string | null {
    if (o.template === 'harvest') return `harvest@${holdArea(this.sr)?.id}`;
    if ((DETOURS as readonly string[]).includes(o.template)) return `${o.template}@${this.sr.at}`;
    return null;
  }

  /** where the player is (world units): the area, or the leg's start while it's travelled */
  at(): V2 {
    return this.sr.map.areaAt(this.sr.area());
  }

  private view(): HordeView {
    const army = available(this.holdings).find((a) => a.kind === 'army');
    return { sr: this.sr, turn: this.turn, at: this.at(), tune: OPP_TUNE.horde, harvest: this.harvest, taken: this.taken, armyAt: army ? this.armyNow(army.id) : undefined, firstSeen: (k) => this.firstSeen(k), intel: this.intel };
  }

  /** where a free army is now: marching for the town from where it was freed (with the player, if it never was) */
  armyNow(id: string): V2 {
    const m = this.march.get(id);
    if (!m) return this.at();
    const town = this.sr.map.areaAt(this.sr.finaleArea);
    const [dx, dy] = delta(m.at, town, this.sr.map.world);
    const l = Math.hypot(dx, dy);
    const k = l > 0 ? Math.min(1, ((this.sr.clock - m.since) * LEVY_PACE) / l) : 0;
    return [m.at[0] + dx * k, m.at[1] + dy * k];
  }

  /** deal this turn's opportunities (the start, and after each turn ends) */
  deal(): DealReport {
    const v = this.view();
    const r = deal(hordeProposals(v), { holdings: this.holdings, turn: this.turn, at: v.at, dist: distOn(this.sr), conflictHooks: ['horde', 'town'], recent: this.recent, tune: OPP_TUNE.dealer });
    const problems = this.o.check?.(r, this.holdings) ?? [];
    if (problems.length) throw new Error(`opportunities: the deal of turn ${this.turn} has ${problems.length} problems:\n${problems.join('\n')}`);
    this.report = r;
    this.reports.push(r);
    this.offered = r.dealt.map((d) => d.opp);
    for (const d of r.dealt) {
      const k = this.seenKey(d.opp);
      if (k && !this.seen.has(k)) this.seen.set(k, { turn: this.turn, minute: this.sr.clock });
    }
    for (const d of r.dealt) this.recent.push({ template: d.opp.template, place: d.opp.location.name, turn: this.turn });
    this.log.push(`turn ${this.turn}: dealt ${r.dealt.map((d) => d.opp.template).join(', ') || 'nothing'} (${r.ms} ms)`);
    return r;
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

  /** commitments still running (resource ones), with the turns they have left */
  running(): { c: Commitment; turnsLeft: number }[] {
    return this.commitments.filter((c) => c.resolvesTurn !== undefined && !this.resolutions.some((r) => r.commitment === c.id)).map((c) => ({ c, turnsLeft: Math.max(0, c.resolvesTurn! - this.turn) }));
  }

  /** commit a resource opportunity: its agents locked, its costs spent, its tier rolled */
  commitResources(id: string): Commitment {
    const o = this.opp(id);
    if (needsPlayer(o)) throw new Error(`opportunities: ${id} needs the player: play() it`);
    if (this.sr.phase !== 'edge') throw new Error(`opportunities: commitments are made at an area's edge (phase ${this.sr.phase})`);
    const cid = `k${++this.n}`;
    const u = rng(hashStr(`${this.o.seed}:${this.sit.id}:${o.id}`))();
    const { holdings, commitment } = commit(this.holdings, o, { id: cid, now: this.sr.clock, turn: this.turn, u });
    this.holdings = holdings;
    this.commitments.push(commitment);
    this.offered = this.offered.filter((x) => x.id !== id);
    this.taken.add(o.template);
    for (const a of commitment.agents) this.march.delete(a);
    this.log.push(`committed ${o.title} (tier ${o.tier}): ${commitment.agents.join(', ')}; resolves turn ${commitment.resolvesTurn}`);
    // (an 'instant' bonus: resolved now)
    if (commitment.resolvesTurn !== undefined && commitment.resolvesTurn <= this.turn) this.settle(commitment);
    return commitment;
  }

  /**
   * Play a player opportunity: the forced one where the hero is (its area plays now), or a way on (the leg, then its
   * area). Committing the player: the turn's one.
   */
  play(id: string): { travel: boolean } {
    const o = this.opp(id);
    if (!needsPlayer(o) || !o.challenge) throw new Error(`opportunities: ${id} isn't a player opportunity`);
    if (this.playing) throw new Error('opportunities: the player is committed already');
    const cid = `k${++this.n}`;
    const { holdings, commitment } = commit(this.holdings, o, { id: cid, now: this.sr.clock, turn: this.turn });
    this.holdings = holdings;
    this.commitments.push(commitment);
    this.playing = commitment;
    this.offered = this.offered.filter((x) => x.id !== id);
    this.log.push(`played ${o.title}`);
    if (o.template === 'outriders') {
      if (this.sr.phase !== 'area' || this.sr.at !== o.challenge.area) throw new Error('opportunities: the outriders are played where they find you');
      return { travel: false };
    }
    if (this.sr.phase !== 'edge') throw new Error(`opportunities: a way on is taken at an area's edge (phase ${this.sr.phase})`);
    if (this.sr.offers.length) this.sr.take(null);
    let choice = o.offer;
    if ((DETOURS as readonly string[]).includes(o.template)) {
      // (a detour: its area made now, off the road, leading on to where this area leads)
      const from = this.sr.area();
      const area = detourArea(this.view(), o.template as Detour);
      if (area.id !== o.challenge.area) throw new Error(`opportunities: the detour ${o.template} moved (${area.id} is not ${o.challenge.area})`);
      const on = this.sr.sit.choices.filter((c) => c.from === from.id && !c.to.startsWith('d-'));
      this.sr.sit.areas.push(area);
      choice = `c-${area.id}`;
      this.sr.sit.choices.push({ id: choice, from: from.id, to: area.id, text: o.title, effects: [] });
      for (const c of on) this.sr.sit.choices.push({ ...structuredClone(c), id: `${c.id}@${area.id}`, from: area.id });
      this.taken.add(o.template);
    }
    this.sr.choose(choice);
    return { travel: true };
  }

  /** the leg's travel done: the next area (the town: the climax first) */
  arrive(): void {
    this.sr.arrive();
    // (the clock moved: what was waiting by the minute and wasn't taken has gone)
    this.expire((o) => o.expires.minute !== undefined && this.sr.clock >= o.expires.minute);
    if (this.sr.area().play.kind === 'town') this.climax();
  }

  /** an area's play is over: the player's commitment resolves from it, the turn ends, the next deal */
  areaDone(r: AreaResult): void {
    const p = this.playing;
    if (!p) throw new Error('opportunities: areaDone with no player commitment');
    const a = this.sr.area();
    this.sr.areaDone(r);
    const tier: Tier = r.heroDied ? 'disaster' : r.won ? (a.play.kind === 'flee' && (r.pursuers ?? 1) === 0 ? 'triumph' : 'success') : 'failure';
    this.settle(p, tier);
    this.playing = null;
    if (this.holdings.agents.some((x) => x.id === 'levy') && this.sr.reinforce) {
      // (the levy is an army agent now: it marches for the town only if it isn't committed elsewhere — run.ts climax)
      this.march.set('levy', { at: this.sr.map.areaAt(a), since: this.sr.clock });
      this.sr.reinforce = null;
      this.levyRecord();
    }
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
      this.settle(this.playing, end === 'fell' ? 'disaster' : end === 'burned' ? 'failure' : 'success');
      this.playing = null;
    }
    this.sr.finish(end, seconds);
  }

  /** the turn's end: commitments due resolve, what wasn't taken expires, the next deal */
  private endTurn(): void {
    this.turn++;
    for (const { c } of this.running()) if (c.resolvesTurn! <= this.turn) this.settle(c);
    this.expire((o) => o.expires.turn < this.turn || (o.expires.minute !== undefined && this.sr.clock >= o.expires.minute));
    this.deal();
  }

  private expire(due: (o: Opportunity) => boolean): void {
    for (const o of this.offered.filter(due)) {
      if (o.onExpire && o.affordable) {
        for (const e of o.onExpire.effects) if (e.kind === 'conflict') this.conflict(e.op, e.amount);
        this.expired.push({ opp: o, text: o.onExpire.text });
        this.log.push(`expired ${o.title}: ${o.onExpire.text}`);
      }
      if (o.template === 'harvest' && o.affordable) this.harvest = 'rotted';
      if (o.onExpire && (DETOURS as readonly string[]).includes(o.template)) this.taken.add(o.template);
    }
    this.offered = this.offered.filter((o) => !due(o));
  }

  /** resolve a commitment: the contract's rules, then the conflict's operations; an army back marches from there */
  private settle(c: Commitment, tier?: Tier): Resolution {
    const { holdings, resolution } = resolve(this.holdings, c, { now: this.sr.clock, turn: this.turn, tier });
    this.holdings = holdings;
    this.resolutions.push(resolution);
    for (const e of resolution.out) if (e.kind === 'conflict') this.conflict(e.op, e.amount);
    if (c.opp.template === 'harvest') this.harvest = 'taken';
    for (const ret of resolution.returns) {
      const a = this.holdings.agents.find((x) => x.id === ret.agent);
      if (a?.kind === 'army') this.march.set(a.id, { at: c.opp.location.at, since: this.sr.clock });
    }
    this.log.push(`resolved ${c.opp.title}: ${resolution.tier}${resolution.rolled !== resolution.tier ? ` (rolled ${resolution.rolled})` : ''} — ${resolution.outcome.text}${resolution.lost.length ? `; lost ${resolution.lost.map((l) => `${l.count} of ${l.agent}`).join(', ')}` : ''}`);
    return resolution;
  }

  /** the conflict's operations on the situation */
  private conflict(op: string, amount: number): void {
    if (op === 'delay') this.sr.delay += amount;
    else if (op === 'hasten') this.sr.delay -= amount;
    else if (op === 'thin') this.sr.thinned += amount;
    else if (op === 'swell') this.sr.thinned -= amount;
    else if (op === 'rally') this.rallied += amount;
    else if (op === 'intel') this.intel += amount;
    else throw new Error(`opportunities: no conflict operation ${op}`);
    this.log.push(`the host: ${op} ${amount}`);
  }

  /** the levy's record's tags and bonuses (a veteran levy stays one, run to run) */
  private levyRecord(): void {
    const a = this.holdings.agents.find((x) => x.id === 'levy');
    const rec = a?.character ? this.o.character?.(a.character) : undefined;
    if (!a || !rec || !rec.alive) return;
    for (const t of rec.tags ?? []) if (!a.tags.includes(t)) a.tags.push(t);
    for (const b of rec.bonuses ?? []) this.holdings.bonuses.push({ ...b, holder: a.id } as Bonus);
    this.log.push(`${a.name} comes with its record: ${(rec.tags ?? []).join(', ') || 'no tags'}`);
    // (a tag opens opportunities: deal again if we're at an edge — areaDone deals after this anyway)
  }

  /**
   * The climax: the hero is at the town. What's still running resolves now (its roll was made at commitment), what's
   * offered and not taken expires, the supplies feed the warned town's defenders, and an army that isn't committed
   * comes in from where it is if it can be there in time.
   */
  climax(): void {
    if (this.climaxed) return;
    this.climaxed = true;
    for (const { c } of this.running()) this.settle(c);
    this.expire(() => true);
    const T = OPP_TUNE.horde;
    this.sr.provisioned = Math.floor((this.holdings.goods.supplies ?? 0) * T.perSupply) + this.rallied;
    const levy = this.holdings.agents.find((x) => x.kind === 'army' && !x.committed && available(this.holdings).includes(x));
    const m = levy ? this.march.get(levy.id) : undefined;
    const hold = this.sit.areas.find((a) => a.play.kind === 'deliver');
    if (levy && m && hold && hold.play.kind === 'deliver') {
      const town = this.sr.map.areaAt(this.sr.area());
      const arrives = m.since + Math.hypot(...delta(m.at, town, this.sr.map.world)) / LEVY_PACE;
      if (arrives - this.sr.clock <= T.levyMarch) {
        this.sr.reinforce = { faction: hold.play.sends.faction, role: hold.play.sends.role, count: levy.count, arrives };
        this.log.push(`climax: ${levy.name} (${levy.count}) comes in at minute ${arrives.toFixed(1)}`);
      } else this.log.push(`climax: ${levy.name} is too far to come in (minute ${arrives.toFixed(1)})`);
    }
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
