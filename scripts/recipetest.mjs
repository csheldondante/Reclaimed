// The recipe and diplomacy contracts through their APIs (round 85): a knight is a person + training + armour +
// a mount, and a hoverbike fits the mount slot as well as a horse does; a hoverbike without power can't move;
// a people that only uses hoverbikes can't make one; a ruin adapted into apartments keeps its history; rights
// and memories read off the diplomacy record.
//   node scripts/recipetest.mjs
import { derive, plan } from '../src/api/contracts/compose.ts';
import { MemoryDiplomacy } from '../src/api/contracts/diplomacy-memory.ts';

let failed = false;
const check = (name, ok, info = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `: ${info}` : ''}`);
};

const kinds = new Map(
  [
    { id: 'person', name: 'person', tags: ['person', 'living'], base: { strength: 1, speed: 1 } },
    { id: 'horse', name: 'horse', tags: ['mount', 'living'], base: { speed: 4, carry: 2 } },
    { id: 'hoverbike', name: 'hoverbike', tags: ['mount', 'vehicle', 'needs-power', 'ancient'], base: { speed: 9, carry: 1 } },
    { id: 'power-cell', name: 'power cell', tags: ['power', 'ancient'] },
    { id: 'magic-stone', name: 'magic stone', tags: ['power', 'arcane'] },
    { id: 'plate', name: 'plate armour', tags: ['armour', 'heavy'], material: 'red-steel' },
    { id: 'knight', name: 'knight', tags: ['unit'] },
    { id: 'megastructure', name: 'ruined tower', tags: ['structure', 'ancient', 'tall'] },
    { id: 'rug', name: 'woven rug', tags: ['fitting', 'decor'], material: 'wool' },
  ].map((k) => [k.id, k]),
);
const rules = [
  { id: 'mounted', when: { all: ['has:mount'] }, from: [{ slot: 'mount', stat: 'speed' }], abilities: ['charge'] },
  { id: 'armoured', when: { all: ['armour:armour'] }, add: { defence: 3 }, mul: { speed: 0.9 } },
  { id: 'power-unmet', when: { all: ['needs-power'], none: ['has:power'] }, unmet: 'no power source', mul: { speed: 0 } },
  { id: 'hover', when: { all: ['mount:vehicle'] }, abilities: ['hover'], tags: ['hover-knight'] },
  { id: 'arcane-power', when: { all: ['power:arcane'] }, tags: ['glows'] },
  { id: 'housing', when: { all: ['structure', 'has:room'] }, tags: ['housing'] },
];
const things = new Map();
const put = (t) => (things.set(t.id, { parts: [], condition: 1, place: { in: 'gone' }, history: [], ...t }), t.id);
put({ id: 'ann', kind: 'person', gained: ['trained:knight'] });
put({ id: 'bess', kind: 'person', gained: ['trained:knight'] });
put({ id: 'nag', kind: 'horse' });
put({ id: 'bike', kind: 'hoverbike', history: [{ what: 'dug-up', run: 3, note: 'from the drowned barracks' }] });
put({ id: 'bike2', kind: 'hoverbike' });
put({ id: 'stone', kind: 'magic-stone' });
put({ id: 'p1', kind: 'plate' });
put({ id: 'p2', kind: 'plate' });
put({ id: 'tower', kind: 'megastructure', condition: 0.3 });
put({ id: 'rug1', kind: 'rug' });
const cat = { kinds, things, rules };

// a bike with the magic stone in its power slot; another with none
things.get('bike').parts.push({ slot: 'power', thing: 'stone' });
const recipe = {
  id: 'knight',
  name: 'knight',
  how: 'assemble',
  makes: 'knight',
  slots: [
    { id: 'rider', accepts: { all: ['person', 'trained:knight'] } },
    { id: 'armour', accepts: { all: ['armour'] } },
    { id: 'mount', accepts: { all: ['mount'], none: ['broken'] } },
  ],
};
const medieval = { id: 'kaudru', name: 'Kaudru', knowledge: { knight: 'makes', hoverbike: 'uses' }, facilities: ['forge'], prefers: { materials: {}, tags: {} }, builds: { grids: ['radial'], architecture: [], storeys: [1, 3] }, values: {} };

const p = plan(cat, medieval, recipe, ['ann', 'p1', 'bike', 'nag'], ['forge']);
check('a medieval people can make a knight from what it has', p.ok, JSON.stringify(p));
check('the mount slot takes a hoverbike as readily as a horse', p.ok && p.fill.mount[0] === 'bike');

const knightOf = (id, rider, armour, mount) => put({ id, kind: 'knight', parts: [{ slot: 'rider', thing: rider }, { slot: 'armour', thing: armour }, { slot: 'mount', thing: mount }] });
const horseK = derive(cat, knightOf('k1', 'ann', 'p1', 'nag'));
const hoverK = derive(cat, knightOf('k2', 'bess', 'p2', 'bike'));
check("a horse knight moves at the horse's speed, slowed by armour", Math.abs(horseK.stats.speed - 3.6) < 1e-9, JSON.stringify(horseK.stats));
check('a hover knight hovers and charges', hoverK.abilities.includes('hover') && hoverK.abilities.includes('charge') && hoverK.tags.includes('hover-knight'), JSON.stringify(hoverK));
check('a magic stone satisfies the bike\'s power', derive(cat, 'bike').unmet.length === 0 && derive(cat, 'bike').tags.includes('glows'));
const dead = derive(cat, 'bike2');
check('a hoverbike with no power source is unmet and still', dead.unmet.includes('no power source') && dead.stats.speed === 0, JSON.stringify(dead));

const bikeRecipe = { id: 'hoverbike', name: 'hoverbike', how: 'craft', makes: 'hoverbike', slots: [{ id: 'power', accepts: { all: ['power'] } }], needs: { facilities: [{ all: ['foundry'] }] } };
const q = plan(cat, medieval, bikeRecipe, ['stone'], ['forge']);
check("a people that uses hoverbikes can't make one", !q.ok && /doesn't know/.test(q.why), JSON.stringify(q));

// adaptive reuse: the ruined tower gains rooms and a rug, keeps its history
const tower = things.get('tower');
put({ id: 'room1', kind: 'rug' });
things.get('room1').gained = ['room'];
tower.parts.push({ slot: 'room', thing: 'room1' }, { slot: 'fitting', thing: 'rug1' });
tower.history.push({ what: 'adapted', run: 5, by: { faction: 'kaudru' }, note: 'made into apartments' });
const t = derive(cat, 'tower');
check('a ruin with rooms is housing, its age kept', t.tags.includes('housing') && t.tags.includes('ancient') && tower.history.length === 1, JSON.stringify(t.tags));

// diplomacy: memories, rights, a broken deal
const d = new MemoryDiplomacy();
d.run = 2;
d.note({ id: 'i1', run: 1, by: { player: true }, to: { who: 'smith', faction: 'kaudru' }, kind: 'spared', weight: 0.5, halfLife: 3, note: "spared the smith's brother" });
d.note({ id: 'i2', run: 2, by: { player: true }, to: { faction: 'kaudru' }, kind: 'raided', weight: -0.3, halfLife: 2, note: 'burned the granary at Oltmere' });
d.agree({ id: 'a1', kind: 'mineral-rights', parties: [{ faction: 'ash' }, { faction: 'kaudru' }], where: { regions: [7], area: { at: [100, 100], radius: 40 } }, covers: ['copper'], share: 0.6, since: { run: 1 }, status: 'active' });
d.agree({ id: 'a2', kind: 'trade', parties: [{ faction: 'ash' }, { faction: 'kaudru' }], flows: [{ from: 0, to: 1, what: 'copper', perDay: 5 }, { from: 1, to: 0, what: 'grain', perDay: 8 }], since: { run: 1 }, status: 'active' });
const smith = d.opinion({ who: 'smith', faction: 'kaudru' }, { player: true });
check('the smith remembers both, the kindness more', smith.because[0]?.id === 'i1' && smith.because.length === 2, JSON.stringify(smith));
check('mineral rights hold inside their area only', d.rights(7, [110, 100]).length === 1 && d.rights(7, [300, 300]).length === 0);
const before = d.opinion({ faction: 'kaudru' }, { faction: 'ash' }).value;
d.end('a2', { brokenBy: { faction: 'ash' }, note: 'stopped the copper' });
const after = d.opinion({ faction: 'kaudru' }, { faction: 'ash' });
check('breaking a trade deal is remembered and sours them', after.value < before - 0.5 && after.because[0]?.kind === 'broke-word', `${before} → ${after.value}`);
let threw = false;
try { d.agree({ id: 'bad', kind: 'land-rights', parties: [{ faction: 'a' }, { faction: 'b' }], since: { run: 0 }, status: 'active' }); } catch { threw = true; }
check('land rights without a place are refused', threw);

process.exit(failed ? 1 : 0);
