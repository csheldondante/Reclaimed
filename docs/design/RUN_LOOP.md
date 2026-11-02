# The run loop: one kind of opportunity on the strategic map (design, revision 4)

The design for the run loop (BACKLOG RN2, with RN1, LW3, LW4, LW5). Revisions 1-3 were drafts on branch `runloop`
(f779c9c). Revision 4 is on branch `opportunities`, where slice A is being built (§7 A; ARCHITECTURE "Opportunities").

**Revision 4** folds in the user's answers to revision 3's three questions (DECISIONS round 120, the newest entry,
verbatim there). Where this list and the rest of the document differ, this list wins:

- **cards are internal only.** "Even if we use cards behind the scenes the game should show them as events or
  opportunities on the map not as a hand." There is no hand on the screen. What revision 3 calls the two hands are now
  two *deals*: the opportunities currently offered, drawn as markers on the atlas map at their locations (player
  opportunities and resource opportunities in different colours). Tapping a marker shows what it needs, what it costs,
  how long it takes, its odds and its consequences, with a Commit button. Ongoing commitments are drawn on the map with
  the turns they have left;
- **one option a turn is allowed.** "The player may only have one option a turn depending on what makes sense." The
  guarantee "at least two player cards" (§5.1) is gone. The guarantee now reads: there is always a way toward the
  climax. A forced opportunity (the outriders, the night assault) is dealt alone. A ruler may get only building, an
  answer to an attack, or a ride out and back that costs turns;
- **the dealer** filters to what makes sense and deals **the most expensive cards you can afford** (the largest
  requirement tier the holdings meet). "Part of the challenge here is designing a mechanical way to filter these and
  deal just the ones that make sense";
- **persistence.** Tags and bonuses stay with named characters into later runs, through `CharacterRecord` (`tags`,
  `bonuses`): "Yes I think that we want them to persist";
- **the dealer is tuned by iteration.** "I think we will need to tune the dealer and learn what is fun for play via
  iteration." Every weight and limit is a slider in a tuning panel (`dealer`), and a debug overlay lists what was dealt
  and why, and what was rejected and why;
- **hand sizes** (revision 3's question 1) become deal limits, per kind of opportunity, as sliders. They are limits,
  not targets: the dealer may deal fewer;
- the run starts behind `?run=opps` (the old situation flow stays behind `?runplan=` until this replaces it).

Stale in revision 3, kept below for the record: "two hands", "hand sizes are small and fixed (3 + 4)", "the player hand
always has at least two cards", `StrategicMap.hand()`, and the A6 row's "the atlas map shows the two hands".

**Authority.** The user's correction, docs/design/STRATEGIC_MAP.md (verbatim, round 120, 2026-11-01), overrides this
document wherever they differ. This revision follows it:

- **one kind of opportunity**: resource requirements, costs, duration, possible outcomes and a location;
- **the player is a resource**: committing it makes the opportunity the round's playable challenge (character control
  or building); any other resource resolves it autonomously over time;
- **no manual allocation and no separate dispatch**: committed resources are locked until the opportunity resolves,
  then the survivors return with rewards, consequences and new opportunities; opportunities run concurrently while
  requirements are met;
- **commits only from the player's current strategic location**, and the GM sets how free travel is;
- **discovery** reveals opportunities, **new resources unlock new kinds**, and known but unaffordable ones stay visible;
- **scaling by resources**: a lone hero, a travelling party, a ruler, an empire;
- **three priority systems**: the atlas / opportunity map, character control, building.

What revision 1 had that is gone: four encounter modes, dispatch as its own category, a fixed board of 3-5 picks per
turn, and a `Base` with a scale enum.

**Revision 3** folds in the user's answers to revision 2's questions (DECISIONS round 120, the latest entry, verbatim
there):

- **availability**: you can commit only resources available to your character. A city's ruler commits what is at the
  city. An empire commits what its constellation of settlements holds;
- **few cards, scaling up**: the number of opportunities is limited, and as resources grow, the cards shown require
  more ("If you have multiple armies you start seeing opportunities that require multiple armies"). It should feel
  epic and never overwhelming, and each turn's fun is the choices' mechanical and world effects and their synergy;
- **the card model**: "a set of cards you can purchase or assign resources to that can resolve or pop up each turn.
  Some can have negative effects for letting them expire". Opportunities can trigger player interactions and
  consequences (forced);
- **one option shown** per opportunity, with player opportunities kept separate (no sibling pairs on the table);
- **travel is a player opportunity**: playing one takes you there. It works like Slay the Spire or FTL: choose the
  next destination and keep going, with the story driving to the conclusion;
- **agents are interchangeable by kind, with tags**: a named character is also a knight, and tags unlock special
  opportunities. Levelling up means gaining better opportunities or **resolution bonuses**: negate a negative effect of
  a certain kind of opportunity, or resolve some instantly.

## In ten lines

1. An opportunity is a **card**: a location, the agents it locks (`requires`), the goods it spends (`costs`), a
   `duration`, an outcome table, an **expiry and its penalty**, and optional **forced** triggers.
2. There are two **hands**. **Player cards** require the player: playing one travels there and plays its challenge
   (character control or building). **Resource cards** take other agents and resolve on their own. Each card shows one
   option.
3. **Hand sizes are small and fixed** (proposed: 3 player cards, up to 4 resource cards). The scale grows through what
   the cards require (**tiers**: one army, two armies, three), not through how many there are.
