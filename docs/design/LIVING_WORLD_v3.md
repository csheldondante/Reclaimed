# Living World — Effects, Rituals, and Run Structures

## Vision

Build a persistent, physically simulated world where characters undertake radically different kinds of runs, and their actions change the geography, ecology, civilizations, and opportunities available in later runs. The world is already a shared simulation: terrain, weather, fluids, fire, destruction, flora, fauna, cities, construction, combat, and autonomous agents interact through physics, flow fields, and generated paths. Runs **structure and showcase existing fun**, rather than substituting quests for an otherwise inert sandbox.

This is a design handoff and idea catalog, **not a request to implement everything immediately**. Prefer reusable effects and small, testable gameplay patterns over hundreds of isolated spells.

## 1. Composable effect vocabulary

| Primitive / effect | Examples and interactions |
|---|---|
| Forces and fields | Attraction, repulsion, telekinesis, gravity wells/black holes, gusts, tornadoes, shockwaves; attractors can pull air into wind and drag water, debris, and creatures |
| Heat and phase changes | Fire spreading with embers and wind; freezing, melting, steam, lava, buoyant icebergs that collide, jam rivers, and crush bridges |
| Material and terrain changes | Petrify, crystallize, corrode, transmute, liquefy/solidify ground, raise stone walls, excavate tunnels, trigger fissures, redirect water, bury objects |
| Growth and decay | Forest expansion, entangling roots, overgrowth, blight, rot, accelerated succession |
| Life, death, restoration | Raise battlefield dead as units, resurrection, life drain, healing fields, repair fields, animate statues and machinery; undead may be harmed by restorative magic |
| Agent state and perception | Fear, frenzy, sleep, charm, possession, loyalty, illusions, invisibility, animal aggression against towns/crops, coordinated swarms |
| Mobility and form | Flight, levitation, teleportation, portals, phase shifting, shapeshifting, size/density changes |
| Time | Haste, slow fields, stasis, localized acceleration of growth/decay; use tractable simulation approximations |
| Summoning and binding | Summon creatures, bind spirits or elementals to structures, control enormous beasts, animate constructs |
| Persistent environmental fields | Storms, darkness, illumination, anti-magic, weather control, altered gravity, curses, sanctuaries |

**Memorable compositions:**
- **Storm legion:** turn an army into a traveling storm, then summon its soldiers back through individual lightning strikes. The moving storm can disturb wind, ignite fires, and damage the landscape.
- **Necromantic battlefield:** fallen agents rise with equipment and roles, then join combat, labor, or a new undead civilization.
- **Healing sanctuary:** a structure sustains a field that heals living creatures, repairs structures, and encourages vegetation, while potentially damaging undead.
- **Gravity engine:** an attractor draws in enemies, air, water, and debris, creating a vortex and physically changing the battlefield.
- **Ice siege:** freeze water into floating masses, push them downstream, crush bridges and ships, form ice jams, then unleash floods.
- **Ancient war machines:** recover fallen-civilization mechs, floating warships with cannons, animated statues, and walking fortresses; all participate in the same damage, construction, and agent systems.

## 2. Ritual magic is constructed infrastructure

A ritual is a **built, sustained spell**, not just a long cast animation. Reuse the building system so that players design interesting architecture. Ritual behavior can depend on:

1. **Power source:** captured magical node, artifact, mana, souls, fuel, sunlight, geothermal energy, or supplied resources.
2. **Geometry and location:** circles, obelisks, towers, conduits, chambers, spatial alignment, and linked sites. Some rituals must be constructed at a specific site—such as a powerful magical node, active volcano, geothermal vent, ancient ruin, or other geographically unique feature. Finding, capturing, and securing a suitable location can be a major objective in its own right.
3. **Effect graph:** one or more of the primitives above, including targeting, intensity, and area.
4. **Maintenance:** workforce, materials, fuel, repairs, and defense.
5. **Persistence and vulnerability:** the structure continues affecting the world and can be discovered, captured, modified, sabotaged, or destroyed in future runs.

**Ritual and megastructure examples:**

