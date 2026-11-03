// (dialog2) The cast and the petition dialog: personas rolled from a seed (quirks distinct and stable), kept on the
// character's record across a save; a card's petition built from its template and its presenter's persona (no tree
// written by hand); the player's answers as outcomes (commit, refuse, ask for more, not now) and as relationship facts
// with the presenter and the group behind them; greetings that remember the player.

import { describe, expect, it } from 'vitest';
import { MemoryWorldState } from '../../src/api/contracts/world-state';
import { actOf, greeting, petitionTree, traitPersuasion } from '../../src/dialog/petition';
import { briarEngine } from '../../src/living/briar';
import { personaOf, QUIRKS, rollPersona, VOICES } from '../../src/living/cast';
import { LivingEngine } from '../../src/living/engine';
import { TEMPLATES } from '../../src/living/library';
import { makePresenter } from '../../src/living/people';
import { hasMet, meetPerson, petitionOf } from '../../src/living/present';
import { FactWorld } from '../../src/living/world';
import { capitalise } from '../../src/living/plain';
import { checkLiving } from '../../src/gm/oppcheck';
import { OppRun } from '../../src/opps/run';
import { fillSituation, situationMap } from '../../src/runsit/fill';
import { seed1, seed1Graph } from '../support/seed1';

const only = (ids: string[]) => {
  const e = briarEngine(false);
  return new LivingEngine(e.w, TEMPLATES.filter((t) => ids.includes(t.id)), undefined, 'briar-hollow');
};
const offer = (e: LivingEngine, t: string) => e.offers.find((o) => o.template === t && o.status === 'offered')!;

