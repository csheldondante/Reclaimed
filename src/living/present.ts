// ---- living/present.ts --------------------------------------------------------------------------------------------
// (dialog2) An offer as its petition: what the dialog system needs to play it (dialog/petition.ts), from the living
// engine's offer, the opportunity contract and the holdings. This is where a card's mechanics become the summary
// panel's plain words (Needs, Takes, You get, If you refuse; docs/WRITING.md) and where the relationship signals are
// said ("Shesha will owe you a favour. The gnolls of the Warrens will trust you more.").
//
// It also meets people: the first time a petition is shown, the player meets its presenter (a `met` event in the
// fact layer), so the next talk greets them as someone known.

import { meet, needsPlayer, type Holdings, type Opportunity } from '../api/contracts/opportunity';
import type { EntityId } from '../api/contracts/facts';
import type { Petition, PetitionSpeaker } from '../dialog/petition';
import { capitalise } from './plain';
import { personaOf } from './cast';
import type { LivingEngine, Offer } from './engine';
import type { FactWorld } from './world';

const SINGULAR: Record<string, string> = { supplies: 'supply', soldiers: 'soldier', coins: 'coin' };
/** "3 supplies", "1 supply" */
export function things(n: number, what: string): string {
  return `${n} ${n === 1 ? (SINGULAR[what] ?? what) : what}`;
}
/** goods asked for on top: "2 more supplies" */
export function moreWords(g: Record<string, number>): string {
  return Object.entries(g).filter(([, n]) => n).map(([k, n]) => `${n} more ${n === 1 ? (SINGULAR[k] ?? k) : k}`).join(' and ');
}
/** goods as the player reads them: "+2 supplies, +1 renown" */
export function goodsWords(g: Record<string, number>): string {
  return Object.entries(g).filter(([, n]) => n).map(([k, n]) => `+${things(n, k)}`).join(', ');
}
/** minutes as the player reads them */
export function minutesWords(m: number): string {
  if (m < 1) return `${Math.max(10, Math.round((m * 60) / 10) * 10)} seconds`;
  const r = Math.round(m * 2) / 2;
  return `${r} minute${r === 1 ? '' : 's'}`;
}

/** has the player talked with them (a `talked` event: a petition opened; a presenter made for a card is `met` when
 *  it's shown, but not yet talked to) */
export function hasMet(w: FactWorld, person: EntityId): boolean {
  return w.facts.events({ kind: 'talked' }).some((e) => e.to.includes(person));
}

/** the player talks with them for the first time: the `talked` event (and `met`, if no card's setup met them) */
export function meetPerson(w: FactWorld, person: EntityId, cause: string): void {
  if (hasMet(w, person)) return;
  const rec = w.ws.character(person);
  const who = `${w.name(person)}${rec ? `, ${rec.role}` : ''}`;
  if (!w.facts.events({ kind: 'met' }).some((e) => e.to.includes(person))) w.facts.record({ kind: 'met', by: ['player'], to: [person], about: { opp: cause }, note: `you met ${who}` });
  w.facts.record({ kind: 'talked', by: ['player'], to: [person], about: { opp: cause }, note: `you talked with ${who}` });
}

/** who is speaking, as the dialog shows them */
export function speakerOf(w: FactWorld, o: Offer): PetitionSpeaker {
  const id = o.presenter;
  const rec = w.ws.character(id);
  return {
    id,
    name: w.name(id),
    role: rec?.role ?? 'friend',
    // (a group's name reads mid-sentence: "speaks for the Baummask Moot")
    group: w.name(o.group).replace(/^The /, 'the '),
    persona: personaOf(w, id),
    met: hasMet(w, id),
    feeling: rec?.relationships.player ?? 0,
  };
}