| Ritual / structure | Consequence |
|---|---|
| Necromantic cathedral | Raise the dead, sustain undead labor and armies, transform a region |
| Sanctuary / world tree | Healing fields, ecological restoration, living architecture |
| Storm gate | Control regional weather; disperse an army into a storm and rematerialize it with lightning |
| Gravity spires | Lift terrain and architecture into **floating cities**; sustain flying islands and sky docks |
| Glacier heart | Grow glaciers, freeze waterways, produce crushing ice floes |
| Volcano forge | Raise volcanoes, create magma fields, power industry; repeated use may transform whole regions |
| Portal network | Connect distant cities, supply routes, rivers, and invasion corridors |
| Time engine | Change local simulation rates and biological or industrial processes |
| **Titan-binding circle** | **Summon or bind a giant creature**—leviathan, sky whale, colossal turtle, worm, elemental, or walking mountain. Requires containment, negotiation, upkeep, and the possibility of escape or rebellion |
| **Living mobile city** | Construct a settlement **on the back of a colossal creature**; its migration becomes the city's travel route, and its health, needs, temperament, and loyalty matter |
| **Walking / flying city** | Build or recover a moving metropolis on mechanical legs, floating rock, anti-gravity engines, flying ships, or a gigantic mobile platform |

These cities should not be cosmetic props. They are settlements with populations, logistics, defenses, construction, and economies. A moving city changes trade routes, threatens terrain, and creates new quests. A bound titan might eventually die, revolt, reproduce, or carry its city into an unexpected biome.

**Site-dependent rituals:** require suitable world features, not just resources in an inventory. For example, a titan-binding circle might need an ancient ley-line nexus, while a magma ritual must be built at a volcano. This ties exploration, territorial control, construction, and magical ambition together.

**Magical nodes:** place geographically meaningful power sources in the world. Capturing, protecting, corrupting, connecting, or exhausting nodes creates strategic geography and natural objectives for rulers, mages, armies, and explorers. Node control can change which large rituals are possible.

## 3. Run structures — vary the grammar, not just the quest text

| Structure | Core activities and pacing |
|---|---|
| **Castle / kingdom ruler** | Hear petitions in a throne room, make consequential decisions, manage castle and city construction, recruit and equip knights, **send other knights on autonomous missions**, receive reports, answer crises, personally join skirmishes or dungeon delves |
| **Overland journey** | Travel toward a climax through choices, detours, discoveries, threats, resource decisions, companions, and changing routes; conclude with a siege, escape, duel, rescue, ritual, or discovery |
| **Dungeon delve** | Tight combat, traversal, traps, puzzles, treasures, and escalating encounters inside caves, ruins, ritual complexes, fallen mechs, or structures built in earlier runs |
| **Folk hero / free exploration** | Wander freely, discover settlements and problems, help or exploit inhabitants, experiment with the simulation, accept optional quests without forced timers |
| **Refugee migration** | Protect a vulnerable group, scavenge, evade pursuers, negotiate passage, fight bandits, and find a new home that can become a persistent settlement |
| **Lich / conqueror** | Gather bodies and artifacts, raise and command armies, construct rituals, invade, defend, and establish an undead society |
| **Builder / engineer** | Collect resources, restore ancient machines, develop infrastructure, build magical or technological megastructures, and manage their side effects |
| **Warship captain / mech pilot** | Aerial or overland campaigns, boarding, artillery, salvage, heavy combat, and vehicle maintenance |
| **Monster / giant creature** | Hunt, survive, migrate, defend territory, grow, or carry a civilization |

Runs can **change structure midstream**. A folk hero inherits a castle; a refugee becomes a ruler; a ruler delves into a dungeon; an explorer binds a titan and establishes a moving city. The generator chooses from reusable activities (travel, combat, construction, governance, negotiation, survival, exploration, ritual, command) based on the character's abilities, motivations, and the current world. Timers and pressures are useful selectively, not mandatory.

## 4. Lessons from *Master of Magic* (1994)

