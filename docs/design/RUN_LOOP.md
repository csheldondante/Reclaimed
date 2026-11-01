# The run loop: one kind of opportunity on the strategic map (design draft, revision 2)

A draft for a design session with the user (BACKLOG RN2, with RN1, LW3, LW4, LW5). Nothing here is built. It is on
branch `runloop`, merged with `places` e9414fc.

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

## In ten lines

1. The only unit is the **Opportunity**: where, what it needs locked (`requires`), what it consumes (`costs`), how long
   it takes (`duration`), and its outcome table (`outcomes`).
2. **Resources** are of one shape. Agents (the player, companions, knights, diplomats, scouts, prospectors, workers,
   armies, ships) are locked while committed and may not come back. Goods (coin, supplies, materials, ore …) are spent.
3. A **Commitment** is made at the player's strategic location. If it includes the player, the opportunity's
   `challenge` is played now, with character control or the building view. Otherwise it **resolves** autonomously at
   `start + duration`, with odds from the resources committed.
4. A **Resolution** returns the survivors, applies the outcome to the world state, gives rewards (new resources too),
   and spawns or reveals new opportunities. Many commitments run at once.
5. The **Strategic map** shows the known opportunities. The GM's **TravelRule** (fixed, choice, region, open) says where
   the player may go. Exploration, scouting, rumours and diplomacy move opportunities from hidden to rumoured to known.
6. **Scale emerges from holdings**. A lone hero has only the player, so every opportunity it can take is a playable
   one. A ruler's knights and armies make many run at once. Holding a knight makes the knight templates spawn.
7. **Generation**: templates state requirements, costs, duration, outcomes and a challenge (if they need the player).
   They are matched against location, holdings and run facts, then scored and spawned at places. Siblings at one place
   (delve it yourself, or send workers to pump it) are separate opportunities that exclude each other.
8. There are 23 worked templates, re-cast as about 50 sibling opportunities with their requirements (§5.4). The GM
   writes the conflict and flavours or extends the templates; `oppcheck` validates.
9. Vertical slice: (A) runsit's horde run as a lone hero on a "choice of destinations" map, where the hold's levy
   becomes an **army resource** and opens autonomous opportunities, the scaling shown in one run; (B) the same
   conflict as a ruler at a fixed location, with knights, workers and nightly imposed defences.
