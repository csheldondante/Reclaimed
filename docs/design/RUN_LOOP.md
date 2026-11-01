# The run loop: opportunities, encounters, the base and the conflict (design draft)

Draft for a design session with the user (BACKLOG RN2, with RN1, LW3, LW4, LW5). Nothing here is built. Branch
`runloop`, from `places` b596b40 (runsit merged, round 122). It is grounded in the code on places and on `cities` and
`traits`, and lists what is missing.

## In ten lines

1. A run is one loop: the **conflict** (the GM's arc, written before the run) moves on a **clock**. Each **turn** the
   **base** (a lone hero, a party, refugees, a stronghold, an army) is offered a board of **opportunities** at real
   places.
2. The player takes one or more of them: plays it live (a game of skill), spends on it (a resource choice), **dispatches**
   members to it (odds, a report) or **builds** for it (the building view). Each is an **encounter**.
3. Every encounter ends in an **outcome**: world-state changes (AtlasEvents, diplomacy, things), base changes, new
   opportunities, and conflict progress (helping or hindering). Every path leads to a **climax**.
4. Opportunities are **spawned by locations**: a template library matched against what is at the place (purpose,
   story, terrain, region state, factions), the hero (profile, traits, record, gear) and the run (the conflict's phase,
   the clock, past choices).
5. Candidates are **scored** on thematic fit, foreshadowing, variety, difficulty for the base's scale, and the hero's
   likes. A board of 3-5 is picked so it covers more than one kind of play.
6. The **GM** writes the conflict, picks from and flavours the candidates, and may write new opportunities in the
   templates' grammar. Everything is checked by **`oppcheck`**, the third validator after storycheck and situationcheck.
7. runsit's `Situation` is the first instance of the loop: a moving base, a horde conflict, and opportunities at each
   area's edge. An adapter shows the new contract covers it before anything changes.
8. There are 23 worked templates across every base scale and all six settlement purposes. Each has a world consequence
   and a gameplay bonus (§5.4).
9. The vertical slice: (A) runsit's horde run re-expressed and given generated opportunities, then (B) the same
   conflict played from a fixed stronghold with days, a building turn and nightly waves.
10. Eight conflations in today's code are flagged (§8), and there are 12 open questions for the user (§10).

---

## 1. What the user asked for (verbatim)

- Round 120: "It's essentially a set of opportunities the player is presented with that resolve via encounters that
  can help or hinder you and that always progress you towards some climactic ending. Notice it doesn't really matter
  if your at a fixed stronghold or leading a party of refugees to find a new home. They interface can be similar. The
  encounters are the games of skill to determine outcomes or just choices of resource allocation to gain benefits or
  hinderances."
- "Note this also works for adventuring parties since we can scale the opportunities and encounters to your resources."
- "the story of the big conflict which we need to know going into the run so we can foreshadow or establish
  motivations."
- "The character and run objective should inform what the GM sets up for that run but the GM can theoretically update
  the interactions mid run based on player choices. If a character excepts the mantle of leadership as a reward for
  great service then the next run may well be city management for that leader."
- On building: "a new view that essentially lets you paint into the building grid … housing, agriculture, ports, civic
  … instead of building a bunch of new baracks you can expand your training camp or hospital or housing … only some
  heroes will get this mode."
- On the stronghold: "switch between building, fending off threats, dispatching workers and armies you build on the
  atlas map and answering petitions … vassalizing other settlements, sending limited troops or spies on missions with
  different rewards".
- This round: "I love the idea of thinking of locations as spawning opportunities based on what is at the location and
  the current hero and run. I would like a process for generating these. We want them thematic and genuinely
  interesting in terms of world consequences and gameplay bonuses."
- Standing rule (round 120): "when possible make the gameplay actually modify the map during the session not with text
  between sessions. Like actually break a dam and flood a valley don't just say it happened."

## 2. What exists, and what each gives the loop

| piece | where | gives the loop | gap |
|---|---|---|---|
| `Situation` | contracts/situation.ts, runsit/ | a threat with a route and a clock; areas played live (flee, ambush, deliver, trader, town); choices at an area's edge with effects (warn, evacuate, delay); items; four endings as `Outcome` | the threat, the map of areas, the encounter's play and the endings are one structure; only one kind of conflict (horde); choices are fixed when the situation is written; no base beyond the hero and followers |
| `SituationRun` | runsit/state.ts | the turn machine (area → edge → travel → area), the clock (`areaMinutes`, `TRAVEL_PACE`), pursuers, reinforcements, offers, loadout | the turn is "an area" only; no resources; no dispatch |
| `fillSituation` | runsit/fill.ts | the first template: reads standing towns, hostile presence, the region graph, a hold, the hills; sets the clock so the fork is real | one template, hard-wired; no scoring; no reading of purpose or story |
| `situationFor` | runsit/gm.ts | the pattern: a GM file for this world (checked), otherwise the template, and the card says which | carried over as is |
| `checkSituation` | gm/situationcheck.ts | shape, references, reachability, a fork, the clock (some path in time), endings that change the world | `oppcheck` extends it |
| `SessionStory` | contracts/story.ts | `Outcome` (atlas, attitude, flags, give, spawn, say, talk, endRun), `Condition`, `happenings` (world effects on a trigger) | the escalation steps of a conflict are happenings in all but name |
| `RunPlan` | contracts/run.ts, runplan/ | `EncounterKind`, `HeroCapabilities.likes`, `affordances` (what a region affords from its kind and state), `StageOutcome` with `CharacterChange`, `FailureRule`, `RunClock`, `TravelLeg` with `EnRouteEvent`s, `RunTerrainAsk` | a second encounter vocabulary and a second clock (§8) |
| `applyEffects`, `finishSituation` | runplan/consequences.ts, runsit/finish.ts | outcomes applied one way through `WorldState`; `CharacterRecord` history, statuses and gear | a settlement's condition is set outside `WorldState.apply` (§8) |
| `WorldState`, `RegionState` | contracts/world.ts, world-state.ts | sunk, buried, overgrowth, frozen, storm, shadow, undead, ruin, flooded, wetness, presence, marks; faction attitude, power, relations; settlements; characters; history; runs | no rumours or open opportunities between runs; no conflict record |
| `Settlement` | contracts/settlement.ts | size, condition, faction, grids, buildings, people, `stores` (stock and rate), `needs` (Jobs) | on places `stores`, `people` and `needs` are empty (settle/records.ts); no economy ticks them |
| purpose and story | **`cities` only**: settle/purpose.ts, settle/story.ts | `SettlementPurposeRec` (port, mining, lumber, farming, trading, hold, with the scores and why) and `SettlementStory` (founded, raided, walled, burned, flooded, ruined, grew) read from the land and the history | not on places yet; the generator's richest input |
| `Diplomacy` | contracts/diplomacy.ts | interactions that fade; agreements: war, truce, peace, alliance, trade, land-rights, mineral-rights, passage, tribute, vassalage; `rights(region)` | not wired into a run; it is the natural home for "vassalise", "trade deal" and "mineral rights" |
| `Instance`, `CivProfile` | contracts/recipe.ts | things with history (an artifact found, named, stolen); a civilisation's knowledge (uses / repairs / makes / understands) | runs carry items as `ItemDef` ids and characters carry gear as strings (§8) |
| `ItemDef`, `Loadout` | contracts/items.ts | slots, asymmetric items, mechanical effects (call-allies, lure, fire-ward, pace, guard) | the reward vocabulary for a lone hero |
| `Followers`, `Order` | contracts/orders.ts | follow, hold, go, release over Units | the moving base's members in play; "work" and "build" orders are open (FO1) |
| `Units` | contracts/units.ts | spawn, order (guard, go, patrol, attack, follow, flee, work), the hero as an Actor | dispatch needs nothing from it (reports are resolved off-screen) |
| `Terrain` | contracts/terrain.ts | atlas region graph and barriers; `BuriedProp` and `ExcavationSite`; `FloodRequest` (water, sand, magma, ash, silt); terrain requests (exits, obstacles) | caves (round 120's cave networks) and dams are not features in the contract yet |
| traits | **`traits` only**: contracts/traits.ts | intrinsic traits (living, undead, flying, construct, fire_immune …), statuses, effects (heal, raise, damage, status) | hero-side preconditions ("an undead hero", "a healer") read these |
| `ControllerProfile` | contracts/play.ts | speed, climb, jump, fly, water, vegetation, body, bridge, destruction, `encounters` (likes) | no list of a hero's abilities (raise the dead, telekinesis, runes) as data the generator can read |
| atlas facts, wiki | gm/atlas-facts.ts, gm/wiki.ts | regions (kind, tier, climate, rivers, lava, stamps, ground, neighbours), sites, roads and crossings, lakes, realms and world factions | magic nodes (LW5) don't exist |

**What's missing, in one list:** a Base; a Conflict record (antagonist, escalation, climaxes, hooks); opportunities as
generated, expiring offers; a resource ledger for the run; dispatch; the building view and functions; a settlement
economy (stores ticking); purposes and stories on places; hero abilities as data; caves, dams and magic nodes as
location features; rumours (what carries over that the next run can find); and one item representation.

## 3. The loop

```
 before the run                each turn (the clock moves)                                   the end
 ─────────────                 ───────────────────────────                                   ───────
 GM: Conflict  ──┐   ┌─► board: 3-5 Opportunities at real places ──┐
 (arc, hooks,    │   │      (generated: §5; GM-flavoured)             │
  climaxes)      ├──►│                                                ▼
 Base chosen  ───┘   │   the player takes one (or several, by scale): play live │ spend │ dispatch │ build
 (hero, scale,       │                                                │
  members, stores)   │                                                ▼
                     │   Encounter → Outcome: world state, base, unlocks, conflict progress (help / hinder)
                     │                                                │
                     │   the conflict's escalation steps that are due fire (the world changes on the map)
                     └──────────────── until a climax's condition holds ┘ ──► Climax encounter ──► Carry-over
```

Why one loop for every run: the user asked for it ("doesn't really matter if your at a fixed stronghold or leading a
party of refugees"). The base's scale is a parameter that filters and sizes the opportunities, so the interface stays
the same. A lone hero is a base of one.

Why turns rather than continuous time: runsit already works this way (an area played live, then a decision at its
edge). The atlas map is where turns are taken, so the stronghold's day and the journey's leg are the same interaction.
This was the stated default in round 120 and the user didn't object.

## 4. The contract

These are the proposed types, in TypeScript, for a future `src/api/contracts/runloop.ts`. They reuse the existing types
wherever they can. §4.8 maps each type to what exists today.

### 4.1 Base

```ts
import type { FactionId, RegionId, AtlasEvent } from './world';
import type { Outcome, Condition, Bark } from './story';
import type { CharacterChange, EncounterKind } from './run';
import type { InstanceId, MaterialId, Tag } from './recipe';
import type { AreaPlay } from './situation';
import type { Agreement, Interaction } from './diplomacy';

/** How big the base is. It filters which opportunities are offered and sizes their stakes. */
export type BaseScale = 'lone' | 'party' | 'refugees' | 'stronghold' | 'army';

/** What the run spends and earns. Bulk goods use Settlement.stores' keys (a MaterialId or a Tag). */
export type ResourceId =
  | 'supplies'   // food, water, fodder: a moving base eats them every turn; a stronghold's people eat them every day
  | 'coin'       // trade goods and money
  | 'materials'  // timber, stone, iron: what the building view spends
  | 'renown'     // standing that opens doors (a hold's levy, a vassal's oath)
  | MaterialId | Tag;   // ore, grain, cloth … where a template names a specific good

export interface BaseMember {
  /** a CharacterRecord id (the hero, a named companion) or a group of nameless units */
  character?: string;
  group?: { role: string; count: number; faction: FactionId | null };
  /** what they're good at, 0..1: fight, scout, sneak, talk, build, heal, haul (the dispatch's odds read these) */
  skills: Partial<Record<'fight' | 'scout' | 'sneak' | 'talk' | 'build' | 'heal' | 'haul', number>>;
  /** away on a dispatch (its id) until it reports */
  away?: string;
  /** lasting conditions (CharacterRecord.statuses' words: wounded, cursed …) */
  statuses: string[];
}

export interface Base {
  id: string;
  kind: BaseScale;
  name: string;
  /** fixed: a settlement (the stronghold IS a Settlement record); moving: where the column is now */
  position:
    | { mobility: 'fixed'; settlement: string; region: RegionId }
    | { mobility: 'moving'; region: RegionId; at: [number, number]; pace: number /* world units a run minute */ };
  /** the hero who leads it (a CharacterRecord id) */
  leader: string;
  members: BaseMember[];
  /** non-combatants it must keep alive (a refugee column's people; a stronghold's townsfolk are its Settlement.people) */
  dependants?: { count: number; safeAt?: RegionId };
  /** stock and the rate each turn (a stronghold's flows from its buildings; a column's upkeep is negative) */
  stores: Partial<Record<ResourceId, { stock: number; rate: number }>>;
  /** what it carries that matters (artifacts, a hoverbike in the garage): Instances, not names */
  things: InstanceId[];
  /** what it can do now, derived from its members, things and buildings (never stored as truth: §4.8) */
  capacity: BaseCapacity;
}

/** Derived each turn from the base's members, things and (fixed) buildings. Opportunities' requirements read it. */
export interface BaseCapacity {
  /** combat power, a unit's worth = 1 */
  strength: number;
  /** members free to dispatch now */
  free: number;
  /** how many dispatches it can run at once (a lone hero: 0; a party: 1; a stronghold: by its training camp …) */
  dispatchSlots: number;
  /** may it use the building view (the hero's mode and a place to build: round 120 "only some heroes") */
  builds: boolean;
  /** world units a run minute (moving); 0 fixed */
  pace: number;
}
```

Why the base is separate from the hero: the same hero can lead a party one run and a stronghold the next ("accepting
the mantle of leadership"). Why a fixed base is a `Settlement`: the user wants the city game to edit the same data the
world shows (round 83), so a stronghold is a settlement the player owns, not a new record. Why capacity is derived:
the user's principle of derived capabilities (round 85, `compose.ts derive`). A training camp painted in the building
view raises `dispatchSlots`, and nothing stores that number by hand.

### 4.2 Conflict

```ts
/** The run's big conflict: written by the GM before the run (or filled by a template), so encounters can foreshadow it. */
export interface Conflict {
  id: string;
  title: string;
  /** a paragraph: who wants what, and what happens if no one stops them */
  premise: string;
  antagonist: {
    faction: FactionId;
    /** a named leader the world remembers (a CharacterRecord id), if there is one */
    leader?: string;
    /** where its power sits: a region, a settlement, a mark (a cathedral, a node) */
    seat: { region: RegionId; settlement?: string; mark?: string };
    /** what it marches with (a horde's role and count; an army's) */
    forces: { role: string; count: number }[];
  };
  /** what it's after, in world terms the validator can check: the end state if it wins */
  goal: { text: string; wins: Outcome };
  /** 0..1: how far along it is. Escalation steps fire as it passes their `at`; the player's outcomes push it back */
  progress: number;
  /** how fast progress grows on its own, per run minute (the clock's pressure; 0 when only events move it) */
  drift: number;
  /** what happens as it advances: each changes the world on the map, once */
  steps: EscalationStep[];
  /** how it can end: the first whose `when` holds is played */
  climaxes: Climax[];
  /** words the opportunity templates match on to foreshadow it: 'undead', 'flood', 'bridge:r2159', 'leader:c-grey-reeve' */
  hooks: string[];
  /** the template it came from, or 'gm' */
  by: string;
}

export interface EscalationStep {
  id: string;
  /** progress at which it fires (or a condition) */
  at: number | Condition[];
  /** a line for the map and the board ("The Muster crosses the Bethorn") */
  text: string;
  /** what it does to the world: AtlasEvents, spawns (the horde on its route), barks */
  outcome: Outcome;
  /** hooks it makes true (an opportunity can answer it: "Burn the bridge under them") */
  raises?: string[];
  /** fired yet */
  fired?: boolean;
}

export interface Climax {
  id: string;
  when: Condition[] | { progress: number };
  /** where it's played, and what (the town's defence, an assault on the seat, a ritual interrupted) */
  where: { region: RegionId; settlement?: string };
  encounter: EncounterSpec;
  /** the endings, keyed like Situation's (saved, burned, evacuated, fell) but open */
  endings: Record<string, { text: string; outcome: Outcome; ends: 'won' | 'lost' | 'fled' | 'captured' | 'late' }>;
}
```

Why progress and steps rather than a single arrival time: runsit's `threat.arrives` is one step (the horde reaches the
town). A conflict over a run is several (the barrows open, the bridge is crossed, the farms burn, the town is
besieged). Each of these changes the map in the session, as the user asked. Why hooks are plain strings: templates and
the GM match on them, and the validator checks every hook a template foreshadows is one the conflict raises.

### 4.3 Opportunity

```ts
export interface Opportunity {
  id: string;
  /** the template it came from (§5), or 'gm' */
  template: string;
  title: string;
  /** a line in the player's words, shown on the board: "Bumku's lower shaft is flooded — and something knocks below" */
  pitch: string;
  where: { region: RegionId; settlement?: string; at?: [number, number]; site?: number /* ExcavationSite id */ };
  /** why here: the facts it was matched on, quoted for the card and the GM ("a mining town", "flooded to 41") */
  because: string[];
  /** who offers it: a settlement, a faction, a character, or the land itself (a ruin found) */
  offeredBy: { settlement?: string; faction?: FactionId; character?: string; land?: true };
  /** what's at stake in a line, and the outcome tiers the card shows (best and worst at least) */
  stakes: string;
  /** what the base needs to take it */
  requires: {
    scales: BaseScale[];
    strength?: number;
    members?: { skill: keyof BaseMember['skills']; min: number; count?: number }[];
    spend?: Partial<Record<ResourceId, number>>;
    things?: Tag[];
  };
  /** how it's resolved; a template can offer several ways (delve or pump or seal) */
  ways: OpportunityWay[];
  /** it's gone at this run minute (or when a condition holds: the town has fallen) */
  expires: number | Condition[];
  /** known (on the board) or a rumour (shown vaguely until scouted or bought) */
  known: boolean;
  /** hooks of the conflict it answers or foreshadows */
  hooks: string[];
  /** the generator's score and its parts, for the GM and the viewer (§5.5) */
  score?: Record<string, number>;
}

export interface OpportunityWay {
  id: string;
  /** "Delve for what knocks", "Pump it out", "Seal it" */
  text: string;
  encounter: EncounterSpec;
}
```

### 4.4 Encounter

```ts
/** How an opportunity is resolved. Four modes, one outcome table. */
export type EncounterSpec =
  /** a game of skill played live on the map: the existing area plays and those to come */
  | { mode: 'live'; play: LivePlay; minutes: number; outcomes: OutcomeTable }
  /** a choice of how to spend: resources (and members' time) for odds or a sure thing */
  | { mode: 'choice'; options: { id: string; text: string; spend: Partial<Record<ResourceId, number>>; turns?: number; odds?: number; outcomes: OutcomeTable }[] }
  /** members sent without the hero: odds from who goes, a report after `turns` (§6.1) */
  | { mode: 'dispatch'; difficulty: number; skill: keyof BaseMember['skills']; turns: number; danger: number; outcomes: OutcomeTable }
  /** the building view: paint functions into a grid with a budget (§6.2) */
  | { mode: 'build'; settlement: string; grid?: string; budget: Partial<Record<ResourceId, number>>; turns: number; goal?: BuildGoal; outcomes: OutcomeTable };

/** The live plays: runsit's AreaPlay, plus the kinds the templates need (each needs a player in runsit/area.ts). */
export type LivePlay =
  | AreaPlay                                                            // flee, ambush, deliver, trader, town
  | { kind: 'delve'; site?: number; depth: number; prize?: string }     // a way down: caves, a shaft, a vault
  | { kind: 'hold'; at: [number, number]; seconds: number; waves: number } // hold a point (a ford, a gate, a ritual)
  | { kind: 'escort'; who: string; count: number; to: [number, number] }    // lead people or a cart through
  | { kind: 'break'; target: string; what: 'dam' | 'bridge' | 'wall' | 'seal' } // destroy a thing in the world
  | { kind: 'duel'; character: string }                                 // a named champion
  | { kind: 'hunt'; role: string; count: number };                      // track and kill a beast

/** Results are tiers; a live play's AreaResult maps onto them (won fast, won, won hurt, lost, the hero fell). */
export type Tier = 'triumph' | 'success' | 'cost' | 'failure' | 'disaster';
export type OutcomeTable = Partial<Record<Tier, LoopOutcome>> & { success: LoopOutcome; failure: LoopOutcome };
```

Why only four modes: they are the user's four ("games of skill", "choices of resource allocation", "sending limited
troops or spies on missions", and "a building phase (which could just be viewed as another encounter)"). Why tiers:
dispatch reports, choice odds and live results all have to land on the same table, or each mode would need its own
outcomes.

### 4.5 Outcome

```ts
/** What an encounter does. story.ts's Outcome (the world) plus the run's own parts. */
export interface LoopOutcome extends Outcome {
  text: string;
  /** characters (run.ts CharacterChange: history, status, gear, death) */
  characters?: CharacterChange[];
  /** the base: resources, members joining or lost, dependants, things gained */
  base?: {
    stores?: Partial<Record<ResourceId, number>>;   // + / − now
    rates?: Partial<Record<ResourceId, number>>;    // + / − a turn from now on (ore income)
    join?: BaseMember[];
    lose?: { character?: string; role?: string; count?: number }[];
    dependants?: number;
    things?: { kind: string; name?: string }[];      // made as Instances (recipe.ts) when applied
    move?: { region: RegionId; at?: [number, number] }; // a moving base relocates (passage bought by sea)
    settle?: { name: string; region: RegionId; at: [number, number] }; // a moving base becomes a fixed one
  };
  /** diplomacy: agreements made or broken, interactions remembered (who saw what) */
  diplomacy?: { agree?: Omit<Agreement, 'since'>[]; note?: Omit<Interaction, 'run'>[] };
  /** new opportunities this opens (template ids with where), and hooks it makes true */
  unlocks?: { template: string; where: Opportunity['where'] }[];
  raises?: string[];
  /** the conflict: progress pushed back (−) or forward (+), a step cancelled, a climax changed */
  conflict?: { progress?: number; cancel?: string[]; climax?: string };
  /** the run's own state (what runsit's ChoiceEffect does now: warn, evacuate, delay) */
  run?: ({ kind: 'warn' } | { kind: 'evacuate' } | { kind: 'delay'; minutes: number })[];
  /** a settlement's condition (an AtlasEvent kind, not a direct write: §8 item 1) */
  settlement?: { id: string; condition: 'thriving' | 'struggling' | 'besieged' | 'abandoned' | 'ruined' };
}
```

### 4.6 Clock and turn

```ts
export interface RunClock {
  /** run minutes since the start (runsit's unit: an area counts its planned minutes, a road its distance at the pace) */
  now: number;
  turn: number;
  /** a stronghold's days: minutes a day; day and night from it (Thronefall's rhythm, if the run wants it) */
  day?: { minutes: number; nightFrom: number /* 0..1 of the day */ };
  /** a hard date, if the conflict has one (runplan's 'late') */
  deadline?: number;
}

export interface Turn {
  n: number;
  /** what was on offer, what was taken and how it came out */
  board: string[];
  taken: { opportunity: string; way: string; tier?: Tier; dispatch?: string }[];
  /** escalation steps that fired at its end */
  fired: string[];
}

/** The run as a loop: the state machine runsit's SituationRun becomes (pure; Node-testable, like it). */
export interface RunLoop {
  readonly conflict: Conflict;
  readonly base: Base;
  readonly clock: RunClock;
  /** the opportunities on offer now (generated at the turn's start; §5) */
  board(): Opportunity[];
  /** take a way of an opportunity: a live play starts, a choice resolves, a dispatch leaves, a build opens */
  take(opportunity: string, way: string, opts?: { members?: string[]; option?: string }): EncounterSpec;
  /** how the encounter came out (live: from the play's AreaResult; build: from the plan) */
  resolve(opportunity: string, tier: Tier): LoopOutcome;
  /** the turn ends: travel or a day passes, dispatches report, upkeep is paid, steps fire, the board is made again */
  endTurn(travel?: { to: RegionId; minutes: number }): { reports: DispatchReport[]; fired: EscalationStep[]; climax: Climax | null };
  readonly turns: Turn[];
}
```

What a turn is, by base: **moving**, a turn is the area's encounter and then a leg to the next place (runsit's edge
and travel, as today). **Fixed**, a turn is a part of a day: morning (board, dispatch, build), the day's live
encounter if one is taken, night (the conflict's wave if a step brings one). Upkeep is charged once a turn. Why run
minutes: they already exist and every checker reasons in them (`pathEstimates`, `areaMinutes`). A day is a number of
them.

### 4.7 Carry-over

```ts
/** What a run leaves for the next: everything durable goes through WorldState; this is what's added at the end. */
export interface CarryOver {
  record: import('./run').RunRecord;
  /** the conflict as the world keeps it: unresolved, it keeps its progress and the antagonist acts between runs */
  conflict: { id: string; progress: number; resolved: boolean; antagonist: FactionId };
  /** a fixed base stays a Settlement owned by the leader's faction; a column that settled becomes one */
  base: { settlement?: string; members: string[] /* CharacterRecord ids */ };
  /** things that leave the run as Instances with history (an artifact found, a banner earned) */
  things: InstanceId[];
  /** opportunities not taken, kept as rumours a later run can find (they keep their `because`) */
  rumours: Pick<Opportunity, 'template' | 'where' | 'because' | 'hooks'>[];
  /** what the GM should consider next (accepted leadership → a stronghold run; a captive → a rescue) */
  suggests: { loop: BaseScale; why: string }[];
}
```

Run-only resources (supplies, coin) don't carry over as numbers. A stronghold's stores do carry over, because they are
its `Settlement.stores`. Whether a moving base's leftover coin becomes renown is an open question (§10).

### 4.8 Mapping to the existing contracts

| new | built from | what changes |
|---|---|---|
| `Base` | `Settlement` (fixed); `Followers` + `Loadout` + `SituationRun.pursuers` (moving); `CharacterRecord` (members) | new type; a fixed base is a `Settlement` reference, not a copy; `capacity` derived like `compose.derive` |
| `Conflict` | `Situation.threat` + `target` + `endings`; `SessionStory.happenings` (steps); `RunPlan.failures` (`FailureRule`) | the threat leaves `Situation`; a horde is one conflict template, `threat.arrives` becomes one step at progress 1 |
| `EscalationStep` | `SessionStory.happenings[]` (`when` + `effects`) | the same shape with `raises` and progress |
| `Opportunity` | `SituationChoice` + `SituationArea` (brief, region, settlement); `RunStage`; `EnRouteEvent` (poi) | generated each turn, not fixed when the situation is written; each has an expiry and its `because` |
| `EncounterSpec` / `LivePlay` | `AreaPlay` (kept, as a member of the union); runplan's `EncounterKind` (only for scoring a hero's likes) | `choice`, `dispatch` and `build` are new modes; the live kinds grow by `delve`, `hold`, `escort`, `break`, `duel`, `hunt` |
| `Tier` | `AreaResult` (won, heroDied); `PlayedStage` (won, runEnd); `StageOutcome` (first = hoped for) | one result scale for every mode |
| `LoopOutcome` | `Outcome` (extends it); `StageOutcome.effects.characters`; `ChoiceEffect` (as `run`); `SituationEnding.settlement` | adds `base`, `diplomacy`, `unlocks`, `raises`, `conflict` |
| `RunClock` | `SituationRun.clock`, `areaMinutes`, `TRAVEL_PACE`, runplan's `RunClock` | one clock (§8 item 3) |
| `RunLoop` | `SituationRun` (area → edge → travel; finaleSetup) | the state machine generalised: `board`, `take`, `resolve`, `endTurn` |
| `CarryOver` | `finishSituation`, `RunRecord`, `WorldState.record`, `applyCharacter` | adds conflict state, rumours, things as Instances, suggests |

**What `Situation` covers today, and what changes for it.** It covers a moving lone base, a horde conflict with one
escalation step, five opportunities (as areas with fixed choices), five live plays, three run effects, and four
climax endings. The first step is an **adapter** (`situationToLoop(sit) → { conflict, opportunities, climax }`) with a
unit test that plays the same paths and gets the same endings. `Situation` stays the GM's file format until the user
agrees to a new one. Nothing on places breaks.

## 5. Generating opportunities

### 5.1 The process

```
 LocationFacts ─┐
 HeroFacts     ─┼─► 1 match: every template × every place in reach whose preconditions hold → candidates
 RunFacts      ─┘   2 instantiate: fill the template's slots from the facts (names, regions, roles, magnitudes)
                    3 score: theme, foreshadowing, variety, difficulty for the scale, the hero's likes (§5.5)
                    4 pick the board: 3-5, greedy with a diversity penalty; at least one that answers the conflict
                    5 GM: may swap, flavour, or add its own in the grammar (§5.6)
                    6 oppcheck: everything referenced exists; every consequence is realisable (§5.7)
                    7 offer
```

This is pure CPU over a few hundred candidates per turn. It should take milliseconds, and the slice will measure it
(`scripts/perf/runloop.mjs`, the way runplan's is measured). Runs are deterministic from the seed, the world version
and the turn, so tests can pin the board.

"In reach" means the places the base can get to by the next step of the clock. A moving base uses the region graph
(`reach(g, caps, region)`) out to a leg's effort (runplan's `LEG_EFFORT`). A fixed base uses the regions within N
borders, which is its sphere, growing with vassals (round 120: "one region a run growing with vassals").

### 5.2 The inputs

```ts
/** What is at a place, read from the wiki, the world state and the settlements (all exist except where marked). */
export interface LocationFacts {
  region: { id: RegionId; kind: string; tier: string | null; climate: string; rivers: number; lava: number; stamps: string[]; ground: { min: number; mean: number; max: number } };
  state: import('./world').RegionState;              // undead, ruin, flooded, overgrowth, shadow, storm, presence, marks
  settlement?: {
    id: string; size: string; condition: string; faction: FactionId | null;
    purpose?: import('./settlement').SettlementPurposeRec;   // `cities` (not on places yet)
    story?: import('./settlement').SettlementStory;          // `cities`
    stores: Record<string, { stock: number; rate: number }>; // empty on places today
  };
  /** terrain features in the region */
  features: {
    excavations: { id: number; at: [number, number]; props: string[] }[];  // terrain.ts ExcavationSite + BuriedProp kinds
    lakes: { id: number; level: number; outflow: boolean }[];              // the wiki's lakes
    crossings: { kind: string; road: string }[];                           // the wiki's road crossings in it (bridges, fords)
    caves?: { at: [number, number] }[];                                    // MISSING: round 120's cave mouths
    dams?: { at: [number, number]; holds: number /* lake id */ }[];        // MISSING
    nodes?: { at: [number, number]; power: string }[];                     // MISSING: LW5 magic nodes
  };
  /** factions here: presence, attitude to the player, power, and the agreements holding here (diplomacy.rights) */
  factions: { id: FactionId; presence: number; attitude: number; power: number }[];
  rights: import('./diplomacy').Agreement[];
  /** people the world remembers who are here (CharacterRecord), alive */
  people: string[];
}

export interface HeroFacts {
  role: string;                                   // runplan heroes.ts ROLES
  profile: import('./play').ControllerProfile;    // speed, fly, water, destruction, encounters (likes)
  traits: string[];                               // `traits`: intrinsic (undead for the lich, living …)
  abilities: string[];                            // MISSING as data: 'raise-dead', 'telekinesis', 'runes', 'lance'
  record: import('./run').CharacterRecord;        // statuses, motivation, gear, relationships, history
  loadout: import('./items').Loadout;
  base: Base;
}

export interface RunFacts {
  conflict: Conflict;                 // its phase (progress), its hooks, the steps due soon
  clock: RunClock;
  taken: Turn[];                      // past choices (variety; what they made true)
  flags: Record<string, boolean>;     // story flags and raised hooks
  offered: { template: string; region: RegionId; turn: number }[];  // what was shown recently (variety)
}
```

### 5.3 The template grammar

A template is data, so the GM can read it, write new ones, and the validator can check them. Preconditions are a
small closed vocabulary (like `Condition`). There is no code in templates.

```ts
export interface OpportunityTemplate {
  id: string;
  title: string;                     // with slots: "The Flooded Shaft of {settlement}"
  pitch: string;
  /** what it's about: matched against the conflict's hooks and themes */
  themes: string[];                  // 'undead', 'water', 'ore', 'faith', 'trade', 'fire' …
  /** all must hold (hard), and the soft ones add to the theme score by how well they hold */
  needs: Need[];
  prefers?: Need[];
  scales: BaseScale[];
  /** the ways, each an encounter shape with slots; outcomes per tier as LoopOutcome with slots */
  ways: { id: string; text: string; encounter: EncounterSpec }[];
  /** how hard, 0..1 at the scale's baseline; scaled by the base's strength (§5.5) */
  difficulty: number;
  /** hooks it can foreshadow or answer when the conflict has them */
  answers?: string[];
  foreshadows?: string[];
  /** run minutes it stays on the board */
  lasts: number;
  /** offered at most once a run, or once per region */
  once?: 'run' | 'region';
}

export type Need =
  | { kind: 'purpose'; is: SettlementPurpose[] }                    // cities' purposes
  | { kind: 'story'; has: SettlementStoryEvent['what'][] }          // cities' stories: raided, flooded, burned …
  | { kind: 'size'; min: Settlement['size'] }
  | { kind: 'condition'; is: Settlement['condition'][] }
  | { kind: 'region'; kinds?: string[]; tier?: string[]; stamps?: string[] }
  | { kind: 'state'; field: 'undead' | 'ruin' | 'overgrowth' | 'shadow' | 'frozen' | 'sunk' | 'wetness'; min?: number; max?: number }
  | { kind: 'flooded' } | { kind: 'storm'; min: number; storm?: string[] }
  | { kind: 'feature'; is: 'excavation' | 'lake' | 'river' | 'crossing' | 'cave' | 'dam' | 'node' | 'lava' }
  | { kind: 'mark'; kinds: string[] }                               // a battlefield, a grave, the burned town of …
  | { kind: 'faction'; attitude: 'hostile' | 'wary' | 'friendly'; min: number /* presence */ }
  | { kind: 'agreement'; is: AgreementKind[]; with?: 'player' | 'owner' }
  | { kind: 'person'; role?: string; status?: string }              // a remembered character here (a captive)
  | { kind: 'hero'; traits?: string[]; abilities?: string[]; fly?: boolean; destruction?: number; statuses?: string[] }
  | { kind: 'base'; dependants?: boolean; mobility?: 'fixed' | 'moving'; has?: ResourceId[] }
  | { kind: 'conflict'; phase?: [number, number]; hooks?: string[]; route?: true /* the place is on the antagonist's road */ }
  | { kind: 'not'; need: Need };
```

Why a closed vocabulary: the validator (`oppcheck`) can prove a template's needs refer to things the world can have.
The GM writes them as JSON. A new `Need` kind is a contract change made on purpose, not prose the game can't read.

### 5.4 The library: 23 worked templates

The table has every base scale and all six purposes (`cities`' port, mining, lumber, farming, trading, hold), plus
terrain-only and conflict-driven templates. **World** means a consequence through `WorldState` (AtlasEvents,
diplomacy, settlements), and where possible it is made in the session (a real flood fill, a real fire). **Bonus** means
the gameplay reward.

| # | template | needs (where, hero, run) | scales | ways (encounter) | world consequence | gameplay bonus |
|---|---|---|---|---|---|---|
| 1 | **The Flooded Shaft** | purpose mining; story `flooded`, or region `flooded`, or wetness > 1.3; prefers undead > 0.1 nearby | lone, party, stronghold | **delve** (live, `delve` into the flooded workings) · **pump it out** (choice: materials + 2 turns of workers) · **seal it** (live `break` the adit, or choice: materials) | delve: a `mark` (the open shaft), undead + nearby if it fails · pump: `drain` (a real drain of the basin) and the town's ore `rate` + · seal: `lay-dead` −0.2 round it, `mark` "the sealed adit" | delve: an artifact (an `Instance`, its history "dug up at …") · pump: ore income each turn · seal: the dead stop rising there, so the conflict's steps that raise dead there are cancelled |
| 2 | **The Strike at the Pit** | purpose mining; owner faction power > 0.5; prefers people with a 'miner' role | party, stronghold, army | **side with the miners** (talk, choice: renown) · **break the strike** (live `ambush` reversed: hold the gate) | miners: the town's `faction-presence` shifts to a free company and `mineral-rights` go to them (diplomacy) · broken: owner `attitude` +, the miners' interaction remembered (grudge, halfLife ∞) | miners: a vassal mine (ore flow by agreement) and miners who join as sappers (good at `break`) · broken: coin now, a hostile camp later (unlocks #22 against you) |
| 3 | **The Last Ship Out** | purpose port; conflict on its way (route within 2 borders); base has dependants | refugees, party | **buy passage** (choice: coin, supplies) · **take the ship** (live `ambush` in the harbour) | buy: the port's `attitude` + · take: port `attitude` −, a `mark` "the stolen cog", the port's ship gone (its trade `rate` −) | the base **moves by sea**: `base.move` over a sea barrier, skipping regions and the pursuers |
| 4 | **The Wreckers' Light** | purpose port; storm in region ≥ 0.4 | lone, party | **light the lamp** (live `hold` at the lighthouse through the storm, wreckers attack) · **join the wreckers** (choice) | lit: a `mark` (the lighthouse kept), the port's trade `agreement` with the player's faction · joined: port `attitude` −, coin, `faction-presence` of wreckers + | lit: trade income and a pilot who joins (a sea route for later turns) · joined: coin and plunder items |
| 5 | **Fell the Old Wood** | purpose lumber; neighbouring region overgrowth > 0.5 with a ruin or a mark | party, stronghold | **clear it** (dispatch woodcutters, 2 turns) · **spare it** (talk: the lumber camp's anger) | clear: `overgrow` −0.4 (the forest really thins), the ruin under it surfaces as an excavation (unlocks #13) · spare: lumber camp `attitude` −, the wood stays (and a grove: a healing field, if LW1 is in) | clear: timber (materials) and a dig site · spare: a sanctuary that heals the base's wounded each turn |
| 6 | **The Firebreak** | purpose lumber or farming; dryness > 0.6; conflict hooks `fire` (or a raider faction near) | lone, party, stronghold | **cut the break** (live `hold`: fell a line before the fire's front, the real fire system) · **let it burn and save the people** (live `escort`) | cut: the fire stops at the line (the region's `burn` is avoided and the camp stands) · let it: `burn` 0.6, the camp `abandoned`, its people move (dependants +) | cut: the camp gives fresh mounts (`pace` item) · let it: more dependants and their gratitude (renown), but supplies − |
| 7 | **Harvest Before the Host** | purpose farming; conflict route passes within 1 border; phase 0.2-0.7 | party, refugees, stronghold, army | **bring it in** (dispatch haulers, 1 turn) · **burn the fields** (live: set the fires before the host, the real fire) | brought in: the town's grain `stock` + · burned: `burn` the fields' region, farmers' `attitude` −, the conflict's `drift` − (the host forages less) | in: supplies for the base · burned: the conflict is slowed (progress −0.1) at a cost in standing |
| 8 | **Blight in the Barley** | purpose farming; shadow > 0.2 or undead > 0.1 in a neighbour; conflict hooks `undead` or `shadow` | lone, party | **trace it** (live `delve` or `explore` to the source) · **burn and salt** (choice) | traced: the source is revealed, a conflict step is shown early (foreshadowing), `light` +0.1 · burned: `burn`, the blight stops, farm `rate` − | traced: **intel** (the conflict's next step and its hook on the map) and a cure (a ward item) |
| 9 | **The Caravan Contract** | purpose trading; roads ≥ 3; a hostile faction presence on a road out | lone, party | **escort it** (live `escort` along a leg; an `ambush` en route) · **rob it** (live `ambush`) | escort: a `trade` agreement (flows of a good to the base's settlement or the town's) · rob: the trading town's `attitude` −, a bounty (unlocks #22 against you) | escort: coin and a steady trade income · rob: coin, goods and items now |
| 10 | **The Market of Rumours** | purpose trading; any phase | any | **buy word** (choice: coin) · **trade for a map** (choice: a thing) | none directly; it reveals | rumours become **known** opportunities: it turns 1-2 hidden candidates into board entries, or shows the conflict's next step and its time |
| 11 | **The Levy of the Hold** (runsit's `deliver`) | purpose hold or size city; same realm as the threatened place; not hostile | lone, party | **carry the word** (live `deliver` within a limit) | the hold's levy marches (in the session); `attitude` + | reinforcements at the climax; the hold may give an item (runsit's `gives`) |
| 12 | **The Oath of a Small Hold** | purpose hold; its faction power < 0.4; conflict near | stronghold, army | **take its oath** (talk, choice: renown) · **demand tribute** (choice: strength shown) | `vassalage` or `tribute` agreement (diplomacy); its presence becomes the player's | oath: its fighters join the climax and its region joins the sphere (more places in reach) · tribute: a flow of coin, and its grudge |
| 13 | **The Dig** | feature excavation (terrain's `ExcavationSite`, `BuriedProp` statue / column / ruin) | lone, party, stronghold | **dig it out** (dispatch diggers, turns by depth) · **lift it out** (live: telekinesis, if the hero has it) | a `mark` (the excavation), the props raised in the session (the lich lifts the statue) | an artifact `Instance` (a relic with history: "a statue of the drowned king, lifted by …"); a statue can be set in the stronghold (renown each turn) |
| 14 | **Break the Dam** | feature dam, or a lake with an outflow upstream of the conflict's route | lone, party, army | **break it** (live `break` the dam; the real flood fill downstream) · **hold it** (choice: the dam's keepers paid) | broken: a `flood` downstream (a real `Terrain.flood` water fill, the user's "actually break a dam and flood a valley"), farms `ruin` there · held: the keepers' `attitude` + | broken: the conflict's route is cut (a step cancelled, the host delayed a lot) · held: the downstream town's gratitude |
| 15 | **Burn the Bridge** | feature crossing on the conflict's route | lone, party | **burn it under them** (live `break` with the vanguard on it) | the crossing is gone (a `mark` "the burned crossing of …" and the road's crossing removed, so later runs' graph has the barrier back) | the conflict's arrival is delayed (runsit's `delay`); the bridge is gone for you too (a longer road back) |
| 16 | **The Cave Mouth** | feature cave (round 120's cave networks); base moving | refugees, party | **hide the column** (choice: supplies; turns pass) · **clear the lair** (live `delve` or `hunt`) | hidden: none · cleared: a `mark` (a refuge), the region's beasts `presence` − | hidden: pursuers lose the trail (pursuers reset) · cleared: a safe winter camp (#19 becomes possible here) |
| 17 | **The Field of the Last War** | mark battlefield, or undead ≥ 0.2 | lone, party, army | **lay them to rest** (live: a `hold` while the rite is sung, the living hero) · **raise them** (live: the lich's raise, if the hero has it) | rest: `lay-dead` −0.3, `light` + · raised: `raise-dead` +, the living factions' `attitude` − (witnesses remember) | rest: the conflict loses forces (`forces.count` −) · raised: the base gains an undead company (members, trait `undead`) |
| 18 | **The Ever-Storm Tower** | storm ≥ 0.5 standing; region stamps spires or crystals preferred | lone, party | **break the storm** (live: climb, a spectacle, the storm system) · **harness it** (choice: materials, a ritual seed) | broken: `clear-storm`, the region's wetness eases · harnessed: a `mark` (a storm gate, LW5's seed), shadow + | broken: the roads there open (border costs fall) · harnessed: a "lightning on call" item, a storm gate the stronghold can later build on |
| 19 | **A Place to Winter** | base moving with dependants; a region with standing water, flat ground, and no hostile presence; or an `abandoned` settlement | refugees | **settle here** (build: paint the first functions) · **press on** (choice) | settle: a new `Settlement` (camp), `rebuild` if over a ruin, `mark` "where the people of … settled" | the base becomes fixed: the run's climax changes to holding the new home (the next run may be city management) |
| 20 | **The Siege of {town}** | conflict holds a settlement (presence > 0.6) or the antagonist's seat | army | **starve it** (choice: supplies, turns) · **storm it** (live, the town's walls) · **parley** (talk) | starved: the town `struggling`, its people `attitude` − · stormed: `ruin` +, the town changes hands (`faction-presence`) · parley: a `truce` | the antagonist's power − (`faction-power`), a seat taken, and the climax may move |
| 21 | **The Well Ran Dry** (a petition) | base fixed; dryness > 0.5 or a `flooded` story reversed | stronghold | **dig a cistern** (build: paint a `water` function) · **send diggers to the spring** (dispatch) | a building (a cistern: `Building.use`) or the spring's `mark`; the town `thriving` | the stronghold's growth (people + per day) and its night defence (fire-fighting) |
| 22 | **The Champion at the Crossroads** | conflict leader has a named lieutenant (CharacterRecord); a crossing on the route; or a bounty set by #2 / #9 | lone, party | **duel** (live `duel`) · **ambush the champion** (live `ambush`) · **parley** (talk) | killed: the `CharacterRecord` dies, the antagonist's `power` − · spared: the champion's relationship + (a future ally) | killed: the conflict's progress −0.1 and a named weapon (an `Instance`) · spared: a turncoat who tells the seat's weakness (a climax's odds rise) |
| 23 | **The Captive** | a person with status `captive:<faction>` here (runplan's capture rule) | lone, party | **get them out** (live `escort` out of a hold) · **ransom** (choice: coin) | freed: the captive's `CharacterRecord` statuses cleared, the holder's `attitude` − · ransomed: the holder's coin + | the freed hero joins the base (a member with their own skills and gear) |

Every row has at least two ways with different world consequences. That is the "genuinely interesting" test, and
`oppcheck` enforces it (§5.7). Coverage: lone (1, 4, 6, 8, 9, 10, 11, 13, 14, 15, 17, 18, 22, 23), party (most), refugees (3, 7, 16,
19), stronghold (1, 2, 5, 6, 7, 12, 13, 21), army (2, 7, 12, 14, 17, 20). Every purpose has at least two templates:
mining 1-2, port 3-4, lumber 5-6, farming 7-8, trading 9-10, hold 11-12.

**One template in full (#1), as data:**

```json
{
  "id": "flooded-shaft",
  "title": "The Flooded Shaft of {settlement}",
  "pitch": "{settlement}'s lower workings drowned {story.flooded.ago}. The miners say something knocks below the water.",
  "themes": ["water", "ore", "undead", "delve"],
  "needs": [{ "kind": "purpose", "is": ["mining"] }, { "kind": "condition", "is": ["thriving", "struggling", "besieged"] }],
  "prefers": [{ "kind": "story", "has": ["flooded"] }, { "kind": "state", "field": "undead", "min": 0.1 }, { "kind": "hero", "abilities": ["telekinesis"] }],
  "scales": ["lone", "party", "stronghold"],
  "difficulty": 0.45,
  "answers": ["undead"], "foreshadows": ["undead", "barrows"],
  "lasts": 30, "once": "region",
  "ways": [
    { "id": "delve", "text": "Delve for what knocks", "encounter": { "mode": "live", "play": { "kind": "delve", "depth": 3, "prize": "{artifact}" }, "minutes": 6, "outcomes": {
      "success": { "text": "You came up with {artifact} and the knocking stopped.", "atlas": [{ "kind": "mark", "regions": ["{region}"], "magnitude": 1, "detail": { "name": "the open shaft of {settlement}", "kind": "mine" } }], "base": { "things": [{ "kind": "{artifact.kind}", "name": "{artifact}" }] }, "raises": ["shaft-open"] },
      "failure": { "text": "The dead came up behind you.", "atlas": [{ "kind": "raise-dead", "regions": ["{region}"], "magnitude": 0.2 }], "characters": [{ "kind": "status", "id": "{hero}", "add": ["wounded"] }] } } } },
    { "id": "pump", "text": "Pump it out", "encounter": { "mode": "choice", "options": [{ "id": "pump", "text": "Men and timber for two turns", "spend": { "materials": 6 }, "turns": 2, "outcomes": {
      "success": { "text": "The shaft is dry; ore comes up again.", "atlas": [{ "kind": "drain", "regions": ["{region}"], "magnitude": 1 }], "base": { "rates": { "ore": 2 } } },
      "failure": { "text": "The pumps failed; the water won.", "base": { "stores": { "materials": -3 } } } } }] } },
    { "id": "seal", "text": "Seal it", "encounter": { "mode": "live", "play": { "kind": "break", "target": "adit", "what": "seal" }, "minutes": 3, "outcomes": {
      "success": { "text": "The adit is rubble. Nothing more comes up.", "atlas": [{ "kind": "lay-dead", "regions": ["{region}"], "magnitude": 0.2 }, { "kind": "mark", "regions": ["{region}"], "magnitude": 1, "detail": { "name": "the sealed adit", "kind": "ruin" } }], "conflict": { "cancel": ["{step.raise-dead-here}"] } },
      "failure": { "text": "The roof held; the dead didn't.", "atlas": [{ "kind": "raise-dead", "regions": ["{region}"], "magnitude": 0.15 }] } } } }
  ]
}
```

(The slots `{…}` are filled at instantiation from the facts, and `oppcheck` rejects an unfilled one.)

### 5.5 Scoring

Each candidate (a template, a place, and its filled slots) gets five scores in 0..1. The board is then picked from
them.

| part | how | why |
|---|---|---|
| **theme** `T` | the share of `prefers` that hold, weighted by how far past the threshold (undead 0.4 against a min of 0.1 counts more than 0.11); the purpose's score margin from `SettlementPurposeRec.scores` (a clear mining town over a near-port); overlap of `themes` with the conflict's hooks | thematic: the place makes this opportunity, rather than it being dropped there |
| **foreshadow** `F` | `foreshadows ∩ conflict.hooks` weighted by how soon the matching step is due (progress distance); `answers ∩` hooks already raised | foreshadowing early and payoff later: the user's "establish motivations" |
| **variety** `V` | 1 minus penalties: the same template shown in the last 3 turns, the same encounter mode or live kind as most of the board, the same region as the last turn | Slay the Spire's legibility: every board is a real choice between kinds of play |
| **difficulty** `D` | the template's `difficulty` × the scale's baseline, against the base's `capacity.strength`, compared to a target band that rises with the conflict's progress (easy early, hard near the climax); Gaussian falloff outside the band; any hard requirement unmet removes the candidate | scaled to the base's resources (the user: "we can scale the opportunities and encounters to your resources") |
| **hero** `H` | `profile.encounters[kind]` for live ways (runplan's likes); 1 for choice, dispatch and build if the base can do them | the bike flees, the lich breaks, the knight delves (round 117) |

`score = 0.30 T + 0.20 F + 0.15 V + 0.20 D + 0.15 H`. These weights are starting points, to be tuned in the viewer.

**Picking the board** (3 for a lone hero, up to 5 for a stronghold). The candidate with the best score goes first.
Each next pick maximises `score − 0.5 × similarity(to those picked)`, the maximal-marginal-relevance pick. Similarity
is a shared template, region, encounter mode or theme. Three constraints: at least one pick answers or foreshadows the
conflict, at least two encounter modes when the base can do more than live play, and one way toward the climax when
progress > 0.8. If the constraints can't be met, the generator says so on the viewer and the card. It doesn't relax
them silently.

### 5.6 The GM's role

| when | what the GM does | what it can't do |
|---|---|---|
| **before the run** (offline, as today) | writes the **Conflict** (antagonist, goal, steps, climaxes, hooks) from the wiki and the hero's record; may write **authored opportunities** for key places (the GM's set pieces) | name anything the wiki doesn't have; write outcomes outside `LoopOutcome` |
| **choosing** | per turn, the generator's top 10 candidates with their scores and `because`; the GM may swap the board's picks, but the board's constraints still apply | offer a candidate whose hard needs don't hold |
| **flavouring** | titles, pitches, speakers (a remembered character as `offeredBy`), barks, the artifact's name and history, slot values within the template's ranges | change a template's ways or outcome kinds |
| **inventing** | a new template in the grammar (JSON), saved under `data/opportunities/`, checked by `oppcheck` before use | invent `Need` or `LivePlay` kinds (those are contract changes for main and the user) |
| **mid-run** (the user: "the GM can theoretically update the interactions mid run") | between turns: add an escalation step, move a climax, raise a hook, retire an opportunity, all as data checked again | rewrite what already happened; change a step that already fired |

How it runs, following runsit's pattern: the deterministic generator always makes the board, and a GM file for this
world and turn replaces or flavours it when present. The card says which ("written by the GM" or "from the template").
On the phone there is no LLM in the loop. The GM's mid-run edits are files made between sessions, or by an agent on
the desktop, until a live GM is designed. That's an open question (§10).

### 5.7 Validation: `oppcheck`

It sits beside storycheck and situationcheck (`src/gm/oppcheck.ts`, `node scripts/storycheck.mjs` gains it). It
returns every problem, and none means the board can be offered. It never patches anything.

| check | how |
|---|---|
| shapes | every field typed; no extra fields; ids unique; no unfilled `{slot}` |
| references | regions, settlements (in their region), factions, characters (alive), sites, lakes, crossings, items, roles (the unit generator's), things' kinds (the catalogue) exist in the snapshot and wiki |
| needs hold | every hard `need` holds in the world as it is at the turn (a template offered at a ruined town fails) |
| realisable consequences | every AtlasEvent passes `atlasEventProblems`; and per kind: a `drain` only where flooded; a `flood` names a level that `Terrain.flood` can fill from that point (a dry run of the basin fill on the CPU height grid); a `burn` only where something burns (plants or timber; RS25's masonry note); `ruin` and `rebuild` only where structures stand; `faction-power` and `relation` on known factions; `settle` on land, not water or another town; a `break` names a thing that exists (a crossing, a dam, an adit) |
| distinct ways | at least two ways, and their success outcomes differ in at least one world consequence (not just the numbers): the "genuinely interesting" rule |
| feasible for the base | the place is in reach (a route the hero's caps can cross, `borderCost` > 0); a live kind has a player (a `LivePlay` the area code can play); the scale is allowed; the requirements can be met by the base now or within its expiry |
| the conflict | every hook it foreshadows is one the conflict raises; a `cancel` names a step that hasn't fired; at least one climax stays reachable after any outcome (no outcome makes the run unwinnable without saying so, as situationcheck's clock rule does) |
| the board | 3-5 entries, the constraints of §5.5 met |

## 6. Dispatch and the city builder in the same loop

### 6.1 Dispatch: delegated encounters

The user: "sending limited troops or spies on missions with different rewards", and Darkest Dungeon's dispatch. A
dispatch is an encounter whose mode is `dispatch`. Any opportunity with a non-live way can be dispatched. A live way can
be dispatched too, at worse odds than playing it, so the player chooses between playing it themselves and the risk of
sending others.

```ts
export interface Dispatch {
  id: string;
  opportunity: string;
  way: string;
  members: string[];            // BaseMember ids sent (their `away` set)
  leaves: number;               // run minute
  returns: number;              // leaves + travel there and back at their pace + the encounter's turns
  /** shown before sending: the odds per tier, from who goes */
  odds: Record<Tier, number>;
  seed: number;                 // the roll is made when it leaves: deterministic, testable, replayable
}

export interface DispatchReport {
  dispatch: string;
  tier: Tier;
  /** a few lines: what they found, what happened, who was hurt (for the report card and the GM) */
  lines: string[];
  outcome: LoopOutcome;         // applied like any other: world, base, characters (injuries, deaths)
}
```

**Odds**: `p = σ((Σ members' skill × weight − difficulty × scale) / spread)`, split into tiers by fixed bands.
`danger` sets how often failure becomes disaster (a death). The hero's absence costs a fixed malus on live ways. All
of this is shown before sending (Darkest Dungeon's legibility). **Injuries** are `CharacterChange` statuses (`wounded`,
`maimed`), so they carry over between runs through `CharacterRecord`. A stronghold's hospital (a building function)
shortens their recovery. **Reports** arrive at `endTurn`, and each is noted in diplomacy as an `Interaction` with
witnesses (the town saw your men burn its granary), so it comes up in dialog later.

Why the roll is made at departure: it keeps everything deterministic, and a test can pin a run. Why reports go
through the same `LoopOutcome`: a dispatched dig and a played dig change the world the same way, and only the odds
and the cost differ.

**Taking control.** A dispatched live encounter can be joined by the hero if the base is fixed and the place is within
a leg (the ruler rides out: the castle-court loop of LIVING_WORLD §3). It is then played live, with the dispatched
members as followers (`Followers.recruit`).

### 6.2 The building view as an encounter

The user: building is "a new view that essentially lets you paint into the building grid", with functions (housing,
agriculture, port, civic, training camp, hospital …), and "only some heroes will get this mode". So `build` is an
encounter mode, offered when `capacity.builds` holds (a builder hero and a fixed base, or a refugee column at
template #19).

```ts
/** What a cell of the settlement's grid is for. Each function is a "material" whose style decides how it renders. */
export type BuildFunction = 'housing' | 'agriculture' | 'port' | 'civic' | 'training' | 'hospital' | 'storage' | 'workshop' | 'wall' | 'water' | 'shrine';

export interface BuildPlan {
  settlement: string;
  grid: string;                                  // a SettlementGrid id (its cells are the painting surface)
  /** painted cells: cell index → function and storeys (vertical: the user's "build vertically") */
  cells: Record<number, { fn: BuildFunction; storeys: number }>;
}

/** What a plan gives the base, derived by rules (data, like compose.ts CapabilityRule), never stored. */
export interface FunctionRule {
  fn: BuildFunction;
  /** per painted cell (and storey): what it adds */
  per: { rate?: Partial<Record<ResourceId, number>>; capacity?: Partial<Record<keyof BaseCapacity, number>>; defence?: number; people?: number };
  /** what it costs to paint a cell */
  cost: Partial<Record<ResourceId, number>>;
  /** contiguous cells of one function form one structure (a castle, a hospital) or a dense block (homes): the style's call */
  joins: 'one-structure' | 'block';
}

export interface BuildGoal {
  /** a petition's need: "water for the people", "walls before the host" */
  text: string;
  /** met when the derived totals reach these */
  needs: Partial<Record<BuildFunction, number>>;
}
```

How it plays: the turn's build encounter opens the building view on the settlement's grid with a budget. The player
paints functions, and each painted cell costs its function's `cost`. The turn ends and the plan is applied. The
structures system grows the buildings over the next turns (`CitySpec.progress`, the stored progress the structures
track already has), and the derived totals change the base (`rates`, `capacity`, defence for the climax). "Expand your
training camp rather than build more barracks": painting next to an existing training cell grows that structure,
because contiguous cells join. Why rules as data: the user's derived-capabilities principle, and the GM and templates
can name functions (#19 settle, #21 cistern) without knowing the rules' numbers.

What's missing for it: the painting UI; a `BuildFunction` → structures mapping (structures has `TileUse` and
`BuildingKind`: house, hut, farmhouse, barn, so functions need styles and modules); `Building.use` filled from the plan;
the settlement's `stores` ticking (an economy step per turn).

### 6.3 One schedule

For a fixed base the turn is the user's schedule: "switch between building, fending off threats, dispatching workers
and armies … and answering petitions".

| part of the day | what the player does | the loop's call |
|---|---|---|
| morning | read reports; answer a petition (a board entry offered by the town); paint (build); send dispatches | `board()`, `take(…build…)`, `take(…dispatch…)` |
| day | ride out to one live opportunity in reach, or stay | `take(…live…)`, `resolve` |
| night | the conflict's wave if a step brings one (the town's defence, runsit's finale played as a recurring `hold`) | `endTurn` → steps fire → a live `town` or `hold` encounter |

A moving base has the same calls without the building part: reports at camp, then the board at the edge, then the leg.

## 7. What to build first: a vertical slice

### A. The moving base: runsit's horde run as the loop

| step | what | measure / test |
|---|---|---|
| A1 | `contracts/runloop.ts` with the types above (only what A needs: Base, Conflict, Opportunity, EncounterSpec with `live` and `choice`, LoopOutcome, RunClock) | typecheck |
| A2 | `situationToLoop(sit)`: a `Situation` as a Conflict (the horde; `arrives` as one step), a lone Base, its areas and choices as opportunities, its finale as the climax | a Node test: every path of `pathEstimates` played through `RunLoop` gives the same endings and clock as `SituationRun` |
| A3 | the generator: `LocationFacts` from the wiki and snapshot (purpose and story once `cities` merges; before that the needs that use them are skipped, and the generator says so), six templates (#11 the levy, #9's ambush on the road, #10 the market (the trader), #15 burn the bridge, #7 harvest before the host, #1 the flooded shaft), scoring and the board | Node tests on seed 1's fixture: the board on the Bumku run has the levy, the bridge on the Bethorn crossing (the GM's "Grey Muster" already names it), and one purpose template; deterministic; time per turn measured (expect < 5 ms) |
| A4 | `oppcheck` (the checks of §5.7 that A3's templates need: references, needs, AtlasEvents, distinct ways, reach, the conflict's climax reachable) | runs in `scripts/storycheck.mjs`; the six templates and seed 1's boards pass |
| A5 | the edge card shows the board instead of fixed choices: each with its `because`, its stakes, and what the clock says (runsit's notes) | headless shot at the phone proxy; the run plays to an ending; driveprofile unchanged (the board is CPU, off the frame) |
| A6 | `break` as a live play for the bridge (the real fire on the crossing's timber, or the solver bringing it down) and the dam later | the crossing removed in the world state; the next run's graph has the barrier |

Why this first: the horde run already works on the phone (merge122). The adapter proves the contract before anything
moves, and the board is the user's new ask ("locations as spawning opportunities"), shown in the run they have already
played.

### B. The fixed base: a stronghold against the same conflict

| step | what |
|---|---|
| B1 | the base is the threatened town (Bumku) and the hero its warden; days of N run minutes; the conflict's steps fire as days pass (the barrows open, the bridge, the farms) |
| B2 | the morning board from the generator (the same templates plus #12 the oath, #13 the dig, #21 a petition), dispatch with odds and reports (`choice` and `dispatch` modes; no new live plays) |
| B3 | the night: runsit's finale (`FinaleRules`, the horde, real fires) as a recurring `hold` with an escalating count; the town's defence from derived capacity (walls painted, militia from housing) |
| B4 | the building view's first cut: paint 3 functions (housing, training, wall) onto the town's grid with a budget; derived rules only; drawn with the structures system's existing modules (the function picks the style) |
| B5 | the climax: the host's full assault, or ride out to its seat if progress was pushed below a threshold |

Why the same conflict: the two halves then test one thing. A moving base and a fixed base on one conflict, one
contract and one generator, which is the user's "the interface can be similar".

**Not in the slice**: the army scale; rituals and nodes (LW5); a live GM mid-run; diplomacy beyond agreements written
by outcomes; the economy beyond rates per turn.

## 8. Conflations in today's code (flagged per the working rules)

1. **A settlement's condition is written directly**, outside `WorldState.apply`: `finishSituation` sets
   `s.condition` and level-sit calls `setCondition`. It is the one world change that isn't an event. Proposal: an
   AtlasEvent kind `settlement-condition` (detail.settlement, detail.condition), so history, the settlement's story
   (cities' story.ts reads history) and replays see it.
2. **`Situation` holds four concerns**: the conflict (threat, target, endings), the run's map (areas, choices), the
   encounter's play (`AreaPlay`) and the items. The loop separates them. Situation stays as a file format behind the
   adapter until the user agrees.
3. **Two clocks**: runplan's `RunClock` (deadline, stage by par) and `SituationRun.clock` with `areaMinutes`. They use
   the same rule (planned minutes, up to 1.5×), written twice. Proposal: one `RunClock`.
4. **Two encounter vocabularies**: runplan's `EncounterKind` (race, chase, fight, horde, spectacle …) and runsit's
   `AreaPlay` kinds. Proposal: `LivePlay` is what's played. `EncounterKind` stays only as the hero's likes (what
   `ControllerProfile.encounters` scores), with a table from each `LivePlay` kind to the likes it satisfies.
5. **Three item representations**: `ItemDef` and `Loadout` (runsit), `CharacterRecord.gear: string[]` (runplan), and
   `Instance` (recipe.ts, the truth for things with history). Proposal: an item a hero keeps after a run is an
   `Instance`. `ItemDef` is its run-time view (slots and effects), converted at the run's boundary. `gear` holds
   Instance ids.
6. **A faction's feeling toward the player is in two places**: `Faction.attitude` and `Diplomacy.opinion(player)`.
   One should be derived from the other. The loop writes interactions, so the proposal is that attitude is read off
   diplomacy.
7. **The hero roster is in consequences.ts** (`HERO_NAMES`), with the outcome rules. It belongs with the heroes
   (heroes.ts or the CharacterRecords).
8. **`Settlement.stores`, `people` and `needs` exist but are empty on places** (settle/records.ts). The loop's economy
   needs them filled and ticked by one owner, the settlements system. Neither the run nor the city builder should own
   them.

## 9. What's missing, by owner (for the backlog)

| item | owner | needed by |
|---|---|---|
| purposes and stories on places | `cities` → merge | the generator's best facts (A3) |
| hero abilities as data (`raise-dead`, `telekinesis`, `runes`, `lance`) | play | `Need` hero abilities; #13, #17 |
| traits on places | `traits` → merge | `Need` hero traits (undead lich) |
| caves, dams, magic nodes as features | terrain (caves, dams), atlas (nodes, LW5) | #14, #16, rituals later |
| `settlement-condition` AtlasEvent; stores ticking | world state, settlements | §8 items 1 and 8 |
| new live plays: delve, hold, escort, break, duel, hunt | runsit's area code | the templates' live ways |
| `BuildFunction` styles in structures | structures | §6.2 |
| rumours in the snapshot | world state | carry-over |

## 10. Open questions for the user

1. **The board's size and pace.** 3 opportunities for a lone hero, up to 5 for a stronghold, a new board every turn?
   Or a persistent board where offers stay until they expire, as FTL's map does?
2. **One action per turn, or several by scale?** A lone hero takes one. A stronghold might dispatch two parties and
   build while the hero rides out. Is that the right asymmetry?
3. **Dispatch odds shown as numbers** (Darkest Dungeon, XCOM), or as words ("likely", "a gamble")?
4. **Rumours.** Should some opportunities be hidden until scouted or bought (#10), or is everything on the board
   known?
5. **What carries over from the run's resources?** Coin and supplies vanish, become renown, or stay with the hero?
   A stronghold's stores stay because they're its settlement's.
6. **Conflict drift.** Does the antagonist advance on its own over time (pressure, as runsit's clock does), or only
   on steps and the player's failures? Folk-hero runs were meant to have a tunable enemy track (round 120).
7. **The GM mid-run.** Is a live LLM GM between turns wanted (desktop only?), or are mid-run changes authored ahead
   as conditional steps the GM writes before the run?
8. **Template authorship.** Should the GM be allowed to invent templates freely (checked by `oppcheck`), or only
   flavour the library's, with new templates written by agents and reviewed with you?
9. **Live versus choice.** How often should an opportunity *require* playing live? Proposal: every board has at least
   one live way, and a choice way never gives the triumph tier.
10. **The stronghold's day.** Should a day be a fixed number of minutes with a night wave (Thronefall), or turns
    with no real time between them (Reigns), with the night only when a step brings one?
11. **Morally grey ways** (rob the caravan, raise the dead, sack the town). Should every template offer a dark way,
    with the world remembering it (diplomacy grudges)?
12. **Scale changes mid-run.** A refugee column settles (#19) and becomes a stronghold within the run. Is that wanted
    now, or only between runs (the next run as city management)?
