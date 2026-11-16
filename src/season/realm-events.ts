// (loop-skeleton round 6; docs/SYSTEMS.md recipe 6) The home-town run's live events, each a template whose
// `play.event` is data (living/live.ts LiveDef) for the one runner (scenes/level/live-runner.ts): the raid, the dead
// in the burial ground, a parade, a fire at the market, refugees walking in. The owner: "I would strongly consider
// using the same system for all of them."
//
// Each is committed like any card (the raid and the refugees' arrival are forced: nobody asks), played in the live
// city while the season goes on round it, and resolved — by its own end, or by the season's — from the state it is in:
// its numbers counted, the realm's synergy rules applied to them (season/realm-rules.ts), a tier read, and that tier's
// outcome run through the engine into the fact layer. In Node (tests, the bots) the same event resolves from the state
// nobody played.
//
// Every number is a first guess, to tune (BACKLOG LS-66). Who decides a fight is still open (LOOP_SKELETON.md
// "Conformance: who decides the fight"): here the live counts do, and what is still standing when the time is up is
// settled by one line of arithmetic (`derive`).
import type { TemplateDef } from '../living/engine';
import type { Effect, Pred } from '../living/dsl';
import type { LiveDef } from '../living/live';
import type { SiteKey } from './realm-templates';

const at = (key: SiteKey, shared = false) => [
  { as: 'town', kind: 'settlement' as const, where: [{ helper: 'isHome', args: ['$town'] }] as Pred[] },
  { as: 'site', kind: 'site' as const, where: [{ helper: 'siteIs', args: ['$site', key] }] as Pred[], ...(shared ? { shared: true } : {}) },
];

export const RAID = 'raid';
export const DEAD_RISE = 'dead-rise';
export const PARADE = 'gate-parade';
export const MARKET_FIRE = 'market-fire';
export const REFUGEES_ARRIVE = 'refugees-arrive';
/** cells round where the raiders stood that burn when they break in */
export const SACK_RADIUS = 30;

// ---- the raid ---------------------------------------------------------------------------------------------------------

/** Raiders come in by a road and attack its gate (no walls: the town's heart); the town's soldiers fight them where
 *  they are posted. It ends when no raider is left, when no soldier has stood for 5 s, or after 150 s. Then: each
 *  soldier still standing holds one raider, the rules may stop more ('stopped'), and the rest got in. */
const RAID_EVENT: LiveDef = {
  tag: 'raid',
  title: 'The raiders attack',
  how: 'Your soldiers fight at their posts. Cast a spell on the raiders to help them.',
  line: '{alive} of {raiders} raiders are left. {soldiers} of your soldiers stand.',
  groups: [
    { id: 'raiders', kind: 'raider', side: 'foe', n: 'raid', tags: ['raider'], from: { place: 'spawn', road: 'entry' }, order: { kind: 'attack', at: { place: 'gate', road: 'entry' } } },
    { id: 'soldiers', kind: 'guard', side: 'town', n: 'soldiers', tags: ['soldier'], from: 'squads' },
  ],
  camera: { follow: 'raider', zoom: 10, fightZoom: 22 },
  seconds: 150,
  spells: ['known'],
  stay: true,
  marchSpeed: 3,
  ends: [
    { when: 'none', tag: 'raider' },
    { when: 'absent', tag: 'soldier', while: 'raider', seconds: 5 },
  ],
  result: [
    { as: 'raiders', count: 'made', tag: 'raider' },
    { as: 'alive', count: 'alive', tag: 'raider' },
    { as: 'soldiers', count: 'alive', tag: 'soldier' },
    { as: 'fallen', count: 'dead', tag: 'soldier' },
    { as: 'stopped', value: 0 },
  ],
  derive: [
    { as: 'held', calc: ['soldiers', '+', 'stopped'] },
    { as: 'left', calc: ['alive', '-', 'held'], min: 0 },
    { as: 'dead', calc: ['raiders', '-', 'left'] },
    // (season/war.ts settle: a point of Might for each squad of 3 fallen; a Material carried off by each raider in)
    { as: 'mightLost', calc: ['fallen', '/', 3], round: 'ceil' },
  ],
  tiers: [{ tier: 'cost', when: [['raiders', '=', 0]] }, { tier: 'success', when: [['left', '=', 0]] }, { tier: 'failure' }],
  marks: [
    ['raider', 'Raiders'],
    ['soldier', 'Your soldiers'],
  ],
};