10. The eight conflations stand (§8). There are 10 open questions (§10), mostly about how to read the correction.

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

 a round:
   the strategic map shows the known opportunities (and the visible unaffordable ones, greyed with what's missing)
   the player may move its strategic location (within the TravelRule; travel takes time, and its legs may meet opportunities)
   from where it is, the player commits resources to any number of affordable opportunities
       ├─ any commitment that includes the player is this round's playable challenge (character control or building)
       └─ the rest are locked and resolve on their own at start + duration
   the clock moves by what the round took (the challenge's play, the travel)
   every commitment whose time is up resolves: survivors return, outcomes apply, new opportunities spawn or are revealed
   the conflict's due escalation steps fire (the world changes on the map); imposed opportunities appear
   until a climax holds → the climax opportunity (it requires the player) → carry-over
```

Why the player is a resource and nothing else is special: the user's guiding principle. One mechanism (commit, lock,
resolve) covers the hero's own play, a companion's errand, a knight's quest and an army's campaign. "Dispatch" is
simply what committing a non-player resource looks like.

Why a round is defined by the player's challenge: "the playable challenge for that round". The player resource can be
in only one opportunity at a time, so each round has at most one playable challenge. Autonomous opportunities keep
running on the clock while it is played.

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

/** One agent resource the player holds. A group (workers, an army) is one resource with a count. */
export interface Agent {
  id: string;
  kind: AgentKind;
  name: string;
  /** a CharacterRecord id when it's a person the world remembers (the hero, a companion, a named knight) */
  character?: string;
  /** a group's size (workers: hands; army: companies); 1 for a person */
  count: number;
  /** how good, 0..1 per skill: autonomous odds read these (fight, scout, sneak, talk, build, heal, haul, dig) */
  skills: Partial<Record<Skill, number>>;
  /** lasting conditions (CharacterRecord.statuses' words: wounded, cursed …) */
  statuses: string[];
  /** its traits (traits.ts: undead for a raised company) */
  traits?: string[];
  /** world units a run minute: how fast it reaches an opportunity's location and comes back */
  pace: number;
  /** locked by this commitment, if any */
  committed?: string;
}
export type Skill = 'fight' | 'scout' | 'sneak' | 'talk' | 'build' | 'heal' | 'haul' | 'dig' | 'sail';

/** Everything the player holds: what decides which opportunities it can take, and so its scale. */
export interface Holdings {
  agents: Agent[];
  goods: Partial<Record<GoodKind, { stock: number; rate: number /* a round */ }>>;
  /** things that matter (an artifact, a hoverbike in the garage) */
  things: InstanceId[];
  /** settlements the player rules (a ruler's seat and vassals): their stores flow into `goods`, their people into workers */
  rules: string[];
  /** non-combatants the player must keep alive (a refugee column) */
  dependants?: { count: number };
}

/** Where the player is on the strategic map: the only place it can commit from. */
export interface StrategicLocation {
  region: RegionId;
  settlement?: string;
  at: [number, number];
}

/** How freely the player may move (the GM's choice: "a fixed location, a choice of destinations, a region, or open travel"). */
export type TravelRule =
  | { kind: 'fixed' }
  | { kind: 'choice'; destinations: StrategicLocation[] /* from here: runsit's ways on */ }
  | { kind: 'region'; regions: RegionId[] }
  | { kind: 'open' };
```

The **scale is derived, never stored**: a lone hero holds only the player; a party adds companions; a ruler has
`rules` and knights, diplomats, workers, armies; an empire has many settlements and armies. A function
`scaleOf(holdings)` names it for the card and for the templates' difficulty bands.

Why goods and agents are separate kinds: costs are spent and requirements are locked and returned. The user's text has
both ("resource requirements, costs").

### 4.2 Opportunity

```ts
export interface Opportunity {
  id: string;
  /** its template (§5), or 'gm' */
  template: string;
  /** siblings at one place: taking one retires the others (delve it yourself, or send workers to pump it out) */
  group?: string;
  title: string;
  pitch: string;
  /** where it happens; the resources travel there at their pace (counted in the duration) */
  location: { region: RegionId; settlement?: string; at?: [number, number]; site?: number };
  /** why here: the facts it was spawned from, quoted for the card and the GM */
  because: string[];
  offeredBy: { settlement?: string; faction?: FactionId; character?: string; land?: true };

  /** agents locked while it runs, by kind and count, with what they must be (a skill floor, a trait) */
  requires: Requirement[];
  /** goods spent when committed */
  costs: Partial<Record<GoodKind, number>>;
  /** run minutes from commitment to resolution, travel there and back included (a player challenge: its planned play) */
  duration: number;

  /** present exactly when `requires` includes the player: what is played (oppcheck enforces it) */
  challenge?: Challenge;
  /** present exactly when it doesn't: how it resolves on its own */
  autonomous?: { skill: Skill; difficulty: number; danger: number };

  /** what can come of it, by tier (a challenge's result, or the autonomous roll, picks the tier) */
  outcomes: OutcomeTable;

  /** hidden: not shown; rumour: shown vaguely (a place, a hint) until revealed; known: shown in full */
  visibility: 'hidden' | 'rumour' | 'known';
  /** gone at this run minute, or when a condition holds (the town has fallen) */
  expires: number | Condition[];
  /** the conflict's hooks it answers or foreshadows */
  hooks: string[];
  /** the conflict forces it on the player now (the night's assault, outriders on the road): see §10 q2 */
  imposed?: boolean;
  score?: Record<string, number>;
}

export interface Requirement {
  kind: AgentKind;
  /** a group's size (workers: 10), or how many agents of the kind */
  count: number;
  /** each committed agent must have at least this skill (a scout's scouting 0.4) */
  skill?: { skill: Skill; min: number };
  traits?: string[];
}

/** What the player plays: one of the two playable systems. */
export type Challenge =
  | { system: 'character'; play: LivePlay; minutes: number }
  | { system: 'building'; build: BuildChallenge };

/** runsit's AreaPlay plus the kinds the templates need (each needs a player in runsit/area.ts). */
export type LivePlay =
  | AreaPlay                                                               // flee, ambush, deliver, trader, town
  | { kind: 'delve'; site?: number; depth: number; prize?: string }
  | { kind: 'hold'; at: [number, number]; seconds: number; waves: number }
  | { kind: 'escort'; who: string; count: number; to: [number, number] }
  | { kind: 'break'; target: string; what: 'dam' | 'bridge' | 'wall' | 'seal' }
  | { kind: 'duel'; character: string }
  | { kind: 'hunt'; role: string; count: number }
  | { kind: 'explore'; radius: number };                                   // walk a region: reveals what's in it

export type Tier = 'triumph' | 'success' | 'cost' | 'failure' | 'disaster';
export type OutcomeTable = Partial<Record<Tier, Resolution['outcome']>> & { success: Resolution['outcome']; failure: Resolution['outcome'] };
```

Why `challenge` and `autonomous` are mutually exclusive and keyed on `requires`: the user's rule, "their resource
requirements determine who undertakes them". The kind of opportunity follows from what it needs, not from a separate
category field.

Why siblings rather than alternative requirements on one opportunity: each opportunity keeps one set of requirements,
as STRATEGIC_MAP says ("predefined resource requirements"). The choice between doing it yourself and sending workers
is a choice between two opportunities at one place.

### 4.3 Commitment and resolution

```ts
/** Resources locked to an opportunity. Made only from the player's strategic location. */
export interface Commitment {
  id: string;
  opportunity: string;
  /** the agents locked (ids from Holdings.agents), and the goods spent */
  agents: string[];
  spent: Partial<Record<GoodKind, number>>;
  /** where it was made from (must equal the strategic location at commit) */
  from: StrategicLocation;
  start: number;
  /** start + duration */
  resolves: number;
  /** the autonomous roll: made at commit from the seed, so a run replays (the odds were shown before committing) */
  roll?: { seed: number; odds: Record<Tier, number> };
}

export interface Resolution {
  commitment: string;
  tier: Tier;
  /** the agents that come back, changed (wounded, a group thinned), and those lost */
  returns: { agent: string; count?: number; statuses?: string[] }[];
  lost: { agent: string; count?: number; how: string }[];
  /** a few lines for the report on the map */
  report: string[];
  outcome: ResolutionOutcome;
}

/** What it does: story.ts's Outcome (the world) plus the run's own parts. */
export interface ResolutionOutcome extends Outcome {
  text: string;
  characters?: CharacterChange[];
  /** the player's holdings: goods (now and per round), new agents (a knight joins, the hold's levy), things */
  gain?: { goods?: Partial<Record<GoodKind, number>>; rates?: Partial<Record<GoodKind, number>>; agents?: Omit<Agent, 'id' | 'committed'>[]; things?: { kind: string; name?: string }[]; rules?: string[] };
  /** the strategic location moves (passage bought by sea; the column settles: `settle`) */
  move?: StrategicLocation;
  settle?: { name: string; region: RegionId; at: [number, number] };
  /** diplomacy: agreements and remembered interactions (with witnesses) */
  diplomacy?: { agree?: Omit<Agreement, 'since'>[]; note?: Omit<Interaction, 'run'>[] };
  /** opportunities this spawns (template ids at places) and those it reveals (rumour → known, hidden → rumour) */
  spawns?: { template: string; location: Opportunity['location'] }[];
  reveals?: { region?: RegionId; opportunities?: string[]; to: 'rumour' | 'known' }[];
  /** the conflict: progress pushed back (−) or forward (+), steps cancelled, hooks raised */
  conflict?: { progress?: number; cancel?: string[]; raises?: string[] };
  /** the GM's travel rule changes (a road opens; the hero is pinned at a siege) */
  travel?: TravelRule;
  /** a settlement's condition: an AtlasEvent kind, not a direct write (§8 item 1) */
  settlement?: { id: string; condition: 'thriving' | 'struggling' | 'besieged' | 'abandoned' | 'ruined' };
}
```

**Autonomous odds.** `p = σ((Σ committed skill × count weight − difficulty × band) / spread)`, cut into tiers. `danger`
says how often failure becomes disaster (agents lost). The odds are shown on the card before committing: the user's "no
manual resource allocation" means the requirements are fixed, so what the player decides is which opportunities to
take, not how to split forces.

**No agents required** (buying word at a market, a ransom, passage bought): such an opportunity only spends goods. It
resolves autonomously after its duration, usually at sure odds. It is still committed from the strategic location.

**Player challenges.** The challenge's result maps onto tiers. runsit's `AreaResult` gives won, won hurt, lost and
fell. A building challenge is met or not against its goal. Agents committed alongside the player (a companion, the
levy) are in the challenge as followers (`Followers.recruit`).

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

### 4.5 Clock and round

```ts
export interface RunClock {
  /** run minutes (runsit's unit: a challenge counts its planned minutes, up to 1.5x when played slower; a road its distance at the pace) */
  now: number;
  round: number;
  /** a ruler's days, if the run has them (a day's minutes; the night from this share) */
  day?: { minutes: number; nightFrom: number };
  deadline?: number;
}

/** The strategic map's state machine (pure; Node-testable, as SituationRun is). */
export interface StrategicMap {
  readonly conflict: Conflict;
  readonly holdings: Holdings;
  readonly clock: RunClock;
  location: StrategicLocation;
  travel: TravelRule;
  /** visible opportunities (known, rumours), each with whether it's affordable now and what's missing if not */
  visible(): { opportunity: Opportunity; affordable: boolean; missing: string[] }[];
  /** move the strategic location (within the TravelRule): the minutes it takes, and any opportunities met on the way */
  go(to: StrategicLocation): { minutes: number; met: Opportunity[] };
  /** commit the opportunity's required resources from here (fixed by its `requires`: no allocation) */
  commit(opportunity: string): Commitment;
  /** the player's challenge came out this way */
  played(commitment: string, tier: Tier): Resolution;
  /** the round ends: the clock moves, due commitments resolve, steps fire, imposed opportunities appear, spawning runs */
  endRound(): { resolved: Resolution[]; fired: string[]; imposed: Opportunity[]; climax: Opportunity | null };
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
| `StrategicLocation`, `TravelRule` | `SituationRun.at` and its choices (a "choice of destinations"), runplan's legs | the GM's choice, data; runsit's area graph is `choice` |
| `Opportunity` | `SituationArea` + `AreaPlay` (a player opportunity's challenge), `SituationChoice` (the way there), `RunStage`, `EnRouteEvent` poi | uniform; with requirements, costs, duration, visibility, expiry |
| `Challenge` / `LivePlay` | `AreaPlay` (kept as a member), runplan's `EncounterKind` (only as the hero's likes) | grows by delve, hold, escort, break, duel, hunt, explore; a building challenge |
| `Commitment`, `Resolution` | `SituationRun.areaDone`, `PlayedStage`, `StageOutcome` | new: locking, concurrency, autonomous odds |
| `ResolutionOutcome` | `Outcome` (extends it), `CharacterChange`, `ChoiceEffect` (warn and evacuate become conflict or holdings effects), `SituationEnding.settlement` | adds gain, move, settle, diplomacy, spawns, reveals, conflict, travel |
| `Conflict` | `Situation.threat` + `target` + `endings`, `SessionStory.happenings`, `FailureRule` | the horde is one conflict; `threat.arrives` is a step; the town finale is a climax opportunity |
| `RunClock` | `SituationRun.clock`, `areaMinutes`, runplan's `RunClock` | one clock (§8 item 3) |
| `StrategicMap` | `SituationRun` | generalised: visible, go, commit, played, endRound |
| `CarryOver` | `finishSituation`, `RunRecord`, `WorldState.record` | adds conflict, agents, rules, open opportunities |

**What runsit's `Situation` already is, in these terms.** A lone hero (holdings: the player). The travel rule is
`choice` (the ways on at each area's edge). Each area is a player opportunity at a destination, with its `AreaPlay` as
the challenge and its planned minutes as the duration. The horde is a conflict with one step (`arrives`). The town is
the climax opportunity. The levy is a resolution that gains an `army` agent, though today it is a special case in
`finaleSetup`. The first step is an adapter (`situationToMap(sit)`), with a Node test that every path gives the same
endings and clock as `SituationRun`. The `Situation` file format stays until the user agrees to a new one.

## 5. Generating opportunities

### 5.1 The process

```
 LocationFacts + Holdings + RunFacts
   1 match: each template × each place in the world's spawn area whose needs hold, and whose requirements use agent
     kinds the player holds or can get (a template needing a knight spawns only once a knight is held or offered)
   2 instantiate: fill the slots (names, regions, magnitudes; requirements and duration scaled to the place and band)
   3 score: theme, foreshadowing, variety, difficulty for the holdings, the hero's likes (player opportunities)
   4 spawn: up to a budget per place and per region, best first; siblings spawned together; visibility set by what the
     player knows of the place (visited, scouted, an ally's, a rumour's)
   5 GM: may swap, flavour, impose, or add its own in the grammar (§5.6)
   6 oppcheck (§5.7)
   7 they are in the world: the strategic map shows the visible ones
```

When it runs: at the run's start, for the world in reach of the travel rule. Then for a place, when something reveals
it (exploration, scouting, a rumour, diplomacy). Then for the world, when the holdings gain a new agent kind (a knight
joins, so knight templates are matched). And when a resolution or an escalation step changes a place's facts (the
shaft drained, the town besieged). It is pure CPU and deterministic from the seed, the world version and the round,
and its time will be measured in a perf script, as runplan's is.

**The spawn area** follows the travel rule. Fixed means within N borders of the seat, a sphere that grows with vassals
(`rules`). Choice means the destinations and their surroundings. Region means the named regions. Open means within a
few legs of the player, refreshed as it moves.

**Two guarantees** (checked, never relaxed silently): at least two affordable player opportunities are reachable this
round, so the player always has something to play. And at least one visible opportunity answers or foreshadows the
conflict.

### 5.2 Inputs

`LocationFacts` (unchanged from revision 1; purpose and story are now on places): the region (kind, tier, climate,
rivers, lava, stamps, ground), its `RegionState`, the settlement (size, condition, faction, purpose, story, stores),
features (excavation sites and buried props, lakes, road crossings; caves, dams and nodes missing), factions present
(presence, attitude, power), agreements holding there, remembered people there.

`HoldingsFacts`: the agent kinds and counts held, their skills and traits; the goods and their rates; the things; the
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
  needs: Need[];                 // must hold at the place (the closed vocabulary of revision 1: purpose, story, size,
  prefers?: Need[];              //  condition, region, state, flooded, storm, feature, mark, faction, agreement, person,
                                 //  hero, holdings, conflict, not)
  /** the opportunities it spawns at the place, siblings in one group (taking one retires the others) */
  offers: TemplateOffer[];
  answers?: string[];
  foreshadows?: string[];
  /** run minutes the offers stay open */
  lasts: number;
  once?: 'run' | 'place';
}

export interface TemplateOffer {
  id: string;
  title: string;
  requires: Requirement[];       // scaled by the band: workers 6 → 10 at a city
  costs: Partial<Record<GoodKind, number>>;
  duration: number;              // base minutes; + travel at the slowest committed agent's pace
  challenge?: Challenge;         // iff requires the player
  autonomous?: { skill: Skill; difficulty: number; danger: number };
  outcomes: OutcomeTable;        // with slots
}
```

A `Need` of kind `holdings` replaces revision 1's `base`: `{ kind: 'holdings'; agents?: AgentKind[]; rules?: boolean;
dependants?: boolean }`. A template whose offers require a knight also needs one held, and that is how "having a knight
creates opportunities requiring a knight". A template with a player offer and a knight offer spawns both when both are
held, and only the player's when the player has no knight.

### 5.4 The library: 23 templates as uniform opportunities

How to read it: **P** means it requires the player and is played (C is character control, B is building). Every other
row resolves autonomously (A, with the skill it rolls). Durations are in run minutes at a town, before travel. Costs
are goods. Siblings of a template exclude each other. A ruler's knight or army offers appear only when such agents are
held.

| # | template (needs) | offer | requires | costs | dur. | resolved | world consequence | gameplay reward |
|---|---|---|---|---|---|---|---|---|
| 1 | **The Flooded Shaft** (mining; flooded story or wet; undead near preferred) | Delve for what knocks | player | supplies 1 | 6 | P·C delve | `mark` the open shaft; failure: `raise-dead` there | an artifact (`Instance`) |
| | | Pump it out | workers 8 | materials 6 | 40 | A build | `drain` (the basin really drained); ore `rate` + | ore income each round |
| | | Seal the adit | player *or a sibling:* workers 4 | materials 3 | 3 / 20 | P·C break / A dig | `lay-dead` −0.2; `mark` the sealed adit | the conflict's raise-dead step there cancelled |
| 2 | **The Strike at the Pit** (mining; owner power > 0.5) | Speak for the miners | diplomat (talk ≥ 0.4) | renown 2 | 20 | A talk | `mineral-rights` to a free company (diplomacy); presence shift | a vassal mine: ore flow by agreement; sappers join (workers, dig) |
| | | Hold the gate for the owners | player | none | 5 | P·C hold | owner `attitude` +; the miners' grudge (interaction, halfLife ∞) | coin; a bounty raised (spawns #22 against you) |
| 3 | **The Last Ship Out** (port; conflict within 2 borders; dependants) | Buy passage | none of the player's agents beyond the column | coin 8, supplies 4 | 10 | A talk | port `attitude` + | the strategic location **moves** by sea (`move`), past the pursuers |
| | | Take the ship | player | none | 5 | P·C ambush | port `attitude` −; `mark` the stolen cog; the port's trade `rate` − | the same move, and a ship agent |
| 4 | **The Wreckers' Light** (port; storm ≥ 0.4) | Light the lamp | player | supplies 1 | 5 | P·C hold | `mark` the lighthouse kept; a `trade` agreement | trade income; a pilot (companion, sail) |
| | | Pay off the wreckers | diplomat | coin 4 | 15 | A talk | wreckers' presence +; port `attitude` − | coin share of wrecks each round |
| 5 | **Fell the Old Wood** (lumber; an overgrown ruin next door) | Clear it | workers 10 | supplies 3 | 40 | A haul | `overgrow` −0.4 (the forest really thins); the ruin surfaces (spawns #13) | timber (materials) |
| | | Walk the old wood | player | none | 5 | P·C explore | reveals the region's hidden opportunities; a grove kept | a sanctuary (healing for wounded agents each round, LW1) |
| 6 | **The Firebreak** (lumber or farming; dry; fire hook) | Cut the break | player | none | 4 | P·C hold (the real fire) | the region's `burn` avoided; the camp stands | fresh mounts (`pace` item) |
| | | Send axemen ahead | workers 6 | supplies 2 | 15 | A haul (danger 0.3) | as above if success; `burn` 0.6 if failure | the same, and the risk to the workers |
| 7 | **Harvest Before the Host** (farming; on the conflict's route; progress 0.2-0.7) | Bring it in | workers 8 | none | 20 | A haul | grain `stock` + | supplies |
| | | Burn the fields | player | none | 4 | P·C hold (set the fires) | `burn` the fields' region; farmers' `attitude` − | the conflict's `drift` − (the host forages less) |
| 8 | **Blight in the Barley** (farming; shadow or undead near) | Trace it to the source | player | supplies 1 | 6 | P·C delve | `light` +0.1; the source **revealed** | the conflict's next step shown early (foreshadowing); a ward item |
| | | Send the priest | priest (heal ≥ 0.4) | supplies 1 | 25 | A heal | `light` +0.1 | a ward item |
| 9 | **The Caravan Contract** (trading; roads ≥ 3; hostiles on a road) | Ride with the caravan | player | none | 6 | P·C escort | a `trade` agreement (flows) | coin, trade income |
| | | Hire it a guard | knight *or* army 1 | coin 2 | 30 | A fight | the same agreement on success | trade income without the player's round |
| | | Rob it | player | none | 4 | P·C ambush | the town's `attitude` −; bounty (spawns #22 against you) | coin, goods, items |
| 10 | **The Market of Rumours** (trading) | Buy word | none | coin 3 | 5 | A talk (sure) | none | **reveals**: rumours in reach → known; the conflict's next step and its time |
| 11 | **The Levy of the Hold** (hold or city; same realm; not hostile) | Carry the word | player | none | 3 + the ride | P·C deliver | the hold's `attitude` +; the levy marches in the session | **gains an army agent** (the levy), committed to the climax or to #12, #14 |
| | | Send an envoy | diplomat | renown 1 | 25 | A talk | the same | the same army, later |
| 12 | **The Oath of a Small Hold** (hold; power < 0.4; conflict near) | Take its oath | diplomat *or* player | renown 2 | 20 / 5 | A talk / P·C deliver | `vassalage` (diplomacy); presence becomes the player's | `rules` + (its stores flow in; the spawn area grows) |
| | | Demand tribute | army 1 | none | 30 | A fight | `tribute` agreement; its grudge | coin each round |
| 13 | **The Dig** (excavation site) | Lift it out | player (with telekinesis) | none | 5 | P·C break | the props raised in the session; `mark` the excavation | an artifact (`Instance` with its history) |
| | | Dig it out | workers 6 (dig) | supplies 2 | 45 | A dig | the same | the same; a statue for the seat (renown each round) |
| | | Survey it | prospector | supplies 1 | 15 | A dig (sure) | none | **reveals** what lies there (the artifact named); halves the dig's duration |
| 14 | **Break the Dam** (dam, or a lake upstream of the route) | Break it | player | none | 4 | P·C break | a real `flood` downstream (`Terrain.flood`); farms `ruin` | the conflict's route cut: a step cancelled, a long delay |
| | | Sap it | workers 6 (dig) *or* army 1 | materials 2 | 25 | A dig (danger 0.4) | the same, and the flood comes when it resolves | the same, without the player's round |
| | | Pay the keepers to hold it | diplomat | coin 4 | 15 | A talk | keepers' `attitude` + | the downstream town's gratitude (renown) |
| 15 | **Burn the Bridge** (crossing on the route) | Burn it under them | player | none | 3 | P·C break (the real fire) | the crossing gone (`mark`; the road's crossing removed: later runs' graph) | the arrival delayed (runsit's `delay`) |
| | | Hold the ford | army 1 *or* knight 2 | supplies 2 | until the host passes | A fight (danger 0.5) | the host's forces − | the delay, and the risk to the army |
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
| | | Send diggers to the spring | workers 6, prospector | supplies 2 | 40 | A dig | the spring's `mark` | the same, without the player's round |
| 22 | **The Champion at the Crossroads** (a named lieutenant; a crossing on the route; or a bounty) | Duel | player | none | 3 | P·C duel | the lieutenant dies (`CharacterRecord`); antagonist `power` − | a named weapon; the conflict's progress −0.1 |
| | | Send a knight | knight (fight ≥ 0.6) | none | 20 | A fight (danger 0.5) | the same, or the knight dies | the same |
| 23 | **The Captive** (a person with `captive:<faction>` here) | Get them out | player | none | 6 | P·C escort | the captive's statuses cleared; the holder's `attitude` − | **gains a companion** (their skills and gear) |
| | | Ransom | diplomat *or* none | coin 6 | 20 | A talk (sure) | the holder's coin + | the same companion |

(Some cells read "player *or* a sibling …". Each such cell is two sibling opportunities with one requirement set each,
not one opportunity with alternatives.)

**Coverage.** Every template has a player offer, so a lone hero always has something to play. Templates 2, 4, 9, 11,
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
  "answers": ["undead"], "foreshadows": ["undead", "barrows"], "lasts": 60, "once": "place",
  "offers": [
    { "id": "delve", "title": "Delve for what knocks", "requires": [{ "kind": "player", "count": 1 }], "costs": { "supplies": 1 }, "duration": 6,
      "challenge": { "system": "character", "play": { "kind": "delve", "depth": 3, "prize": "{artifact}" }, "minutes": 6 },
      "outcomes": {
        "success": { "text": "You came up with {artifact}; the knocking stopped.", "atlas": [{ "kind": "mark", "regions": ["{region}"], "magnitude": 1, "detail": { "name": "the open shaft of {settlement}", "kind": "mine" } }], "gain": { "things": [{ "kind": "{artifact.kind}", "name": "{artifact}" }] } },
        "failure": { "text": "The dead came up behind you.", "atlas": [{ "kind": "raise-dead", "regions": ["{region}"], "magnitude": 0.2 }], "characters": [{ "kind": "status", "id": "{hero}", "add": ["wounded"] }] } } },
    { "id": "pump", "title": "Pump it out", "requires": [{ "kind": "workers", "count": 8 }], "costs": { "materials": 6 }, "duration": 40,
      "autonomous": { "skill": "build", "difficulty": 0.4, "danger": 0.1 },
      "outcomes": {
        "success": { "text": "The shaft is dry; ore comes up again.", "atlas": [{ "kind": "drain", "regions": ["{region}"], "magnitude": 1 }], "gain": { "rates": { "ore": 2 } } },
        "failure": { "text": "The pumps failed; the water won.", "gain": { "goods": { "materials": -3 } } } } },
    { "id": "seal", "title": "Seal the adit", "requires": [{ "kind": "player", "count": 1 }], "costs": { "materials": 3 }, "duration": 3,
      "challenge": { "system": "character", "play": { "kind": "break", "target": "adit", "what": "seal" }, "minutes": 3 },
      "outcomes": {
        "success": { "text": "The adit is rubble. Nothing more comes up.", "atlas": [{ "kind": "lay-dead", "regions": ["{region}"], "magnitude": 0.2 }], "conflict": { "cancel": ["{step.raise-dead-here}"] } },
        "failure": { "text": "The roof held; the dead didn't.", "atlas": [{ "kind": "raise-dead", "regions": ["{region}"], "magnitude": 0.15 }] } } }
  ]
}
```

### 5.5 Scoring

Scoring now decides **what spawns** (a budget per place and region, best first) and **what the map highlights**. It no
longer picks a fixed board.

| part | how |
|---|---|
| theme `T` | the share of `prefers` that hold, weighted by how far past the threshold; the purpose's score margin; overlap of `themes` with the conflict's hooks |
| foreshadow `F` | `foreshadows ∩ hooks`, weighted by how soon the matching step is due; `answers ∩` raised hooks |
| variety `V` | penalties for the same template or region as recent spawns, and for a map dominated by one challenge kind |
| difficulty `D` | the offers' difficulty against the holdings that can meet them (the player's band by the conflict's progress; an autonomous offer against the best agents of its kind) |
| hero `H` | for player offers, `ControllerProfile.encounters` for the live kind; 1 for building if the hero has the mode |

The starting weights are `0.30 T + 0.20 F + 0.15 V + 0.20 D + 0.15 H`, tuned in a viewer. Unaffordable known
opportunities stay visible, as the user said. The map shows what's missing ("needs 8 workers"), which is also how a
player learns what holding more would open.

### 5.6 The GM

| when | does | can't |
|---|---|---|
| before the run | writes the Conflict and the TravelRule; may author set-piece opportunities | name what the wiki lacks |
| spawning | sees the top candidates per place with scores and `because`; swaps, flavours (titles, pitches, who offers it, the artifact's name), sets visibility (a secret kept hidden) | spawn an offer whose needs fail |
| imposing | through a step's `imposes`: an opportunity the player must take now (the night assault, the outriders) | impose more than one at a time |
| inventing | a new template in the grammar, saved under `data/opportunities/`, checked by `oppcheck` | invent `Need`, `AgentKind` or `LivePlay` kinds (contract changes) |
| mid-run | between rounds: add or move a step, change the travel rule, retire an opportunity, all data checked again | rewrite resolutions already made |

As runsit does today, the deterministic generator always runs, and a GM file for this world and round replaces or
flavours its output. The card says which one it is.

### 5.7 `oppcheck`

Everything situationcheck's design checked (shapes, references, needs hold, AtlasEvents realisable per kind, distinct
outcomes across siblings, a climax reachable), plus these:

| check | rule |
|---|---|
| uniformity | `challenge` present iff `requires` has the player; `autonomous` present iff not; a challenge's live kind has a player in the area code; a building challenge only for a hero with the mode |
| requirements | agent kinds known; counts > 0; skill floors in 0..1; a requirement no agent in the world could ever meet is an error (a knight offer in a world with no knights to recruit) |
| costs and gains | goods known; no outcome loses more agents than were committed; gains of new agent kinds name a template family that uses them (a reward that opens nothing is flagged) |
| duration | > 0; at least the travel there and back at the slowest required agent's pace; before the expiry |
| the strategic location | a commit is only from the location; a player offer is reachable under the travel rule this round, or marked unreachable |
| the guarantees | §5.1's two: player offers reachable, one answering the conflict |
| imposed | an imposed offer requires the player and expires the same round |

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
night's imposed defence. So building is how a ruler gets the resources that open more opportunities. The structures
system grows the buildings over the following rounds (`CitySpec.progress`).

Still missing for building: the painting UI; function styles and modules in structures (it has house, hut, farmhouse,
barn); `Building.use` from the plan; settlement stores ticking.

## 7. What to build first: a vertical slice

### A. A lone hero: runsit's horde run on the strategic map

| step | what | test / measure |
|---|---|---|
| A1 | `contracts/opportunity.ts`: Agent, Holdings, StrategicLocation, TravelRule, Opportunity, Requirement, Challenge, Commitment, Resolution, Conflict, RunClock | typecheck |
| A2 | `situationToMap(sit)`: the player as the only agent; travel `choice` (the ways on); each area a player opportunity (its `AreaPlay` the challenge); the horde a conflict; the town the climax opportunity; the hold's `deliver` resolving with **gain: an army agent** (the levy) in place of `finaleSetup`'s special case | Node test: every path gives the same endings and clock as `SituationRun` |
| A3 | the levy as a resource: with the army held, #15's "Hold the ford" and #7's "Bring it in" spawn as autonomous offers running while the hero rides on. This is the user's "companions enable additional opportunities that resolve while the hero plays", inside the run they've already played | Node test on seed 1 (the Bumku run): the army commits, resolves at its time, the delay or the stock applied |
| A4 | the generator and six templates (#11, #15, #10, #7, #1, #22); spawning by place with visibility; scoring; the two guarantees | Node tests: deterministic; the Bethorn crossing gets #15 (the GM's Grey Muster names it); time per round measured (expect < 5 ms) |
| A5 | `oppcheck` for those six | runs in `scripts/storycheck.mjs` |
| A6 | the atlas map shows the visible opportunities, the locked agents and their return times, the unaffordable greyed with what's missing; commits from the current destination | headless shot at the phone proxy; the run plays to an ending; driveprofile unchanged |

### B. A ruler at a fixed location

| step | what |
|---|---|
| B1 | the hero is Bumku's warden; travel `fixed`; holdings: the player, two knights, workers 10, a scout, a diplomat; days of N run minutes |
| B2 | opportunities in the seat's sphere from the same templates plus #12, #13, #21; many commitments at once; reports on resolution |
| B3 | the night: the conflict's step imposes a defence (runsit's finale, `FinaleRules`, the real fires) on the player, with escalating counts |
| B4 | building's first cut: paint housing, training and wall onto the town's grid; the rules produce workers and knights, and walls add defence |
| B5 | the climax: the host's full assault, or ride to its seat if progress was pushed down (the travel rule opens for it) |

Why these two: they show the user's scaling, a lone hero then a ruler, on one conflict, one contract and one
generator. A3 shows the scaling inside a single run.

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

## 10. Open questions for the user (mostly about reading the correction)

1. **"Committed from the player's current strategic location"**: must the agents be there too (the knights at the
   seat), or may the player commit any agent it holds, wherever that agent is, as long as the player is at the
   location? I read it as the first, since it makes where the player stands matter.
2. **Imposed opportunities**: the night's assault, outriders on the road, the climax. Are these opportunities the
   conflict forces on the player resource? Or should every opportunity be the player's choice, with the threat as a
   consequence of ignoring a visible one ("defend the walls tonight")?
3. **Alternatives as siblings**: "the player or a knight" as two opportunities at one place, as proposed. Or is it
   one opportunity whose requirement is "one of"?
4. **Travel**: is moving the strategic location itself an opportunity (it requires the player, has a duration, and
   its legs can meet challenges), or a separate action on the map?
5. **Agent quality**: does a veteran knight resolve better than a green one (skills), or are requirements and odds
   fixed per opportunity, with no quality?
6. **The round's length**: the player's challenge sets it, and autonomous commitments tick on the clock meanwhile.
   Should a round with no player commitment (the player waits) advance by a fixed step?
7. **Visibility of the unaffordable**: show all known ones, or a few, ranked?
8. **What carries over**: named agents (knights) as CharacterRecords, yes. Groups (workers, armies) go back to their
   settlement, or stay with the hero?
9. **The GM mid-run**: a live LLM between rounds (desktop only?), or steps written ahead?
10. **Scale changes inside a run** (the levy, a vassal, a settled column): wanted now, as A3 proposes, or only
    between runs?
