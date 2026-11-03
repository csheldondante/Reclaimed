// (dialog2) The style lint (docs/WRITING.md): every string a player reads — the living templates as written, the run's
// cards and petitions as dealt on seed 1, the Briar Hollow cards, the cast's voices and quirks, the roster, the intro,
// the status line, the GM's situation — has no code words, no parentheses, no semicolons or joining dashes, and no
// sentence over 20 words. The user (round 125): "Use simple plain language like in the worked examples and fix
// whatever in the prompt produced that monstrosity."

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Situation } from '../../src/api/contracts/situation';
import { MemoryWorldState } from '../../src/api/contracts/world-state';
import { petitionTree, type PetitionState } from '../../src/dialog/petition';
import { briarEngine } from '../../src/living/briar';
import { QUIRKS, VOICES } from '../../src/living/cast';
import type { LivingEngine, TemplateDef } from '../../src/living/engine';
import { HORDE_TEMPLATES } from '../../src/living/horde';
import { TEMPLATES } from '../../src/living/library';
import { petitionOf } from '../../src/living/present';
import { checkLiving } from '../../src/gm/oppcheck';
import { OppRun } from '../../src/opps/run';
import { introLines, mapHint, rosterLines, situationLines, statusLines } from '../../src/opps/words';
import { fillSituation, situationMap } from '../../src/runsit/fill';
import { seed1, seed1Graph } from '../support/seed1';
import { lint, lintAll } from '../support/writing';

type Line = { where: string; text: string };

/** a template's own strings, with its fill-ins as a plain word (so the lint reads the sentence, not the braces) */
function templateLines(t: TemplateDef): Line[] {
  const f = (s: string | undefined) => (s ?? '').replace(/\{[^}]+\}/g, 'Muru');
  const out: Line[] = [
    { where: `${t.id}.title`, text: f(t.title) },
    { where: `${t.id}.pitch`, text: f(t.pitch) },
    { where: `${t.id}.line`, text: f(t.presenter.line) },
    { where: `${t.id}.gain`, text: f(t.presenter.gain) },
    { where: `${t.id}.refuse`, text: f(t.presenter.refuse) },
    { where: `${t.id}.reward`, text: f(t.reward.text) },
    { where: `${t.id}.outcomeText`, text: f(t.outcomeText) },
    { where: `${t.id}.expireText`, text: f(t.expireText) },
  ];
  for (const [k, o] of Object.entries(t.outcomes ?? {})) out.push({ where: `${t.id}.outcomes.${k}`, text: f(o.text) });
  for (const a of t.reward.agents ?? []) out.push({ where: `${t.id}.reward.agent`, text: f(a.name) });
  return out;
}

/** a dealt offer as the player reads it: its card's words and its whole petition, each answer state */
function offerLines(e: LivingEngine, id: string): Line[] {
  const o = e.offers.find((x) => x.id === id)!;
  const w = `${o.template}@turn${o.dealt}`;
  const out: Line[] = [
    { where: `${w}.title`, text: o.opp.title },
    { where: `${w}.pitch`, text: o.opp.pitch },
    { where: `${w}.reward`, text: o.reward },
    { where: `${w}.where`, text: o.opp.location.name },
    ...Object.entries(o.opp.outcomes).map(([k, x]) => ({ where: `${w}.outcome.${k}`, text: x!.text })),
    ...(o.opp.onExpire ? [{ where: `${w}.onExpire`, text: o.opp.onExpire.text }] : []),
    ...(o.opp.challenge ? [{ where: `${w}.encounter`, text: o.opp.challenge.encounter.text }] : []),
  ];
  const { petition, speaker } = petitionOf(e, id);
  for (const state of [{}, { haggled: 'yes' }, { haggled: 'no' }] as PetitionState[]) {
    const tree = petitionTree(petition, { ...speaker }, 'the Rider', state);
    for (const [n, node] of Object.entries(tree.nodes)) {
      out.push({ where: `${w}.petition.${n}`, text: node.text });
      if (node.aside) out.push({ where: `${w}.petition.${n}.aside`, text: node.aside });
      for (const f of node.facts ?? []) out.push({ where: `${w}.petition.${n}.${f.label}`, text: f.text });
      for (const c of node.choices) out.push({ where: `${w}.petition.${n}.choice`, text: c.text + (c.disabled ? ` ${c.disabled}` : '') });
    }
  }
  return out;
}

