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

## Open questions (to talk through before planning the build)

See the conversation; main's list is kept here once answered.
