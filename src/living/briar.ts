// ---- living/briar.ts ----------------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F8) A small seeded test world with Briar Hollow's cast (OPPORTUNITY_CATALOG.md D):
// a feudal river city with noble houses, a serf cohort, a communal gnoll cohort, a merchant guild; the polity that
// permits serfdom; a downstream town on the same river; a neutral neighbour. The owners hold what they own (WorldState:
// regions, factions with their power, settlements with stores and people, characters; the holdings: the player's
// pawns), and the fact layer holds the tags, relations, claims and history — diplomacy's agreements among them.
// Deterministic: the same world every time (the inspector's and the tests').

import { emptyHoldings, type Holdings } from '../api/contracts/opportunity';
import type { Faction } from '../api/contracts/world';
import type { Settlement } from '../api/contracts/settlement';
import { MemoryWorldState } from '../api/contracts/world-state';
import { LivingEngine } from './engine';
import { droughtArc, TEMPLATES } from './library';
import { FactWorld } from './world';

const REGIONS = [
  { id: 11, name: 'Briar Vale', kind: 'valley' },
  { id: 12, name: 'Lower Briar', kind: 'floodplain' },
  { id: 13, name: 'Vell Uplands', kind: 'upland' },
];

const FACTIONS: Faction[] = [
  { id: 'briar-crown', name: 'The Briar Crown', ethos: 'an old feudal crown, proud and short of coin', era: 'medieval', attitude: 0.2, relations: {}, power: 0.6 },
  { id: 'house-aldren', name: 'House Aldren', ethos: 'the oldest house of the vale, holders of Briar Hollow', era: 'medieval', attitude: 0.1, relations: {}, power: 0.55 },
  { id: 'house-morrow', name: 'House Morrow', ethos: 'a younger house, rich in fields, hungry for standing', era: 'medieval', attitude: 0, relations: {}, power: 0.45 },
  { id: 'lantern-guild', name: 'The Lantern Guild', ethos: 'merchants who want open roads and protected caravans', era: 'medieval', attitude: 0.3, relations: {}, power: 0.5 },
  { id: 'millbrook-council', name: 'The Millbrook Council', ethos: 'a council of millers and farmers downriver', era: 'medieval', attitude: 0.2, relations: {}, power: 0.35 },
  { id: 'vell-march', name: 'The Vell March', ethos: 'a free upland republic, neutral and watchful', era: 'medieval', attitude: 0, relations: {}, power: 0.5 },
];

const settlement = (s: Pick<Settlement, 'id' | 'name' | 'region' | 'faction' | 'at' | 'size' | 'people' | 'stores'>): Settlement => ({ radius: 60, condition: 'thriving', grids: [], buildings: [], needs: [], ...s });

const SETTLEMENTS: Settlement[] = [
  settlement({
    id: 'briar-hollow',
    name: 'Briar Hollow',
    region: 11,
    faction: 'house-aldren',
    at: [400, 300],
    size: 'city',
    people: [{ role: 'noble', count: 12 }, { role: 'serf', count: 140 }, { role: 'gnoll', count: 60 }, { role: 'merchant', count: 25 }, { role: 'guard', count: 20 }],
    stores: { grain: { stock: 150, rate: 2 }, stone: { stock: 80, rate: 1 }, timber: { stock: 40, rate: 1 } },
  }),
  settlement({ id: 'millbrook', name: 'Millbrook', region: 12, faction: 'millbrook-council', at: [620, 420], size: 'town', people: [{ role: 'farmer', count: 90 }, { role: 'miller', count: 10 }], stores: { grain: { stock: 90, rate: 2 } } }),
  settlement({ id: 'vellford', name: 'Vellford', region: 13, faction: 'vell-march', at: [180, 120], size: 'town', people: [{ role: 'farmer', count: 100 }, { role: 'weaver', count: 20 }], stores: { grain: { stock: 110, rate: 2 }, cloth: { stock: 30, rate: 1 } } }),
];

const CHARACTERS = [
  { id: 'edric-aldren', name: 'Lord Edric Aldren', role: 'lord', faction: 'house-aldren', region: 11, motivation: 'keep his house first in the vale' },
  { id: 'isolde-morrow', name: 'Lady Isolde Morrow', role: 'lady', faction: 'house-morrow', region: 11, motivation: 'win her house the standing its fields deserve' },
  { id: 'guildmaster-pell', name: 'Guildmaster Pell', role: 'merchant', faction: 'lantern-guild', region: 11, motivation: 'open every road' },
  { id: 'matron-grisk', name: 'Matron Grisk', role: 'elder', faction: null, region: 11, motivation: 'room for the young' },
  { id: 'reeve-tamsin', name: 'Reeve Tamsin', role: 'reeve', faction: 'millbrook-council', region: 12, motivation: 'keep the mills turning' },
];

