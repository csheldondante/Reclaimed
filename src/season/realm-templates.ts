// (loop-skeleton round 2; docs/design/LOOP_SKELETON.md "Conformance") The home-town run's opportunities as living
// templates (living/engine.ts TemplateDef): data over the fact world, dealt by the one dealer, committed and resolved
// through the one contract. They replace round 1's `Petition` cards. Two families:
//   - the town's projects: one template a season catalog card (season/catalog.ts), built by the season loop a stage a
//     season (the ledger adopts the engine's commitment: season/ledger.ts adopt);
//   - the world's: the user's catalog where it fits a home-town run (OPPORTUNITY_CATALOG.md INF-01 a mining outpost,
//     INF-03's tower as a place of learning, DEF: a neighbour relieved or left to fall), hazards whose expiry is a
//     physical change, and the run's one arc (the raiders).
// Every one is deterministic: no `odds`, one outcome (the orchestrator's ruling, 2026-11-15; the engine's own odds are
// untouched). Each stands at a site of the home town (a named building or district counts as a location: an assumption
// listed for the user), so the dealer's "one card a place" holds and the card can be shown over its place.
// What a template can't say in the DSL it names as a helper the realm registers (season/realm.ts): `canBuild`, `pool`,
// `income`, `spell`, `raid`, `avert`; and the land's side of an outcome: `mutateAt` (the land round a site of the home
// town, or a spot out of it) and `found` (a new camp), beside the mutators' own `mutate` and `sign` for a whole place
// (mutate/outcomes.ts).
import type { ArcDef, TemplateDef } from '../living/engine';
import type { Effect, Pred } from '../living/dsl';
import { PEOPLE_KIND, type Pool, type SeasonCard } from './ledger';

/** the home town's sites a card can stand at: a key, its name, and what the place is (for the scene's marker rule) */
export const SITES = [
  { key: 'keep', name: 'the keep yard', kind: 'military' },
  { key: 'forge', name: 'the smithy', kind: 'workshop' },
  { key: 'quarter', name: 'the weavers\' street', kind: 'homes' },
  { key: 'fields', name: 'the east fields', kind: 'fields' },
  { key: 'market', name: 'the market', kind: 'market' },
  { key: 'gate', name: 'the road gate', kind: 'gate' },
  { key: 'tower', name: 'the old tower', kind: 'landmark' },
  { key: 'dam', name: 'the old dam', kind: 'water' },
  { key: 'shrine', name: 'the mountain shrine', kind: 'landmark' },
  { key: 'mill', name: 'the mill street', kind: 'workshop' },
  { key: 'wall', name: 'the town\'s edge', kind: 'gate' },
  { key: 'watch', name: 'the watch post', kind: 'gate' },
  { key: 'harbour', name: 'the waterside', kind: 'water' },
  { key: 'quarry', name: 'the quarry hill', kind: 'landmark' },
  { key: 'woods', name: 'the woods', kind: 'fields' },
  { key: 'river', name: 'the river crossing', kind: 'water' },
  { key: 'road', name: 'the trade road', kind: 'gate' },
] as const;
export type SiteKey = (typeof SITES)[number]['key'];
export const siteId = (home: string, key: SiteKey): string => `site:${home}:${key}`;

const at = (key: SiteKey) => [
  { as: 'town', kind: 'settlement' as const, where: [{ helper: 'isHome', args: ['$town'] }] as Pred[] },
  { as: 'site', kind: 'site' as const, where: [{ helper: 'siteIs', args: ['$site', key] }] as Pred[] },
];

/** who asks for each catalog card, where, and in what words (round 1's lines, kept: they passed the writing lint) */
const ASKS: Record<string, { site: SiteKey; role: string; line: string; gain?: string }> = {
  keep: { site: 'keep', role: 'captain', line: 'My recruits sleep in a barn. Give me a barracks and I will give you soldiers.', gain: 'Two more Might when it is built. Each Might is 3 soldiers.' },
  workshops: { site: 'forge', role: 'smith', line: 'I need a proper forge and three pairs of hands. Then the town gets tools and nails.' },
  houses: { site: 'quarter', role: 'midwife', line: 'Three families share one roof on my street. Build them homes.' },
  farms: { site: 'fields', role: 'reeve', line: 'The granary is half empty. Give me workers and I will plant the east fields.' },
  market: { site: 'market', role: 'trader', line: 'We sell from carts in the mud. Give us a market square.' },
  walls: { site: 'wall', role: 'mason', line: 'Stone walls and gates. Raiders will have to come through a gate.', gain: 'One more Might when they are built. Your soldiers gather at the muster yard.' },
  harbour: { site: 'harbour', role: 'harbour master', line: 'Boats pass us by for want of a quay. Build one and they will stop here.' },
  quarry: { site: 'quarry', role: 'quarryman', line: 'There is good stone in the hill. Give me one worker and I will open a quarry.' },
  lumber: { site: 'woods', role: 'woodcutter', line: 'The woods are thick with timber. One worker and I will start a camp.' },
  bridge: { site: 'river', role: 'ferryman', line: 'My ferry is too slow for carts. Bridge the river.' },
  trade: { site: 'road', role: 'carter', line: 'With a market, my wagons could run a trade route. I need silver and a guide.' },
};

