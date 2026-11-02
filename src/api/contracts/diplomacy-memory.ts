// Diplomacy's reference implementation (round 85): opinions read off the interactions by their fading.
// (round 125, `facts`; BACKLOG LW-F3) Merged into the fact layer — one source of truth: the records live in a FactStore
// (facts.ts) and this is the Diplomacy API over it. An agreement in force is a relation there (war → at_war_with,
// alliance → allied_with, trade → trades_with, rights → has_rights, tribute → pays_tribute_to, vassalage → vassal_of;
// the Agreement kept on the relation); one that ends leaves the relation's history edge (former_ally_of …) and an
// event. An interaction is a FactEvent with a weight (and a half-life; absent: never forgotten), so an opportunity's
// event with a weight moves opinions the same way. Parties are entity ids: a faction's id, a person's id, 'player'.
// Why this way round (facts holds, diplomacy reads): the template engine's predicates and the inspector need war,
// alliance, rights and the history as plain relations and events beside every other kind; diplomacy's API (opinion,
// memories, rights) is a view that dialog, the GM and units already code against, so it stays as it was.

import type { Agreement, AgreementKind, Diplomacy, Interaction, Opinion, Party } from './diplomacy';
import type { EntityId, FactEvent, FactStore, Relation, RelationType } from './facts';
import { MemoryFacts } from './facts-store.ts';
import type { RegionId } from './world';

export function partyKey(p: Party): string {
  if ('player' in p) return 'player';
  if ('faction' in p && !('who' in p)) return `f:${p.faction}`;
  return `w:${(p as { who: string }).who}`;
}

/** an agreement's kind as a relation type, and whether it holds both ways */
export const AGREEMENT_RELATION: Record<AgreementKind, { type: RelationType; symmetric: boolean }> = {
  war: { type: 'at_war_with', symmetric: true },
  truce: { type: 'truce_with', symmetric: true },
  peace: { type: 'at_peace_with', symmetric: true },
  alliance: { type: 'allied_with', symmetric: true },
  trade: { type: 'trades_with', symmetric: true },
  'land-rights': { type: 'has_rights', symmetric: false },
  'mineral-rights': { type: 'has_rights', symmetric: false },
  passage: { type: 'has_rights', symmetric: false },
  tribute: { type: 'pays_tribute_to', symmetric: false },
  vassalage: { type: 'vassal_of', symmetric: false },
};

const STANDING: Partial<Record<Agreement['kind'], number>> = { alliance: 0.4, peace: 0.1, trade: 0.15, truce: -0.1, war: -0.6, vassalage: 0.05, tribute: -0.05 };

export class MemoryDiplomacy implements Diplomacy {
  run = 0;

  readonly facts: FactStore;

  constructor(facts: FactStore = new MemoryFacts()) {
    this.facts = facts;
  }

  // ---- parties as entities (at the boundary) -------------------------------------------------------------------------

  /** a party's entity id, its entity made when the store hasn't met it (a faction, a person, the player) */
  idOf(p: Party): EntityId {
    if ('player' in p) {
      if (!this.facts.entity('player')) this.facts.add({ id: 'player', kind: 'person', name: 'the player' });
      return 'player';
    }
    if ('who' in p) {
      if (!this.facts.entity(p.who)) this.facts.add({ id: p.who, kind: 'person', name: p.who, ref: { character: p.who } });
      if (p.faction) {
        const f = this.idOf({ faction: p.faction });
        if (!this.facts.relations({ type: 'member_of', from: p.who, to: f }).length) this.facts.relate({ type: 'member_of', from: p.who, to: f });
      }
      return p.who;
    }
    if (!this.facts.entity(p.faction)) this.facts.add({ id: p.faction, kind: 'faction', name: p.faction, ref: { faction: p.faction } });
    return p.faction;
  }

  /** an id back as a party */
  partyOf(id: EntityId): Party {
    if (id === 'player') return { player: true };
    const e = this.facts.entity(id);
    if (e?.kind === 'person') return { who: id, faction: this.factionOf(id) };
    return { faction: id };
  }

  /** whose side an id is on: a person's faction, a faction itself, the player none */
  private factionOf(id: EntityId): EntityId | null {
    if (id === 'player') return null;
    const e = this.facts.entity(id);
    if (e?.kind === 'person') return this.facts.relations({ type: 'member_of', from: id })[0]?.to ?? null;
    return id;
  }

  // ---- records as the old API had them -------------------------------------------------------------------------------

