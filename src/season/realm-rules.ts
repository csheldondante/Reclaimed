// (loop-skeleton round 6; docs/SYSTEMS.md recipe 7) The home-town run's tags and its first synergy rules, as data
// (living/rules.ts RuleDef). The owner: "make the tags and synnergies thematically appropriate and then finding them
// and optimizing engines to deal with crises will be fun."
//
// Tags. A site of the town carries what it is (SITE_TAGS `is`), 'standing', and 'worked' once the card that puts
// people to work there is built (`built`). The realm adds states set by play: 'growth-active' (a growth rune this
// season), 'festival' (a parade ended there this season), 'sheltered' (the refugees' camp housed). A site that is
// burned, flooded, buried, melted or abandoned carries only 'ruined' and those words: every rule about what it was
// stops. The home town itself carries 'town', 'home', 'wall' (walls built and the gate not sacked), 'garrison'
// (soldiers gathered), 'unrest'. A far town that trades with you carries 'trade-partner' and 'standing' until it falls.
//
// Every number here is a first guess, to tune (BACKLOG LS-66).
import type { RuleDef } from '../living/rules';
import type { SiteKey } from './realm-templates';

export const SITE_TAGS: Record<SiteKey, { is: string[]; built?: string }> = {
  keep: { is: ['keep'], built: 'keep' },
  forge: { is: ['workshop'], built: 'workshops' },
  quarter: { is: ['homes'], built: 'houses' },
  fields: { is: ['field'], built: 'farms' },
  market: { is: ['market'], built: 'market' },
  gate: { is: ['gate'] },
  tower: { is: ['tower'] },
  dam: { is: ['water', 'dam'] },
  shrine: { is: ['temple'] },
  mill: { is: ['workshop', 'mill'] },
  wall: { is: ['rampart'], built: 'walls' },
  watch: { is: ['gate', 'watch'] },
  harbour: { is: ['water', 'quay'], built: 'harbour' },
  quarry: { is: ['quarry'], built: 'quarry' },
  woods: { is: ['woods'], built: 'lumber' },
  river: { is: ['water', 'river'] },
  road: { is: ['road'], built: 'trade' },
  pit: { is: ['workshop', 'ore'] },
  wagons: { is: ['yard'] },
  graves: { is: ['graves'] },
};

/** conditions that take a thing's working tags away */
export const RUIN = ['burned', 'flooded', 'buried', 'melted', 'abandoned', 'destroyed', 'occupied', 'lost'] as const;
/** states set by play that last to the end of the season they are set in (a tag whose value is the turn it ends) */
export const TIMED = ['growth-active', 'festival'] as const;

/** cells: "next to" for two sites of a town, "passes" for a parade's way, "close" for water to a fire */
const NEXT_TO = 90;
const PASSES = 70;
const CLOSE = 110;

export const RULES: RuleDef[] = [
  {
    // (the owner's example: "double output from the field of growth effect is active". The farms pay 2 Materials a
    // season: the rune pays them again)
    id: 'blessed-fields',
    name: 'Rune-fed fields',
    on: 'turn',
    a: { tags: ['field', 'worked', 'growth-active'] },
    effect: { pool: 'materials', n: 2 },
    cap: 2,
    why: 'the growth rune doubled the crop on {a}: +{n} Materials',
  },
  {
    id: 'temple-procession',
    name: 'Procession past the shrine',
    on: { live: 'parade' },
    a: { tags: ['temple', 'standing'], near: { of: 'route', cells: PASSES } },
    effect: { pool: 'magic', n: 1 },
    per: { amount: 'crowd', each: 6 },
    // (the shrine's capacity: it holds so many at prayer)
    cap: 2,
    why: 'the parade passed {a} and some of the crowd prayed there: +{n} Magic',
  },
  {
    id: 'garrisoned-walls',
    name: 'Garrisoned walls',
    on: { live: 'raid' },
    a: { tags: ['home', 'wall', 'garrison'] },
    effect: { amount: 'stopped', op: 'add', n: 2 },
    why: 'your walls and their garrison stopped {n} raiders at the gate',
  },
  {
    id: 'gate-market',
    name: 'Market by the gate',
    on: 'turn',
    a: { tags: ['market', 'worked'] },
    b: { tags: ['trade-partner', 'standing'] },
    effect: { pool: 'materials', n: 1 },
    per: 'b',
    cap: 3,
    why: 'traders from {count} towns still standing sold at {a}: +{n} Materials',
  },
  {
    id: 'water-by-fire',
    name: 'Water close by',
    on: { live: 'fire' },
    a: { tags: ['water', 'standing'], near: { of: 'event', cells: CLOSE } },
    effect: { amount: 'burned', op: 'mul', n: 0.5 },
    why: '{a} is close: bucket lines saved {n} of the burning lots',
  },
  {
    id: 'sullen-festival',
    name: 'A sullen town',
    on: { live: 'parade' },
    a: { tags: ['home', 'unrest'] },
    effect: { amount: 'crowd', op: 'mul', n: 0.5 },
    why: 'with unrest in the town, {n} fewer people came out for the parade',
  },
  {
    id: 'harvest-home',
    name: 'Harvest home',
    on: { live: 'parade' },
    a: { tags: ['field', 'worked', 'growth-active'] },
    effect: { amount: 'crowd', op: 'add', n: 4 },
    why: 'the rune-fed harvest on {a} brought {n} more people to the parade',
  },
  {
    id: 'tower-watch',
    name: 'Watch from the tower',
    on: { event: 'scouts-seen' },
    a: { tags: ['tower', 'standing'] },
    b: { tags: ['home', 'garrison'] },
    effect: { pool: 'intel', n: 1 },
    why: 'your soldiers on {a} counted the scouts: +{n} Intel',
  },
  {
    id: 'forge-by-keep',
    name: 'Forge by the keep',
    on: { live: 'raid' },
    a: { tags: ['workshop', 'worked'] },
    b: { tags: ['keep', 'worked'], near: { of: 'a', cells: NEXT_TO } },
    effect: { amount: 'stopped', op: 'add', n: 1 },
    why: '{a} stands next to {b}: better blades stopped {n} more raider',
  },
  {
    id: 'camp-hands',
    name: 'Hands from the camp',
    on: 'turn',
    a: { tags: ['camp', 'sheltered'] },
    b: { tags: ['field', 'worked'] },
    effect: { pool: 'materials', n: 1 },
    why: 'refugees from {a} worked {b}: +{n} Materials',
  },
];