/** the template id of a catalog card's project */
export const projectId = (card: string): string => `build:${card}`;
export const cardOfTemplate = (id: string): string | null => (id.startsWith('build:') ? id.slice(6) : null);

/** a season catalog card as a template: its people locked, its goods spent, its seasons; built by the season loop */
export function projectTemplate(c: SeasonCard): TemplateDef | null {
  const ask = ASKS[c.id];
  if (!ask) return null;
  const agents = (Object.entries(c.locks) as [Pool, number][]).filter(([, n]) => n > 0).map(([k, n]) => ({ kind: PEOPLE_KIND[k]!, count: n }));
  const goods = Object.fromEntries((Object.entries(c.costs) as [Pool, number][]).filter(([, n]) => n > 0));
  const gives = [...Object.entries(c.gives ?? {}).map(([k, v]) => `+${v} ${cap(k)} when built`), ...Object.entries(c.income ?? {}).map(([k, v]) => `+${v} ${cap(k)} each season`)].join(', ');
  return {
    id: projectId(c.id),
    title: c.title,
    pitch: c.pitch,
    themes: c.id === 'keep' || c.id === 'walls' ? ['town', 'build', 'war', 'raiders'] : ['town', 'build'],
    ...(c.id === 'keep' || c.id === 'walls' ? { hooks: ['raiders'] } : {}),
    bind: at(ask.site),
    eligible: [{ helper: 'canBuild', args: [c.id] }],
    at: 'site',
    requires: { agents, goods },
    turns: c.seasons,
    work: 'labour',
    outcome: [{ event: 'built', by: ['player'], to: ['$site'], note: `${c.name} built at {site}`, weight: 0.2 }],
    outcomeText: `${cap(c.name)} is finished.`,
    presenter: { of: '$town', role: ask.role, own: true, verb: 'asks', line: ask.line, ...(ask.gain ? { gain: ask.gain } : {}) },
    reward: { text: gives ? `${gives}.` : c.pitch },
    offerTurns: 3,
    cooldown: 1,
    parts: { theme: 0.6 },
  };
}
const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** a hazard: a small cost now, or its expiry changes the land (a named physical change) */
function hazard(o: { id: string; site: SiteKey; title: string; pitch: string; role: string; line: string; workers?: number; goods?: Record<string, number>; done: string; kind: string; where: string; lapse: string; unrest?: number; offerTurns: number; radius: number; spot?: string; setup?: Effect[]; calm?: Effect[] }): TemplateDef {
  return {
    id: o.id,
    title: o.title,
    pitch: o.pitch,
    themes: ['hazard', o.kind],
    bind: at(o.site),
    eligible: [{ not: { tag: ['$site', 'condition', o.kind], is: true } }],
    at: 'site',
    requires: { agents: o.workers ? [{ kind: 'workers', count: o.workers }] : [], ...(o.goods ? { goods: o.goods } : {}) },
    turns: 1,
    work: 'labour',
    ...(o.setup ? { setup: o.setup } : {}),
    outcome: [...(o.calm ?? []), { event: 'made-safe', by: ['player'], to: ['$site'], note: o.done, weight: 0.2 }],
    outcomeText: o.done,
    // (the event first: the land's change is its physical side and carries its id)
    onExpire: [
      { setTag: ['$site', 'condition', o.kind, true] },
      ...(o.unrest ? [{ helper: 'pool', args: ['unrest', o.unrest] } as Effect] : []),
      { event: o.kind, by: [], to: ['$site', '$town'], note: o.lapse, weight: -0.4 },
      { helper: 'mutateAt', args: [o.kind, '$site', o.radius, 1, ...(o.spot ? [o.spot] : [])] },
    ],
    expireText: o.lapse,
    presenter: { of: '$town', role: o.role, own: true, verb: 'warns', line: o.line },
    reward: { text: o.done },
    offerTurns: o.offerTurns,
    cooldown: 6,
    once: true,
  };
}

/** raiders in the run's last stage */
export const RAIDERS = 6;

