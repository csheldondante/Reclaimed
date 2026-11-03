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
