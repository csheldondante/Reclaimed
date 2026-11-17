// (card-table, docs/design/TURN_PUZZLE.md; the owner, 2026-11-17: "More opportunities. Things on the board you can
// assign. Abilities you can activate that make instant changes to strategic resources so optimal play is order
// dependent and involves thinking through which choices and what order.") The base game's works: things in play with
// room for crews and soldiers and with instant uses, the cards that build them, cards that send crews out for a later
// return, and needs with a deadline. Written in the pack format (draft 10) and loaded like any pack, so both front ends
// read it through the same loader. Every number is a first guess, to tune with the bots (scripts/tablebots.mjs).
import type { Pack } from '../packs/check';

export const WORKS: Pack = {
  pack: { id: 'works', name: 'The town at work', version: 1, summary: 'Crews and soldiers to post, uses to make each season, needs with a deadline.', themes: ['works'] },
  tags: [
    { id: 'mine', on: 'site', meaning: 'Ore is dug here by the crews posted on it.' },
    { id: 'stalls', on: 'site', meaning: 'Traders buy and sell here.' },
    { id: 'altar', on: 'site', meaning: 'People pray here; a keeper tends it.' },
    { id: 'foundry', on: 'site', meaning: 'Iron is cast here: tools and arms.' },
    { id: 'muster', on: 'site', meaning: 'The levy gathers here.' },
    { id: 'grain-store', on: 'site', meaning: 'Grain is kept here against hard seasons.' },
    { id: 'watchtower', on: 'site', meaning: 'A soldier on it sees the road a day out.' },
    { id: 'wall-walk', on: 'site', meaning: 'Soldiers on it fight from above the gate.' },
  ],
  start: ['works-mine', 'works-stalls', 'works-shrine'],
  things: [
    {
      id: 'works-mine', name: 'The mine', kind: 'building', at: 'site:pit', tags: ['mine'],
      text: 'Room for 3 crews. Each digs Materials every season.',
      slots: [{ takes: 'crew', n: 3, each_season: { materials: 1 } }],
      uses: [{ id: 'works-dig-deep', name: 'Dig deep', cost: { magic: 1 }, gives: { materials: 1 }, per: 'crew', text: 'Pay 1 Magic: +1 Materials for each crew on the mine now.' }],
    },
    {
      id: 'works-stalls', name: 'Market stalls', kind: 'building', at: 'site:market', tags: ['stalls'],
      text: 'Room for 1 crew, who brings in news every season.',
      slots: [{ takes: 'crew', n: 1, each_season: { intel: 1 } }],
      uses: [
        { id: 'works-sell-stone', name: 'Sell stone', cost: { materials: 2 }, gives: { intel: 2 }, times: 2, text: 'Twice a season: 2 Materials for 2 Intel.' },
        { id: 'works-buy-stone', name: 'Buy stone', cost: { intel: 2 }, gives: { materials: 3 }, text: '2 Intel for 3 Materials.' },
      ],
    },
    {
      id: 'works-shrine', name: 'The shrine', kind: 'building', at: 'site:shrine', tags: ['altar'],
      text: 'Room for 1 crew as its keeper, who brings in Magic every season.',
      slots: [{ takes: 'crew', n: 1, each_season: { magic: 1 } }],
      uses: [
        { id: 'works-pray', name: 'Pray', cost: { materials: 1 }, gives: { magic: 1 }, text: 'An offering of 1 Materials: +1 Magic.' },
        { id: 'works-calm', name: 'Calm the town', cost: { magic: 2 }, gives: { unrest: -1 }, text: '2 Magic: Unrest -1.' },
      ],
    },
    {
      id: 'works-foundry', name: 'The foundry', kind: 'building', at: 'site:forge', tags: ['foundry'],
      text: 'Room for 2 crews. Each casts Materials every season.',
      slots: [{ takes: 'crew', n: 2, each_season: { materials: 1 } }],
      uses: [{ id: 'works-arm', name: 'Arm a recruit', cost: { materials: 2, magic: 1 }, gives: { might: 1 }, text: '2 Materials and 1 Magic: +1 soldier.' }],
    },
    {
      id: 'works-muster', name: 'The muster ground', kind: 'building', at: 'site:keep', tags: ['muster'],
      text: 'Where the levy is called up and sent home.',
      uses: [
        { id: 'works-levy', name: 'Call the levy', gives: { might: 1, unrest: 1 }, text: '+1 soldier, Unrest +1.' },
        { id: 'works-stand-down', name: 'Stand down', cost: { might: 1 }, gives: { labor: 1 }, text: 'A free soldier goes back to work: -1 soldier, +1 crew.' },
      ],
    },
    {
      id: 'works-granary', name: 'The granary', kind: 'building', at: 'site:fields', tags: ['grain-store'],
      text: 'Room for 1 crew, who brings in Materials every season.',
      slots: [{ takes: 'crew', n: 1, each_season: { materials: 1 } }],
      uses: [{ id: 'works-open-granary', name: 'Open the granary', cost: { materials: 2 }, gives: { unrest: -1 }, text: '2 Materials of grain handed out: Unrest -1.' }],
    },
    {
      id: 'works-watchtower', name: 'The watchtower', kind: 'building', at: 'site:watch', tags: ['watchtower'],
      text: 'Room for 1 soldier, who brings in news every season and sees raiders coming.',
      slots: [{ takes: 'soldier', n: 1, each_season: { intel: 1 } }],
    },
    {
      id: 'works-wall-walk', name: 'The wall walk', kind: 'building', at: 'site:wall', tags: ['wall-walk'],
      text: 'Room for 3 soldiers above the gate.',
      slots: [{ takes: 'soldier', n: 3 }],
    },
  ],
  cards: [
    // ---- things to build: crews tied up for the build, the thing in play when it is done ----
    { id: 'works-build-foundry', title: 'Build a foundry', presenter: { role: 'smith', at: 'site:forge' }, pitch: 'Give me crews and stone and I will cast tools and blades.', cost: { labor: 2, materials: 3 }, build_seasons: 2, if_taken: [{ put: 'works-foundry' }, { say: 'The foundry fires are lit.' }], if_expires: [{ say: 'The smith goes back to shoeing horses.' }] },
    { id: 'works-clear-muster', title: 'Clear a muster ground', presenter: { role: 'sergeant', at: 'site:keep' }, pitch: 'A yard where the levy can gather when we need it.', cost: { labor: 1, materials: 1 }, build_seasons: 1, if_taken: [{ put: 'works-muster' }, { say: 'The yard is cleared and marked out.' }], if_expires: [{ say: 'The yard stays a mess of carts.' }] },
    { id: 'works-build-granary', title: 'Build a granary', presenter: { role: 'farmer', at: 'site:fields' }, pitch: 'Grain kept dry is bread in a bad winter.', cost: { labor: 2, materials: 2 }, build_seasons: 2, if_taken: [{ put: 'works-granary' }, { say: 'The granary stands by the east fields.' }], if_expires: [{ say: 'The grain stays in the barns.' }] },
    { id: 'works-raise-watchtower', title: 'Raise a watchtower', presenter: { role: 'watchman', at: 'site:watch' }, pitch: 'From up there a soldier sees the road a day out.', cost: { labor: 1, materials: 2 }, build_seasons: 1, if_taken: [{ put: 'works-watchtower' }, { say: 'The watchtower stands over the road.' }], if_expires: [{ say: 'The watch post stays a hut by the road.' }] },
    { id: 'works-build-wall-walk', title: 'Build a wall walk', presenter: { role: 'mason', at: 'site:wall' }, pitch: 'Planks and stone along the top of the wall, so soldiers can fight from above.', cost: { labor: 2, materials: 3 }, build_seasons: 2, if_taken: [{ put: 'works-wall-walk' }, { say: 'The wall walk is done.' }], if_expires: [{ say: 'The wall stays bare.' }] },
    // ---- crews sent out: tied up now, a return later ----
    { id: 'works-hire-out', title: 'Hire out crews to the neighbours', presenter: { role: 'carter', at: 'site:road' }, pitch: 'The next valley pays well for hands at harvest.', once: false, cost: { labor: 2 }, build_seasons: 2, if_taken: [{ pool: 'materials', add: 4 }, { say: 'The crews come home with their pay.' }], if_expires: [{ say: 'The neighbours hire someone else.' }] },
    { id: 'works-ore-hills', title: 'Send a crew for ore in the hills', presenter: { role: 'prospector', at: 'site:quarry' }, pitch: 'A rich seam up the hill, if someone digs it out before the snow.', once: false, cost: { labor: 1, magic: 1 }, build_seasons: 2, if_taken: [{ pool: 'materials', add: 4 }, { say: 'The crew comes down with sacks of ore.' }], if_expires: [{ say: 'The snow covers the seam.' }] },
    { id: 'works-train', title: 'Train recruits', presenter: { role: 'drillmaster', at: 'site:wagons' }, pitch: 'Give me a crew and some stone for targets and I will give you a soldier.', once: false, cost: { labor: 1, materials: 2 }, build_seasons: 2, if_taken: [{ pool: 'might', add: 1 }, { say: 'The recruit marches back with a spear.' }], if_expires: [{ say: 'The drillmaster leaves for the city.' }] },
    { id: 'works-pilgrims', title: 'Welcome pilgrims', presenter: { role: 'priest', at: 'site:graves' }, pitch: 'Pilgrims pay in prayer and coin if we can tell them the way.', once: false, cost: { intel: 2 }, build_seasons: 1, if_taken: [{ pool: 'magic', add: 2 }, { say: 'The pilgrims leave offerings at the shrine.' }], if_expires: [{ say: 'The pilgrims pass by.' }] },
    { id: 'works-feast', title: 'Hold a feast', presenter: { role: 'innkeeper', at: 'site:mill' }, pitch: 'A full table makes a quiet town.', once: false, cost: { materials: 3 }, build_seasons: 1, if_taken: [{ pool: 'unrest', add: -2 }, { say: 'The town eats well for a night.' }], if_expires: [{ say: 'The tables stay bare.' }] },
    // ---- needs: a stated demand and a deadline ----
    { id: 'works-winter-stores', title: 'Lay in winter stores', presenter: { role: 'reeve', at: 'site:river' }, pitch: 'Winter is coming. Fill the cellars or the town goes hungry.', threat: true, once: false, offer_seasons: 2, weight: 4, appears_when: [{ season_gte: 3 }], cost: { labor: 1, materials: 4 }, build_seasons: 1, if_taken: [{ say: 'The cellars are full.' }], if_expires: [{ pool: 'unrest', add: 2 }, { say: 'The town goes hungry through the winter.' }] },
    { id: 'works-mend-dam', title: 'Mend the old dam', presenter: { role: 'miller', at: 'site:dam' }, pitch: 'The old dam leaks. Mend it before the spring melt or the mill street floods.', threat: true, offer_seasons: 3, weight: 3, appears_when: [{ season_gte: 5 }], cost: { labor: 2, materials: 2 }, build_seasons: 1, if_taken: [{ say: 'The dam holds.' }], if_expires: [{ mutate: 'flooded', where: 'site:mill' }, { say: 'The spring melt breaks the dam.' }] },
    { id: 'works-wardens', title: 'The road wardens want their due', presenter: { role: 'warden', at: 'site:gate' }, pitch: 'Pay the wardens or the carts stop coming.', threat: true, once: false, offer_seasons: 2, weight: 3, appears_when: [{ season_gte: 6 }], cost: { intel: 2, materials: 1 }, build_seasons: 1, if_taken: [{ say: 'The wardens wave the carts through.' }], if_expires: [{ pool: 'unrest', add: 1 }, { pool: 'materials', add: -2 }, { say: 'The carts stop at the border for a season.' }] },
  ],
  rules: [
    { id: 'works-watch-the-road', name: 'Watch on the road', on: { live: 'raid' }, a: { tags: ['watchtower', 'manned'] }, effect: { amount: 'stopped', op: 'add', n: 3 }, per: { posted: 'soldier' }, why: 'the soldier on {a} saw them coming: {n} raiders stopped on the road' },
    { id: 'works-from-the-wall', name: 'From the wall walk', on: { live: 'raid' }, a: { tags: ['wall-walk', 'manned'] }, effect: { amount: 'stopped', op: 'add', n: 1 }, per: { posted: 'soldier' }, why: 'soldiers on {a} fought from above: {n} more raiders stopped' },
  ],
} as unknown as Pack;