4. **Availability**: only the agents and goods available to the character can be committed. That means what travels
   with the hero, plus what is at the settlements it rules (a city's ruler, its city; an empire, all of them).
5. Agents of a kind are **interchangeable**, and their quality is not a number. **Tags** (named, veteran, sapper,
   oath-sworn, champion) unlock special cards. **Bonuses** won by levelling up negate a kind of negative effect or
   resolve some cards instantly.
6. **A turn**: new cards pop up into free hand slots, the player plays one player card (it must keep moving; there is
   no waiting), any resource cards are assigned, commitments due resolve, expired cards apply their penalties, forced
   cards trigger, and the conflict's steps fire.
7. **Travel is not a separate action.** Destinations are player cards, and the GM's travel rule decides which places
   can appear in the player hand (a fixed seat, a choice, a region, open). The story pulls the hand toward the climax.
8. **Generation** selects by what is available: templates have requirement tiers, and the tier shown is the largest the
   holdings can meet, or one step above it as a visible goal. At most N cards per hand, scored on theme, foreshadowing,
   variety, synergy and the hero's likes.
9. The 23 templates keep their offers as a library, but only one offer of a template is ever shown at a time. Tiers,
   expiry penalties and tag cards are added where they matter (§5.4).
10. Vertical slice: (A) the horde run as a player hand of destinations, where the levy becomes an army and fills the
    resource hand, with an expiry penalty and a forced outrider card; (B) a ruler at Bumku with what the city holds.
    The conflations stand (§8), and there are three new questions (§10).

---

## 1. What the user asked for

The correction is in docs/design/STRATEGIC_MAP.md. Read it first: its "Core Mechanic" and "Guiding Principle"
("Opportunities are uniform. Their resource requirements determine who undertakes them; committing the player resource
makes an opportunity interactive. All opportunities resolve into consequences for the same persistent world.") are the
rules this document implements.

Earlier, still in force (DECISIONS round 120, verbatim):

- "the story of the big conflict which we need to know going into the run so we can foreshadow or establish
  motivations";
- "The character and run objective should inform what the GM sets up for that run but the GM can theoretically update
  the interactions mid run based on player choices";
- building as "a new view that essentially lets you paint into the building grid … housing, agriculture, ports, civic
  … only some heroes will get this mode";
- the ask behind this document: "I love the idea of thinking of locations as spawning opportunities based on what is at
  the location and the current hero and run. I would like a process for generating these. We want them thematic and
  genuinely interesting in terms of world consequences and gameplay bonuses";
- "when possible make the gameplay actually modify the map during the session not with text between sessions".

## 2. What exists, and what each gives

(These are on `places` now. Since revision 1, `cities`' purposes and stories and `traits` have merged.)

| piece | where | gives | gap for this design |
|---|---|---|---|
| `Situation`, `SituationRun` | contracts/situation.ts, runsit/state.ts | a threat with a route and a clock; areas played live (flee, ambush, deliver, trader, town); choices at an area's edge; items; four endings | the areas are fixed places for the player to play, and the choices fix where to go next. In this design both become opportunities on a "choice of destinations" map |
| `fillSituation`, `situationFor`, `checkSituation` | runsit/fill.ts, runsit/gm.ts, gm/situationcheck.ts | the first template (from world state), the GM-file-else-template pattern with the card saying which, and the validator | the pattern carries over as is; `oppcheck` extends the validator |
| `SessionStory` | contracts/story.ts | `Outcome`, `Condition`, `happenings` | the conflict's escalation steps are happenings |
| runplan | contracts/run.ts, runplan/ | `HeroCapabilities.likes`, `affordances`, `StageOutcome` with `CharacterChange`, `FailureRule`, `RunClock`, `TravelLeg` with `EnRouteEvent`s, terrain asks | travel and its events; a hero's likes for scoring |
| `WorldState` | contracts/world.ts, world-state.ts | regions' states, factions (attitude, power, relations), settlements, characters, history, runs | no opportunity record, no rumours, no conflict record |
| `Settlement` + purpose + story | contracts/settlement.ts, settle/purpose.ts, settle/story.ts | size, condition, faction, grids, buildings, people, stores, needs; `SettlementPurposeRec` (port, mining, lumber, farming, trading, hold with the scores); `SettlementStory` (founded, raided, walled, burned, flooded, ruined, grew) | the generator's richest facts; `stores` and `people` are not ticked by an economy |
| `Diplomacy` | contracts/diplomacy.ts | interactions; agreements (trade, land and mineral rights, passage, tribute, vassalage …) | how diplomacy reveals opportunities (allies share what they know) and what diplomats resolve |
| traits | contracts/traits.ts | intrinsic traits and statuses (undead, living, flying …), effects (heal, raise, damage, status) | hero and resource preconditions (an undead lich; a priest's `heal`) |
| `Instance` | contracts/recipe.ts | things with history | artifacts as rewards |
| `ItemDef`, `Loadout` | contracts/items.ts | slots and mechanical effects | the player's gear for its challenges |
| `Followers`, `Units` | contracts/orders.ts, units.ts | units in play that take orders | companions committed with the player are followers in its challenge |
| `Terrain` | contracts/terrain.ts | the region graph and barriers, `ExcavationSite`, `BuriedProp`, `FloodRequest` | caves and dams aren't features yet |
| `ControllerProfile` | contracts/play.ts | movement, destruction, `encounters` (likes) | no hero abilities as data |
| atlas facts, wiki | gm/ | regions, sites, roads and crossings, lakes, realms | no magic nodes (LW5) |

**Missing, in one list:** opportunities as a world record, with visibility and expiry; a resource catalogue and the
player's holdings; commitment and resolution; the travel rule; a conflict record; rumours; an economy step for
settlement stores; hero abilities as data; caves, dams and nodes as features; the building view and its functions; one
item representation.

## 3. The loop

```
 before the run: the GM writes the Conflict and the TravelRule; the holdings are set (the player + what the hero has)

 a turn:
   1 deal: new cards fill the free slots of the two hands (player: destinations and challenges; resources: the rest),
     chosen by what is available to the character (§5); forced cards from the conflict take a slot at once
   2 the player plays ONE player card: the hero travels there (the leg, its en-route events) and plays its challenge
     (character control or building). It must keep going: there is no waiting
   3 the player assigns resource cards: each locks its required agents (from what is available) and spends its costs
   4 the clock moves by the played card's duration (travel + challenge)
   5 resolve: every commitment that is due returns its survivors with outcomes, rewards, new agents, revealed cards
   6 expire: cards past their expiry leave the hand and apply their penalty (the harvest rots, the hold's patience ends)
   7 the conflict's due steps fire (the world changes on the map) and may force cards for the next turn
   until a climax holds → the climax is a forced player card → carry-over
```

Why the player is a resource and nothing else is special: the user's guiding principle. One mechanism (commit, lock,
resolve) covers the hero's own play, a companion's errand, a knight's quest and an army's campaign. "Dispatch" is
simply what committing a non-player resource looks like.

Why one player card a turn, and always one: "the playable challenge for that round", and "you have a choice of next
destination but you have to keep going". The turn is the step of the journey. A ruler at a fixed seat plays its turn
at the seat (a defence, a building, a petition) or on a card that rides out and back.

Why small hands that scale by requirement: the user's "players are never overwhelmed with choices", with the epic
coming from bigger cards (two armies, a siege) rather than more of them. A turn is fun because of how its few cards
combine (the levy holds the ford while the hero burns the bridge).

## 4. The contract

These are proposed types, in TypeScript, for a future `src/api/contracts/opportunity.ts`. They reuse the existing
types; §4.7 maps them.

### 4.1 Resources and holdings

```ts
import type { FactionId, RegionId } from './world';
import type { Outcome, Condition } from './story';
import type { CharacterChange } from './run';
import type { InstanceId, MaterialId, Tag } from './recipe';
import type { AreaPlay } from './situation';
import type { Agreement, Interaction } from './diplomacy';

/** Agents: locked while committed, they return (or die) when it resolves. 'player' is the hero the player controls. */
export type AgentKind = 'player' | 'companion' | 'knight' | 'diplomat' | 'scout' | 'prospector' | 'priest' | 'workers' | 'army' | 'ship';
/** Goods: spent as costs, earned as rewards. A specific good is a material id or a tag (ore, grain, timber). */
export type GoodKind = 'coin' | 'supplies' | 'materials' | 'renown' | MaterialId | Tag;

/** One agent. Agents of a kind are interchangeable (the user: "Interchangeable but I would have tags"). A group is one
 *  agent with a count (workers: hands; an army: one army; "two armies" is two army agents). */
export interface Agent {
  id: string;
  kind: AgentKind;
  name: string;
  /** a CharacterRecord id when it's a person the world remembers (the hero, a companion, a named knight) */
  character?: string;
  count: number;
  /** what unlocks special cards: 'named', 'veteran', 'sapper', 'oath-sworn', 'champion', 'undead', 'pilot' … (a named
   *  character who is also a knight is kind 'knight' with the tag 'named:<id>') */
  tags: string[];
  /** lasting conditions (CharacterRecord.statuses' words: wounded, cursed …); a wounded agent isn't available */
  statuses: string[];
  /** where it is: with the hero, or stationed at a settlement (the character's availability reads this) */
  at: { with: 'player' } | { settlement: string };
  /** locked by this commitment, if any */
  committed?: string;
}

/** Everything the player holds. */
export interface Holdings {
  agents: Agent[];
  goods: Partial<Record<GoodKind, { stock: number; rate: number /* a turn */ }>>;
  things: InstanceId[];
  /** settlements the character rules: their stationed agents and stores are available to it (a city's ruler: the city;
   *  an empire: its constellation) */
  rules: string[];
  dependants?: { count: number };
  /** what levelling up has won (§4.2 Bonus) */
  bonuses: Bonus[];
}

/** What can be committed now: the user's "they must be available to your character". */
export function available(h: Holdings): Agent[] {
  return h.agents.filter((a) => !a.committed && !a.statuses.includes('wounded') && ('with' in a.at || h.rules.includes(a.at.settlement)));
}

/** Where the player is: where its player cards travel from. */
export interface StrategicLocation {
  region: RegionId;
  settlement?: string;
  at: [number, number];
}

/** Which places may appear on player cards (the GM's: "a fixed location, a choice of destinations, a region, or open travel"). */
export type TravelRule =
  | { kind: 'fixed' }                                           // player cards only at the seat (or out and back)
  | { kind: 'choice'; destinations: StrategicLocation[] }       // runsit's ways on
  | { kind: 'region'; regions: RegionId[] }
  | { kind: 'open' };
```

The **scale is derived, never stored**: a lone hero holds only the player; a party adds companions; a ruler has
`rules` and knights, diplomats, workers, armies; an empire has many settlements and armies. `scaleOf(holdings)` names
it for the card and for the requirement tiers.

Why quality is tags, not numbers: the user's "Interchangeable … tags so named characters are also knights or whatever
and then have special opportunities that only show up for them". A veteran knight doesn't roll better. It is offered
the cards that only veterans see, and it may carry a bonus.

### 4.2 Opportunity: a card

```ts
export interface Opportunity {
  id: string;
  /** its template and which of the template's offers is shown (one option a card: the user's "only show one option") */
  template: string;
  offer: string;
  /** the hand it's in: requires the player → 'player', else 'resources' (the user: "keep player opportunities separate") */
  hand: 'player' | 'resources';
  title: string;
  pitch: string;
  location: { region: RegionId; settlement?: string; at?: [number, number]; site?: number };
  because: string[];
  offeredBy: { settlement?: string; faction?: FactionId; character?: string; land?: true };

  /** agents locked while it runs, by kind and count, and the tags they must carry */
  requires: Requirement[];
  /** the requirement tier shown (1: one army; 2: two …), of the template's tiers (§5.3) */
  tier: number;
  costs: Partial<Record<GoodKind, number>>;
  /** run minutes from commitment to resolution (a player card: the leg there + its challenge's planned play) */
  duration: number;

  /** iff hand 'player': what is played on arrival */
  challenge?: Challenge;
  /** iff hand 'resources': its fixed odds by tier (no agent quality; bonuses may change them) */
  odds?: Record<Tier, number>;

  outcomes: OutcomeTable;

  visibility: 'rumour' | 'known';
  /** it leaves the hand at this run minute (or turn count), or when a condition holds */
  expires: { turns: number } | { at: number } | Condition[];
  /** what letting it expire does (the user: "Some can have negative effects for letting them expire") */
  onExpire?: ResolutionOutcome;
  /** forced: it must be played this turn (the night assault, outriders on the road, the climax) — the user's
   *  "Opportunities can trigger player interactions and consequences" */
  forced?: boolean;
  /** what playing or resolving it triggers beyond its outcome: a forced card dealt next turn, a consequence elsewhere */
  triggers?: { forces?: string /* template id */; at?: Opportunity['location']; outcome?: ResolutionOutcome }[];
  hooks: string[];
  score?: Record<string, number>;
}

export interface Requirement {
  kind: AgentKind;
  /** how many agents of the kind (armies: 2), or a group's size (workers: 8) */
  count: number;
  /** tags every committed agent must carry (a 'named:c-maeve' card; a 'sapper' card) */
  tags?: string[];
}

/** Won by levelling up (the user: "gaining better opportunities or resolution bonuses. Negate a negative effect of
 *  certain types of opportunity or resolve some instantly"). Held by the holdings, or by one agent (its tags). */
export type Bonus =
  /** cards of these template themes (or with these tags) lose their failure and disaster atlas effects of these kinds */
  | { kind: 'negate'; themes: string[]; effects: (import('./world').AtlasEventKind | 'lost-agents' | 'expiry')[]; holder?: string }
  /** resource cards of these themes resolve at once when committed (duration 0) */
  | { kind: 'instant'; themes: string[]; holder?: string }
  /** a tier up: cards of these themes are dealt one tier richer in rewards at the same requirement */
  | { kind: 'better'; themes: string[]; holder?: string }
  /** a special card family opens (only shows up for this agent or the holdings) */
  | { kind: 'unlock'; templates: string[]; holder?: string };

export type Challenge =
  | { system: 'character'; play: LivePlay; minutes: number }
  | { system: 'building'; build: BuildChallenge };

export type LivePlay =
  | AreaPlay                                                               // flee, ambush, deliver, trader, town
  | { kind: 'delve'; site?: number; depth: number; prize?: string }
  | { kind: 'hold'; at: [number, number]; seconds: number; waves: number }
  | { kind: 'escort'; who: string; count: number; to: [number, number] }
  | { kind: 'break'; target: string; what: 'dam' | 'bridge' | 'wall' | 'seal' }
  | { kind: 'duel'; character: string }
  | { kind: 'hunt'; role: string; count: number }
  | { kind: 'explore'; radius: number }
  /** a destination with nothing staged: the leg (and its en-route events) is the play */
  | { kind: 'journey' };

export type Tier = 'triumph' | 'success' | 'cost' | 'failure' | 'disaster';
export type OutcomeTable = Partial<Record<Tier, ResolutionOutcome>> & { success: ResolutionOutcome; failure: ResolutionOutcome };
```

Why one option per card: the user's answer 3. A template still knows several ways (delve, pump, seal), but the hand
shows the one that fits what's available, and the rest stay in the library. When the player has workers but no time,
the pump card is dealt. When the player is alone, the delve card is dealt. The player never sees a pair to pick from.

Why `hand` follows `requires`: "keep player opportunities separate". The card's kind is still decided by what it needs
(the guiding principle), and the hand only groups the cards on the screen.

### 4.3 Commitment and resolution

```ts
/** A card committed: its required agents locked (from what's available to the character), its costs spent. */
export interface Commitment {
  id: string;
  opportunity: string;
  agents: string[];
  spent: Partial<Record<GoodKind, number>>;
  start: number;
  /** start + duration (0 with an 'instant' bonus) */
  resolves: number;
  /** a resource card's roll: made at commit from the seed (the card showed its odds) */
  roll?: { seed: number };
}

export interface Resolution {
  commitment: string;
  tier: Tier;
  returns: { agent: string; count?: number; statuses?: string[] }[];
  lost: { agent: string; count?: number; how: string }[];
  report: string[];
  outcome: ResolutionOutcome;
  /** the bonuses that applied (what a level bought, shown on the report) */
  bonuses?: string[];
}

export interface ResolutionOutcome extends Outcome {
  text: string;
  characters?: CharacterChange[];
  /** goods, new agents (the levy as an army), new tags on agents (a knight becomes a veteran), bonuses (a level), things */
  gain?: { goods?: Partial<Record<GoodKind, number>>; rates?: Partial<Record<GoodKind, number>>; agents?: Omit<Agent, 'id' | 'committed'>[]; tags?: { agent: string; add: string[] }[]; bonuses?: Bonus[]; things?: { kind: string; name?: string }[]; rules?: string[] };
  /** a player card always moves the player to its location; `move` is for anything else that does (passage by sea) */
  move?: StrategicLocation;
  settle?: { name: string; region: RegionId; at: [number, number] };
  diplomacy?: { agree?: Omit<Agreement, 'since'>[]; note?: Omit<Interaction, 'run'>[] };
  /** cards it deals next turn (template ids at places) and rumours it makes known */
  spawns?: { template: string; location: Opportunity['location'] }[];
  reveals?: { region?: RegionId; opportunities?: string[] }[];
  conflict?: { progress?: number; cancel?: string[]; raises?: string[] };
  travel?: TravelRule;
  settlement?: { id: string; condition: 'thriving' | 'struggling' | 'besieged' | 'abandoned' | 'ruined' };
}
```

**Resource cards' odds are fixed per card.** Agents are interchangeable, so the card states its odds ("8 in 10: the
shaft runs dry") and the roll is made at commit. Bonuses are what change outcomes: `negate` strips a kind of bad effect
(a "warden" tag means a failed lay-the-dead card raises no dead), `instant` makes a kind resolve at once, and `better`
gives richer rewards.

**Player cards.** Playing one moves the hero to the card's location (the leg is part of its duration and may meet
en-route events), then its challenge is played. The result maps onto tiers. runsit's `AreaResult` gives won, won hurt,
lost and fell. Agents committed with the player (a companion, the levy) join as followers.

**Cards that need no agents** (buying word at a market, a ransom, passage bought) are resource cards that only spend
goods. They resolve on their next resolution step, usually at sure odds.

### 4.4 Conflict

The conflict is kept from revision 1. The GM writes it before the run.

```ts
export interface Conflict {
  id: string;
  title: string;
  premise: string;
  antagonist: { faction: FactionId; leader?: string; seat: { region: RegionId; settlement?: string; mark?: string }; forces: { role: string; count: number }[] };
  goal: { text: string; wins: Outcome };
  /** 0..1; steps fire as it passes them; resolutions push it back or forward */
  progress: number;
  /** growth a run minute on its own (pressure); 0: only events move it */
  drift: number;
  steps: { id: string; at: number | Condition[]; text: string; outcome: Outcome; raises?: string[]; imposes?: string[] /* template ids forced on the player */; fired?: boolean }[];
  /** how it ends: each is an opportunity that requires the player (its challenge the finale) */
  climaxes: { id: string; when: Condition[] | { progress: number }; opportunity: string }[];
  /** what templates foreshadow and answer: 'undead', 'bridge:r2159', 'leader:c-grey-reeve' */
  hooks: string[];
  by: string;
}
```

### 4.5 Clock and turn

```ts
export interface RunClock {
  /** run minutes (runsit's unit: a challenge counts its planned minutes, up to 1.5x when played slower; a leg its distance at the pace) */
  now: number;
  turn: number;
  day?: { minutes: number; nightFrom: number };
  deadline?: number;
}

/** How many cards are dealt (the user: "limit the number of opportunities and instead show ones that require more"). */
export interface HandRule {
  player: number;      // proposed 3 (the next destinations: FTL's beacons)
  resources: number;   // proposed 4 at most; 0 for a lone hero with no agents
}

/** The strategic map's state machine (pure; Node-testable, as SituationRun is). */
export interface StrategicMap {
  readonly conflict: Conflict;
  readonly holdings: Holdings;
  readonly clock: RunClock;
  location: StrategicLocation;
  travel: TravelRule;
  hands: HandRule;
  /** the two hands, each card with whether it's affordable from what's available and what's missing */
  hand(which: 'player' | 'resources'): { card: Opportunity; affordable: boolean; missing: string[] }[];
  /** play the turn's player card: the hero travels there, its challenge starts */
  play(card: string): Commitment;
  /** the challenge came out this way */
  played(commitment: string, tier: Tier): Resolution;
  /** assign a resource card: its required agents locked from what's available, its costs spent */
  assign(card: string): Commitment;
  /** the turn ends: the clock moves, commitments due resolve, expired cards apply penalties, steps fire, new cards are dealt */
  endTurn(): { resolved: Resolution[]; expired: { card: Opportunity; outcome?: ResolutionOutcome }[]; fired: string[]; dealt: Opportunity[]; climax: Opportunity | null };
  readonly commitments: Commitment[];
}
```

### 4.6 Carry-over

```ts
export interface CarryOver {
  record: import('./run').RunRecord;
  conflict: { id: string; progress: number; resolved: boolean; antagonist: FactionId };
  /** agents who outlast the run, as CharacterRecords (a knight is a person the world remembers); groups go back to their settlement */
  agents: string[];
  /** settlements the player now rules (a ruler's run leaves a realm) */
  rules: string[];
  things: InstanceId[];
  /** opportunities still open: kept in the world as rumours a later run can find, with their `because` */
  open: Pick<Opportunity, 'template' | 'location' | 'because' | 'hooks'>[];
  /** what the GM might run next (leadership accepted → a ruler's run) */
  suggests: { holdings: 'lone' | 'party' | 'ruler' | 'empire'; why: string }[];
}
```

### 4.7 Mapping to the existing contracts

| new | built from | change |
|---|---|---|
| `Agent`, `Holdings` | `CharacterRecord` (people), `Followers` (in play), `Settlement.people` and `stores` (a ruler's), `Loadout` (the player's gear) | new; the player becomes an agent like the others |
| `StrategicLocation`, `TravelRule` | `SituationRun.at` and its choices (a "choice of destinations"), runplan's legs | the GM's choice, data; it limits which places player cards are dealt for; runsit's area graph is `choice` |
| `Opportunity` | `SituationArea` + `AreaPlay` (a player opportunity's challenge), `SituationChoice` (the way there), `RunStage`, `EnRouteEvent` poi | uniform; with requirements, costs, duration, visibility, expiry |
| `Challenge` / `LivePlay` | `AreaPlay` (kept as a member), runplan's `EncounterKind` (only as the hero's likes) | grows by delve, hold, escort, break, duel, hunt, explore; a building challenge |
| `Commitment`, `Resolution` | `SituationRun.areaDone`, `PlayedStage`, `StageOutcome` | new: locking, concurrency, autonomous odds |
| `ResolutionOutcome` | `Outcome` (extends it), `CharacterChange`, `ChoiceEffect` (warn and evacuate become conflict or holdings effects), `SituationEnding.settlement` | adds gain, move, settle, diplomacy, spawns, reveals, conflict, travel |
| `Conflict` | `Situation.threat` + `target` + `endings`, `SessionStory.happenings`, `FailureRule` | the horde is one conflict; `threat.arrives` is a step; the town finale is a climax opportunity |
| `RunClock` | `SituationRun.clock`, `areaMinutes`, runplan's `RunClock` | one clock (§8 item 3) |
| `StrategicMap`, `HandRule` | `SituationRun` (its edge card is a player hand of destinations) | generalised: two hands, play, assign, endTurn |
| `CarryOver` | `finishSituation`, `RunRecord`, `WorldState.record` | adds conflict, agents, rules, open opportunities |

**What runsit's `Situation` already is, in these terms.** A lone hero (holdings: the player). The travel rule is
`choice`, and the ways on at each area's edge are the player hand. Each area is a player card at a destination, with its `AreaPlay` as
the challenge and its planned minutes as the duration. The horde is a conflict with one step (`arrives`). The town is
the climax opportunity. The levy is a resolution that gains an `army` agent, though today it is a special case in
`finaleSetup`. The first step is an adapter (`situationToMap(sit)`), with a Node test that every path gives the same
endings and clock as `SituationRun`. The `Situation` file format stays until the user agrees to a new one.

## 5. Generating opportunities

### 5.1 The process: dealing a hand

```
 LocationFacts + Holdings (what's available) + RunFacts
   1 match: each template × each place the hand may deal for (player: places the travel rule allows within a leg or two;
     resources: places within the reach of what's available) whose needs hold
   2 pick the offer: of a template's offers, the one for this hand that what's available can meet (or the one tier above,
     as a visible goal); one offer per template per place, never two
   3 pick the tier: the template's largest requirement tier the holdings meet (two armies held → the two-army siege);
     one tier up may be dealt unaffordable, shown with what's missing
   4 instantiate: fill the slots (names, regions, magnitudes, the expiry and its penalty)
   5 score: theme, foreshadowing, variety, synergy with the cards in hand and the commitments running, the hero's likes
   6 deal: fill the hand's free slots up to HandRule, best first; forced cards first and over the limit if they must
   7 GM: may swap, flavour, force, or add its own in the grammar (§5.6)
   8 oppcheck (§5.7)
```

When it runs: every turn, for the free slots. Also when the holdings gain an agent kind, a tag or a bonus (the next
deal can hold cards for it), and when a resolution or an escalation step changes a place's facts. It is pure CPU,
deterministic from the seed, the world version and the turn, and timed by a perf script.

**Selection by available resources** is the rule that keeps the hand small and scaling. A template is only matched for
the resources hand if what's available can meet some tier of it. Among the tiers, the deal takes the largest that fits,
so the hand grows in weight rather than in count. Unaffordable cards (the next tier) may take at most one slot, which
shows what growing would open.

**Three guarantees** (checked, never relaxed silently): the player hand always has at least two cards (the hero must
keep going, with a choice). Some card in either hand answers or foreshadows the conflict. And as the conflict nears its
climax, one player card leads toward it (the story "progress players to the conclusion").

### 5.2 Inputs

`LocationFacts` (unchanged from revision 1; purpose and story are now on places): the region (kind, tier, climate,
rivers, lava, stamps, ground), its `RegionState`, the settlement (size, condition, faction, purpose, story, stores),
features (excavation sites and buried props, lakes, road crossings; caves, dams and nodes missing), factions present
(presence, attitude, power), agreements holding there, remembered people there.

`HoldingsFacts`: what's available (agent kinds and counts, their tags and traits, the bonuses); the goods and their rates; the things; the
settlements ruled; the player's profile (`ControllerProfile`, its `encounters` likes), traits (traits.ts), abilities
(missing as data), record (statuses, motivation) and loadout.

`RunFacts`: the conflict (progress, hooks, steps due soon), the clock, the travel rule, the commitments running, what
was offered and taken (variety), flags.

### 5.3 The template grammar

```ts
export interface OpportunityTemplate {
  id: string;
  title: string;
  pitch: string;
  themes: string[];
  needs: Need[];       // the closed vocabulary of revision 1 (purpose, story, size, condition, region, state, flooded,
  prefers?: Need[];    //  storm, feature, mark, faction, agreement, person, hero, holdings, conflict, not)
  /** its ways, at most one of which is dealt at a time */
  offers: TemplateOffer[];
  answers?: string[];
  foreshadows?: string[];
  once?: 'run' | 'place';
}

export interface TemplateOffer {
  id: string;
  title: string;
  /** the requirement tiers, smallest first: the deal takes the largest the holdings meet. Rewards scale with the tier */
  tiers: { requires: Requirement[]; costs: Partial<Record<GoodKind, number>>; duration: number; reward: number /* × the outcomes' gains */ }[];
  challenge?: Challenge;                                     // iff the tiers require the player
  odds?: Record<Tier, number>;                               // iff not
  outcomes: OutcomeTable;
  /** how long it stays in the hand, and what letting it go does */
  expires: { turns: number };
  onExpire?: ResolutionOutcome;
  triggers?: Opportunity['triggers'];
  forced?: boolean;
}
```

A `Need` of kind `holdings` matches what's available: `{ kind: 'holdings'; agents?: { kind: AgentKind; count?: number;
tags?: string[] }[]; rules?: boolean; dependants?: boolean; bonuses?: string[] }`. Special cards for a tag ("only
shows up for them") are templates whose needs name the tag: `{ agents: [{ kind: 'knight', tags: ['named:c-maeve'] }] }`.

### 5.4 The library: 23 templates as uniform opportunities

How to read it: **P** means a player card, played (C is character control, B is building). Every other row is a
resource card that resolves on its own (A, with what it is about). Durations are in run minutes at a town, before
travel. Costs are goods. **Only one offer of a template is dealt at a time**, chosen by what's available: the lone hero
is dealt the P offer and a ruler with workers the A offer. The rows are the template's library, not a choice shown
together. The skill floors of revision 2 are gone, because agents are interchangeable. Where a row names a tag, it
is a tag card.

| # | template (needs) | offer | requires | costs | dur. | resolved | world consequence | gameplay reward |
|---|---|---|---|---|---|---|---|---|
| 1 | **The Flooded Shaft** (mining; flooded story or wet; undead near preferred) | Delve for what knocks | player | supplies 1 | 6 | P·C delve | `mark` the open shaft; failure: `raise-dead` there | an artifact (`Instance`) |
| | | Pump it out | workers 8 | materials 6 | 40 | A build | `drain` (the basin really drained); ore `rate` + | ore income each turn |
| | | Seal the adit | player *or* workers 4 | materials 3 | 3 / 20 | P·C break / A dig | `lay-dead` −0.2; `mark` the sealed adit | the conflict's raise-dead step there cancelled |
| 2 | **The Strike at the Pit** (mining; owner power > 0.5) | Speak for the miners | diplomat | renown 2 | 20 | A talk | `mineral-rights` to a free company (diplomacy); presence shift | a vassal mine: ore flow by agreement; sappers join (workers, dig) |
| | | Hold the gate for the owners | player | none | 5 | P·C hold | owner `attitude` +; the miners' grudge (interaction, halfLife ∞) | coin; a bounty raised (spawns #22 against you) |
| 3 | **The Last Ship Out** (port; conflict within 2 borders; dependants) | Buy passage | none of the player's agents beyond the column | coin 8, supplies 4 | 10 | A talk | port `attitude` + | the strategic location **moves** by sea (`move`), past the pursuers |
| | | Take the ship | player | none | 5 | P·C ambush | port `attitude` −; `mark` the stolen cog; the port's trade `rate` − | the same move, and a ship agent |
| 4 | **The Wreckers' Light** (port; storm ≥ 0.4) | Light the lamp | player | supplies 1 | 5 | P·C hold | `mark` the lighthouse kept; a `trade` agreement | trade income; a pilot (companion, sail) |
| | | Pay off the wreckers | diplomat | coin 4 | 15 | A talk | wreckers' presence +; port `attitude` − | coin share of wrecks each turn |
| 5 | **Fell the Old Wood** (lumber; an overgrown ruin next door) | Clear it | workers 10 | supplies 3 | 40 | A haul | `overgrow` −0.4 (the forest really thins); the ruin surfaces (spawns #13) | timber (materials) |
| | | Walk the old wood | player | none | 5 | P·C explore | reveals the region's hidden opportunities; a grove kept | a sanctuary (healing for wounded agents each turn, LW1) |
| 6 | **The Firebreak** (lumber or farming; dry; fire hook) | Cut the break | player | none | 4 | P·C hold (the real fire) | the region's `burn` avoided; the camp stands | fresh mounts (`pace` item) |
| | | Send axemen ahead | workers 6 | supplies 2 | 15 | A haul (risk 0.3) | as above if success; `burn` 0.6 if failure | the same, and the risk to the workers |
| 7 | **Harvest Before the Host** (farming; on the conflict's route; progress 0.2-0.7) | Bring it in | workers 8 | none | 20 | A haul | grain `stock` + | supplies |
| | | Burn the fields | player | none | 4 | P·C hold (set the fires) | `burn` the fields' region; farmers' `attitude` − | the conflict's `drift` − (the host forages less) |
| 8 | **Blight in the Barley** (farming; shadow or undead near) | Trace it to the source | player | supplies 1 | 6 | P·C delve | `light` +0.1; the source **revealed** | the conflict's next step shown early (foreshadowing); a ward item |
| | | Send the priest | priest | supplies 1 | 25 | A heal | `light` +0.1 | a ward item |
| 9 | **The Caravan Contract** (trading; roads ≥ 3; hostiles on a road) | Ride with the caravan | player | none | 6 | P·C escort | a `trade` agreement (flows) | coin, trade income |
| | | Hire it a guard | knight *or* army 1 | coin 2 | 30 | A fight | the same agreement on success | trade income without the player's turn |
| | | Rob it | player | none | 4 | P·C ambush | the town's `attitude` −; bounty (spawns #22 against you) | coin, goods, items |
| 10 | **The Market of Rumours** (trading) | Buy word | none | coin 3 | 5 | A talk (sure) | none | **reveals**: rumours in reach → known; the conflict's next step and its time |
| 11 | **The Levy of the Hold** (hold or city; same realm; not hostile) | Carry the word | player | none | 3 + the ride | P·C deliver | the hold's `attitude` +; the levy marches in the session | **gains an army agent** (the levy), committed to the climax or to #12, #14 |
| | | Send an envoy | diplomat | renown 1 | 25 | A talk | the same | the same army, later |
| 12 | **The Oath of a Small Hold** (hold; power < 0.4; conflict near) | Take its oath | diplomat *or* player | renown 2 | 20 / 5 | A talk / P·C deliver | `vassalage` (diplomacy); presence becomes the player's | `rules` + (its stores flow in; the spawn area grows) |
| | | Demand tribute | army 1 | none | 30 | A fight | `tribute` agreement; its grudge | coin each turn |
| 13 | **The Dig** (excavation site) | Lift it out | player (with telekinesis) | none | 5 | P·C break | the props raised in the session; `mark` the excavation | an artifact (`Instance` with its history) |
| | | Dig it out | workers 6 | supplies 2 | 45 | A dig | the same | the same; a statue for the seat (renown each turn) |
| | | Survey it | prospector | supplies 1 | 15 | A dig (sure) | none | **reveals** what lies there (the artifact named); halves the dig's duration |
| 14 | **Break the Dam** (dam, or a lake upstream of the route) | Break it | player | none | 4 | P·C break | a real `flood` downstream (`Terrain.flood`); farms `ruin` | the conflict's route cut: a step cancelled, a long delay |
| | | Sap it | workers 6 *or* army 1 | materials 2 | 25 | A dig (risk 0.4) | the same, and the flood comes when it resolves | the same, without the player's turn |
| | | Pay the keepers to hold it | diplomat | coin 4 | 15 | A talk | keepers' `attitude` + | the downstream town's gratitude (renown) |
| 15 | **Burn the Bridge** (crossing on the route) | Burn it under them | player | none | 3 | P·C break (the real fire) | the crossing gone (`mark`; the road's crossing removed: later runs' graph) | the arrival delayed (runsit's `delay`) |
| | | Hold the ford | army 1 *or* knight 2 | supplies 2 | until the host passes | A fight (risk 0.5) | the host's forces − | the delay, and the risk to the army |
| 16 | **The Cave Mouth** (cave; the player moving) | Hide the column | none beyond the column | supplies 3 | 20 | A sneak (sure) | none | pursuers lose the trail |
| | | Clear the lair | player | none | 6 | P·C hunt | beasts' presence −; `mark` a refuge | a safe camp (spawns #19 here) |
| 17 | **The Field of the Last War** (battlefield mark or undead ≥ 0.2) | Lay them to rest | player (living) *or* priest | none / supplies 1 | 5 / 25 | P·C hold / A heal | `lay-dead` −0.3; `light` + | the conflict's forces − |
| | | Raise them | player (`raise-dead` ability) | none | 4 | P·C (the lich's raise) | `raise-dead` +; the living factions' `attitude` − (witnesses) | **gains an army agent** (undead company, trait undead) |
| 18 | **The Ever-Storm Tower** (storm ≥ 0.5) | Break the storm | player | none | 6 | P·C explore (the climb) | `clear-storm` | the roads there open (border costs fall) |
| | | Harness it | priest *or* prospector, workers 6 | materials 8 | 50 | A build | `mark` a storm gate (LW5's seed); shadow + | a "lightning on call" item; the gate as a later building |
| 19 | **A Place to Winter** (dependants; flat, watered, no hostiles; or an abandoned settlement) | Settle here | player | materials 4, supplies 4 | the building | P·B (paint the first functions) | a new `Settlement` (camp); `rebuild` if over a ruin; `mark` | `rules` + (the column becomes a ruler's seat; the travel rule may become `fixed`) |
| 20 | **The Siege of {town}** (the antagonist holds it) | Storm the walls | player, army 2 | supplies 4 | 8 | P·C (the assault, the army as followers) | `ruin` +; the town changes hands | the antagonist's `power` −; a seat taken |
| | | Starve it | army 2 | supplies 6 | 90 | A fight | the town `struggling`; its people's `attitude` − | the same, slowly, at no risk to the player |
| | | Parley | diplomat | renown 2 | 30 | A talk | a `truce` | time, and the conflict paused |
| 21 | **The Well Ran Dry** (a seat; dry) | Dig a cistern | player | materials 5 | the building | P·B (paint a `water` function) | a building (`Building.use` water); the town `thriving` | people + per day; fire-fighting at night |
| | | Send diggers to the spring | workers 6, prospector | supplies 2 | 40 | A dig | the spring's `mark` | the same, without the player's turn |
| 22 | **The Champion at the Crossroads** (a named lieutenant; a crossing on the route; or a bounty) | Duel | player | none | 3 | P·C duel | the lieutenant dies (`CharacterRecord`); antagonist `power` − | a named weapon; the conflict's progress −0.1 |
| | | Send a knight | knight | none | 20 | A fight (risk 0.5) | the same, or the knight dies | the same |
| 23 | **The Captive** (a person with `captive:<faction>` here) | Get them out | player | none | 6 | P·C escort | the captive's statuses cleared; the holder's `attitude` − | **gains a companion** (their tags, gear and own cards) |
| | | Ransom | diplomat *or* none | coin 6 | 20 | A talk (sure) | the holder's coin + | the same companion |

(Where a cell reads "player *or* …", it means two offers of the template, each with one requirement set. Only one is
dealt, the one that fits what's available.)

**Tiers, expiry and tag cards, where they matter** (the rest have one tier and expire without penalty):

| # | tiers (requires → reward) | expires | if let go | tag card / bonus it can grant |
|---|---|---|---|---|
| 7 Harvest | workers 4 / 8 / 16 → grain ×1 / ×2 / ×4 | 2 turns | the grain rots: supplies −; the host forages, so the conflict's drift + | — |
| 11 Levy | player (one card) | 3 turns | the hold gives up on you: `attitude` −; its levy marches for itself | `named:` the hold's captain joins as a knight (tag `named`) |
| 12 Oath | diplomat / diplomat + army 1 → vassal / vassal + its levy | 3 turns | the hold swears to the antagonist instead (presence +) | oath-sworn: the vassal's armies carry the tag |
| 14 Dam | workers 6 / army 1 / army 2 → the flood / + the route cut / + a step cancelled | until the host passes | none, the chance is gone | sapper (tag): dig cards resolve instantly (`instant` bonus) |
| 15 Ford | army 1 / army 2 / army 3 → delay 2 / 5 / 10 min | until the host passes | none | veteran (tag) on surviving armies: `negate` lost-agents on fight cards |
| 17 Field | priest / priest + army 1 → lay-dead −0.3 / −0.6 | 4 turns | the dead rise there (`raise-dead` +0.2) | warden (tag on the priest): `negate` raise-dead on failed rite cards |
| 20 Siege | army 2 / army 3 / army 5 → starve / storm / take the seat | 5 turns | the antagonist reinforces (`faction-power` +) | — |
| 22 Champion | knight / knight `veteran` → duel / duel at better odds as a tag card | 2 turns | the champion rides on: a forced ambush card next turn (a trigger) | the champion's weapon gives `better` on fight cards |
| 23 Captive | player / diplomat → escape / ransom | 3 turns | the captive is moved to the seat (a later, harder card) | the freed hero: a `named` companion with their own cards |
| new: **Outriders** | player (forced) | this turn | none (it can't be let go) | — |
| new: **The Night Assault** | player (forced, a ruler at its seat) | this turn | none | walls painted: `negate` burn on the defence's failure |



**Coverage.** Every template has a player offer, so the player hand can always be dealt. Templates 2, 4, 9, 11,
12, 13, 14, 15, 18, 20, 21 and 22 have offers that only a party or ruler can take autonomously. Agents that rewards
create: army (11, 17), companion (4, 23), workers (2), and settlements ruled (12, 19). Those rewards are how a run
grows in scale within itself. Every purpose has at least two templates. Every template has at least two offers with
different world consequences, and `oppcheck` enforces that.

**One template as data (#1):**

```json
{
  "id": "flooded-shaft", "title": "The Flooded Shaft of {settlement}",
  "pitch": "{settlement}'s lower workings drowned {story.flooded.ago}. The miners say something knocks below the water.",
  "themes": ["water", "ore", "undead", "delve"],
  "needs": [{ "kind": "purpose", "is": ["mining"] }, { "kind": "condition", "is": ["thriving", "struggling", "besieged"] }],
  "prefers": [{ "kind": "story", "has": ["flooded"] }, { "kind": "state", "field": "undead", "min": 0.1 }],
  "answers": ["undead"], "foreshadows": ["undead", "barrows"], "once": "place",
  "offers": [
    { "id": "delve", "title": "Delve for what knocks", "tiers": [{ "requires": [{ "kind": "player", "count": 1 }], "costs": { "supplies": 1 }, "duration": 6, "reward": 1 }], "expires": { "turns": 3 },
      "challenge": { "system": "character", "play": { "kind": "delve", "depth": 3, "prize": "{artifact}" }, "minutes": 6 },
      "outcomes": {
        "success": { "text": "You came up with {artifact}; the knocking stopped.", "atlas": [{ "kind": "mark", "regions": ["{region}"], "magnitude": 1, "detail": { "name": "the open shaft of {settlement}", "kind": "mine" } }], "gain": { "things": [{ "kind": "{artifact.kind}", "name": "{artifact}" }] } },
        "failure": { "text": "The dead came up behind you.", "atlas": [{ "kind": "raise-dead", "regions": ["{region}"], "magnitude": 0.2 }], "characters": [{ "kind": "status", "id": "{hero}", "add": ["wounded"] }] } } },
    { "id": "pump", "title": "Pump it out", "tiers": [{ "requires": [{ "kind": "workers", "count": 8 }], "costs": { "materials": 6 }, "duration": 40, "reward": 1 }, { "requires": [{ "kind": "workers", "count": 16 }], "costs": { "materials": 10 }, "duration": 25, "reward": 2 }],
      "odds": { "success": 0.8, "failure": 0.2 }, "expires": { "turns": 3 },
      "outcomes": {
        "success": { "text": "The shaft is dry; ore comes up again.", "atlas": [{ "kind": "drain", "regions": ["{region}"], "magnitude": 1 }], "gain": { "rates": { "ore": 2 } } },
        "failure": { "text": "The pumps failed; the water won.", "gain": { "goods": { "materials": -3 } } } } },
    { "id": "seal", "title": "Seal the adit", "tiers": [{ "requires": [{ "kind": "player", "count": 1 }], "costs": { "materials": 3 }, "duration": 3, "reward": 1 }], "expires": { "turns": 3 },
      "onExpire": { "text": "Something came up the shaft while no one watched.", "atlas": [{ "kind": "raise-dead", "regions": ["{region}"], "magnitude": 0.1 }] },
      "challenge": { "system": "character", "play": { "kind": "break", "target": "adit", "what": "seal" }, "minutes": 3 },
      "outcomes": {
        "success": { "text": "The adit is rubble. Nothing more comes up.", "atlas": [{ "kind": "lay-dead", "regions": ["{region}"], "magnitude": 0.2 }], "conflict": { "cancel": ["{step.raise-dead-here}"] } },
        "failure": { "text": "The roof held; the dead didn't.", "atlas": [{ "kind": "raise-dead", "regions": ["{region}"], "magnitude": 0.15 }] } } }
  ]
}
```

### 5.5 Scoring

Scoring decides **which cards are dealt into the free slots**. The hand is small, so this is where a turn's fun is
made. A **synergy** term rewards cards that work with what's in hand or running: a resource card that holds the ford
while a player card burns the bridge, or a pump card while the hero delves next door.

| part | how |
|---|---|
| theme `T` | the share of `prefers` that hold, weighted by how far past the threshold; the purpose's score margin; overlap of `themes` with the conflict's hooks |
| foreshadow `F` | `foreshadows ∩ hooks`, weighted by how soon the matching step is due; `answers ∩` raised hooks |
| variety `V` | penalties for the same template or region as recent deals, and for a hand dominated by one challenge kind |
| synergy `S` | shared location, shared hooks, or an outcome of one that meets a need of another (the levy for the ford; the drained shaft for the ore card) |
| difficulty `D` | the offers' difficulty against the holdings that can meet them (the player's band by the conflict's progress; an autonomous offer against the best agents of its kind) |
| hero `H` | for player offers, `ControllerProfile.encounters` for the live kind; 1 for building if the hero has the mode |

The starting weights are `0.25 T + 0.20 F + 0.10 V + 0.15 D + 0.15 H + 0.15 S`, tuned in a viewer. Unaffordable known
opportunities stay visible, as the user said. The map shows what's missing ("needs 8 workers"), which is also how a
player learns what holding more would open.

### 5.6 The GM

| when | does | can't |
|---|---|---|
| before the run | writes the Conflict and the TravelRule; may author set-piece opportunities | name what the wiki lacks |
| spawning | sees the top candidates per place with scores and `because`; swaps, flavours (titles, pitches, who offers it, the artifact's name), sets visibility (a secret kept hidden) | spawn an offer whose needs fail |
| forcing | through a step's `imposes` or a card's `triggers`: a forced player card this turn (the night assault, the outriders) | force more than one at a time |
| inventing | a new template in the grammar, saved under `data/opportunities/`, checked by `oppcheck` | invent `Need`, `AgentKind` or `LivePlay` kinds (contract changes) |
| mid-run | between rounds: add or move a step, change the travel rule, retire an opportunity, all data checked again | rewrite resolutions already made |

As runsit does today, the deterministic generator always runs, and a GM file for this world and turn replaces or
flavours its output. The card says which one it is.

### 5.7 `oppcheck`

Everything situationcheck's design checked (shapes, references, needs hold, AtlasEvents realisable per kind, distinct
outcomes across a template's offers, a climax reachable), plus these:

| check | rule |
|---|---|
| uniformity | `challenge` present iff `requires` has the player; `autonomous` present iff not; a challenge's live kind has a player in the area code; a building challenge only for a hero with the mode |
| requirements | agent kinds and tags known; counts > 0; a requirement no agent in the world could ever meet is an error (a knight offer in a world with no knights to recruit) |
| costs and gains | goods known; no outcome loses more agents than were committed; gains of new agent kinds name a template family that uses them (a reward that opens nothing is flagged) |
| duration | > 0; at least the travel there and back at the slowest required agent's pace; before the expiry |
| reachable | a player card's location is allowed by the travel rule and within a leg or two of the strategic location |
| the guarantees | §5.1's two: player offers reachable, one answering the conflict |
| forced | a forced card is a player card and expires the same turn |
| hands | at most `HandRule` per hand (forced cards aside); one offer per template per place; one unaffordable card at most |
| tiers | ascending; the dealt tier is the largest the available agents meet (or one above, marked unaffordable) |
| expiry | every `onExpire` is realisable like an outcome; a card that can be let go says so on its face |
| availability | a commitment's agents are all in `available(holdings)` at commit |
| bonuses | a `negate` names effect kinds that the themed cards actually have; an `unlock` names existing templates |

## 6. Character control and building as the player's challenges

There is no dispatch section any more. Committing a knight is dispatch, and §4.3 covers it.

**Character control.** The existing runsit area code plays an `AreaPlay`. The templates add delve, hold, escort, break,
duel, hunt and explore, each needing a live implementation. Agents committed with the player (a companion, the levy)
join the challenge as followers.

**Building** (the user: paint into the building grid). A building challenge:

```ts
export type BuildFunction = 'housing' | 'agriculture' | 'port' | 'civic' | 'training' | 'hospital' | 'storage' | 'workshop' | 'wall' | 'water' | 'shrine';