const raidLosses: Effect[] = [{ helper: 'raidOver' }, { helper: 'pool', args: ['might', '-mightLost'] }];

// FIXED-CITY (BACKLOG LS-40): the raid is on the home town's gate
const RAID_T: TemplateDef = {
  id: RAID,
  title: 'The raiders attack',
  pitch: 'The raiders are on the road. Your soldiers meet them where they are posted.',
  themes: ['war', 'raiders'],
  hooks: ['raiders'],
  // (the gate is shared: the tribute's card may still stand there)
  bind: at('gate', true),
  eligible: [{ helper: 'raidDue' }],
  threat: 'arc',
  live: true,
  parts: { urgency: 1 },
  at: 'site',
  requires: { agents: [] },
  turns: 1,
  work: 'talk',
  play: { area: '$site', forced: true, climax: true, event: RAID_EVENT },
  vars: 'live',
  outcomes: {
    cost: { text: 'No raider reached the town.', effects: [{ helper: 'raidOver' }, { event: 'raid-missed', by: [], to: ['$town'], note: 'the raiders found no road into the town' }] },
    success: { text: 'The town held. All {raiders} raiders are dead or driven off.', effects: [...raidLosses, { event: 'raid-held', by: [], to: ['$town'], note: 'the town held against {raiders} raiders; {fallen} soldiers died', weight: 0.5 }] },
    failure: {
      text: '{left} of {raiders} raiders got into the town.',
      effects: [
        ...raidLosses,
        { helper: 'pool', args: ['materials', '-left'] },
        { helper: 'pool', args: ['unrest', 1] },
        // (sacked: the district by the gate burned, its people gone; thieves in what is left for three seasons. The
        // event first: the land's change is its physical side and carries its id)
        { setTag: ['$site', 'condition', 'burned', true] },
        { setTag: ['$site', 'condition', 'abandoned', true] },
        { event: 'raid-broke', by: [], to: ['$town'], note: '{left} of {raiders} raiders broke into the town; {fallen} soldiers died', weight: -0.6 },
        { helper: 'mutateAt', args: ['burned', '$site', SACK_RADIUS, 1, 'live'] },
        { helper: 'sign', args: ['crime', '$town', 0.8, 3] },
      ],
    },
  },
  presenter: { of: '$town', role: 'gate captain', own: true, verb: 'warns', line: 'They are on the road now. Everyone to their posts.' },
  reward: { text: 'The town stands or falls by this fight.' },
  offerTurns: 1,
  cooldown: 1,
};

// ---- the dead in the burial ground --------------------------------------------------------------------------------------

/** A few of the dead get up at the burial ground; the player goes there and casts Fire on them. It ends when none is
 *  up. Left as it stands, it is settled at the season's end: any still up get out. */
const DEAD_EVENT: LiveDef = {
  tag: 'rising',
  title: 'The dead are up',
  how: 'Press Fire, then tap the dead. Each cast costs 1 Magic.',
  line: '{up} of the dead are still up.',
  groups: [{ id: 'dead', kind: 'shambler', side: 'foe', n: 5, tags: ['dead'], from: { site: 'here' }, spread: 7 }],
  camera: { follow: 'dead', zoom: 15.4 },
  spells: ['fire'],
  ends: [{ when: 'none', tag: 'dead' }],
  result: [{ as: 'up', count: 'alive', tag: 'dead' }],
  tiers: [{ tier: 'success', when: [['up', '=', 0]] }, { tier: 'failure' }],
  marks: [['dead', 'The dead']],
};

const deadLoose: Effect[] = [{ helper: 'pool', args: ['unrest', 1] }, { helper: 'sign', args: ['deadrise', '$town', 0.9, 3] }, { event: 'dead-loose', by: [], to: ['$site', '$town'], note: 'the dead got out of the burial ground and walk the streets', weight: -0.4 }];

