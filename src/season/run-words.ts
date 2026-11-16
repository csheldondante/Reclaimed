// (loop-skeleton; docs/design/LOOP_SKELETON.md) Every line the player reads in the main loop's skeleton, and its
// data: the three leaders, the petitions and their named characters, the threat (docs/WRITING.md: plain words, one idea
// a sentence, concrete numbers). Linted whole as a words module (test/unit/writing-sources.test.ts) and as produced
// (test/unit/run.test.ts). Stand-in screens say so on screen.
import { card } from './catalog';
import type { Pools, SeasonCard } from './ledger';
import type { MutationKind, SignKind } from './mutation';
import type { Effect, Leader, Petition, Place, RunRecord, SpellId, WorldChange } from './run';
import { poolsLine } from './words';

export const LEADERS: readonly Leader[] = [
  {
    id: 'ysolt',
    name: 'Marshal Ysolt',
    line: 'A soldier. She starts with more Might. Captains bring her their plans first.',
    pools: { magic: 1, might: 3, labor: 4, materials: 4, intel: 1, unrest: 0 },
    income: { materials: 2, magic: 1 },
    suit: 'arms',
  },
  {
    id: 'dunstan',
    name: 'Master Dunstan',
    line: 'A builder. He starts with more Labor and Materials. Craftsmen bring him their plans first.',
    pools: { magic: 1, might: 1, labor: 6, materials: 7, intel: 1, unrest: 0 },
    income: { materials: 2, magic: 1 },
    suit: 'build',
  },
  {
    id: 'ilveth',
    name: 'Sister Ilveth',
    line: 'A keeper of the tower. She starts with more Magic and Intel. Scholars bring her their plans first.',
    pools: { magic: 4, might: 1, labor: 4, materials: 4, intel: 3, unrest: 0 },
    income: { materials: 2, magic: 2 },
    suit: 'lore',
  },
];

export const leader = (id: string): Leader => {
  const l = LEADERS.find((x) => x.id === id);
  if (!l) throw new Error(`run: no leader ${id}`);
  return l;
};

/** a town project on a catalog card's work (its district, its walls), with this petition's own small numbers */
const project = (id: string, over: Partial<SeasonCard>): SeasonCard => ({ ...card(id), ...over });

/** raiders in the first threat */
export const RAIDERS = 6;

