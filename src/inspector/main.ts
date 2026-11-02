// ---- inspector/main.ts --------------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F9) The world inspector (cardlab.html; the old deck lab at cardlab.html?deck=1): the
// living world's fact layer and template engine on a seeded Briar Hollow, in plain DOM. Browse entities (tags by scope,
// quantities from their owners, relations in and out, claims, history), the relations, claims and history whole, the
// invariants; the dealer's cards with why each was or wasn't dealt (and what each would change, as a diff of the fact
// layer); commit cards and advance turns, each change shown as a diff. Everything runs in the page (src/living/).

import type { EntityKind, TagScope } from '../api/contracts/facts';
import { ENTITY_KINDS, TAG_SCOPES } from '../api/contracts/facts';
import { checkInvariants } from '../api/contracts/facts-rules';
import { briarEngine } from '../living/briar';
import type { LivingEngine, Offer } from '../living/engine';
import { pawnTraits } from '../living/traits';
import { checkLiving } from '../gm/oppcheck';

const app = document.getElementById('app')!;
let e: LivingEngine = briarEngine(true);
let selected = 'briar-hollow';
let kindFilter: EntityKind | '' = '';
let problems: string[] = [];

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
};
const btn = (label: string, on: () => void, cls = '', disabled = false) => {
  const b = h('button', cls ? { class: cls } : {}, label);
  b.disabled = disabled;
  b.onclick = () => {
    try {
      on();
    } catch (err) {
      problems = [(err as Error).message];
    }
    render();
  };
  return b;
};
const diffList = (lines: string[]) => h('pre', { class: 'diff' }, lines.length ? lines.join('\n') : '(no change)');
const ent = (id: string) => {
  const a = h('a', { href: '#', class: 'ent' }, e.w.name(id));
  a.onclick = (ev) => {
    ev.preventDefault();
    selected = id;
    render();
    document.getElementById('entity')?.scrollIntoView({ behavior: 'smooth' });
  };
  return a;
};

function deal(): void {
  const r = e.report ?? e.deal();
  problems = checkLiving(e, r);
}

function counters(): HTMLElement {
  const w = e.w;
  const n = (v: number | undefined, d = 0) => (v === undefined ? '—' : v.toFixed(d));
  const unrest = Number(w.facts.tag('cohort:briar-hollow:serf', 'condition', 'unrest')?.value ?? 0);
  const stage = e.arcStage();
  const items: [string, string][] = [
    ['turn', String(e.turn)],
    ['drought', stage < 0 ? 'not yet' : e.arc!.stages[stage].name],
    ['Briar Hollow grain', `${n(w.qty('briar-hollow', 'grain'))} (${n(w.qty('briar-hollow', 'grain_rate'))}/day)`],
    ['river at Briar Hollow', n(w.qty('briar-hollow', 'inflow'), 2)],
    ['Millbrook grain', `${n(w.qty('millbrook', 'grain'))} (${n(w.qty('millbrook', 'grain_rate'))}/day)`],
    ['river at Millbrook', n(w.qty('millbrook', 'inflow'), 2)],
    ['serfs’ unrest', unrest.toFixed(2)],
  ];
  return h('div', { class: 'counters' }, ...items.map(([k, v]) => h('div', {}, h('b', {}, v), h('span', {}, k))));
}

function holdings(): HTMLElement {
  const H = e.w.holdings;
  return h(
    'div',
    {},
    h('h2', {}, 'Your pawns and goods'),
    h('div', {}, ...H.agents.map((a) => h('span', { class: 'pawn', title: a.tags.join(', ') }, `${a.name}${a.count > 1 ? ` ×${a.count}` : ''} · ${a.kind} · ${pawnTraits(a).join(', ') || 'no traits'}${a.committed ? ' · busy' : ''}`))),
    h('div', { class: 'status' }, Object.entries(H.goods).map(([g, n]) => `${g} ${n}`).join(' · ')),
  );
}