const DEAD_T: TemplateDef = {
  id: DEAD_RISE,
  title: 'Burn the risen dead',
  pitch: 'The dead are up in the old burial ground. Fire will put them down again.',
  themes: ['magic', 'undead'],
  bind: at('graves'),
  eligible: [{ helper: 'after', args: [0.35] }, { not: { event: { kind: 'dead-burned', involving: '$town' } } }, { not: { event: { kind: 'dead-loose', involving: '$town' } } }],
  threat: true,
  live: true,
  parts: { urgency: 0.72 },
  at: 'site',
  setup: [{ helper: 'sign', args: ['deadrise', '$town', 0.1] }],
  requires: { agents: [] },
  turns: 1,
  work: 'talk',
  play: { area: '$site', event: DEAD_EVENT },
  vars: 'live',
  outcomes: {
    success: { text: 'The dead are ash. The burial ground is quiet.', effects: [{ helper: 'sign', args: ['deadrise', '$town', 0] }, { event: 'dead-burned', by: ['player'], to: ['$site', '$town'], note: 'you burned the risen dead in the old burial ground', weight: 0.3 }] },
    failure: { text: '{up} of the dead got out of the burial ground. They walk the streets at night. Unrest +1.', effects: deadLoose },
  },
  onExpire: deadLoose,
  expireText: 'The dead are out of the burial ground. They walk the streets at night. Unrest +1.',
  presenter: { of: '$town', role: 'gravedigger', own: true, verb: 'warns', line: 'The dead are up and walking in the old burial ground. Some are in the streets already. Come and burn them.' },
  reward: { text: 'You go there and cast Fire on them. Each cast costs 1 Magic.' },
  offerTurns: 2,
  once: true,
};

// ---- a parade ---------------------------------------------------------------------------------------------------------

/** A column marches in by a road to the market (no market yet: the stores) under falling petals, with townspeople out
 *  along the way. It ends when the column stands at the market. Its result is the crowd: the marchers who arrived and
 *  the people who came out — which the rules then change (unrest, a harvest, a shrine on the way). */
const PARADE_EVENT: LiveDef = {
  tag: 'parade',
  title: 'The parade',
  how: 'The marchers come in by the road and go to the market. You can leave: it goes on without you.',
  line: '{marching} marchers are on their way. {out} people are out to watch.',
  groups: [
    { id: 'marchers', kind: 'worker', side: 'folk', n: 9, tags: ['marcher', 'crowd'], from: { place: 'spawn', road: 'entry' }, order: { kind: 'go', at: { place: 'market', else: { place: 'stores' } }, formation: 'column', discipline: 0.8 } },
    { id: 'watchers', kind: 'worker', side: 'folk', n: 'watchers', tags: ['watcher', 'crowd'], from: { place: 'stores' }, order: { kind: 'go', at: { place: 'market', else: { place: 'stores' } }, formation: 'loose' } },
  ],
  fx: { burst: 'petals', over: 'marchers', every: 1.2, count: 16 },
  camera: { follow: 'marcher', zoom: 11 },
  marchSpeed: 3,
  ends: [{ when: 'arrived', group: 'marchers' }],
  result: [
    { as: 'crowd', count: 'arrived', tag: 'crowd' },
    { as: 'marching', count: 'alive', tag: 'marcher' },
    { as: 'out', count: 'alive', tag: 'watcher' },
  ],
  tiers: [{ tier: 'triumph', when: [['crowd', '>=', 14]] }, { tier: 'success', when: [['crowd', '>=', 8]] }, { tier: 'failure' }],
  marks: [['marcher', 'The parade']],
};