export const PETITIONS: readonly Petition[] = [
  {
    id: 'raiders',
    suit: 'arms',
    presenter: { name: 'Vessa', role: 'the scout' },
    title: 'Raiders on the east road',
    ask: `I counted ${RAIDERS} raiders camped on the east road. They want tribute. Pay them or get ready to fight.`,
    cost: { spend: { materials: 6 } },
    played: { text: 'The raiders take the tribute and leave.' },
    expires: { text: `${RAIDERS} raiders attack the town.`, raid: RAIDERS },
    seasons: 3,
    threat: {
      helps: 'Soldiers from a barracks fight them. Walls slow them down.',
      brings: { kind: 'burned', where: 'the east district', near: { spot: 'east', size: 0.3 } },
      broke: 'The raiders burn the east district. Its people leave it.',
    },
  },
  {
    id: 'mine',
    suit: 'build',
    first: true,
    presenter: { name: 'Dagna', role: 'the prospector' },
    title: 'Found a mining camp',
    ask: 'There is copper in the Redcap hills, two days north. Give me a crew and timber and I will dig.',
    cost: { project: { id: 'mine', title: 'Found a mining camp', name: 'the mining camp', pitch: 'A camp in the hills that sends ore home.', locks: { labor: 1 }, costs: { materials: 2 }, seasons: 1, work: { kind: 'stub', waits: 'the camp is another place of the world: built by the world mutators' } } },
    played: { text: 'Copper Hollow is founded in the Redcap hills. Its ore wagons come down your road. +1 Materials each season.', mutation: { kind: 'founded', where: 'Copper Hollow', far: { id: 'copper-hollow', name: 'Copper Hollow', owner: 'you', status: 'founded', tribute: { materials: 1 } } } },
    expires: { text: 'Dagna sells her claim to another town. You lose 1 Intel.', pools: { intel: -1 } },
    seasons: 2,
  },
  {
    id: 'relief',
    suit: 'arms',
    first: true,
    presenter: { name: 'Josk', role: 'a rider from Harrowgate' },
    title: 'Send help to Harrowgate',
    ask: 'Raiders ring Harrowgate, three days east. Send soldiers now or the town falls.',
    cost: { spend: { might: 1 } },
    played: { text: 'Your soldiers break the ring. Harrowgate swears to you and pays 1 Materials each season.', mutation: { kind: 'vassal', where: 'Harrowgate', far: { id: 'harrowgate', name: 'Harrowgate', owner: 'free', status: 'vassal', tribute: { materials: 1 } } } },
    expires: { text: 'Harrowgate falls. Raiders hold it now. Its refugees reach your east gate. Unrest +1.', pools: { unrest: 1 }, mutation: { kind: 'captured', where: 'Harrowgate', far: { id: 'harrowgate', name: 'Harrowgate', owner: 'raiders', status: 'captured', tribute: {} } } },
    seasons: 1,
  },
  {
    id: 'refugees',
    suit: 'build',
    when: { place: 'harrowgate', status: 'captured' },
    presenter: { name: 'Ansa', role: 'a refugee from Harrowgate' },
    title: 'House the refugees',
    ask: 'We walked three days from Harrowgate with what we could carry. Give us roofs and we will work for you.',
    cost: { project: project('houses', { title: 'House the refugees', locks: { labor: 2 }, costs: { materials: 2 }, seasons: 2, gives: { labor: 3 }, unrestOnDone: -1 }) },
    played: { text: 'Houses go up for the refugees. +3 Labor and Unrest −1 when built.' },
    expires: { text: 'The refugees camp outside the east gate. Unrest +1.', pools: { unrest: 1 } },
    seasons: 2,
  },
  {
    id: 'toll',
    suit: 'arms',
    when: { place: 'harrowgate', status: 'captured' },
    presenter: { name: 'Gorm', role: 'a raider from Harrowgate' },
    title: 'Pay the Harrowgate toll',
    ask: 'Harrowgate is ours. The east road is ours. Pay the toll and your carts pass.',
    cost: { spend: { materials: 2 } },
    played: { text: 'Your carts pass for now.' },
    expires: { text: 'The raiders stop your carts. You lose 2 Materials. Unrest +1.', pools: { materials: -2, unrest: 1 } },
    seasons: 1,
  },
  {
    id: 'levy',
    suit: 'arms',
    when: { place: 'harrowgate', status: 'vassal' },
    presenter: { name: 'Josk', role: 'a rider from Harrowgate' },
    title: 'Send grain to Harrowgate',
    ask: 'The siege ate our stores. Send grain or my town will not last the winter.',
    cost: { spend: { materials: 2 } },
    played: { text: 'Harrowgate eats this winter. Unrest −1.', pools: { unrest: -1 } },
    expires: { text: 'Harrowgate goes hungry. Its people leave it.', mutation: { kind: 'abandoned', where: 'Harrowgate', far: { id: 'harrowgate', name: 'Harrowgate', owner: 'free', status: 'abandoned', tribute: {} } } },
    seasons: 2,
  },
  {
    id: 'dam',
    suit: 'build',
    presenter: { name: 'Ferrin', role: 'the dam keeper' },
    title: 'Mend the old dam',
    ask: 'The old dam is cracked from top to bottom. Two workers and some stone will hold it.',
    cost: { project: { id: 'dam', title: 'Mend the old dam', name: 'the dam', pitch: 'A mended dam keeps the river out of the lower town.', locks: { labor: 2 }, costs: { materials: 2 }, seasons: 1, work: { kind: 'stub', waits: 'a dam as a place in the town: none yet' } } },
    played: { text: 'The dam is mended. The lower town stays dry.' },
    expires: { text: 'The dam breaks. The lower town floods.', mutation: { kind: 'flooded', where: 'the lower town', near: { spot: 'low', size: 0.3 } } },
    seasons: 1,
  },
  {
    id: 'wards',
    suit: 'lore',
    presenter: { name: 'Kessa', role: 'the fire mage' },
    title: 'Pay for fire wards',
    ask: 'My work gets hot. Pay for wards on the market roofs. I will not ask twice.',
    cost: { spend: { magic: 1 } },
    played: { text: 'Kessa wards the market. Her fire stays in her hearth.' },
    expires: { text: 'Kessa loses hold of her fire. The market burns.', pools: { unrest: 1 }, mutation: { kind: 'burned', where: 'the market', near: { spot: 'centre', size: 0.2 } } },
    seasons: 2,
  },
  {
    id: 'shrine',
    suit: 'lore',
    presenter: { name: 'Brother Ash', role: 'the shrine keeper' },
    title: 'Feed the mountain shrine',
    ask: 'Ash has been falling on the town for days. The mountain will break soon. Send stone and an offering.',
    warns: ['ashfall'],
    cost: { spend: { materials: 2, magic: 1 } },
    played: { text: 'The shrine is fed. The mountain sleeps.' },
    expires: { text: 'The mountain breaks. The quarry road is melted. Ash and darkness hang over the town.', signs: { kinds: ['ashfall', 'darkness'], seasons: 3 }, mutation: { kind: 'melted', where: 'the quarry road', near: { spot: 'north', size: 0.25 } } },
    seasons: 2,
  },
  {
    id: 'slope',
    suit: 'build',
    presenter: { name: 'Hobb', role: 'the miller' },
    title: 'Shore up the hill',
    ask: 'The hill above my mill is slipping. One worker with timber can pin it.',
    cost: { project: { id: 'slope', title: 'Shore up the hill', name: 'the hill props', pitch: 'Timber props hold the hill above the mill.', locks: { labor: 1 }, costs: { materials: 1 }, seasons: 1, work: { kind: 'stub', waits: 'retaining walls as a town work: none yet' } } },
    played: { text: 'The hill is pinned. The mill is safe.' },
    expires: { text: 'The hill slides. The mill street is buried.', mutation: { kind: 'buried', where: 'the mill street', near: { spot: 'west', size: 0.25 } } },
    seasons: 2,
  },
  {
    id: 'barracks',
    suit: 'arms',
    presenter: { name: 'Captain Orrin', role: 'the captain of the guard' },
    title: 'Build a barracks',
    ask: 'My recruits sleep in a barn. Give me a barracks and I will give you soldiers.',
    cost: { project: project('keep', { title: 'Build a barracks', locks: { labor: 2 }, costs: { materials: 3 }, seasons: 2, gives: { might: 2 }, unrestOnDone: 0, needs: [] }) },
    played: { text: 'The barracks goes up. +2 Might when built. Each Might is 3 soldiers.' },
    expires: { text: 'The recruits go home angry. Unrest +1.', pools: { unrest: 1 } },
    seasons: 2,
  },
  {
    id: 'walls',
    suit: 'arms',
    presenter: { name: 'Hale', role: 'the mason' },
    title: 'Build town walls',
    ask: 'Stone walls and gates. Raiders will have to come through a gate.',
    cost: { project: project('walls', { locks: { labor: 2 }, costs: { materials: 3 }, seasons: 3, gives: { might: 1 }, unrestOnStart: 1 }) },
    played: { text: 'The walls rise around the town. +1 Might when built. Unrest +1 now.' },
    expires: { text: 'Hale takes his masons to another town. You lose 1 Materials.', pools: { materials: -1 } },
    seasons: 2,
  },
  {
    id: 'forge',
    suit: 'build',
    presenter: { name: 'Brannoch', role: 'the smith' },
    title: 'Build a forge',
    ask: 'I need a proper forge and three pairs of hands. Then the town gets tools and nails.',
    cost: { project: project('workshops', { title: 'Build a forge', locks: { labor: 3 }, costs: { materials: 3 }, seasons: 2, income: { materials: 2 }, needs: [] }) },
    played: { text: 'The forge goes up. +2 Materials each season when built.' },
    expires: { text: 'Brannoch shuts his shop. Unrest +1.', pools: { unrest: 1 } },
    seasons: 2,
  },
  {
    id: 'homes',
    suit: 'build',
    presenter: { name: 'Maren', role: 'the midwife' },
    title: 'Build houses',
    ask: 'Three families share one roof on my street. Build them homes.',
    cost: { project: project('houses', { locks: { labor: 2 }, costs: { materials: 2 }, seasons: 2, gives: { labor: 2 }, unrestOnDone: 0 }) },
    played: { text: 'New houses go up. +2 Labor when built.' },
    expires: { text: 'The families stay crowded. Unrest +1.', pools: { unrest: 1 } },
    seasons: 2,
  },
  {
    id: 'fields',
    suit: 'build',
    presenter: { name: 'Tobin', role: 'the reeve' },
    title: 'Clear land for farms',
    ask: 'The granary is half empty. Give me one worker and I will plant the east fields.',
    cost: { project: project('farms', { locks: { labor: 1 }, costs: { materials: 1 }, seasons: 2, unrestOnDone: -1 }) },
    played: { text: 'New fields are cleared. Unrest −1 when the crop is in.' },
    expires: { text: 'Bread runs short. Unrest +1.', pools: { unrest: 1 } },
    seasons: 3,
  },
  {
    id: 'tower',
    suit: 'lore',
    presenter: { name: 'Adept Corwen', role: 'the tower scholar' },
    title: 'Light the tower lens',
    ask: 'The old lens in the tower still works. Give me Magic and one worker. You will get a heat ray.',
    cost: { project: { id: 'tower', title: 'Light the tower lens', name: 'the tower lens', pitch: 'A lens that burns what it looks at.', locks: { labor: 1 }, costs: { magic: 1 }, seasons: 1, work: { kind: 'stub', waits: 'a tower with visible levels: no tower place in the town yet' } } },
    played: { text: 'You can cast Heat ray in a fight.', spell: 'heatray' },
    expires: { text: 'Corwen sells the lens. You lose 1 Magic.', pools: { magic: -1 } },
    seasons: 2,
  },
  {
    id: 'archive',
    suit: 'lore',
    presenter: { name: 'Old Pell', role: 'the archivist' },
    title: 'Send scouts to the old road',
    ask: 'The maps of the east road are wrong. Send a rider and I will mark every ford.',
    cost: { spend: { intel: 1 } },
    played: { text: 'The maps are fixed. +2 Materials from a lost cart the rider found.', pools: { materials: 2 } },
    expires: { text: 'A trader gets lost on the east road. You lose 1 Materials.', pools: { materials: -1 } },
    seasons: 2,
  },
];

