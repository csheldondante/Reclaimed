// Diplomacy's reference implementation (round 85): in memory, interactions and agreements kept in order,
// opinions read off them by their fading. Enough for dialog, the GM and units to code against.

import type { Agreement, Diplomacy, Interaction, Opinion, Party } from './diplomacy';
import type { RegionId } from './world';

export function partyKey(p: Party): string {
  if ('player' in p) return 'player';
  if ('faction' in p && !('who' in p)) return `f:${p.faction}`;
  return `w:${(p as { who: string }).who}`;
}

/** a person's faction (they take a share of what's done to their faction, and it of what's done to them) */
function factionOf(p: Party): string | null {
  if ('player' in p) return null;
  if ('who' in p) return p.faction ? `f:${p.faction}` : null;
  return `f:${p.faction}`;
}

/** how much an interaction counts for `of` thinking of `about` */
function weightFor(i: Interaction, of: Party, about: Party, run: number): number {
  const ko = partyKey(of);
  const ka = partyKey(about);
  const by = partyKey(i.by);
  const byF = factionOf(i.by);
  if (by !== ka && byF !== ka) return 0;
  const to = partyKey(i.to);
  const toF = factionOf(i.to);
  let share = 0;
  if (to === ko) share = 1;
  else if (toF === ko) share = 0.5; // done to one of ours
  else if (factionOf(of) === to) share = 0.5; // done to our people
  else if (i.witnesses?.some((w) => partyKey(w) === ko)) share = 0.5;
  if (by !== ka) share *= 0.5; // done by one of theirs
  if (!share) return 0;
  const age = Math.max(0, run - i.run);
  const fade = Number.isFinite(i.halfLife) ? Math.pow(0.5, age / Math.max(1e-6, i.halfLife)) : 1;
  return i.weight * share * fade;
}

const STANDING: Partial<Record<Agreement['kind'], number>> = { alliance: 0.4, peace: 0.1, trade: 0.15, truce: -0.1, war: -0.6, vassalage: 0.05, tribute: -0.05 };

export class MemoryDiplomacy implements Diplomacy {
  readonly interactions: Interaction[] = [];
  readonly deals: Agreement[] = [];
  run = 0;

  note(i: Interaction): void {
    if (!(i.weight >= -1 && i.weight <= 1)) throw new Error(`interaction ${i.id}: weight ${i.weight} outside -1..1`);
    this.interactions.push(i);
  }

  agree(a: Agreement): void {
    if (a.parties.length < 2) throw new Error(`agreement ${a.id}: needs two parties`);
    if ((a.kind === 'land-rights' || a.kind === 'mineral-rights' || a.kind === 'passage') && !a.where) throw new Error(`agreement ${a.id}: ${a.kind} needs where`);
    if ((a.kind === 'trade' || a.kind === 'tribute') && !a.flows?.length) throw new Error(`agreement ${a.id}: ${a.kind} needs flows`);
    const k = this.deals.findIndex((d) => d.id === a.id);
    if (k >= 0) this.deals[k] = a;
    else this.deals.push(a);
  }

  end(id: string, how: 'expired' | 'ended' | { brokenBy: Party; note: string }): void {
    const a = this.deals.find((d) => d.id === id);
    if (!a) throw new Error(`no agreement ${id}`);
    if (typeof how === 'string') {
      a.status = how;
      return;
    }
    const iid = `${id}:broken`;
    a.status = 'broken';
    a.broken = { by: how.brokenBy, interaction: iid };
    const by = partyKey(how.brokenBy);
    for (const p of a.parties) {
      if (partyKey(p) === by) continue;
      this.note({ id: `${iid}:${partyKey(p)}`, run: this.run, by: how.brokenBy, to: p, kind: 'broke-word', weight: -0.6, halfLife: 4, agreement: id, note: how.note });
    }
  }

  agreements(of: Party): Agreement[] {
    const k = partyKey(of);
    const f = factionOf(of);
    return this.deals.filter((d) => d.status === 'active' && d.parties.some((p) => partyKey(p) === k || partyKey(p) === f));
  }

  opinion(of: Party, about: Party, run = this.run): Opinion {
    const scored = this.interactions.map((i) => ({ i, w: weightFor(i, of, about, run) })).filter((s) => s.w !== 0);
    let value = scored.reduce((s, x) => s + x.w, 0);
    const ka = partyKey(about);
    const both = this.agreements(of).filter((d) => d.parties.some((p) => partyKey(p) === ka || partyKey(p) === factionOf(about)));
    for (const d of both) value += STANDING[d.kind] ?? 0;
    value = Math.max(-1, Math.min(1, value));
    const war = both.some((d) => d.kind === 'war');
    const allied = both.some((d) => d.kind === 'alliance');
    const stance: Opinion['stance'] = war ? 'war' : allied && value > 0 ? 'allied' : value < -0.5 ? 'hostile' : value < -0.15 ? 'wary' : value > 0.4 ? 'friendly' : 'neutral';
    scored.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
    return { value, stance, because: scored.slice(0, 5).map((s) => s.i), agreements: both };
  }

  memories(who: Party, about?: Party, limit = 5): Interaction[] {
    const k = partyKey(who);
    const f = factionOf(who);
    const mine = this.interactions.filter((i) => {
      const t = partyKey(i.to);
      const seen = t === k || i.witnesses?.some((w) => partyKey(w) === k) || t === f || partyKey(i.by) === k;
      if (!seen) return false;
      if (!about) return true;
      const ka = partyKey(about);
      return partyKey(i.by) === ka || factionOf(i.by) === ka || partyKey(i.to) === ka;
    });
    const fade = (i: Interaction) => Math.abs(i.weight) * (Number.isFinite(i.halfLife) ? Math.pow(0.5, Math.max(0, this.run - i.run) / i.halfLife) : 1);
    return mine.sort((a, b) => fade(b) - fade(a)).slice(0, limit);
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