const snap = () => seed1().wiki.snapshot;
const graph = seed1Graph();
const fill = () => fillSituation({ graph, world: snap(), seed: 1, from: seed1().wiki.spawn.region, at: seed1().wiki.spawn.at as [number, number] });
const gm = (): Situation => JSON.parse(readFileSync(new URL('../../data/situations/grey-muster-bumku.json', import.meta.url), 'utf8'));
const make = (sit: Situation) => new OppRun(sit, situationMap(graph, snap()), { seed: 1, hero: 'hoverbike', world: MemoryWorldState.restore(structuredClone(snap())), check: (rep, e) => checkLiving(e, rep, { region: (id) => !!graph.node(id), situation: sit }) });

/** a run played along one path, every offer of every turn read (and its status line) */
function runLines(sit: Situation, path: string[], crews: string[]): Line[] {
  const r = make(sit);
  const out: Line[] = [];
  const read = () => {
    for (const o of r.engine.offered) out.push(...offerLines(r.engine, o.id));
    const left = r.sr.hordeArrives() - r.sr.clock;
    const st = statusLines({ turn: r.turn, clock: r.sr.clock, threat: sit.threat.name, target: sit.target.name, left, held: r.holdings.agents.filter((a) => a.kind !== 'player').map((a) => ({ name: a.name, count: a.count, veteran: a.tags.includes('veteran'), busy: !!a.committed })), goods: r.holdings.goods, running: r.running().map(({ c, turnsLeft }) => ({ title: c.opp.title, turns: turnsLeft })), done: r.resolutions.map((x) => x.outcome.text), lapsed: r.expired.map((x) => x.text), warned: r.sr.warned, evacuate: !!r.sr.evacuate });
    out.push(...st.map((text) => ({ where: `status@turn${r.turn}`, text })));
    out.push(...situationLines({ title: sit.title, threat: sit.threat.name, count: sit.threat.count, role: sit.threat.role, target: sit.target.name, left, premise: sit.premise, hero: 'Rider', intelPct: 15, rallied: 3 }).map((text) => ({ where: 'situation', text })));
  };
  read();
  r.play(r.offered[0].id);
  r.areaDone({ seconds: 150, won: true, pursuers: 1 });
  for (const choice of path) {
    read();
    // (one crew a turn: the levy is one army)
    const c = crews.map((t) => r.forResources.find((o) => o.template === t && o.affordable)).find(Boolean);
    if (c) r.commitResources(c.id);
    const o = r.forPlayer.find((x) => x.offer === choice);
    if (!o) break;
    r.play(o.id);
    r.arrive();
    if (r.sr.phase === 'area' && r.sr.area().play.kind !== 'town') r.areaDone({ seconds: 150, won: true });
  }
  read();
  return out;
}