export const SPELL_NAME: Record<SpellId, string> = { heatray: 'Heat ray', telekinesis: 'Telekinesis' };
export const SPELL_LATER: Partial<Record<SpellId, string>> = { telekinesis: 'Telekinesis arrives with the new physics.' };
export const SPELL_NONE = 'You have no spells. Some projects give you one.';
export const SPELL_AIM = 'Tap the ground to cast it.';
export const SPELL_STANDIN = 'Stand-in. Heat ray shows as a lightning strike for now.';
export const RUNE_LATER = 'Later you will draw a rune to cast. For now, tap the spell.';

export const PICK_TITLE = 'Pick a leader';
export const PICK_SUB = 'Each leader starts with different pools. Each hears from different people first.';
export const PICK_BUTTON = 'Lead the town';
export const PORTRAIT = 'Portrait to come';
export const WORLD_KEPT = 'This world remembers your earlier runs.';

export const ASKS_TITLE = 'People are asking for you';
export const TAP_MARKER = 'Tap a name on the map to hear them out.';
export const PLAY = 'Agree';
export const LEAVE = 'Not now';
export const BACK = 'Back to the town';
export const COST = 'Cost';
export const IF_PLAYED = 'If you agree';
export const IF_EXPIRES = 'If you wait too long';
export const HELPS = 'What helps';
export const NEXT = 'Next season';
export const SKIP = 'Skip';
export const BUILDING = 'The season passes. The town builds.';
export const ATTACK_TITLE = 'The raiders attack';
export const ATTACK_WAIT = 'The raiders are on their way.';
export const RESULT_HELD = 'The town held';
export const RESULT_BROKEN = 'The raiders broke through';
export const CONTINUE = 'Continue';
export const WORLD_CHANGES = 'The world changes';
export const END_TITLE = 'The run is over';
export const END_LIST = 'What changed in the world';
export const END_NONE = 'Nothing changed in the world this run.';
export const END_BEFORE = 'From earlier runs';
export const NEW_RUN = 'Start a new run in this world';