function card(o: Offer): HTMLElement {
  const t = e.template(o.template);
  const ctxStores = (t.requires.stores ?? []).map((s) => `${s.amount} ${s.good}${s.upkeep ? ' (upkeep)' : ''} from ${e.w.name(s.at.startsWith('$') ? o.bind[s.at.slice(1)] : s.at)}`);
  const needs = [...o.opp.requires.map((r) => `${r.count} ${r.kind}${r.tags?.length ? ` (${r.tags.join(', ')})` : ''}`), ...ctxStores, ...Object.entries(o.opp.costs).map(([g, n]) => `${n} ${g}`)];
  const committed = o.status === 'committed';
  return h(
    'div',
    { class: `card ${o.opp.requires.some((r) => r.kind === 'player') ? 'player' : 'agents'}${o.opp.affordable ? '' : ' no'}` },
    h('div', { class: 'kind' }, `${t.themes.join(' · ').toUpperCase()} — AT ${e.w.name(o.place).toUpperCase()}`),
    h('div', { class: 't' }, o.opp.title),
    h('div', { class: 'r' }, o.opp.pitch),
    h('div', { class: 'r' }, h('span', { class: 'k' }, 'needs '), needs.join(', ')),
    h('div', { class: 'r' }, h('span', { class: 'k' }, 'takes '), committed ? `resolves turn ${o.resolvesTurn}` : `${t.turns} turn${t.turns > 1 ? 's' : ''} of ${t.work} · offered until turn ${o.expires}`),
    h('div', { class: 'r' }, h('span', { class: 'k' }, 'then '), o.opp.outcomes.success?.text ?? ''),
    o.opp.onExpire ? h('div', { class: 'r' }, h('span', { class: 'k' }, 'if let go '), o.opp.onExpire.text) : null,
    o.unlocks.length ? h('div', { class: 'r ok' }, `unlocks: ${o.unlocks.join(', ')}`) : null,
    o.crew?.length ? h('div', { class: 'r ok' }, o.crew.join('; ')) : null,
    !o.opp.affordable ? h('div', { class: 'r bad' }, o.opp.missing.join('; ')) : null,
    o.setup.length ? h('details', {}, h('summary', {}, 'the incident its setup made'), diffList(o.setup)) : null,
    h('details', {}, h('summary', {}, committed ? 'what committing changed' : 'what it would change (a dry run)'), diffList(committed ? (o.spent ?? []) : o.preview)),
    h('details', {}, h('summary', {}, 'why it was dealt'), h('pre', {}, o.because.join('\n'))),
    committed ? null : btn('Commit', () => e.commit(o.id), 'main', !o.opp.affordable),
  );
}

function board(): HTMLElement {
  const r = e.report!;
  const offered = e.offers.filter((o) => o.status === 'offered');
  const under = e.offers.filter((o) => o.status === 'committed');
  return h(
    'div',
    {},
    h('h2', {}, `The board (turn ${e.turn}): ${offered.length} offered, ${under.length} under way`),
    h('div', { class: 'status' }, `evaluated ${r.evaluated.templates} of ${r.evaluated.of} templates (${r.evaluated.changed} entities changed) · dealt in ${r.ms} ms`),
    h('div', { class: 'board' }, ...offered.map(card)),
    under.length ? h('div', {}, h('h2', {}, 'Under way'), h('div', { class: 'board' }, ...under.map(card))) : null,
    h(
      'details',
      {},
      h('summary', {}, `Why the others weren't dealt (${r.notProposed.length + (r.dealer?.rejected.length ?? 0)})`),
      h(
        'table',
        {},
        h('tr', {}, h('th', {}, 'card'), h('th', {}, 'step'), h('th', {}, 'why')),
        ...r.notProposed.map((n) => h('tr', {}, h('td', {}, n.title), h('td', {}, n.step), h('td', {}, n.why))),
        ...(r.dealer?.rejected ?? []).map((x) => h('tr', {}, h('td', {}, x.title), h('td', {}, `dealer: ${x.step}`), h('td', {}, x.why))),
      ),
      r.dealer ? h('pre', {}, r.dealer.guarantees.join('\n')) : null,
    ),
  );
}

function changes(): HTMLElement {
  const recent = [...e.changes].reverse().slice(0, 30);
  return h(
    'details',
    { open: '' },
    h('summary', {}, 'What changed (newest first, as diffs of the fact layer and the owners’ records)'),
    ...recent.map((c) => h('details', c.turn === e.turn ? { open: '' } : {}, h('summary', {}, `turn ${c.turn} — ${c.what} (${c.lines.length})`), diffList(c.lines))),
  );
}