export interface BuildChallenge {
  settlement: string;
  grid?: string;                 // a SettlementGrid id: the painting surface
  budget: Partial<Record<GoodKind, number>>;
  /** met when the derived totals reach these (a petition's need: walls before the host) */
  goal?: { text: string; needs: Partial<Record<BuildFunction, number>> };
}

/** what painted cells give, as data (derived, never stored: compose.ts's principle) */
export interface FunctionRule {
  fn: BuildFunction;
  per: { rate?: Partial<Record<GoodKind, number>>; agents?: { kind: AgentKind; every: number /* rounds */ }; defence?: number; people?: number };
  cost: Partial<Record<GoodKind, number>>;
  joins: 'one-structure' | 'block';
}
```

What painting gives the holdings ties building into the same loop. A training camp produces knights or army
companies over rounds. Housing produces workers. A hospital shortens wounded agents' recovery. Walls add defence to the
night's forced defence. So building is how a ruler gets the resources that open more opportunities. The structures
system grows the buildings over the following rounds (`CitySpec.progress`).

Still missing for building: the painting UI; function styles and modules in structures (it has house, hut, farmhouse,
barn); `Building.use` from the plan; settlement stores ticking.

## 7. What to build first: a vertical slice

### A. A lone hero: runsit's horde run as a hand of cards

| step | what | test / measure |
|---|---|---|
| A1 | `contracts/opportunity.ts`: Agent (tags, at), Holdings (bonuses, `available`), TravelRule, Opportunity (hand, tier, expires, onExpire, forced, triggers), Bonus, Commitment, Resolution, Conflict, RunClock, HandRule | typecheck |
| A2 | `situationToMap(sit)`: the player as the only agent; each area edge's ways on as the **player hand** (destinations: playing one travels there and plays its `AreaPlay`); the start's outriders as a **forced** card; the horde a conflict; the town the forced climax card; the hold's `deliver` resolving with **gain: an army agent** (the levy) | Node test: every path gives the same endings and clock as `SituationRun` |
| A3 | the levy fills the **resources hand**: with one army available, #15 "Hold the ford" (tier 1) and #7 "Bring in the harvest" (expires in 2 turns: the grain rots and the host's drift rises) are dealt while the hero rides on; a surviving army gains `veteran` | Node test on seed 1 (the Bumku run): the army is locked, resolves at its time, the delay or the stock applied; letting the harvest go applies its penalty |
| A4 | the dealer: six templates (#11, #15, #10, #7, #1, #22), one offer per template, tiers, HandRule 3 + 4, scoring with synergy, the three guarantees | Node tests: deterministic; the Bethorn crossing is dealt #15; time per turn measured (expect < 5 ms) |
| A5 | `oppcheck` for those six | runs in `scripts/storycheck.mjs` |
| A6 | the atlas map shows the two hands (cards with their odds, their expiry and what letting them go does), the locked agents and their return times | headless shot at the phone proxy; the run plays to an ending; driveprofile unchanged |

### B. A ruler at a fixed seat

| step | what |
|---|---|
| B1 | the hero is Bumku's warden; travel `fixed`; available: what is at Bumku (two knights, workers 10, a scout, a diplomat); days of N run minutes |
| B2 | the resources hand from the same templates plus #12, #13, #21, scaling by tier (a second army from the oath deals the two-army cards); reports on resolution |
| B3 | the night: the conflict forces **The Night Assault** player card (runsit's finale, `FinaleRules`, the real fires), escalating each night |
| B4 | building's first cut as a player card: paint housing, training and wall onto the town's grid; the rules produce workers and knights; walls grant a `negate` burn bonus on the defence |
| B5 | the climax: the forced assault, or a player card to ride to the antagonist's seat once progress is pushed down |

Why these two: they show the user's scaling, a lone hero then a ruler, with one contract and one dealer. A3 shows it
inside a single run: the levy turns a lone hero into a small force with a resources hand.

## 8. Conflations in today's code (kept from revision 1)

1. A settlement's condition is written directly (`finishSituation`, `setCondition`), outside `WorldState.apply`. I
   propose a `settlement-condition` AtlasEvent.
2. `Situation` holds four concerns: the conflict, the run's map, the challenge's play, and the items.
3. Two clocks: runplan's `RunClock` and `SituationRun.clock` with `areaMinutes`, the same rule written twice.
4. Two encounter vocabularies: `EncounterKind` and the `AreaPlay` kinds. `LivePlay` would be what's played, and
   `EncounterKind` would stay only as the hero's likes.
5. Three item representations: `ItemDef`/`Loadout`, `CharacterRecord.gear` strings, and `Instance`. A kept item would
   be an `Instance` and `ItemDef` its run-time view.
6. A faction's feeling toward the player is in both `Faction.attitude` and `Diplomacy.opinion(player)`.
7. `HERO_NAMES` lives in runplan/consequences.ts, with the outcome rules.
8. `Settlement.stores`, `people` and `needs` have no owner that ticks them. A ruler's holdings would read them, so the
   settlements system should own the economy step.

And one in runsit that this design removes: the hold's levy is a special case in `finaleSetup`, where it should be a
resource gained.

## 9. Missing, by owner

| item | owner | needed by |
|---|---|---|
| hero abilities as data (raise-dead, telekinesis, runes, lance) | play | player offers of #13, #17 |
| caves, dams, magic nodes as features | terrain; atlas (LW5) | #14, #16 |
| `settlement-condition` AtlasEvent; stores ticking | world state; settlements | §8 items 1 and 8 |
| live plays: delve, hold, escort, break, duel, hunt, explore | runsit's area code | the player offers |
| function styles in structures | structures | building |
| opportunities and rumours in the snapshot | world state | carry-over, visibility |
| recruitable agents (where a knight or a scout comes from: a hold's hall, the market, a freed captive) | the templates + settlements | knight and scout offers |

## 10. Questions

Revision 3's three are answered (revision 4, at the top): no hands on screen (opportunities on the map), a turn may
offer one option, the dealer deals the most expensive affordable, tags and bonuses persist, the dealer is tuned by
iteration. A ruler may ride out and back at a cost in turns.

Revision 2's ten are answered (DECISIONS round 120, latest entry): commitment is from what's available to the
character; forced cards exist; one option per card; travel is player cards; agents are interchangeable, with tags and
bonuses. Revision 3's questions, as asked:

1. **Hand sizes.** Three player cards (the next destinations) and up to four resource cards. Is that right, or should
   the resources hand grow a little with scale (a ruler 3, an empire 5) while the cards grow heavier?
2. **Levelling between runs.** Should tags and bonuses (veteran, sapper, warden) stay with named agents into the next
   run through their CharacterRecords, or are they won and spent within a run?
3. **A ruler's player card.** At a fixed seat, is every player card at the seat (defend, build, petition), or may the
   ruler ride out on a card and return (the castle-court loop's "personally join skirmishes")?