  /** the interactions: the fact layer's events with a weight */
  get interactions(): Interaction[] {
    return this.facts.events().filter((e) => e.weight !== undefined).map((e) => this.toInteraction(e));
  }

  /** the agreements in force: the relations that carry one */
  get deals(): Agreement[] {
    return this.agreementRelations().map((r) => r.agreement!);
  }

  private agreementRelations(): Relation[] {
    return this.facts.relations({}).filter((r) => r.agreement);
  }

  private toInteraction(e: FactEvent): Interaction {
    return {
      id: e.id,
      run: e.run,
      ...(e.t !== undefined ? { t: e.t } : {}),
      by: this.partyOf(e.by[0]),
      to: this.partyOf(e.to[0]),
      kind: e.kind,
      weight: e.weight!,
      halfLife: e.halfLife ?? Infinity,
      ...(e.witnesses ? { witnesses: e.witnesses.map((w) => this.partyOf(w)) } : {}),
      ...(e.where?.region !== undefined ? { region: e.where.region } : {}),
      ...(e.about?.thing ? { thing: e.about.thing } : {}),
      ...(e.about?.agreement ? { agreement: e.about.agreement } : {}),
      note: e.note,
    };
  }

  // ---- the API -------------------------------------------------------------------------------------------------------

  note(i: Interaction): void {
    if (!(i.weight >= -1 && i.weight <= 1)) throw new Error(`interaction ${i.id}: weight ${i.weight} outside -1..1`);
    this.facts.record({
      id: i.id,
      run: i.run,
      ...(i.t !== undefined ? { t: i.t } : {}),
      kind: i.kind,
      by: [this.idOf(i.by)],
      to: [this.idOf(i.to)],
      ...(i.witnesses?.length ? { witnesses: i.witnesses.map((w) => this.idOf(w)) } : {}),
      ...(i.region !== undefined ? { where: { region: i.region } } : {}),
      weight: i.weight,
      // (never forgotten: no half-life — Infinity doesn't survive a JSON save)
      ...(Number.isFinite(i.halfLife) ? { halfLife: i.halfLife } : {}),
      ...(i.thing || i.agreement ? { about: { ...(i.thing ? { thing: i.thing } : {}), ...(i.agreement ? { agreement: i.agreement } : {}) } } : {}),
      note: i.note,
    });
  }

  agree(a: Agreement): void {
    if (a.parties.length < 2) throw new Error(`agreement ${a.id}: needs two parties`);
    if ((a.kind === 'land-rights' || a.kind === 'mineral-rights' || a.kind === 'passage') && !a.where) throw new Error(`agreement ${a.id}: ${a.kind} needs where`);
    if ((a.kind === 'trade' || a.kind === 'tribute') && !a.flows?.length) throw new Error(`agreement ${a.id}: ${a.kind} needs flows`);
    const had = this.agreementRelations().find((r) => r.agreement!.id === a.id);
    const ids = a.parties.map((p) => this.idOf(p));
    if (a.status !== 'active') {
      // (only an agreement in force is a relation; a proposed one is an event, an ended one leaves its history)
      if (had) this.end(a.id, a.status === 'broken' && a.broken ? { brokenBy: a.broken.by, note: `${a.kind} broken` } : a.status === 'expired' ? 'expired' : 'ended');
      else this.facts.record({ kind: `agreement-${a.status}`, by: [ids[0]], to: ids.slice(1), about: { agreement: a.id }, note: `${a.kind} ${a.status}`, run: a.since.run });
      return;
    }
    const k = AGREEMENT_RELATION[a.kind];
    if (had) this.facts.unrelate({ id: had.id, type: had.type });
    this.facts.relate({ type: k.type, from: ids[0], to: ids[1], symmetric: k.symmetric, agreement: structuredClone(a), ...(ids.length > 2 ? { also: ids.slice(2) } : {}), cause: a.id });
  }

  end(id: string, how: 'expired' | 'ended' | { brokenBy: Party; note: string }): void {
    const r = this.agreementRelations().find((x) => x.agreement!.id === id);
    if (!r) throw new Error(`no agreement ${id}`);
    const a = r.agreement!;
    // (the relation goes, its history edge stays: an alliance ended is former_ally_of)
    this.facts.unrelate({ id: r.id, type: r.type }, id);
    const parties = [r.from, r.to, ...(r.also ?? [])];
    if (typeof how === 'string') {
      this.facts.record({ kind: `agreement-${how}`, by: [parties[0]], to: parties.slice(1), about: { agreement: id }, note: `${a.kind} ${how}`, run: this.run });
      return;
    }
    const iid = `${id}:broken`;
    const by = this.idOf(how.brokenBy);
    for (const p of parties) {
      if (p === by) continue;
      this.note({ id: `${iid}:${partyKey(this.partyOf(p))}`, run: this.run, by: how.brokenBy, to: this.partyOf(p), kind: 'broke-word', weight: -0.6, halfLife: 4, agreement: id, note: how.note });
    }
  }