describe('the cast (living/cast.ts)', () => {
  it('a persona is stable from its seed: the same roll every time, 2-3 distinct quirks, 2 distinct traits, a voice, a want and a portrait', () => {
    const a = rollPersona(7, 'person:shesha', 'gnoll', 'matron');
    expect(rollPersona(7, 'person:shesha', 'gnoll', 'matron')).toEqual(a);
    expect(a.quirks.length).toBeGreaterThanOrEqual(2);
    expect(a.quirks.length).toBeLessThanOrEqual(3);
    expect(new Set(a.quirks.map((q) => q.id)).size).toBe(a.quirks.length);
    expect(new Set(a.traits).size).toBe(2);
    expect(Object.keys(VOICES)).toContain(a.voice);
    expect(a.want.length).toBeGreaterThan(5);
    expect(a.portrait).toMatchObject({ species: 'gnoll' });
    // (another seed or id: another person)
    expect(rollPersona(8, 'person:shesha', 'gnoll', 'matron')).not.toEqual(a);
  });
  it('a cast is varied, species quirks stay with their species, and a role leans its quirks', () => {
    const humans = Array.from({ length: 40 }, (_, i) => rollPersona(1, `p${i}`, 'human', 'trader'));
    expect(new Set(humans.map((p) => p.voice)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(humans.map((p) => p.quirks.map((q) => q.id).sort().join(','))).size).toBeGreaterThanOrEqual(30);
    const gnollOnly = new Set(QUIRKS.filter((q) => q.only?.includes('gnoll')).map((q) => q.id));
    expect(humans.some((p) => p.quirks.some((q) => gnollOnly.has(q.id)))).toBe(false);
    const gnolls = Array.from({ length: 40 }, (_, i) => rollPersona(1, `g${i}`, 'gnoll', 'matron'));
    expect(gnolls.some((p) => p.quirks.some((q) => gnollOnly.has(q.id)))).toBe(true);
    // (a matron counts twice more often than chance)
    const counts = gnolls.filter((p) => p.quirks.some((q) => q.id === 'counts-twice')).length;
    expect(counts).toBeGreaterThan(40 * (2.4 / QUIRKS.length));
  });
  it('a person made for a card gets a persona on their record; it survives a save; an older record gets one when first met', () => {
    const e = briarEngine(false);
    const id = makePresenter(e.w, 'cohort:briar-hollow:gnoll', 'matron', 'test');
    const p = e.w.ws.character(id)!.persona!;
    expect(p.quirks.length).toBeGreaterThanOrEqual(2);
    expect(e.w.ws.character(id)!.motivation).toBe(p.want);
    const back = new FactWorld(MemoryWorldState.restore(JSON.parse(JSON.stringify(e.w.ws.snapshot()))));
    expect(back.ws.character(id)!.persona).toEqual(p);
    // (Matron Grisk predates personas: rolled and written once)
    expect(e.w.ws.character('matron-grisk')!.persona).toBeUndefined();
    const g = personaOf(e.w, 'matron-grisk');
    expect(e.w.ws.character('matron-grisk')!.persona).toEqual(g);
    expect(personaOf(e.w, 'matron-grisk')).toEqual(g);
    expect(g.portrait.species).toBe('gnoll');
  });
});

describe('the petition (dialog/petition.ts, living/present.ts)', () => {
  it("a card's petition comes from its template and its presenter: greeting, ask, the questions, the summary panel", () => {
    const e = only(['build-burrows']);
    e.deal();
    const o = offer(e, 'build-burrows');
    const { petition, speaker } = petitionOf(e, o.id);
    expect(speaker).toMatchObject({ id: 'matron-grisk', name: 'Matron Grisk', met: false });
    const t = petitionTree(petition, speaker, 'the Rider');
    const start = t.nodes[t.start];
    // (first meeting: they say who they are; then the template's ask)
    expect(start.text).toContain('Matron Grisk');
    expect(start.text).toContain('The pups sleep three to a hollow.');
    expect(start.aside).toMatch(/Matron Grisk/);
    expect(start.facts!.map((f) => f.label)).toEqual(['Needs', 'Takes', 'You get', 'If you refuse']);
    expect(start.facts![2].text).toBe('4 gnoll diggers join you. They heal between turns. You can build burrows in the city builder.');
    expect(start.facts![3].text).toMatch(/Matron Grisk will hold it against you\. The gnolls of the Warrens will trust you less\./);
    expect(start.choices.map((c) => c.text)).toEqual(['Send The Hollow work gang.', "What's in it for me?", 'What if I say no?', 'No.', 'Not now.']);
    expect(start.choices.map((c) => c.act ?? '')).toEqual(['commit', '', '', 'refuse', 'later']);
    // (the template's own answers, in the character's words)
    expect(t.nodes.gain.text).toContain('Four of our diggers will work for you.');
    expect(t.nodes.ifno.text).toBe('Then the pups stay crowded. And we will remember who said no.');
    expect(t.nodes.thanks.facts![0].text).toBe('Matron Grisk will owe you a favour. The gnolls of the Warrens will trust you more.');
    // (no haggling on a card whose template allows none)
    expect(start.choices.some((c) => c.act === 'haggle')).toBe(false);
    expect(actOf(t, 'start', 0)).toBe('commit');
  });
  it('commit: the engine commits it, and the presenter and the group behind them owe the player', () => {
    const e = only(['build-burrows']);
    e.deal();
    const o = offer(e, 'build-burrows');
    const t = petitionTree(petitionOf(e, o.id).petition, petitionOf(e, o.id).speaker, 'you');
    expect(actOf(t, 'start', 0)).toBe('commit');
    e.commit(o.id);
    const f = e.w.facts;
    expect(f.relations({ type: 'owes_favor_to', from: 'matron-grisk', to: 'player' })[0].strength).toBeCloseTo(0.3);
    expect(f.relations({ type: 'owes_favor_to', from: 'cohort:briar-hollow:gnoll', to: 'player' })[0].strength).toBeCloseTo(0.15);
  });
  it('refuse: the presenter and their group hold it against the player, and what happens when it lapses happens now', () => {
    const e = only(['arbitrate-holding']);
    e.deal();
    const o = offer(e, 'arbitrate-holding');
    const { petition } = petitionOf(e, o.id);
    expect(petition.ifRefuse).toMatch(/will hold it against you\./);
    expect(petition.ifRefuse).toMatch(/Nobody rules on Thornfield\. House Aldren and House Morrow start a feud\.|start a feud/);
    const before = e.w.facts.events({ kind: 'feud' }).length;
    e.refuse(o.id);
    const f = e.w.facts;
    expect(f.relations({ type: 'grievance_against', from: o.presenter, to: 'player' })[0].strength).toBeCloseTo(0.3);
    expect(f.relations({ type: 'grievance_against', from: o.group, to: 'player' })[0].strength).toBeCloseTo(0.15);
    expect(f.events({ kind: 'feud' }).length).toBe(before + 1);
    expect(e.w.ws.character(o.presenter)!.relationships.player).toBeCloseTo(-0.3);
  });
  it('ask for more: where the template allows it, settled by the persuasion; a yes adds to what the player gets and costs a little goodwill', () => {
    const e = only(['open-corridor']);
    e.deal();
    const o = offer(e, 'open-corridor');
    const { petition, speaker } = petitionOf(e, o.id);
    expect(petition.haggle).toBe('5 more coin');
    const t = petitionTree(petition, speaker, 'you');
    const i = t.nodes.start.choices.findIndex((c) => c.act === 'haggle');
    expect(i).toBeGreaterThan(0);
    // (the talk ends on the ask; it's opened again where they answer)
    expect(t.nodes.start.choices[i].to).toBeUndefined();
    const yes = petitionTree(petition, speaker, 'you', { haggled: 'yes' });
    expect(yes.nodes.haggle.text).toMatch(/5 more coin\.$/);
    expect(yes.nodes.haggle.facts![2].text).toMatch(/5 more coin\.$/);
    expect(yes.nodes.haggle.choices.some((c) => c.act === 'haggle')).toBe(false);
    const coin = e.w.holdings.goods.coin;
    e.haggle(o.id, true);
    expect(() => e.haggle(o.id, true)).toThrow(/already agreed/);
    e.commit(o.id);
    // (20 coin spent on the road, 5 more given for the asking)
    expect(e.w.holdings.goods.coin).toBe(coin - 20 + 5);
    expect(e.w.facts.events({ kind: 'haggled' })).toHaveLength(1);
    expect(e.w.facts.relations({ type: 'owes_favor_to', from: o.presenter, to: 'player' })[0].strength).toBeCloseTo(0.3);
    // (the default persuasion reads traits)
    expect(traitPersuasion.settle({ speaker: 'x', traits: ['generous', 'brave'], feeling: -1, what: '' })).toEqual({ agreed: true });
    expect(traitPersuasion.settle({ speaker: 'x', traits: ['stubborn', 'kind'], feeling: 1, what: '' })).toEqual({ agreed: true });
    expect(traitPersuasion.settle({ speaker: 'x', traits: ['proud', 'funny'], feeling: 1, what: '' })).toEqual({ agreed: false });
    expect(traitPersuasion.settle({ speaker: 'x', traits: ['funny', 'curious'], feeling: -0.2, what: '' })).toEqual({ agreed: false });
  });
  it('greetings remember: who they are the first time, then how they feel; it carries into the next run', () => {
    const e = only(['build-burrows', 'abolish-serfdom']);
    e.deal();
    const g = offer(e, 'build-burrows');
    const s0 = petitionOf(e, g.id).speaker;
    const intro = greeting(s0, 'Rider', 'k');
    expect(VOICES[s0.persona.voice].intro.map((l) => capitalise(l.replace(/\{name\}/g, s0.name).replace(/\{role\}/g, s0.role).replace(/\{group\}/g, s0.group)))).toContain(intro);
    meetPerson(e.w, 'matron-grisk', g.id);
    expect(hasMet(e.w, 'matron-grisk')).toBe(true);
    e.commit(g.id);
    const fond = petitionOf(e, g.id).speaker;
    expect(fond).toMatchObject({ met: true });
    expect(fond.feeling).toBeGreaterThan(0.15);
    const fill = (l: string) => capitalise(l.replace(/\{name\}/g, fond.name).replace(/\{role\}/g, fond.role).replace(/\{group\}/g, fond.group).replace(/\{hero\}/g, 'Rider'));
    expect(VOICES[fond.persona.voice].fond.map(fill)).toContain(greeting(fond, 'Rider', 'k'));
    // (the next run: the same person, the same persona, the same feeling)
    const next = new FactWorld(MemoryWorldState.restore(JSON.parse(JSON.stringify(e.w.ws.snapshot()))));
    expect(next.ws.character('matron-grisk')!.relationships.player).toBeGreaterThan(0.15);
    expect(personaOf(next, 'matron-grisk')).toEqual(fond.persona);
    expect(hasMet(next, 'matron-grisk')).toBe(true);
  });
});

describe("the run's petitions (opps/run.ts on seed 1)", () => {
  const snap = () => seed1().wiki.snapshot;
  const graph = seed1Graph();
  const make = () => {
    const sit = fillSituation({ graph, world: snap(), seed: 1, from: seed1().wiki.spawn.region, at: seed1().wiki.spawn.at as [number, number] });
    return new OppRun(sit, situationMap(graph, snap()), { seed: 1, hero: 'hoverbike', world: MemoryWorldState.restore(structuredClone(snap())), check: (rep, e) => checkLiving(e, rep, { region: (id) => !!graph.node(id), situation: sit }) });
  };
  it("the outriders can't be refused; a way on is left, not refused; refusing the harvest lets the grain rot now", () => {
    const r = make();
    const out = r.offered[0];
    const t = petitionTree(petitionOf(r.engine, out.id).petition, petitionOf(r.engine, out.id).speaker, 'you');
    expect(t.nodes.start.choices.map((c) => c.act ?? '')).toEqual(['commit', '', '']);
    expect(() => r.refuse(out.id)).toThrow(/forced/);
    r.play(out.id);
    r.areaDone({ seconds: 150, won: true, pursuers: 1 });
    const hold = r.forPlayer.find((o) => o.offer === 'c-hold')!;
    expect(() => r.refuse(hold.id)).toThrow(/way on/);
    const ht = petitionTree(petitionOf(r.engine, hold.id).petition, petitionOf(r.engine, hold.id).speaker, 'you');
    expect(ht.nodes.start.choices.map((c) => c.act ?? '')).toEqual(['commit', '', '', 'haggle', 'later']);
    r.play(hold.id);
    r.arrive();
    r.areaDone({ seconds: 170, won: true });
    const h = r.forResources.find((o) => o.template === 'harvest')!;
    const who = r.engine.offers.find((o) => o.id === h.id)!.presenter;
    r.refuse(h.id);
    expect(r.harvest).toBe('rotted');
    expect(r.w.facts.relations({ type: 'grievance_against', from: who, to: 'player' })[0].strength).toBeCloseTo(0.3);
  });
});