/** the world's opportunities of a home-town run */
export const WORLD_TEMPLATES: TemplateDef[] = [
  {
    // (OPPORTUNITY_CATALOG INF-01: establish a mining outpost)
    id: 'mining-outpost',
    title: 'Found a mining camp',
    pitch: 'There is copper in the hills. A crew and timber would start a camp that sends ore home.',
    themes: ['expansion', 'economy'],
    bind: at('gate'),
    eligible: [{ not: { helper: 'exists', args: ['copper-hollow'] } }],
    at: 'site',
    requires: { agents: [{ kind: 'workers', count: 1 }], goods: { materials: 2 } },
    turns: 1,
    work: 'labour',
    outcome: [
      { helper: 'found', args: ['copper-hollow', 'Copper Hollow'] },
      { setTag: ['copper-hollow', 'economy', 'mine', true] },
      { relate: ['player', 'controls', 'copper-hollow'] },
      { relate: ['copper-hollow', 'supplies', '$town'] },
      { helper: 'income', args: ['materials', 1] },
      { event: 'camp-opened', by: ['player'], to: ['copper-hollow', '$town'], note: 'Copper Hollow was founded in the hills. Its ore wagons come down your road', weight: 0.4 },
    ],
    outcomeText: 'Copper Hollow is founded in the hills. Its ore wagons come down your road.',
    presenter: { of: '$town', role: 'prospector', own: true, verb: 'asks', line: 'There is copper in the hills, two days out. Give me a crew and timber and I will dig.', gain: 'One more Materials every season.' },
    reward: { text: '+1 Materials each season.' },
    offerTurns: 3,
    once: true,
  },
  {
    // (INF-03 at a small scale: a place of learning gives a spell)
    id: 'tower-lens',
    title: 'Light the tower lens',
    pitch: 'The old lens in the tower still works. With Magic and one worker it gives you a heat ray.',
    themes: ['magic', 'research'],
    bind: at('tower'),
    eligible: [{ not: { helper: 'hasSpell', args: ['heatray'] } }],
    at: 'site',
    requires: { agents: [{ kind: 'workers', count: 1 }], goods: { magic: 1 } },
    turns: 1,
    work: 'labour',
    outcome: [{ helper: 'spell', args: ['heatray'] }, { event: 'lens-lit', by: ['player'], to: ['$site'], note: 'the lens in the old tower was lit', weight: 0.3 }],
    outcomeText: 'The lens is lit. You can cast Heat ray in a fight.',
    presenter: { of: '$town', role: 'scholar', own: true, verb: 'offers', line: 'The old lens in the tower still works. Give me Magic and one worker. You will get a heat ray.' },
    reward: { text: 'You can cast Heat ray in a fight. Each cast costs 1 Magic.' },
    offerTurns: 3,
    once: true,
  },
  {
    // (a neighbour under attack: helped, it pays you; left, it falls and its people come to you)
    id: 'relieve-neighbour',
    title: 'Send help to {other}',
    pitch: 'Raiders ring {other}. Soldiers sent now would break the ring.',
    themes: ['war', 'diplomacy'],
    bind: [...at('watch'), { as: 'other', kind: 'settlement', shared: true, where: [{ helper: 'neighbour', args: ['$other'] }] }],
    eligible: [{ not: { event: { kind: 'relieved', involving: '$other' } } }, { not: { tag: ['$other', 'condition', 'occupied'], is: true } }],
    at: 'site',
    requires: { agents: [{ kind: 'army', count: 1 }] },
    turns: 1,
    work: 'travel',
    outcome: [
      { helper: 'mutate', args: ['vassal', '$other', 1, 1, 'player', 1] },
      { helper: 'income', args: ['materials', 1] },
      { event: 'relieved', by: ['player'], to: ['$other'], note: 'your soldiers broke the ring round {other}. It swore to you and pays 1 Materials each season', weight: 0.6 },
    ],
    outcomeText: 'Your soldiers break the ring. {other} swears to you and pays 1 Materials each season.',
    onExpire: [
      { setTag: ['$other', 'condition', 'occupied', true] },
      { condition: ['$other', 'besieged'] },
      { helper: 'mutate', args: ['captured', '$other', 1, 1, 'raiders'] },
      { helper: 'pool', args: ['unrest', 1] },
      { event: 'fell', by: [], to: ['$other', '$town'], note: '{other} fell to raiders. Its refugees reached your gate', weight: -0.6 },
    ],
    expireText: '{other} falls. Raiders hold it now. Its refugees reach your gate. Unrest +1.',
    presenter: { of: '$other', role: 'rider', own: true, verb: 'asks', line: 'Raiders ring {other}. Send soldiers now or the town falls.', gain: '{other} will pay you 1 Materials each season.' },
    reward: { text: '{other} pays you 1 Materials each season.' },
    offerTurns: 1,
    once: true,
  },
  {
    id: 'pay-raiders',
    title: 'Pay the raiders off',
    pitch: 'The raiders on the road want tribute. Paid, they leave and no attack comes.',
    themes: ['war', 'raiders'],
    bind: at('gate'),
    eligible: [{ helper: 'threatComing' }, { helper: 'threatNear' }],
    at: 'site',
    requires: { agents: [], goods: { materials: 6 } },
    turns: 1,
    work: 'talk',
    outcome: [{ helper: 'avert' }, { event: 'tribute-paid', by: ['player'], to: ['$town'], note: 'you paid the raiders 6 Materials and they left', weight: -0.1 }],
    outcomeText: 'The raiders take the tribute and leave.',
    presenter: { of: '$town', role: 'scout', own: true, verb: 'warns', line: 'I counted the raiders camped on the road. They want tribute. Pay them or get ready to fight.' },
    reward: { text: 'No attack comes this run.' },
    offerTurns: 2,
    cooldown: 1,
    hooks: ['raiders'],
  },
  hazard({ id: 'mend-dam', site: 'dam', title: 'Mend the old dam', pitch: 'The old dam is cracked. Two workers and some stone will hold it.', role: 'dam keeper', line: 'The old dam is cracked from top to bottom. Two workers and some stone will hold it.', workers: 2, goods: { materials: 2 }, done: 'The dam is mended. The lower town stays dry.', kind: 'flooded', where: 'the lower town', lapse: 'The dam broke. The lower town is flooded.', offerTurns: 2, radius: 34 }),
  hazard({ id: 'fire-wards', site: 'market', title: 'Pay for fire wards', pitch: 'A fire mage works by the market. Wards on its roofs keep her fire in her hearth.', role: 'fire mage', line: 'My work gets hot. Pay for wards on the market roofs. I will not ask twice.', goods: { magic: 1 }, done: 'The market is warded. The fire stays in the hearth.', kind: 'burned', where: 'the market', lapse: 'The fire got loose. The market burned.', unrest: 1, offerTurns: 2, radius: 22 }),
  hazard({ id: 'feed-shrine', site: 'shrine', title: 'Feed the mountain shrine', pitch: 'Ash falls on the town. Stone and an offering at the shrine may quiet the mountain.', role: 'shrine keeper', line: 'Ash has been falling for days. The mountain will break soon. Send stone and an offering.', goods: { materials: 2, magic: 1 }, done: 'The shrine is fed. The mountain sleeps.', kind: 'melted', where: 'the mountain', lapse: 'The mountain broke. Lava ran down its side. Ash and darkness hang over the town.', offerTurns: 2, radius: 70, spot: 'mountain',
    // (the sign the keeper points at: thin ash over the town while the card stands; fed, it stops. Broken, the eruption
    // casts its own ash and darkness for three seasons — mutate/engine.ts)
    setup: [{ helper: 'sign', args: ['ashfall', '$town', 0.4] }], calm: [{ helper: 'sign', args: ['ashfall', '$town', 0] }] }),
  hazard({ id: 'shore-hill', site: 'mill', title: 'Shore up the hill', pitch: 'The hill above the mill is slipping. One worker with timber can pin it.', role: 'miller', line: 'The hill above my mill is slipping. One worker with timber can pin it.', workers: 1, goods: { materials: 1 }, done: 'The hill is pinned. The mill is safe.', kind: 'buried', where: 'the mill street', lapse: 'The hill slid. The mill street is buried.', offerTurns: 2, radius: 24 }),
];