  agreements(of: Party): Agreement[] {
    const k = this.idOf(of);
    const f = this.factionOf(k);
    return this.agreementRelations()
      .filter((r) => [r.from, r.to, ...(r.also ?? [])].some((p) => p === k || p === f))
      .map((r) => r.agreement!);
  }

  /** how much an interaction counts for `of` thinking of `about` */
  private weightFor(i: FactEvent, of: EntityId, about: EntityId, run: number): number {
    const by = i.by[0];
    const byF = this.factionOf(by);
    if (by !== about && byF !== about) return 0;
    const to = i.to[0];
    const toF = this.factionOf(to);
    let share = 0;
    if (to === of) share = 1;
    else if (toF === of) share = 0.5; // done to one of ours
    else if (this.factionOf(of) === to) share = 0.5; // done to our people
    else if (i.witnesses?.includes(of)) share = 0.5;
    if (by !== about) share *= 0.5; // done by one of theirs
    if (!share) return 0;
    const age = Math.max(0, run - i.run);
    const fade = i.halfLife !== undefined ? Math.pow(0.5, age / Math.max(1e-6, i.halfLife)) : 1;
    return i.weight! * share * fade;
  }

  opinion(of: Party, about: Party, run = this.run): Opinion {
    const ko = this.idOf(of);
    const ka = this.idOf(about);
    const scored = this.facts
      .events()
      .filter((e) => e.weight !== undefined)
      .map((e) => ({ e, w: this.weightFor(e, ko, ka, run) }))
      .filter((s) => s.w !== 0);
    let value = scored.reduce((s, x) => s + x.w, 0);
    const fa = this.factionOf(ka);
    const both = this.agreements(of).filter((d) => d.parties.some((p) => this.idOf(p) === ka || this.idOf(p) === fa));
    for (const d of both) value += STANDING[d.kind] ?? 0;
    value = Math.max(-1, Math.min(1, value));
    const war = both.some((d) => d.kind === 'war');
    const allied = both.some((d) => d.kind === 'alliance');
    const stance: Opinion['stance'] = war ? 'war' : allied && value > 0 ? 'allied' : value < -0.5 ? 'hostile' : value < -0.15 ? 'wary' : value > 0.4 ? 'friendly' : 'neutral';
    scored.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
    return { value, stance, because: scored.slice(0, 5).map((s) => this.toInteraction(s.e)), agreements: both };
  }

  memories(who: Party, about?: Party, limit = 5): Interaction[] {
    const k = this.idOf(who);
    const f = this.factionOf(k);
    const ka = about ? this.idOf(about) : undefined;
    const mine = this.facts.events().filter((i) => {
      if (i.weight === undefined) return false;
      const t = i.to[0];
      const seen = t === k || i.witnesses?.includes(k) || t === f || i.by[0] === k;
      if (!seen) return false;
      if (!ka) return true;
      return i.by[0] === ka || this.factionOf(i.by[0]) === ka || t === ka;
    });
    const fade = (i: FactEvent) => Math.abs(i.weight!) * (i.halfLife !== undefined ? Math.pow(0.5, Math.max(0, this.run - i.run) / i.halfLife) : 1);
    return mine
      .sort((a, b) => fade(b) - fade(a))
      .slice(0, limit)
      .map((e) => this.toInteraction(e));
  }

  rights(region: RegionId, at?: [number, number]): Agreement[] {
    return this.deals.filter((d) => {
      if (d.status !== 'active' || !d.where || !d.where.regions.includes(region)) return false;
      if (!at || !d.where.area) return true;
      const [x, y] = d.where.area.at;
      return Math.hypot(at[0] - x, at[1] - y) <= d.where.area.radius;
    });
  }
}

/** (round 125) a diplomacy record made before the merge, brought into a fact store (a save's migration) */
export function importDiplomacy(facts: FactStore, old: { interactions: Interaction[]; deals: Agreement[] }, run = 0): MemoryDiplomacy {
  const d = new MemoryDiplomacy(facts);
  d.run = run;
  for (const a of old.deals) d.agree(a);
  for (const i of old.interactions) d.note(i);
  return d;
}