**Reference:** [Master of Magic — List of Spells](https://masterofmagic.fandom.com/wiki/List_of_Spells). Also study the game's schools of magic, unit abilities/statuses, city enchantments, global enchantments, summoning, and magic-node control. Treat this as **inspiration, not a specification to reproduce wholesale**.

What made its world feel enormous was not only the number of spells but their **interlocking rules and exceptions**:

- **Unit properties matter:** undead, living, flying, invisible, incorporeal, resistant, immune, regenerating, and enchanted units interact differently with attacks and spells. Undead have particular immunities and can be vulnerable to life/healing effects. Flight changes what can reach a unit; invisibility changes targeting and detection. These are systemic properties, not just numerical buffs.
- **Different scales of magic:** tactical combat spells, persistent unit enchantments, city enchantments, summons, terrain changes, and world-scale effects all coexist.
- **Terrain can be rewritten:** raising volcanoes, corrupting land, transforming terrain, and imposing global enchantments have consequences beyond one battle. In this game, repeated volcanism could progressively cover a region in magma, destroy ecosystems, and redirect civilizations.
- **Magical nodes create strategic geography:** capturing and defending power sources drives exploration, warfare, settlement, and ritual construction.
- **Counterplay creates depth:** flying units need anti-air or magic; invisible units need detection; undead may ignore some mental or biological effects but have other weaknesses; wards and dispels create contests over infrastructure.
- **Statuses are verbs on the simulation:** flight changes movement; petrification changes material and collision; invisibility changes perception; regeneration changes survival; possession changes agent goals. Favor these over generic +10% modifiers.

The lesson is **combinatorial depth from shared status/effect semantics**, not hundreds of hard-coded bespoke spell scripts. Create a compact, extensible trait and interaction system, and make sure effects are reflected in the actual world.

## 5. Implementation guidance for the coding agent

- First inspect the existing simulation, agent, building, ability, and run-generation architecture; do not assume missing systems need rebuilding.
- Represent effects as reusable operations on fields, materials, geometry, agents, traits, and persistent world state. Support composition and data-driven parameterization.
- Treat traits such as `undead`, `flying`, `invisible`, `detects_invisible`, `incorporeal`, `fire_immune`, or `regenerating` as examples of **systemic interaction rules**, not mandatory exact schema names.
- Treat rituals as persistent constructed effect graphs with resource inputs, spatial extent, activation rules, and destructible dependencies.
- Make run structures compositional and motivation-driven. They should deliberately stage fun physical interactions while honoring existing geography, history, and faction state.
- Distinguish emergent simulation consequences from larger, directed between-run developments; both should alter future opportunities and the visible world.
- Prototype one vertical slice of each major novelty before expanding the catalog: e.g., a healing/necromancy status interaction, an attractor with wind/debris, a node-powered ritual, a knight dispatched from a castle, and a journey culminating in a world-changing event.
- Preserve mobile performance: use bounded local fields, aggregate distant agents/effects, and approximate exotic physics where necessary.

**North star:** A ruler hears petitions about an undead blight, dispatches knights to investigate, and discovers a necromantic cathedral powered by captured magical nodes. A future Lich binds a colossal creature, constructs a city on its back, and marches it across the landscape. A later hero boards a flying cannon ship to assault the moving city, while gravity rituals, storms, undead, and terrain destruction interact in the same persistent simulation. Every outcome creates new possible runs—not merely new text descriptions.

## 6. Run-structure references: borrow proven game loops

**Important clarification:** Do not invent an entirely new pacing grammar for every run. Study successful games and reuse their *structural loops*, then ground their stops, conflicts, resources, and consequences in the persistent world. The overland map is the strategic/travel layer; encounters transition into the existing playable simulation map (or remain lightweight choices when appropriate). Both layers refer to the same locations, agents, resources, factions, and history.

| Reference | Proven loop | Adaptation to this game |
|---|---|---|
| **Thronefall / Kingdom: Two Crowns** | Build and recruit during the day; defend against escalating waves at night | Construct walls, recruit agents, deploy defenses and rituals, then personally fight or command during attacks. Damage and construction persist. Day/night is one possible pressure cycle, not a universal rule. |
| **FTL: Faster Than Light** | Choose a path through branching map stops; spend resources, encounter events, upgrade, and stay ahead of pursuit; reach a climactic confrontation | Route a flying ship, caravan, knight, or party across actual regions. Stops include trade, diplomacy, salvage, dungeon entrances, storms, and skirmishes. Pursuers and destinations are real world entities. |
| **The Oregon Trail** | Manage a long journey with supplies, health, hazards, stops, and consequential choices | Refugees or settlers cross wilderness, ford rivers, forage, negotiate passage, evade enemies, and select a place to settle. Their eventual settlement exists afterward. |
| **Reigns / Yes, Your Grace** | Hear petitions and choose between competing needs under limited resources | Rule from a castle; answer petitions from simulated characters and factions, commission buildings, dispatch diplomats or knights, negotiate, and respond to reports. Decisions affect world agents and infrastructure. |
| **Darkest Dungeon** | Prepare and dispatch parties into dangerous expeditions; manage risk, injuries, rewards, and a home base | Equip knights, send them on autonomous missions, inspect reports, and occasionally take direct control for a key dungeon or rescue. Injuries, deaths, relics, and discoveries persist. |
| **Mount & Blade** | Free overland travel, recruitment, diplomacy, trade, and transitions into tactical battles or sieges | Move through the persistent map, encounter armies and towns, switch into direct combat, then return to the strategic layer with the physical aftermath preserved. |
| **Slay the Spire** | Branching routes with legible risk/reward and an escalating sequence toward a climax | Useful pacing model for compact, deliberately staged adventures, even if encounters themselves are real-time and physics-driven. |
| **Against the Storm** | Establish and develop settlements under changing pressures, balancing economy and hazards | A city-building run with evolving objectives and an external threat, culminating in stabilization, evacuation, or transformation of the region. |

### Run archetypes to implement

- **Day/build → night/defend:** Prepare, fortify, expand, survive assaults; repeat with escalating stakes and an eventual siege or counterattack.
- **Branching journey → climax:** FTL/Oregon Trail structure; choose routes and stops on the overland map, resolve selected encounters on the main map, accumulate companions/resources/injuries, then reach a major objective.
- **Castle court → missions → reports:** Hear petitions, make policy, build, send diplomats and knights on simulated missions, receive consequences, and personally intervene in important encounters.
- **Home base → dungeon expedition → recovery:** Prepare a party, delve into a real ruin/ritual structure, escape with rewards or suffer losses, upgrade the base and repeat.
- **Free exploration → emergent opportunities:** No forced timer or climax; follow discoveries, NPC requests, and world changes. Permit optional transitions into structured quests.
- **Settlement development → crisis:** Build an economy, recruit, construct rituals, handle shortages and faction tensions, then survive or resolve a major environmental or military event.
- **Conquest campaign:** Overland maneuver, recruit and supply armies, capture magical nodes and infrastructure, resolve sieges in the main simulation, govern or transform conquered territory.

### Overland-to-main-map contract

1. **Plan:** Overland presents actual destinations, routes, risks, supplies, moving threats, and optional stops. Choices consume travel time and world resources.
2. **Encounter:** For significant moments, instantiate or focus a playable encounter at the corresponding physical location. Preserve local terrain, structures, populations, weather, and relevant agents; add only deliberate staging needed for pacing and readability.
3. **Resolve:** Record casualties, construction, damage, environmental effects, diplomatic changes, and acquired resources in shared persistent state.
4. **Continue:** Return to overland view with updated routes, factions, geography, pursuers, and possible stops. Not every stop needs full direct play; use concise choices or simulation for low-value encounters.
5. **Climax and aftermath:** Runs may culminate in a siege, ritual, settlement, escape, rescue, discovery, or political decision. The outcome should materially affect future world state and the menu of possible subsequent runs.

**Generator principle:** Choose a proven loop to fit the character and motivation; then select a compatible route, pressure mechanism, encounter vocabulary, and climax. Allow transitions between loops (a refugee becomes a ruler; a knight inherits a castle; an explorer finds a dungeon). Do not force combat, timers, or a climax on genuinely free exploration. Favor recognizable, well-paced structures over maximal procedural novelty.

References: https://ftl.fandom.com/wiki/Sectors ; https://gameplayatlas.loopyhop.com/mechanic/defense-day-night-investment/ . Other titles above are design inspirations, not requirements to copy their exact systems.