const PARADE_T: TemplateDef = {
  id: PARADE,
  title: 'Hold a parade',
  pitch: 'A parade from the road to the market would lift the town. The feast costs 1 Materials.',
  themes: ['town', 'festival'],
  // (at the shrine: no project of the town stands there, so it never keeps one off the board)
  bind: at('shrine'),
  eligible: [{ helper: 'after', args: [0.1] }],
  at: 'site',
  requires: { agents: [], goods: { materials: 1 } },
  turns: 1,
  work: 'talk',
  play: { area: '$site', event: PARADE_EVENT },
  vars: 'live',
  outcomes: {
    triumph: { text: '{crowd} people came out for the parade. Unrest -2.', effects: [{ helper: 'pool', args: ['unrest', -2] }, { helper: 'mark', args: ['$site', 'festival'] }, { event: 'parade-held', by: ['player'], to: ['$site', '$town'], note: 'a parade drew {crowd} people to the market', weight: 0.3 }] },
    success: { text: '{crowd} people came out for the parade. Unrest -1.', effects: [{ helper: 'pool', args: ['unrest', -1] }, { helper: 'mark', args: ['$site', 'festival'] }, { event: 'parade-held', by: ['player'], to: ['$site', '$town'], note: 'a parade drew {crowd} people to the market', weight: 0.2 }] },
    failure: { text: 'Only {crowd} people came out for the parade. It changed nothing.', effects: [{ event: 'parade-thin', by: ['player'], to: ['$site', '$town'], note: 'a parade passed through nearly empty streets' }] },
  },
  presenter: { of: '$town', role: 'piper', own: true, verb: 'asks', line: 'The streets have been grim since the raiders were seen. Let us march in from the road to the market with drums. You pay for the feast.', gain: 'A good crowd calms the town. Unrest falls by 1 if 8 people come and by 2 if 14 come.' },
  reward: { text: 'Unrest -1 if 8 people come. Unrest -2 if 14 come.' },
  offerTurns: 3,
  cooldown: 4,
  // (a small worth: a parade does not keep a building off the board)
  parts: { ev: 0.15 },
};

// ---- a fire at the market ---------------------------------------------------------------------------------------------

/** The real fire system lit at six spots round the market (the stalls: timber and canvas put there as it starts). The
 *  player brings rain on it. It ends when nothing is alight (20 s in at the earliest) or after 80 s. A spot that stayed
 *  alight long enough is a burned lot; the lots burned get the `burned` condition where they stand. */
const FIRE_EVENT: LiveDef = {
  tag: 'fire',
  title: 'Fire at the market',
  how: 'Press Rain, then tap the flames. Each cast costs 1 Magic.',
  line: '{alight} of {lots} stalls are alight. {burned} have burned down.',
  groups: [],
  hazard: { kind: 'fire', at: { site: 'here' }, points: 6, spread: 13, radius: 2.5, intensity: 0.9 },
  camera: { at: { site: 'here' }, zoom: 10 },
  seconds: 80,
  spells: ['rain'],
  ends: [{ when: 'out', after: 20 }],
  result: [
    { as: 'lots', read: 'points' },
    { as: 'burned', read: 'burned' },
    { as: 'alight', read: 'alight' },
  ],
  tiers: [{ tier: 'triumph', when: [['burned', '=', 0]] }, { tier: 'success', when: [['burned', '<=', 2]] }, { tier: 'failure' }],
};

const marketLost: Effect[] = [{ setTag: ['$site', 'condition', 'burned', true] }, { helper: 'pool', args: ['unrest', 1] }, { event: 'burned', by: [], to: ['$site', '$town'], note: 'The fire got loose. The market burned.', weight: -0.4 }];