/** the player's pawns and goods: real agents, stationed at the city they rule */
export function briarHoldings(): Holdings {
  const h = emptyHoldings();
  h.rules = ['briar-hollow'];
  h.goods = { coin: 40, influence: 6 };
  h.agents = [
    { id: 'you', kind: 'player', name: 'You', count: 1, tags: ['species:human'], statuses: [], at: { with: 'player' } },
    { id: 'maren', kind: 'diplomat', name: 'Envoy Maren', count: 1, tags: ['species:human'], statuses: [], at: { settlement: 'briar-hollow' } },
    { id: 'work-gang', kind: 'workers', name: 'The Hollow work gang', count: 8, tags: ['species:human'], statuses: [], at: { settlement: 'briar-hollow' } },
    { id: 'grisk-diggers', kind: 'workers', name: "Grisk's diggers", count: 6, tags: ['species:gnoll'], statuses: [], at: { settlement: 'briar-hollow' } },
  ];
  return h;
}

export function briarWorld(): FactWorld {
  const ws = new MemoryWorldState(125, REGIONS, structuredClone(FACTIONS));
  ws.settlements.push(...structuredClone(SETTLEMENTS));
  for (const c of CHARACTERS) ws.applyCharacter({ kind: 'meet', character: { ...c, hero: false, alive: true } });
  const w = new FactWorld(ws, briarHoldings());
  const f = w.facts;
  const T = (scope: Parameters<typeof f.setTag>[1], key: string, value: string | boolean | number) => ({ scope, key, value, since: 0 });
  // (turn −40: the history before the run — the old foundings the claims can rest on)
  f.turn = -40;
  // polities, factions, places: entities on the owners' ids
  f.add({ id: 'briar-crown', kind: 'polity', name: 'The Briar Crown', ref: { faction: 'briar-crown' }, at: { settlement: 'briar-hollow', region: 11 }, tags: [T('law', 'serfdom', 'legal'), T('government', 'hereditary_nobility', true), T('culture', 'traditionalist', true)] });
  f.add({ id: 'vell-march', kind: 'polity', name: 'The Vell March', ref: { faction: 'vell-march' }, at: { settlement: 'vellford', region: 13 }, tags: [T('law', 'serfdom', 'abolished'), T('government', 'council_rule', true), T('government', 'elected_offices', true)] });
  f.add({ id: 'house-aldren', kind: 'faction', name: 'House Aldren', ref: { faction: 'house-aldren' }, tags: [T('government', 'hereditary_nobility', true), T('culture', 'militarist', true)] });
  f.add({ id: 'house-morrow', kind: 'faction', name: 'House Morrow', ref: { faction: 'house-morrow' }, tags: [T('government', 'hereditary_nobility', true)] });
  f.add({ id: 'lantern-guild', kind: 'faction', name: 'The Lantern Guild', ref: { faction: 'lantern-guild' }, tags: [T('culture', 'mercantile', true), T('economy', 'guild_controlled', true)] });
  f.add({ id: 'millbrook-council', kind: 'faction', name: 'The Millbrook Council', ref: { faction: 'millbrook-council' }, tags: [T('government', 'council_rule', true)] });
  for (const s of SETTLEMENTS) f.add({ id: s.id, kind: 'settlement', name: s.name, ref: { settlement: s.id }, at: { region: s.region } });
  for (const c of CHARACTERS) f.add({ id: c.id, kind: 'person', name: c.name, ref: { character: c.id }, at: { region: c.region }, tags: [T('biology', 'species', c.id === 'matron-grisk' ? 'gnoll' : 'human')] });
  // cohorts: the people of a role in a settlement
  f.add({ id: 'cohort:briar-hollow:serf', kind: 'cohort', name: 'the serfs of Briar Hollow', ref: { people: { settlement: 'briar-hollow', role: 'serf' } }, at: { region: 11, settlement: 'briar-hollow' }, tags: [T('biology', 'species', 'human'), T('economy', 'labor', 'serf'), T('condition', 'unrest', 0.25)] });
  f.add({ id: 'cohort:briar-hollow:gnoll', kind: 'cohort', name: 'the gnolls of the Warrens', ref: { people: { settlement: 'briar-hollow', role: 'gnoll' } }, at: { region: 11, settlement: 'briar-hollow' }, tags: [T('biology', 'species', 'gnoll'), T('custom', 'communal_childcare', true), T('custom', 'communal_housing', true), T('economy', 'communal_ownership', true), T('culture', 'clan_based', true)] });
  // sites
  f.add({ id: 'thornfield', kind: 'site', name: 'Thornfield', at: { region: 11, settlement: 'briar-hollow' }, tags: [T('economy', 'holding', true), T('economy', 'farm', true)] });
  f.add({ id: 'briar-river', kind: 'site', name: 'the Briar', at: { region: 11, settlement: 'briar-hollow' }, tags: [T('economy', 'river', true)] });
  f.add({ id: 'route:river-road', kind: 'route', name: 'the river road', at: { region: 11, settlement: 'briar-hollow' }, tags: [T('economy', 'trade_road', true)] });
  // relations: jurisdiction, residence, membership
  f.relate({ type: 'part_of_polity', from: 'briar-hollow', to: 'briar-crown' });
  f.relate({ type: 'part_of_polity', from: 'millbrook', to: 'briar-crown' });
  f.relate({ type: 'part_of_polity', from: 'vellford', to: 'vell-march' });
  f.relate({ type: 'governs', from: 'briar-crown', to: 'briar-hollow' });
  for (const x of ['cohort:briar-hollow:serf', 'cohort:briar-hollow:gnoll', 'house-aldren', 'house-morrow', 'lantern-guild']) f.relate({ type: 'resident_at', from: x, to: 'briar-hollow' });
  f.relate({ type: 'resident_at', from: 'millbrook-council', to: 'millbrook' });
  f.relate({ type: 'member_of', from: 'matron-grisk', to: 'cohort:briar-hollow:gnoll' });
  // control and the river
  f.relate({ type: 'controls', from: 'house-morrow', to: 'thornfield' });
  f.relate({ type: 'depends_on', from: 'briar-hollow', to: 'briar-river', meta: { what: 'water' } });
  f.relate({ type: 'depends_on', from: 'millbrook', to: 'briar-river', meta: { what: 'water' } });
  f.relate({ type: 'downstream_of', from: 'millbrook', to: 'briar-hollow' });
  f.relate({ type: 'connected_by', from: 'briar-hollow', to: 'route:river-road' });
  f.relate({ type: 'connected_by', from: 'millbrook', to: 'route:river-road' });
  f.relate({ type: 'connected_by', from: 'briar-hollow', to: 'millbrook', symmetric: true });
  // personal and political
  f.relate({ type: 'rival_of', from: 'house-morrow', to: 'house-aldren', strength: 0.5 });
  f.relate({ type: 'grievance_against', from: 'cohort:briar-hollow:serf', to: 'house-morrow', strength: 0.3 });
  // diplomacy's agreements: relations in the fact layer (vassalage, peace with the neutral neighbour)
  const d = w.diplomacy;
  d.agree({ id: 'aldren-fealty', kind: 'vassalage', parties: [{ faction: 'house-aldren' }, { faction: 'briar-crown' }], since: { run: 0 }, status: 'active', cause: { by: 'world' } });
  d.agree({ id: 'morrow-fealty', kind: 'vassalage', parties: [{ faction: 'house-morrow' }, { faction: 'briar-crown' }], since: { run: 0 }, status: 'active', cause: { by: 'world' } });
  d.agree({ id: 'vell-peace', kind: 'peace', parties: [{ faction: 'briar-crown' }, { faction: 'vell-march' }], since: { run: 0 }, status: 'active', cause: { by: 'world' } });
  // the history the claims can rest on
  f.record({ kind: 'founding', by: ['house-aldren'], to: ['thornfield'], note: 'House Aldren cleared and first farmed Thornfield' });
  f.turn = -12;
  f.record({ kind: 'grant', by: ['briar-crown'], to: ['house-morrow', 'thornfield'], note: 'the Crown granted Thornfield to House Morrow for its loans' });
  d.note({ id: 'h-tithe', run: 0, by: { faction: 'house-morrow' }, to: { faction: 'house-aldren' }, kind: 'insult', weight: -0.3, halfLife: 6, note: 'House Morrow mocked the Aldren claim at the spring court' });
  f.turn = 0;
  f.drainChanged();
  return w;
}

/** the inspector's (and the tests') engine: the world, the library, the drought */
export function briarEngine(withArc = true): LivingEngine {
  const w = briarWorld();
  return new LivingEngine(w, TEMPLATES, withArc ? droughtArc('briar-hollow', 'millbrook', ['cohort:briar-hollow:serf', 'cohort:briar-hollow:gnoll']) : undefined);
}