export const leaderTitle = (name: string, season: number, run: number): string => `${name} · Season ${season} · Run ${run}`;

export const presenterLine = (p: Petition): string => `${p.presenter.name}, ${p.presenter.role}`;

/** the marker over the town: the character's name */
export const markerLabel = (p: Petition): string => p.presenter.name;

const seasons = (n: number): string => (n === 1 ? '1 season' : `${n} seasons`);

/** the cost in the fixed format: what is locked and for how long, what is spent */
export function costText(p: Petition): string {
  if ('spend' in p.cost) return `Spend ${poolsLine(p.cost.spend)}.`;
  const c = p.cost.project;
  const out: string[] = [];
  const locks = poolsLine(c.locks);
  if (locks) out.push(`Lock ${locks} for ${seasons(c.seasons)}.`);
  const costs = poolsLine(c.costs);
  if (costs) out.push(`Spend ${costs}.`);
  return out.join(' ');
}

export const shortText = (miss: Partial<Pools>): string => `You need ${poolsLine(miss)} more.`;

/** the countdown on a card: "Asks for 2 more seasons." and a threat's "Raiders come in 3 seasons." */
export function leftText(p: Petition, left: number): string {
  if (p.expires.raid) return left === 1 ? 'They come next season.' : `They come in ${left} seasons.`;
  return left === 1 ? 'This is the last season to agree.' : `The offer stands for ${seasons(left)}.`;
}