describe('the style lint (docs/WRITING.md)', () => {
  it('catches the line the user quoted, and passes the catalog\'s', () => {
    const bad = lint("You get: Huggek's levy, yours to command (it comes with its record: a veteran levy stays one), and supplies.");
    expect(bad.length).toBeGreaterThanOrEqual(3);
    expect(bad.join(' | ')).toMatch(/parenthesis/);
    expect(bad.join(' | ')).toMatch(/record/);
    expect(bad.join(' | ')).toMatch(/yours to command/);
    expect(lint('The ford ran red; the host waited 1.5 min to cross.').length).toBeGreaterThan(0);
    expect(lint("Request allied reinforcements. The ally's troops march on the map.")).toEqual([]);
    expect(lint('You get: 8 soldiers from Huggek. +3 supplies.')).toEqual([]);
  });

  it('the living templates as written: the run\'s and Briar Hollow\'s', () => {
    expect(lintAll([...HORDE_TEMPLATES, ...TEMPLATES].flatMap(templateLines))).toEqual([]);
  });

  it('the cast: every voice line and every quirk', () => {
    const fillIn = (s: string) => s.replace(/\{name\}/g, 'Shesha').replace(/\{role\}/g, 'matron').replace(/\{group\}/g, 'the gnolls of the Warrens').replace(/\{hero\}/g, 'Rider');
    const lines: Line[] = [];
    for (const [id, v] of Object.entries(VOICES)) for (const [k, xs] of Object.entries(v)) for (const x of xs as string[]) lines.push({ where: `voice.${id}.${k}`, text: fillIn(x) });
    for (const q of QUIRKS) lines.push({ where: `quirk.${q.id}`, text: fillIn(q.aside) }, { where: `quirk.${q.id}.saying`, text: q.saying ?? '' }, { where: `quirk.${q.id}.text`, text: q.text });
    expect(lintAll(lines)).toEqual([]);
  });

  it("the run's cards and petitions as dealt on seed 1: the hold's way with crews sent, and the straight road", () => {
    const lines = [...runLines(fill(), ['c-hold', 'c-levy'], ['harvest', 'watchtower', 'ford']), ...runLines(fill(), ['c-road', 'c-stand'], [])];
    expect(lines.length).toBeGreaterThan(100);
    expect(lintAll(lines)).toEqual([]);
  });

  it("the GM's situation for seed 1, as written and as played", () => {
    const s = gm();
    const lines: Line[] = [
      { where: 'title', text: s.title },
      { where: 'premise', text: s.premise },
      ...s.choices.map((c) => ({ where: `choice.${c.id}`, text: c.text })),
      ...s.areas.flatMap((a) => [{ where: `area.${a.id}`, text: a.brief }, ...(a.say ?? []).map((b) => ({ where: `area.${a.id}.say`, text: b.line }))]),
      ...(s.items ?? []).map((i) => ({ where: `item.${i.id}`, text: i.text })),
      ...Object.entries(s.endings).map(([k, e]) => ({ where: `ending.${k}`, text: e.text })),
    ];
    expect(lintAll(lines)).toEqual([]);
    const played = runLines(gm(), ['c-hold', 'c-levy'], ['harvest', 'watchtower']);
    expect(lintAll(played)).toEqual([]);
  });

  it('the situation the template fills, as written', () => {
    const s = fill();
    expect(lintAll([{ where: 'premise', text: s.premise }, ...s.choices.map((c) => ({ where: c.id, text: c.text })), ...s.areas.map((a) => ({ where: a.id, text: a.brief })), ...Object.entries(s.endings).map(([k, e]) => ({ where: k, text: e.text }))])).toEqual([]);
  });

  it("Briar Hollow's cards and petitions over four turns", () => {
    const e = briarEngine(true);
    const lines: Line[] = [];
    for (let t = 0; t < 4; t++) {
      for (const o of e.offered) lines.push(...offerLines(e, o.id));
      e.advance();
    }
    expect(lines.length).toBeGreaterThan(50);
    expect(lintAll(lines)).toEqual([]);
  });

  it('the roster, the intro and the map hint', () => {
    const src = (p: string) => readFileSync(new URL(`../../src/play/controllers/${p}.ts`, import.meta.url), 'utf8').match(/\bline: '([^']+)'/)![1];
    const lines: Line[] = [];
    for (const [id, line] of [['hoverbike', src('hoverbike')], ['lich', src('lich')]]) {
      const r = rosterLines({ icon: '🏍', name: id, who: 'the Rider', dead: false, line, top: 24, jump: { height: 3, gap: 12 }, fly: id === 'lich' ? 8 : 0, breaks: 0.4, earned: ['veteran', 'Grave Ward'], deeds: 3, modes: [{ name: 'ride and race', on: true }, { name: 'combat', on: false }] });
      lines.push({ where: `roster.${id}.head`, text: r.head }, ...r.lines.map((text) => ({ where: `roster.${id}`, text })));
    }
    for (const s of [fill(), gm()]) {
      const i = introLines({ title: s.title, threat: s.threat.name, count: s.threat.count, role: s.threat.role, faction: 'the Hollow Court', target: s.target.name, outriders: s.threat.outriders?.count ?? 0, premise: s.premise, arrives: s.threat.arrives, hero: 'Hoverbike', byGM: true });
      lines.push({ where: 'intro.title', text: i.title }, ...i.lines.map((text) => ({ where: 'intro', text })), { where: 'intro.foot', text: i.foot });
    }
    for (const n of [1, 4]) lines.push(...mapHint(n).map((text) => ({ where: 'hint', text })));
    expect(lintAll(lines)).toEqual([]);
  });
});
