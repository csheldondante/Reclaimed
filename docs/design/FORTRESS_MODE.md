# Fortress mode — the user's vision (round 128c), structured

Source: the user's own write-up, verbatim in docs/DECISIONS.md round 128c. This file only structures it and lists the
open questions; nothing is decided beyond what the user said. Not built yet: talked through first.

## Shape of play

- **Two phases.** Building and economy (time effectively paused while planning; the player designs, issues orders,
  then watches workers build it into the map), and **raids**: an army sieges the stronghold, the player's units fight,
  and the player supports with spells and limited orders. Raids are the action of the run structure.
- **No hero needed for now.** A lich or horseback general who casts and fights may come later.
- **Limited control / micro.** Order archers onto the walls, send certain units to ride out; not full RTS micro.
- **Concern to resolve:** a stronghold showcases one place, not the world at large, which makes opportunities less
  compelling. The strategic map, trade, expeditions and the caravan mode are part of the answer (below).

## Spells

- Cast in combat by **drawing runes**; mana regenerates from the player's **power income**.
- Big effects: meteors, volcanoes, summoned creatures, raised walls, heat rays, arrow bombardments (the sandbox's
  powers are the seed: they reshape the land for real).
- A **spellbook**, spells researched. Based on **traits** (the traits system), inspired by **Dominions** and **Master
  of Magic** (the user's gold standard).
- Combat spells and **city spells**: fertility, crop yield, richer ore veins, better trade, faster construction.

## Building

- Townscaper-style painting of the city: buildings, **fields**, **walls**, **mining camps**.
- **First thing to try:** pick a building type, then paint it; the larger the painted area, the faster it
  produces / converts / stores.
- Open question the user raised: are brushes typed buildings (a barracks or training-camp brush that grows vertically
  into stone forts or horizontally into a tent camp), or Townscaper-like generic brushes?
- Building takes time and resources, which gives a reason to want more resources for cooler structures, and makes
  destruction in raids matter.

## The fortress grows huge (the user, round 128d)

> "Yes please. I want the player fortress to be something that can grow huge and impressive with spires and bridges and fountains and crystals and floating stones etc. we can adorn it with claimed prizes from opportunities."

- The fortress is the player's showpiece and keeps growing: no height cap (a cell's levels are runs, build/runs.ts),
  gaps where something holds a block (a wall spanning an empty level between two stacks: a bridge's span).
- Already by local shape rules: turrets with spires on a keep cell above its neighbours, lone towers with spires,
  domes, courtyards with fountains (fortress/shapes.ts).
- To come (BACKLOG FT-33..FT-37): bridges as a structure type; crystals; floating stones (a rule letting a block
  float); claimed prizes from opportunities set on the fortress as adornments; spires and fountains placed by hand.
- Power already rewards height (a block at level L gives × (1 + 0.5 L)), so a huge fortress is a strong one.

## Economy (a factory game)

- **Extractors change the land for real:** quarries dig pits, mines dig into mountains for ore, lumber mills cut
  forests. Food from farms, fish, game.
- **Logistics:** agents carry goods automatically to the structures that need them; warehouses hold stockpiles.
- **People are a resource:** housing fills with people who wander in from the road or move out and have children.
  A built structure needs workers; unassigned people take its jobs.
- **Recipes:** structures convert goods into goods (blacksmith: ore + coal → armour, weapons, tools, some by demand;
  fletcher: wood + cord → bows) or people into units (archery range: people + bows + armour → archers). New
  building types come from what they convert; each needs distinct visuals and agents animated at their work
  (training, chopping).
- **The day:** accumulate resources, spend them on structures that make food, stockpiles, equipment, units and
  population.
- **Variety by kind:** undead need no rest or homes and work constantly (finish things faster).

## Research and technology

- Universities, workshops, arcane guilds produce research: new recipes (technology) and magic.
- Tech advances **as you build**, on the tag-based resources (contracts/recipe.ts tags, docs/design/RUN_LOOP.md
  §5): building what a recipe requires unlocks the next (furnaces → steam engines → factories; copper + magnets +
  engines → electricity).

## The world beyond the walls

- Scouts or a spymaster's house widen the opportunities seen and their range.
- The strategic map assigns resources: scouts, specific knights, armies (many units with the soldier tag), settlers
  (miners).
- Trade: wagons in and out, goods for goods, new items in the stores.
- Opportunities feed the economy (griffon eggs → a hatchery → griffon riders).
- **Finite named characters**, promoted, sent on opportunities: the pawns that limit how much happens at once; away
  while on a job (the opportunity card format: one card, cost / played / expired; the player as a cost).

## Caravan mode (later)

The same economy on the move: units carry resources or gather from the land (hunting, plunder), make camp at night,
arrive places to fight, build settlements and so on.

## What already exists to build on

GPU agents (AgentUnits, thousands) and traits; the settlements' builders raising storeys (settle/life.ts) and
workers carrying bricks or logs (builder branch); the structures module library and irregular tile grid (cities);
the sandbox powers; integrity/physics for walls and metal collapsing; fire through towns; the opportunity cards and
dealer (runloop / opportunities); recipes and tags (contracts/recipe.ts); the strategic map design
(docs/design/STRATEGIC_MAP.md); M128-6's hold (dialog pauses play).

## Answers (round 128c, verbatim in DECISIONS)

1. **One place under direct control, on purpose.** Direct control only where you are; a few pawns with growing
   resources take opportunities elsewhere. This avoids the unwieldy late empire of 4X/RTS. Show the region changed
   when an opportunity completes (deferred unless easy); reflect it on the macro map, and with carts arriving
   (from mines, trade) and conscripts coming in from nearby villages.
2. **Threats through the opportunity system** (raids, cultists, floods, droughts: then drainage, water stockpiles,
   aqueducts). **For now one big opportunity: an approaching army that arrives after some number of day/night
   cycles.** Building is faster than life: ordered buildings complete within days or the same day. This is the
   same persistent game (the legacy world), a reprioritisation of the run structure, not a separate game.
3. **Brushes:** the grids' brush system (3D tiles that stack). Select the structure type, then paint brushes set
   its size and look, which set its cost and output. Upgrade by adding to a structure later; select a structure
   and repurpose it into something else at less cost than building new (good for the legacy mechanic).
4. **Raids:** by default your agents form armies and line up inside the walls (if any); you send them out to meet
   enemies, or let them autobattle while you cast. Archers and ranged units garrison walls and fire on their own.
   Time pauses or slows while casting or ordering. Panning: single tap to pan and double tap to order, or a small
   on-screen pan joystick (drag may not work across a battlefield).
5. **Runes:** to be played with: drawing leaves a trail on screen; compare with picking from a wheel.
6. **Time:** paused while planning a build; otherwise agents build what you planned, mine and move goods.
7. **Order: building and resources first, then combat.** Plan the city, watch agents build it, see resources
   accumulate. Use the existing opportunity system if easy. Combat and spells are already fun to watch; later scry
   the enemy army and cast at it (storms, lightning, rockfalls). Units: the procedural unit generator for now,
   different sizes and colours for creatures and units; the voxel hero models usable. A **unit editor** to make
   the recipes work. Better art later through better editors (what the user wants) and/or downloaded animated
   CC/asset-store models with body sections mutated for gear.

## More answers (round 128c)

- **Start:** a small town, or the player picks the site of the fortress.
- **First buildings:** houses, farms, lumber camp, quarry, warehouse, walls, blacksmith, barracks (so soldiers can
  be made).
- **Power (mana income):** a power structure (a shrine or temple, or the player's tower), raised by opportunities
  to find nodes of power and channel ley lines back to it.
  - (round 128d, the user: "building your fortress should add to your magic power so that players are incentivised to
    build ever bigger and elaborate fortresses") The fortress itself gives power: the Fortress type's built blocks,
    more the higher they stand (slice 1: power × (1 + 0.5 × level) a day, a number in the stores, nothing spends it
    yet). Shrines and ley lines add to it later.

## Inventory of what exists (round 128c, read from places and the branches)

| Area | What exists | Where | Ready (1-5) | Gap |
|---|---|---|---|---|
| Atlas + macro map | GPU world, regions, sites, ways, rivers; a pannable map with labels; travel on the map | atlas/atlas.ts, api/atlas-map.ts, runplan/travel.ts | 4 | no strategic layer (pawns, carts, conscripts, region-changed overlay); STRATEGIC_MAP.md is design only |
| Opportunities / situations | Opportunity contract (holdings, commitments, expiry), dealer, template engine, card lab; SituationRun with a clock and `threat.arrives` (the horde on its route); petitions as dialogs; cast | api/contracts/opportunity.ts, situation.ts; opps/; living/; runsit/ | 4 | clock in run minutes, not days; pawns not promotable named characters; a "siege in N days" template |
| Creatures | inhabitants: 7 body plans, gear, palettes, GPU procedural animation, bestiary viewer | api/contracts/inhabitants.ts; inhabitants/ | 3 | not combat units (separate from agents); no unit editor; agents capped at 8 kinds |
| Stacking tiles / city | `Town` Townscaper blocks (8 levels) + the editor's town tool; CityPlan (tiles → WFC façades → modules → claims → nav) | build/town.ts; structures/plan.ts, modules.ts | 3 | blocks untyped; CityPlan generated, not painted; no typed brush, size→cost/output, upgrade, repurpose; town tool breaks after a slide (Q32) |
| Workers | GPU agents (8192), BuildCrew; SettlementLife: miners dig real pits, woodcutters fell real trees, builders carry storey by storey, farmers to the granary | agents/; units/agent-units.ts; settle/life.ts | 4 | hard-coded roles; no jobs from buildings, no idle pool, no hauling between any buildings, no warehouses; one live settlement |
| Economy | Settlement.stores {stock, rate} by DAY_S off-screen | settle/settlements.ts | 2 | no per-building inventory, logistics or production chains |
| Recipes / tags | Recipe{assemble, craft, train, adapt, salvage}, needs facilities/knowledge, CivProfile knowledge | api/contracts/recipe.ts; data/recipes | 2 | data model only: nothing runs recipes in buildings, no people→units, no research unlocks (adapt ≈ repurpose) |
| Traits | GPU traits, statuses, effects, raise | traits/ | 4 | spell/research tags, city-spell effects |
| Powers / effects | grow, lightning, wind, storms, cyclone; editor tools (dig, smash, drop, telekinesis, beam, volcano, meteor, water, drain, plant, mesa, bedrock); the lich's raise; dragon breath | game/powers.ts; ui/editor.ts | 4 | no mana, runes, spellbook; no mind control or summoning (raise only); mesa/bedrock are the seed of raising walls |
| Time | DayNight (480 s), sim pause, editor speeds, the talk hold (merge128) | weather/daynight.ts; sim/simulation.ts | 3 | no day counter (DAY_S 600 vs dayLength 480), no plan-mode pause, no slow-mo for casting |
| Combat | GPU melee (reach, damage, period per kind), hunts, guards, raids | agents.wgsl, units.wgsl | 3 | no ranged agents or projectiles, no garrisons on walls, no formations |
| Physics / walls | judges, rigid bodies, solver, craters, fire through towns | game/integrity.ts, solver/ | 4 | no wall damage tied to the economy, no repair job |

The five biggest gaps: an economy runtime (inventories, recipes over time, hauling); typed painted structures; jobs and population; ranged and army combat; the fortress's time and threat loop (day counter, plan pause, a siege in N days).

## The building mode (the user, round 128c, verbatim: the rule for every build plan)

> "Please remember the building mode I want is to select the what then plan it with tiles like townscraper.  That's imporant for making towns with a bunch of small huts or apartments and for making your fortress which sounds like a good thing to keep adding onto for power."

Select WHAT (the structure type), then plan its shape with Townscaper-like stacking tiles: many small huts or
apartments make a town; the fortress (the power tower) is something you keep adding onto for more power.