/**
 * The run's one arc (FACTIONS_WORLD_STATE §6): raiders on the road, seen from the first seasons, attacking in the last.
 * `seasons` is the run's length (a knob: 16 by default, the orchestrator's number, not the user's). Its stages land at
 * a quarter, a half and the end.
 */
export function raidArc(home: string, seasons: number, n = RAIDERS): ArcDef {
  const q = Math.max(1, Math.round(seasons / 4));
  return {
    id: 'raiders',
    name: 'The raiders on the road',
    themes: ['raiders', 'war'],
    bind: { town: home },
    stages: [
      { name: 'Scouts on the road', turn: Math.min(q, seasons - 1), text: `Raiders' scouts are seen on the road. They will attack in season ${seasons}.`, effects: [{ event: 'scouts-seen', by: [], to: ['$town'], note: "raiders' scouts were seen on the road" }] },
      { name: 'A farm burned', turn: Math.max(Math.min(2 * q, seasons - 1), Math.min(q, seasons - 1) + 1), text: 'The raiders burn a farm outside the town. Unrest +1.', effects: [{ helper: 'pool', args: ['unrest', 1] }, { event: 'farm-burned', by: [], to: ['$town'], note: 'raiders burned a farm outside the town' }] },
      { name: 'The raiders attack', turn: seasons, text: `${n} raiders attack the town.`, effects: [{ helper: 'raid', args: [n] }] },
    ],
  };
}