export const playedLine = (p: Petition): string => `You agreed with ${p.presenter.name}. ${p.played.text}`;
export const expiredLine = (p: Petition, e: Effect): string => `You did not answer ${p.presenter.name}. ${e.text}`;

export function attackLine(n: number, alive: number, soldiers: number, stage: 'coming' | 'there' | 'fighting'): string {
  const mine = soldiers === 0 ? 'You have no soldiers.' : soldiers === 1 ? '1 soldier stands ready.' : `${soldiers} soldiers stand ready.`;
  if (alive === 0) return `All ${n} raiders are dead.`;
  if (stage === 'fighting') return `Your soldiers are fighting. ${alive} of ${n} raiders are left.`;
  if (stage === 'there') return `The raiders are in the town. ${alive} of ${n} are left. ${mine}`;
  return `${alive} raiders are marching on the town. ${mine}`;
}

export function resultLines(f: NonNullable<RunRecord['fight']>, lost: { might: number; materials: number; unrest: number }): string[] {
  const out: string[] = [];
  if (f.raiders === 0) out.push('No raider reached the town.');
  else out.push(f.left ? `${f.left} of ${f.raiders} raiders got into the town.` : `All ${f.raiders} raiders are dead.`);
  out.push(f.fallen === 0 ? 'You lost no soldiers.' : f.fallen === 1 ? '1 soldier died.' : `${f.fallen} soldiers died.`);
  if (lost.might) out.push(`You lost ${lost.might} Might.`);
  if (lost.materials) out.push(`They took ${lost.materials} Materials.`);
  if (lost.unrest) out.push(`Unrest +${lost.unrest}.`);
  return out;
}

export const KIND_NAME: Record<MutationKind, string> = { flooded: 'Flooded', burned: 'Burned', melted: 'Melted', buried: 'Buried', abandoned: 'Abandoned', founded: 'Founded', destroyed: 'Destroyed', captured: 'Captured', vassal: 'Your vassal' };

/** a world change in the list: what happened, and where */
export const changeLine = (c: WorldChange): string => `${c.text} ${KIND_NAME[c.kind]}. ${cap(c.where)}${c.near ? `, ${c.near.town}` : ''}.`;
export const NEAR = 'In your town';
export const FAR = 'Far away';
export const SHOW = 'Show';
export const BACK_LIST = 'Back to the list';
export const FAR_MAP_LATER = 'Stand-in. Far places will show on the world map. That view is not wired yet.';
export const FAR_CHANGE = 'News from far away';
/** tribute this season: "Tribute came in. +2 Materials." */
export const tributeLine = (t: Partial<Pools>): string => `Tribute came in. ${poolsLine(t, true)}.`;
/** a place of the world, for the list of places */
export const placeLine = (p: Place): string => {
  const pays = poolsLine(p.tribute, true);
  return `${p.name}. ${KIND_NAME[p.status]}.${pays ? ` Pays you ${pays} each season.` : ''}`;
};
export const SIGN_NAME: Record<SignKind, string> = { ashfall: 'Ash is falling', darkness: 'The sky is dark', undead: 'The dead walk the streets', crime: 'Thieves work the streets' };
export const STANDIN_SIGNS = 'Stand-in. These signs will be seen in the town itself.';
export const PLACES_TITLE = 'Places of the world';
export const seasonLabel = (n: number): string => `Season ${n}`;
export const CHOICES_TITLE = 'Your choices and what they caused';
/** what far places bring home this season, as seen in the town */
export const homeLines = (h: { people: number; wagons: number }): string[] => [
  ...(h.people ? [`${h.people} refugees are living in your streets.`] : []),
  ...(h.wagons ? [`${h.wagons} ore wagons are on your road.`] : []),
];
export const STANDIN_HOME = 'Stand-in. Refugees show as more people in the streets, not a column on the road.';
/** the tag over the map where a change happened */
export const changeTag = (c: WorldChange): string => KIND_NAME[c.kind];
/** what a threat brings if you are not ready */
export const bringsLine = (p: Petition): string => (p.threat ? `If they break through, ${p.threat.brings.where} is ${KIND_NAME[p.threat.brings.kind].toLowerCase()}.` : '');
export const STANDIN_MUTATION = 'Stand-in. The real look of this change comes with the world mutators.';
const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

export const runLine = (n: number): string => (n === 1 ? 'This was the first run in this world.' : `This was run ${n} in this world.`);