/** who an opportunity needs, in words: "You." or "1 army: Huggek's soldiers." */
function needsWords(o: Opportunity, h: Holdings): string {
  const m = meet(o.requires, h);
  const who = m.ok
    ? m.agents.map((id) => h.agents.find((a) => a.id === id)!).map((a) => (a.kind === 'player' ? 'You' : `${a.name}, ${a.count} strong`))
    : o.requires.map((r) => (r.kind === 'player' ? 'You' : `${r.count} ${r.kind === 'army' ? (r.count === 1 ? 'army' : 'armies') : r.kind}${r.tags?.includes('veteran') ? ' of veterans' : ''}`));
  const cost = Object.entries(o.costs).filter(([, n]) => n > 0).map(([g, n]) => things(n, g));
  return `${[...who, ...cost].join('. ')}.`;
}

/** what it takes, in words: the time, the danger, the chance */
function takesWords(o: Opportunity): string {
  const parts: string[] = [];
  if ('minutes' in o.duration) parts.push(`About ${minutesWords(o.duration.minutes)}.`);
  else parts.push(`${o.duration.turns} turn${o.duration.turns === 1 ? '' : 's'}.`);
  if (o.challenge?.encounter.text) parts.push(capitalise(o.challenge.encounter.text.replace(/\.?$/, '.')));
  if (o.odds) {
    const good = (o.odds.triumph ?? 0) + (o.odds.success ?? 0);
    parts.push(`${Math.round(good * 100)}% chance it goes well.`);
  }
  return parts.join(' ');
}

/** why the player can't agree yet, in words */
function shortWords(o: Opportunity, h: Holdings): string {
  const m = meet(o.requires, h);
  const lack: string[] = [];
  if (!m.ok) for (const r of o.requires) if (r.kind !== 'player') lack.push(r.kind === 'army' ? (r.tags?.includes('veteran') ? 'veteran soldiers' : 'soldiers to send') : `${r.count} ${r.kind}`);
  for (const [g, n] of Object.entries(o.costs)) if ((h.goods[g] ?? 0) < n) lack.push(things(n, g));
  return lack.length ? `You need ${lack.join(' and ')}.` : 'You cannot do this now.';
}

/** An offer as its petition and its speaker. */
export function petitionOf(e: LivingEngine, offerId: string): { petition: Petition; speaker: PetitionSpeaker } {
  const w = e.w;
  const o = e.offers.find((x) => x.id === offerId);
  if (!o) throw new Error(`petition: no offer ${offerId}`);
  const opp = o.opp;
  const h = w.holdings;
  const sp = speakerOf(w, o);
  const grp = o.group !== o.presenter && ['faction', 'cohort', 'polity'].includes(w.facts.entity(o.group)?.kind ?? '') ? capitalise(sp.group) : '';
  const player = needsPlayer(opp);
  const m = meet(opp.requires, h);
  const crew = m.ok ? m.agents.filter((id) => id !== 'player').map((id) => h.agents.find((a) => a.id === id)!.name) : [];
  const lapse = opp.onExpire?.text ? ` ${opp.onExpire.text}` : '';
  const signalNo = `${sp.name} will hold it against you.${grp ? ` ${grp} will trust you less.` : ''}${lapse}`;
  const petition: Petition = {
    id: o.id,
    title: opp.title,
    ask: o.line,
    ...(o.gain ? { gain: o.gain } : {}),
    ...(o.refuseLine ? { refuse: o.refuseLine } : {}),
    needs: needsWords(opp, h),
    takes: takesWords(opp),
    get: o.reward,
    ifRefuse: opp.forced ? 'You cannot. They have already seen you.' : o.passable ? 'Nothing changes. You can go another way.' : signalNo,
    agree: opp.forced ? "Let's go!" : player ? (opp.challenge?.area === undefined ? "I'll do it." : "I'll go.") : `Send ${crew.length ? crew.join(' and ') : 'them'}.`,
    canAgree: opp.affordable ? true : shortWords(opp, h),
    passable: o.passable,
    forced: !!opp.forced,
    ...(o.haggle ? { haggle: moreWords(o.haggle) } : {}),
    signalYes: `${sp.name} will owe you a favour.${grp ? ` ${grp} will trust you more.` : ''}`,
    signalNo,
  };
  return { petition, speaker: sp };
}