const FIRE_T: TemplateDef = {
  id: MARKET_FIRE,
  title: 'Fight the fire at the market',
  pitch: "The fire mage's hearth has set the market stalls alight. Rain will put it out.",
  themes: ['hazard', 'burned'],
  bind: at('market'),
  eligible: [{ not: { tag: ['$site', 'condition', 'burned'], is: true } }, { helper: 'after', args: [0.45] }],
  threat: true,
  live: true,
  parts: { urgency: 0.7 },
  at: 'site',
  requires: { agents: [] },
  turns: 1,
  work: 'talk',
  play: { area: '$site', event: FIRE_EVENT },
  vars: 'live',
  outcomes: {
    triumph: { text: 'The fire is out. Nothing burned down.', effects: [{ event: 'made-safe', by: ['player'], to: ['$site'], note: 'you put the market fire out before a stall was lost', weight: 0.3 }] },
    success: { text: 'The fire is out. {burned} of {lots} stalls burned down.', effects: [{ event: 'fire-fought', by: ['player'], to: ['$site', '$town'], note: 'you fought the market fire; {burned} stalls burned down', weight: 0.1 }, { helper: 'burnPoints', args: ['$site', 7] }] },
    failure: { text: '{burned} of {lots} stalls burned down. The market is lost. Unrest +1.', effects: [...marketLost, { helper: 'burnPoints', args: ['$site', 9] }] },
  },
  // (nobody went: all of it burns, as the instant hazard did)
  onExpire: [...marketLost, { helper: 'mutateAt', args: ['burned', '$site', 22, 1] }],
  expireText: 'The fire got loose. The market burned. Unrest +1.',
  presenter: { of: '$town', role: 'fire mage', own: true, verb: 'warns', line: 'My hearth got away from me. The market stalls are burning. Bring rain, now.' },
  reward: { text: 'You go there and cast Rain on the flames. Each cast costs 1 Magic.' },
  offerTurns: 1,
  cooldown: 6,
  once: true,
};

// ---- refugees walking in ----------------------------------------------------------------------------------------------

/** When a far town falls its people walk in by a road, with their carts, to the stores; nobody asks. It ends when the
 *  column stands there. Their camp by the gate is the realm's (`camp` helper), and what is done with it a later card. */
const REFUGEE_EVENT: LiveDef = {
  tag: 'refugees',
  title: 'Refugees on the road',
  how: 'They come in by the road with what they could carry. You can leave: they walk on without you.',
  line: '{walking} refugees and {carts} carts are on the road.',
  groups: [
    { id: 'people', kind: 'worker', side: 'folk', n: 12, tags: ['refugee'], from: { place: 'spawn', road: 'entry' }, order: { kind: 'go', at: { place: 'stores' }, formation: 'column', discipline: 0.3 } },
    { id: 'carts', kind: 'cart', side: 'folk', n: 3, tags: ['cart'], from: { place: 'spawn', road: 'entry' }, order: { kind: 'go', at: { place: 'stores' }, formation: 'column', discipline: 0.3 } },
  ],
  camera: { follow: 'refugee', zoom: 10 },
  marchSpeed: 3,
  ends: [{ when: 'arrived', group: 'people' }],
  result: [
    { as: 'walking', count: 'alive', tag: 'refugee' },
    { as: 'carts', count: 'alive', tag: 'cart' },
  ],
  tiers: [{ tier: 'success' }],
  marks: [['refugee', 'Refugees']],
};

const REFUGEE_T: TemplateDef = {
  id: REFUGEES_ARRIVE,
  title: 'Refugees reach your gate',
  pitch: 'People from a fallen town are walking in along the road.',
  themes: ['town', 'refugees'],
  bind: at('watch', true),
  eligible: [{ event: { kind: 'fell', involving: '$town', within: 1 } }, { not: { event: { kind: 'refugees-arrived', involving: '$town', within: 2 } } }],
  threat: 'arc',
  live: true,
  parts: { urgency: 0.9 },
  at: 'site',
  requires: { agents: [] },
  turns: 1,
  work: 'talk',
  play: { area: '$site', forced: true, event: REFUGEE_EVENT },
  vars: 'live',
  outcomes: {
    success: { text: 'The refugees have camped by the watch post.', effects: [{ helper: 'camp', args: ['$site'] }, { event: 'refugees-arrived', by: [], to: ['$site', '$town'], note: 'refugees walked in along the road and camped by the watch post' }] },
  },
  presenter: { of: '$town', role: 'gate guard', own: true, verb: 'warns', line: 'There is a column on the road. Not raiders. Families, with carts.' },
  reward: { text: 'They will ask you for shelter.' },
  offerTurns: 1,
  cooldown: 1,
};

/** the run's live events, as templates */
export const LIVE_TEMPLATES: TemplateDef[] = [RAID_T, DEAD_T, PARADE_T, FIRE_T, REFUGEE_T];