function entityPanel(): HTMLElement {
  const w = e.w;
  const f = w.facts;
  const x = f.entity(selected);
  const kinds = h('select', {}, h('option', { value: '' }, 'every kind'), ...ENTITY_KINDS.map((k) => h('option', k === kindFilter ? { value: k, selected: '' } : { value: k }, k)));
  kinds.onchange = () => {
    kindFilter = (kinds as HTMLSelectElement).value as EntityKind | '';
    render();
  };
  const list = f.find(kindFilter ? { kind: kindFilter } : {});
  const st = x?.kind === 'settlement' ? w.settlementOf(selected) : undefined;
  const names = st ? [...Object.keys(st.stores).flatMap((g) => [g, `${g}_rate`]), 'people', 'refugee', 'inflow'] : ['power', 'population', 'inflow'];
  const qtys = names.map((q) => [q, w.qty(selected, q)] as const).filter(([, v]) => v !== undefined);
  const rels = w.relations({ from: selected }).concat(w.relations({ to: selected }).filter((r) => r.from !== selected));
  return h(
    'div',
    { id: 'entity' },
    h('h2', {}, 'Entities'),
    h('div', { class: 'bar' }, kinds, h('span', { class: 'status' }, `${list.length} entities`)),
    h('div', { class: 'ents' }, ...list.map((y) => h('span', { class: y.id === selected ? 'pawn sel' : 'pawn' }, ent(y.id), ` ${y.kind}`))),
    x
      ? h(
          'div',
          { class: 'card' },
          h('div', { class: 'kind' }, `${x.kind.toUpperCase()} · ${x.id}${x.ref ? ` · its record: ${JSON.stringify(x.ref)}` : ''}`),
          h('div', { class: 't' }, w.name(x.id)),
          h('table', {}, ...TAG_SCOPES.filter((s: TagScope) => x.tags.some((t) => t.scope === s)).map((s) => h('tr', {}, h('th', {}, s), h('td', {}, x.tags.filter((t) => t.scope === s).map((t) => `${t.key} = ${typeof t.value === 'number' ? t.value.toFixed(2) : t.value}`).join(', '))))),
          qtys.length ? h('div', { class: 'r' }, h('span', { class: 'k' }, 'from its owners: '), qtys.map(([q, v]) => `${q} ${+(v as number).toFixed(2)}`).join(' · ')) : null,
          h('div', { class: 'r' }, h('span', { class: 'k' }, 'relations: ')),
          h('ul', {}, ...rels.map((r) => h('li', {}, ent(r.from), ` ${r.type}${r.symmetric ? ' ⇄' : ' →'} `, ent(r.to), r.strength !== undefined ? ` (${r.strength})` : '', r.derived ? ' — derived from its record' : '', r.agreement ? ` — agreement ${r.agreement.kind}` : ''))),
          h('div', { class: 'r' }, h('span', { class: 'k' }, 'claims: '), f.claims().filter((c) => c.claimant === selected || c.target === selected).map((c) => `${w.name(c.claimant)} → ${w.name(c.target)}${c.what ? ` (${c.what})` : ''}: ${c.basis}, ${c.strength}${c.recognisedBy.length ? `, recognised by ${c.recognisedBy.map((r) => w.name(r)).join(', ')}` : ''}`).join('; ') || 'none'),
          h('details', {}, h('summary', {}, 'its history'), h('pre', {}, f.events({ involving: selected }).map((v) => `turn ${v.turn}: ${v.kind} — ${v.note}`).reverse().join('\n') || '(nothing yet)')),
        )
      : null,
  );
}

function tables(): HTMLElement {
  const w = e.w;
  const f = w.facts;
  const inv = checkInvariants(f);
  return h(
    'div',
    {},
    h('details', {}, h('summary', {}, `Relations (${f.relations({}).length} stored, plus derived)`), h('table', {}, h('tr', {}, h('th', {}, 'from'), h('th', {}, 'type'), h('th', {}, 'to'), h('th', {}, 'since')), ...w.relations({}).map((r) => h('tr', {}, h('td', {}, ent(r.from)), h('td', {}, `${r.type}${r.symmetric ? ' ⇄' : ''}${r.strength !== undefined ? ` ${r.strength}` : ''}${r.derived ? ' (derived)' : ''}`), h('td', {}, ent(r.to)), h('td', {}, String(r.since)))))),
    h('details', {}, h('summary', {}, `Claims (${f.claims().length})`), h('table', {}, ...f.claims().map((c) => h('tr', {}, h('td', {}, ent(c.claimant)), h('td', {}, `claims${c.what ? ` ${c.what} of` : ''}`), h('td', {}, ent(c.target)), h('td', {}, `${c.basis} ${c.strength}${c.expires !== undefined ? ` until ${c.expires}` : ''}`))))),
    h('details', {}, h('summary', {}, `History (${f.events().length} events, newest first)`), h('pre', {}, [...f.events()].reverse().map((v) => `turn ${v.turn}: ${v.kind}${v.weight !== undefined ? ` (${v.weight > 0 ? '+' : ''}${v.weight})` : ''} — ${v.note}`).join('\n'))),
    h('details', {}, h('summary', {}, `Invariants: ${inv.length ? `${inv.length} broken` : 'all hold'}`), h('pre', {}, inv.map((v) => `${v.rule}: ${v.why}`).join('\n') || 'every invariant holds')),
    h('details', {}, h('summary', {}, 'Log'), h('pre', {}, e.log.join('\n'))),
  );
}

function render(): void {
  deal();
  app.replaceChildren(
    ...[
    h('h1', {}, 'World inspector — Briar Hollow in the long drought'),
    h('div', { class: 'status' }, 'The living world’s fact layer and template engine (round 125). Cards bind real entities; committing spends real pawns and stores; every outcome is an instant mutation shown as a diff. ', h('a', { href: '?deck=1' }, 'The deck lab')),
    h('div', { class: 'bar' }, btn('Next turn', () => e.advance(), 'main'), btn('Reset', () => (e = briarEngine(true)))),
    problems.length ? h('pre', { class: 'bad', id: 'problems' }, problems.join('\n')) : null,
    counters(),
    holdings(),
    board(),
    changes(),
    entityPanel(),
    tables(),
    ].filter((x): x is HTMLElement => !!x),
  );
}

// (for scripted checks: the engine)
(window as unknown as { inspector: () => LivingEngine }).inspector = () => e;
render();
