# Draft for review — DESIGN §18 and §21 rewritten for seasons and simple resources

Status: **draft, not agreed.** Written by Orchestrator A from the user's answers of 2026-11-09 (DECISIONS round 128r).
Once the user agrees, it replaces the strategic parts of `.claude/docs/design/DESIGN.md` §18 and §21; the rest of those
sections (painting, shape rules, recipes as data, presenters, the dealer, arcs, the GM) stays as written there.

## 18. The city loop and economy (draft)

**Intent** (the user, 2026-11-09):
- "Turns plus abstract resources for now … (it's better simulation but worse game design)."
- "I imagine seasons and buildings go up in some smallish counting number and then effect the world and future opportunities."
- "I really want the jobs to finish in discrete chunks we can show visually with time lapse playback so buildings noticable erect or get delapedated or otherwise modified so that it is as visually rewarding as combat actions."
- "I want to see social, economic and political changes visually reflected and evident in the city."

**Design.**
- **Two layers, one world.** The *strategic layer* is the truth: resources, projects, cards, the civic state of places.
  It moves a season at a time and changes instantly. The *real-time layer* (agents, weather, fluids, physics) presents those
  changes and hosts the player's live actions (spells, battles); a live action's outcome writes back to the strategic layer.
- **The season is the step.** The player taps *Next season*. Everything due resolves instantly and deterministically. Then
  the season plays back as a short time-lapse: scaffolds rise, floors appear, people move in, ruins sag.
- **Resources are a few simple pools,** in small counting numbers (single and low double digits): **Magic, Might, Labor,
  Resources, Intel**, with **Unrest** lowering effective Labor. Each has a stock and a per-season income. The set is a data
  table, so it can change later for flavour. Physical goods and carrying are presentation only.
- **Committed is committed.** Paying for a project or a card locks its cost; it can't be moved to something else.
- **Work happens in stages.** A project (a building, a road, a repair, a ritual) has a small number of stages. Each season
  completes stages according to the Labor (or Magic, or Might) assigned. Each finished stage is one event with one visible
  change: plot marked → scaffolding → walls → roof → finished and lived in. Decay runs the same way in reverse: damaged →
  ruined → overgrown.
- **Magic comes from the fortress in steps.** Each tier of the tower adds Magic income, and each tier changes the tower
  visibly: a new level, a spire, crystals, floating stones.
- **Civic state lives on places and shows in the city.** Prosperity, unrest, festival, occupation, siege, quarantine
  and similar are *modifiers* on a district or a building. Each one has strategic effects (income, Labor, which cards
  appear) and a *visual projection*:
  - more market stalls and lit windows;
  - boarded windows and graffiti;
  - banners and crowds;
  - foreign flags and checkpoints;
  - camps outside the walls.
  How modifiers stack and which one wins is defined and tested per pair. We don't assume every combination works.
- **Named trigger points, not a fixed phase list.**
  - Effects attach to: `OnSeasonStart`, `OnStageComplete`, `OnResolve`, `OnExpire`, `OnReveal`, `OnCommit`,
    `OnSeasonEnd`, `OnTagAdded`.
  - Within a season they fire in one deterministic order, and an effect can't re-trigger itself in the same season.

**Rules.**
- The strategic layer is pure, testable logic with one clock (the season). Day/night, people's routines and the
  time-lapse all read that clock; none keeps its own.
- Outcomes write the world through owner systems' APIs: plan, terrain, water, plants, traits, people. After a write,
  routes are checked (section 13): the world is fixed, or the change is refused in plain words, unless the card deliberately
  cuts a route.
- A presentation never changes the outcome. Skipping the time-lapse gives the same world.

## 21. Runs and opportunities (draft changes only)

- **A card's time is its own attribute,** in seasons:
  - how long it stays offered;
  - how long it runs once played;
  - when its expiry effect fires.
  There is no global turn length for cards.
- **Costs come from the pools** (plus pawns where a card needs them, section 20).
- **Outcomes are instant world changes,** shown in the next time-lapse:
  - a building raised or ruined;
  - a district's modifier changed;
  - terrain, water or plants changed;
  - people arriving or leaving;
  - a faction's control shifting.
  The living world's facts are updated in the same step, so the town and the atlas agree.
- **Cards change the city and future cards.** A finished building adds income or an engine (for example, a university
  adds Intel and one extra card each season). Modifiers change which cards are dealt.
- **The run's threat** is chosen from the user's list of spectacle effects (pending). A fight is one option, not the default.
- **Persistence:** the world carries over between runs by default. Clearing it (`&fresh=1`, or a config option) is a debug
  tool.

## Open points for the user
- Does the player always tap *Next season*, or can a season also end on its own?
- How many stages does a typical building have: 3, 4 or 5?
- Does each project show its stage count before it's committed?
- Can the player watch a season in real time instead of the time-lapse? If so, is that just a speed choice?
