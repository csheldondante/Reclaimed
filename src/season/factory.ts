// (card-table, docs/design/FACTORY.md; the owner, 2026-11-17: "I want the locations that I build to work as a factory
// economy where buildings produce, consume and transform resources. However, I want to click the buildings to perform
// the conversions each season. Then I want to have the cards have specific requirements for pawns or resources that
// they need so that I have to build engines to produce the resources required by those cards.")
// The factory game as a pack (draft 11), loaded like any pack: buildings with crews and recipes (each posted crew is
// one click a season), the houses that eat bread, cards that ask for exact goods and pieces by a deadline, and the
// engines that make chains worth building. Every number is a first guess, tuned with the bots
// (`node scripts/tablebots.mjs --factory --measure`).
import type { Pack } from '../packs/check';

/** each posted crew's clicks a season (the lever if the turn's choices explode: docs/design/FACTORY.md §6) */
export const CLICKS_PER_CREW = 1;

const crewSlot = (n: number) => [{ takes: 'crew', n }];

export function factoryPack(cpc = CLICKS_PER_CREW): Pack {
  const c = cpc;
  return {
    pack: { id: 'factory', name: 'The town as a factory', version: 1, summary: 'Buildings that make, eat and turn goods into other goods, a click at a time; cards that ask for exact goods by a deadline.', themes: ['factory'] },
    tags: [
      { id: 'woodcutters', on: 'site', meaning: 'Trees are felled here.' },
      { id: 'farm', on: 'site', meaning: 'Grain is grown here.' },
      { id: 'bakery', on: 'site', meaning: 'Grain is baked into bread here.' },
      { id: 'houses', on: 'site', meaning: 'The crews live here and eat bread.' },
      { id: 'stone-cut', on: 'site', meaning: 'Stone is cut here.' },
      { id: 'sawmill', on: 'site', meaning: 'Wood is sawn into planks here.' },
      { id: 'mine', on: 'site', meaning: 'Ore is dug here.' },
      { id: 'smelter', on: 'site', meaning: 'Ore is smelted into iron here.' },
      { id: 'smithy', on: 'site', meaning: 'Iron is forged into tools and weapons here.' },
      { id: 'apprentice', on: 'site', meaning: 'An apprentice works the forge.' },
      { id: 'muster', on: 'site', meaning: 'Recruits are armed here.' },
      { id: 'builders-yard', on: 'site', meaning: 'Planks and stone are made ready for building here.' },
      { id: 'stalls', on: 'site', meaning: 'Traders buy and sell here.' },
      { id: 'altar', on: 'site', meaning: 'People pray here.' },
      { id: 'watchtower', on: 'site', meaning: 'A soldier on it sees the road a day out.' },
      { id: 'town-wall', on: 'site', meaning: 'A stone wall round the town, with a walk for soldiers.' },
    ],
    stock: { wood: 4, grain: 4, bread: 6, labor: 1 },
    start: ['factory-woodcutters', 'factory-fields', 'factory-bakery', 'factory-houses'],
    things: [
      { id: 'factory-woodcutters', name: 'The woodcutters', kind: 'building', at: 'site:woods', tags: ['woodcutters'], text: 'Room for 2 crews. Each crew is one click a season.', slots: crewSlot(2), clicks_per_crew: c, uses: [{ id: 'factory-fell', name: 'Fell trees', gives: { wood: 3 }, text: 'Fell trees: 3 wood.' }] },
      {
        id: 'factory-fields', name: 'The fields', kind: 'building', at: 'site:fields', tags: ['farm'], text: 'Room for 2 crews. Each crew is one click a season.', slots: crewSlot(2), clicks_per_crew: c,
        uses: [
          { id: 'factory-harvest', name: 'Harvest', gives: { grain: 3 }, text: 'Harvest: 3 grain.' },
          { id: 'factory-harvest-tools', name: 'Harvest with tools', cost: { tools: 1 }, gives: { grain: 5 }, text: '1 tools: 5 grain.' },
        ],
      },
      { id: 'factory-bakery', name: 'The bakery', kind: 'building', at: 'site:mill', tags: ['bakery'], text: 'Room for 1 crew, one click a season.', slots: crewSlot(1), clicks_per_crew: c, uses: [{ id: 'factory-bake', name: 'Bake', cost: { grain: 2 }, gives: { bread: 4 }, text: '2 grain: 4 bread.' }] },
      { id: 'factory-ovens', name: 'The big bakery', kind: 'building', at: 'site:mill', tags: ['bakery'], text: 'Room for 2 crews. Each crew is one click a season.', slots: crewSlot(2), clicks_per_crew: c, uses: [{ id: 'factory-bake-big', name: 'Bake', cost: { grain: 2 }, gives: { bread: 6 }, text: '2 grain: 6 bread.' }] },
      {
        id: 'factory-houses', name: 'The houses', kind: 'building', at: 'site:quarter', tags: ['houses'], text: 'The crews eat 1 bread for every 3 of them each season. Short of bread: Unrest +1.', eats: { bread: 1 }, eats_per: 3, if_hungry: { unrest: 1 },
        uses: [
          { id: 'factory-feast', name: 'Hold a feast', cost: { bread: 4 }, gives: { unrest: -1 }, text: '4 bread: Unrest -1. Once a season.' },
          { id: 'factory-calm', name: 'Calm the town', cost: { magic: 2 }, gives: { unrest: -1 }, text: '2 Magic: Unrest -1. Once a season.' },
        ],
      },
      { id: 'factory-quarry', name: 'The quarry', kind: 'building', at: 'site:quarry', tags: ['stone-cut'], text: 'Room for 2 crews. Each crew is one click a season.', slots: crewSlot(2), clicks_per_crew: c, uses: [{ id: 'factory-cut', name: 'Cut stone', gives: { stone: 2 }, text: 'Cut stone: 2 stone.' }] },
      { id: 'factory-sawmill', name: 'The sawmill', kind: 'building', at: 'site:river', tags: ['sawmill'], text: 'Room for 1 crew, one click a season.', slots: crewSlot(1), clicks_per_crew: c, uses: [{ id: 'factory-saw', name: 'Saw planks', cost: { wood: 2 }, gives: { planks: 3 }, text: '2 wood: 3 planks.' }] },
      {
        id: 'factory-mine', name: 'The mine', kind: 'building', at: 'site:pit', tags: ['mine'], text: 'Room for 2 crews. Each crew is one click a season.', slots: crewSlot(2), clicks_per_crew: c,
        uses: [
          { id: 'factory-dig', name: 'Dig', gives: { ore: 1 }, text: 'Dig: 1 ore.' },
          { id: 'factory-dig-tools', name: 'Dig with tools', cost: { tools: 1 }, gives: { ore: 3 }, text: '1 tools: 3 ore.' },
        ],
      },
      {
        id: 'factory-deep-mine', name: 'The deep mine', kind: 'building', at: 'site:pit', tags: ['mine'], text: 'Room for 3 crews. Each crew is one click a season.', slots: crewSlot(3), clicks_per_crew: c,
        uses: [
          { id: 'factory-dig-deep', name: 'Dig', gives: { ore: 2 }, text: 'Dig: 2 ore.' },
          { id: 'factory-dig-deep-tools', name: 'Dig with tools', cost: { tools: 1 }, gives: { ore: 4 }, text: '1 tools: 4 ore.' },
        ],
      },
      { id: 'factory-smelter', name: 'The smelter', kind: 'building', at: 'site:wagons', tags: ['smelter'], text: 'Room for 1 crew, one click a season.', slots: crewSlot(1), clicks_per_crew: c, uses: [{ id: 'factory-smelt', name: 'Smelt', cost: { ore: 2, wood: 1 }, gives: { iron: 1 }, text: '2 ore and 1 wood: 1 iron.' }] },
      {
        id: 'factory-smithy', name: 'The smithy', kind: 'building', at: 'site:forge', tags: ['smithy'], text: 'Room for 1 crew, one click a season: tools or weapons.', slots: crewSlot(1), clicks_per_crew: c,
        uses: [
          { id: 'factory-forge-tools', name: 'Forge tools', cost: { iron: 1 }, gives: { tools: 2 }, text: '1 iron: 2 tools.' },
          { id: 'factory-forge-weapons', name: 'Forge weapons', cost: { iron: 1, planks: 1 }, gives: { weapons: 1 }, text: '1 iron and 1 planks: 1 weapons.' },
        ],
      },
      { id: 'factory-apprentice', name: 'The apprentice', kind: 'people', at: 'site:forge', tags: ['apprentice'], text: 'The first tools forged each season give the iron back.' },
      { id: 'factory-muster', name: 'The muster ground', kind: 'building', at: 'site:keep', tags: ['muster'], text: 'A free crew and a weapon make a soldier, twice a season.', uses: [{ id: 'factory-arm', name: 'Arm a recruit', cost: { labor: 1, weapons: 1 }, gives: { might: 1 }, times: 2, text: '1 free crew and 1 weapons: 1 soldier. Twice a season.' }] },
      { id: 'factory-yard', name: "The builder's yard", kind: 'building', at: 'site:harbour', tags: ['builders-yard'], text: 'Room for 1 crew, one click a season.', slots: crewSlot(1), clicks_per_crew: c, uses: [{ id: 'factory-bundle', name: 'Make building stock', cost: { planks: 1, stone: 1 }, gives: { materials: 3 }, text: '1 planks and 1 stone: 3 Materials.' }] },
      {
        id: 'factory-stalls', name: 'The market stalls', kind: 'building', at: 'site:market', tags: ['stalls'], text: 'Room for 1 crew, one click a season.', slots: crewSlot(1), clicks_per_crew: c,
        uses: [
          { id: 'factory-buy-iron', name: 'Buy iron', cost: { wood: 4 }, gives: { iron: 1 }, text: '4 wood: 1 iron.' },
          { id: 'factory-buy-stone', name: 'Buy stone', cost: { bread: 3 }, gives: { stone: 2 }, text: '3 bread: 2 stone.' },
        ],
      },
      { id: 'factory-shrine', name: 'The shrine', kind: 'building', at: 'site:shrine', tags: ['altar'], text: 'Room for 1 crew, one click a season.', slots: crewSlot(1), clicks_per_crew: c, uses: [{ id: 'factory-pray', name: 'Pray', cost: { bread: 2 }, gives: { magic: 1 }, text: '2 bread: 1 Magic.' }] },
      { id: 'factory-watchtower', name: 'The watchtower', kind: 'building', at: 'site:watch', tags: ['watchtower'], text: 'Room for 1 soldier, who stops raiders on the road (3 a soldier).', capacity: 3, slots: [{ takes: 'soldier', n: 1 }] },
      { id: 'factory-wall', name: 'The town wall', kind: 'building', at: 'site:wall', tags: ['town-wall'], text: 'Stops raiders at the gate. Room for 3 soldiers on the walk: each stops one more.', slots: [{ takes: 'soldier', n: 3 }] },
    ],
    cards: [
      // ---- buildings: the town changes from season 1 ----
      { id: 'factory-open-quarry', title: 'Open the quarry', presenter: { role: 'quarryman', at: 'site:quarry' }, pitch: 'There is good stone in that hill. Give me wood for props and a crew.', weight: 5, cost: { wood: 2, labor: 1 }, build_seasons: 1, if_taken: [{ put: 'factory-quarry' }, { say: 'The quarry is open.' }], if_expires: [{ say: 'The hill stays as it is.' }] },
      { id: 'factory-build-sawmill', title: 'Build a sawmill', presenter: { role: 'carpenter', at: 'site:river' }, pitch: 'A wheel on the river and a saw. Planks for everything.', weight: 5, cost: { wood: 3, labor: 1 }, build_seasons: 1, if_taken: [{ put: 'factory-sawmill' }, { say: 'The saw runs by the river.' }], if_expires: [{ say: 'The carpenter saws by hand.' }] },
      { id: 'factory-sink-mine', title: 'Sink a mine', presenter: { role: 'prospector', at: 'site:pit' }, pitch: 'Ore under the yard. Planks for the shaft, wood for the props.', weight: 4, cost: { planks: 2, wood: 2, labor: 1 }, build_seasons: 1, if_taken: [{ put: 'factory-mine' }, { say: 'The mine is dug.' }], if_expires: [{ say: 'The prospector moves on.' }] },
      { id: 'factory-build-smelter', title: 'Build a smelter', presenter: { role: 'smelter', at: 'site:wagons' }, pitch: 'A stone furnace in the wagon yard, where the ore carts stop.', weight: 3, cost: { stone: 4, labor: 1 }, build_seasons: 1, if_taken: [{ put: 'factory-smelter' }, { say: 'The furnace is lit.' }], if_expires: [{ say: 'The ore stays in the ground.' }] },
      { id: 'factory-build-smithy', title: 'Build a smithy', presenter: { role: 'smith', at: 'site:forge' }, pitch: 'Stone for the hearth, planks for the roof, and I will forge tools and blades.', weight: 3, cost: { stone: 3, planks: 2, labor: 1 }, build_seasons: 2, if_taken: [{ put: 'factory-smithy' }, { say: 'The smithy rings.' }], if_expires: [{ say: 'The smith shoes horses instead.' }] },
      { id: 'factory-clear-muster', title: 'Clear a muster ground', presenter: { role: 'sergeant', at: 'site:keep' }, pitch: 'A fenced yard where a crew with a blade becomes a soldier.', weight: 3, cost: { planks: 2, labor: 1 }, build_seasons: 1, if_taken: [{ put: 'factory-muster' }, { say: 'The muster ground is fenced.' }], if_expires: [{ say: 'The yard stays full of carts.' }] },
      { id: 'factory-builders-yard', title: "Set up a builder's yard", presenter: { role: 'builder', at: 'site:harbour' }, pitch: 'Planks and stone made ready, for anyone who asks for building stock.', weight: 2, cost: { planks: 2, labor: 1 }, build_seasons: 1, if_taken: [{ put: 'factory-yard' }, { say: 'The yard is stacked and ready.' }], if_expires: [{ say: 'The builders go home.' }] },
      { id: 'factory-put-up-stalls', title: 'Put up market stalls', presenter: { role: 'trader', at: 'site:market' }, pitch: 'Bring me what you have too much of. I will find what you lack.', weight: 2, cost: { planks: 3, labor: 1 }, build_seasons: 1, if_taken: [{ put: 'factory-stalls' }, { say: 'The stalls go up round the square.' }], if_expires: [{ say: 'The traders set up in the next town.' }] },
      { id: 'factory-raise-watchtower', title: 'Raise a watchtower', presenter: { role: 'watchman', at: 'site:watch' }, pitch: 'From up there a soldier sees the road a day out.', weight: 2, appears_when: [{ season_gte: 3 }], cost: { planks: 3, stone: 2, labor: 1 }, build_seasons: 1, if_taken: [{ put: 'factory-watchtower' }, { say: 'The watchtower stands over the road.' }], if_expires: [{ say: 'The watch post stays a hut by the road.' }] },
      { id: 'factory-raise-wall', title: 'Raise the town wall', presenter: { role: 'mason', at: 'site:wall' }, pitch: 'A stone wall round the town, and a walk on top for soldiers.', weight: 3, appears_when: [{ season_gte: 4 }], cost: { stone: 8, planks: 3, labor: 2 }, build_seasons: 2, if_taken: [{ put: 'factory-wall' }, { say: 'The wall closes round the town.' }], if_expires: [{ say: 'The town stays open to the road.' }] },
      { id: 'factory-build-shrine', title: 'Build a shrine', presenter: { role: 'priest', at: 'site:shrine' }, pitch: 'Stone for an altar and bread for the first offering.', weight: 2, appears_when: [{ season_gte: 3 }], cost: { stone: 2, bread: 2, labor: 1 }, build_seasons: 1, if_taken: [{ put: 'factory-shrine' }, { say: 'The shrine is raised.' }], if_expires: [{ say: 'People pray at home.' }] },
      // ---- engines: upgrades that make chains worth building ----
      { id: 'factory-second-shaft', title: 'Sink a second shaft', presenter: { role: 'foreman', at: 'site:pit' }, pitch: 'A second shaft: room for one more crew, and twice the ore a dig.', weight: 3, appears_when: [{ has_thing: 'factory-mine' }], cost: { planks: 4, iron: 2, labor: 1 }, build_seasons: 1, if_taken: [{ remove: 'factory-mine' }, { put: 'factory-deep-mine' }, { say: 'The second shaft is open.' }], if_expires: [{ say: 'The old shaft will do.' }] },
      { id: 'factory-build-ovens', title: 'Build bread ovens', presenter: { role: 'baker', at: 'site:mill' }, pitch: 'Stone ovens and an iron door: room for a second crew, and more bread a bake.', weight: 3, appears_when: [{ season_gte: 3 }], cost: { stone: 3, iron: 1, labor: 1 }, build_seasons: 1, if_taken: [{ remove: 'factory-bakery' }, { put: 'factory-ovens' }, { say: 'The new ovens are hot.' }], if_expires: [{ say: 'The baker keeps the old oven.' }] },
      { id: 'factory-take-apprentice', title: 'Take on an apprentice', presenter: { role: 'smith', at: 'site:forge' }, pitch: 'Pay the lad in tools and bread, and he saves me iron.', weight: 3, appears_when: [{ has_thing: 'factory-smithy' }], cost: { tools: 2, bread: 2 }, build_seasons: 1, if_taken: [{ put: 'factory-apprentice' }, { say: 'The apprentice starts at the bellows.' }], if_expires: [{ say: 'The lad goes to the city.' }] },
      { id: 'factory-cottages', title: 'Build cottages', presenter: { role: 'reeve', at: 'site:quarter' }, pitch: 'Planks for a cottage and bread to welcome a family: one more crew.', once: false, weight: 3, appears_when: [{ season_gte: 2 }], cost: { planks: 3, bread: 2, labor: 1 }, build_seasons: 1, if_taken: [{ pool: 'labor', add: 1 }, { say: 'A new family moves in.' }], if_expires: [{ say: 'The family settles elsewhere.' }] },
      { id: 'factory-hire-out', title: 'Hire out a crew', presenter: { role: 'carter', at: 'site:road' }, pitch: 'The next valley pays in iron for hands at harvest.', once: false, weight: 2, cost: { labor: 1 }, build_seasons: 2, if_taken: [{ pool: 'iron', add: 2 }, { say: 'The crew comes home with iron.' }], if_expires: [{ say: 'The next valley hires someone else.' }] },
      { id: 'factory-miners-tools', title: 'Tools for the miners', presenter: { role: 'miner', at: 'site:tower' }, pitch: 'The hill miners will send ore every season for good tools.', weight: 3, appears_when: [{ season_gte: 5 }], offer_seasons: 3, cost: { tools: 4 }, build_seasons: 1, if_taken: [{ income: 'ore', add: 2 }, { say: 'Ore carts come down from the hills.' }], if_expires: [{ say: 'The miners trade with someone else.' }] },
      // ---- needs: exact goods and pieces, a deadline ----
      { id: 'factory-send-bread', title: 'Send bread to the next valley', presenter: { role: 'messenger', at: 'site:fields' }, pitch: 'The next valley is starving. Bread and a crew to carry it.', threat: true, weight: 4, appears_when: [{ season_gte: 2 }], offer_seasons: 3, cost: { bread: 4, labor: 1 }, build_seasons: 2, if_taken: [{ pool: 'unrest', add: -1 }, { pool: 'intel', add: 2 }, { say: 'The valley sends thanks and news.' }], if_expires: [{ pool: 'unrest', add: 2 }, { say: 'The valley starves. People here are angry.' }] },
      { id: 'factory-winter-stores', title: 'Lay in winter stores', presenter: { role: 'reeve', at: 'site:river' }, pitch: 'Bread and firewood in the cellars before the snow.', threat: true, once: false, weight: 4, appears_when: [{ season_gte: 4 }], offer_seasons: 2, cost: { bread: 6, wood: 2 }, build_seasons: 1, if_taken: [{ say: 'The cellars are full.' }], if_expires: [{ pool: 'unrest', add: 2 }, { say: 'The town goes cold and hungry through the winter.' }] },
      { id: 'factory-arm-watch', title: 'Arm the watch', presenter: { role: 'captain', at: 'site:gate' }, pitch: 'Thieves on the roads. Blades for the watch and soldiers to walk with them.', threat: true, weight: 4, appears_when: [{ season_gte: 4 }], offer_seasons: 3, cost: { weapons: 3, might: 2 }, build_seasons: 1, if_taken: [{ pool: 'unrest', add: -1 }, { pool: 'intel', add: 2 }, { say: 'The roads are safe again.' }], if_expires: [{ pool: 'unrest', add: 1 }, { pool: 'bread', add: -3 }, { say: 'Thieves raid the bakery.' }] },
      { id: 'factory-mend-dam', title: 'Mend the old dam', presenter: { role: 'miller', at: 'site:dam' }, pitch: 'The dam leaks. Stone, planks and two crews before the spring melt, or the mill street floods.', threat: true, weight: 3, appears_when: [{ season_gte: 5 }], offer_seasons: 3, cost: { stone: 4, planks: 2, labor: 2 }, build_seasons: 1, if_taken: [{ say: 'The dam holds.' }], if_expires: [{ mutate: 'flooded', where: 'site:mill' }, { say: 'The spring melt breaks the dam. The mill street floods.' }] },
      { id: 'factory-wardens', title: 'The road wardens want their due', presenter: { role: 'warden', at: 'site:watch' }, pitch: 'Building stock for the toll house, or the carts stop.', threat: true, once: false, weight: 3, appears_when: [{ season_gte: 7 }], offer_seasons: 2, cost: { materials: 4 }, build_seasons: 1, if_taken: [{ say: 'The wardens wave the carts through.' }], if_expires: [{ pool: 'unrest', add: 1 }, { pool: 'iron', add: -2 }, { say: 'The carts stop at the border.' }] },
    ],
    rules: [
      { id: 'factory-watch-the-road', name: 'Watch on the road', on: { live: 'raid' }, a: { tags: ['watchtower', 'manned'] }, effect: { amount: 'stopped', op: 'add', n: 3 }, per: { posted: 'soldier' }, why: 'the soldier on {a} saw them coming: {n} raiders stopped on the road' },
      { id: 'factory-the-wall', name: 'The town wall', on: { live: 'raid' }, a: { tags: ['town-wall'] }, effect: { amount: 'stopped', op: 'add', n: 4 }, why: '{a} stopped {n} raiders at the gate' },
      { id: 'factory-from-the-wall', name: 'From the wall walk', on: { live: 'raid' }, a: { tags: ['town-wall', 'manned'] }, effect: { amount: 'stopped', op: 'add', n: 1 }, per: { posted: 'soldier' }, why: 'soldiers on {a} fought from above: {n} more raiders stopped' },
      { id: 'factory-apprentice-saves', name: 'The apprentice', on: { event: 'used:factory-forge-tools' }, a: { tags: ['apprentice'] }, effect: { pool: 'iron', n: 1 }, perSeason: 1, why: 'the apprentice saved the iron: +{n} iron' },
    ],
  } as unknown as Pack;
}

export const FACTORY: Pack = factoryPack();
