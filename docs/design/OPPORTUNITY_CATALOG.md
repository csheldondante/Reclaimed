# Living World — Opportunity Catalog and Worked Examples

**Companion to:** `Opportunity_Faction_World_State_Design.md`  
**Status:** Working design catalog; examples and proposed predicates, not a finalized rules specification  
**Date:** November 2026

## The point of opportunities

**Opportunities are not primarily a strategy minigame layered on top of the world.** Their main purpose is to offer **interesting, context-sensitive ways to mutate the persistent simulated world**—creating creatures, buildings, infrastructure, institutions, relationships, technology, magic, terrain changes, and playable situations. These changes should be enjoyable to explore **and potentially useful when confronting the run's impending challenge**. The resource tradeoffs and engine-building decisions arise naturally from pursuing some opportunities while allowing others to expire; they are not ends in themselves.

Each run has **one primary developing arc**. It could culminate in **an army arriving at the city gates**, but equally in **drought, harvest failure, food shortages, rationing, riots, and abandonment**; or in a duel, coup, expedition, migration, technological breakthrough, or escape. Its stages unfold over enough world time to allow meaningful investments, discoveries, and cascading side effects. Threats should often be **visibly approaching in the simulation**: armies advancing, water tables falling, settlements emptying, fires spreading, refugees moving. Players can prepare for the climax, redirect it, preempt it, or accept its consequences.

A knight sent to recover griffin eggs can unlock actual griffin mounts that halve that pawn's travel time. A mine can supply new city-builder recipes and units. A university can physically appear in a city and enable research; a policy can change how people live, assemble, work, or rebel; a ritual can lift a city and its landmass into the sky. **An opportunity's payoff is often more gameplay, not merely an abstract bonus.**

## Uniform opportunity rules

There is **one opportunity system**, not separate playable/delegated card types:

- Each card binds to real **factions, characters, places, populations, creatures, structures, resources, and/or events** in the present world.
- **Eligibility** is a *loose plausibility predicate*, not a demand that an entire quest already exists. A functioning trade route can justify **generating** a missing convoy; diplomacy can justify generating an envoy incident.
- **Requirements** specify committed resources (workers, stone, diplomats, armies, gold, magical energy, etc.). **`player` is just one such resource**: when required, that opportunity becomes the playable encounter for the turn/round.
- **Duration** specifies time until an outcome; commitments are unavailable while occupied. Some threatening opportunities instead count down to a negative outcome if not intercepted.
- **Payoffs** mutate authoritative world state: simulation/terrain, population, inventory, laws, statuses, relations, claims, buildings, recipes, capabilities, and actual units. Changes enable or disable other opportunity predicates.
- **Selection** surfaces a small, relevant, varied subset of eligible cards, with at most one displayed opportunity per map location. The player may favor entertaining tangents over optimal preparation.
- Outcomes can be uncertain or depend on the played encounter. **There is no general choice of whether to “play” or “delegate” the same opportunity**; its resource requirement defines that.

**Notation below:** `Needs` = plausible world-state predicate, **not** the whole cost. `Commit` = typical resources (illustrative). `Changes →` = actual persistent effects and later opportunities. The catalog is intentionally expansive: derive the minimal predicate/effect basis **after** exploring the examples.

---

# A. Opportunity catalog

## A1. Infrastructure, economy, craft, and research

| ID | Opportunity | Needs (loose predicate) | Commit | Changes → further opportunities |
|---|---|---|---|---|
| INF-01 | Establish a mining outpost | Known or discoverable deposit; reachable site | Workers, tools, supplies | Actual mine, miners, ore flow → foundries, new city-builder materials, units, contested claims |
| INF-02 | Construct a workshop | Settlement with material supply and craftspeople | Workers, materials | Visible workshops, crafting capacity → tools, inventions, equipment recipes |
| INF-03 | Found a university | Settlement able to support scholars | Builders, funds, scholars | Campus, learned faction, research capacity → experiments, technologies, new spells |
| INF-04 | Build a foundry / advanced industry | Ore or salvaged metals; requisite technique | Workers, fuel, equipment | Production structures → machinery, armor, metal units, pollution and labor disputes |
| INF-05 | Connect the realm | Two places worth connecting; feasible route | Engineers, labor, materials | Roads, bridges, **tunnels, railways, or warp gates** → trade, travel, troop supply, sabotage, migration |
| INF-06 | Open a public rail corridor | Rail capability and useful unconnected places | Rail engineers, materials | Physical rail/terminals → mass transport, trade towns, rail ambushes |
| INF-07 | Electrify a city | Power source or obtainable power capability | Engineers, generators, materials | Power plants, lines, lights, industry → devices, blackouts, grid sabotage |
| INF-08 | Establish a border market | Tradeable neighboring communities, no active fighting at site | Merchants, construction materials | Market, traffic, wealth and goodwill → agreements, tariff fights, smuggling |
| INF-09 | Negotiate a trade agreement | Two factions with plausible goods or routes | Diplomat, diplomatic leverage | `trade_agreement` relationship, freer exchange → trade routes, new materials, commercial factions |
| INF-10 | Rebuild or repurpose ancient ruins | Ruin/megabuilding; occupant or builders | Workers, salvage, plans | New structures inside old shell → housing, workshops, cultural hybrids, relic discoveries |
| INF-11 | Build a civic institution | Settlement needs treatment, teaching, or common facilities | Labor, materials | Hospitals, schools, communes → population health, specialized cohorts, local opportunities |
| INF-12 | Establish a trade caravan / sea lane | Two markets and traversable route | Merchants, vehicles, goods | Active convoys and trade flows → tolls, escorts, robberies, missing convoy incidents |
| INF-13 | Establish communal burrows | Communal-housing cohort (e.g., gnolls); suitable land | Workers, earth/stone, food stores | Interconnected burrows and shared nurseries → distinctive housing, childcare, growth, disputes |
| INF-14 | Build a new settlement or outpost | Usable site and colonists | Settlers, supplies, builders | Actual town/hamlet → trade, local factions, land claims, defenses, further construction |

## A2. Exploration, creatures, discoveries, and character opportunities

| ID | Opportunity | Needs | Commit | Changes → further opportunities |
|---|---|---|---|---|
| EXP-01 | Recover griffin eggs | Griffins or plausible nesting habitat | `player` | Eggs/aerie → griffin husbandry, **mounts that halve a pawn's travel time**, aerial units and missions |
| EXP-02 | Establish a griffin aerie | Eggs/griffins and suitable breeding site | Handlers, builders, food | Physical aerie, breeding population → mounted knights, sky patrols, faster expeditions |
| EXP-03 | Investigate rumors of an artifact | Plausible ruin, witness, legend, or hidden site | `player` | Revealed dungeon/relic → research, claims, relic theft, magical powers |
| EXP-04 | Recover ancient machinery | Ruin/wreck and plausible old technology | `player` | Salvaged components → equipment, machinery, vehicles, new research |
| EXP-05 | Salvage a fallen skyship | Skyship wreck can plausibly be present | Salvage crews, equipment | Propulsion components, survivors, salvage site → airships, aerial exploration, sky infrastructure |
| EXP-06 | Shelter a defecting inventor | Another faction has expertise; plausible dissident | Shelter, funds, guards | Specialist and knowledge → research; grievance, spies, retrieval attempts |
| EXP-07 | Bind or summon a giant creature | Appropriate creature or summoning capability | Ritualists, magical resources | Bound titan/guardian/mount → travel, siege, walking-city possibilities, escape risks |
| EXP-08 | Discover a magical node | Magical phenomena, unknown or poorly explored ground | `player` | Revealed node → contest for control, ritual sites, magical infrastructure |
| EXP-09 | Capture a magical node | Known node controlled by rival, creatures, or nobody | Forces or `player` | Node control and magical income → great rituals, raids, rival claims |
| EXP-10 | Recover a lost homeland | Traditions/records and plausible ancestral place | `player` / expedition supplies | New site and historical claims → settlement, restoration, political disputes |
| EXP-11 | Rescue or recruit a noteworthy character | Person endangered, isolated, or recruitable | `player` | New hero/retainer, ties and obligations → personalized missions |
| EXP-12 | Investigate a missing convoy | Existing route and traffic; disappearance **may be generated** | `player` | Convoy incident and culprit → rescue, bandit hunt, monster discovery, faction grievance |

*A card always has one defined resource requirement. For example, the ancient-machinery recovery above requires `player`; a separately authored salvage-crew card could exist, but an individual opportunity does not offer a choice of execution modes.*

## A3. Diplomacy, warfare, intrigue, and claims

| ID | Opportunity | Needs | Commit | Changes → further opportunities |
|---|---|---|---|---|
| DIP-01 | Establish diplomatic ties | Two extant factions capable of contact | Envoy, gifts/influence | Diplomatic relation → later alliances, mutual aid, reinforcements |
| DIP-02 | Negotiate an alliance | Diplomatic contact, sufficient common interest | Diplomat, concessions | Alliance → rescues, shared campaigns, troop support, betrayals |
| DIP-03 | Rescue allied units | Existing allies; plausible nearby danger | `player` | Recovered people/units, obligations → gratitude, reinforcements, loyalty |
| DIP-04 | Request allied reinforcements | Ally with available military capacity | Envoy, favors or agreed price | Allied units travel to a real location → joint battles, diplomatic debts |
| DIP-05 | Send aid after a disaster | Another settlement or faction suffering loss | Relief supplies, transport, workers | Recovery, goodwill, survivor migration → alliances, dependencies |
| DIP-06 | Raise diplomatic tensions | Two factions with interests that can conflict | Agent, influence | Grievance/incidents → disputes, mobilization, possible war |
| DIP-07 | Discover contested resources | Valuable resource; multiple plausible nearby interested factions | Prospectors or `player` | Deposit and competing **claims** → arbitration, border crisis, raids |
| DIP-08 | Investigate murdered envoy | Diplomatic traffic and plausible intrigue; **murder may be seeded** | `player` | Culprit/conspiracy revealed → reconciliation, revenge, war, exposure of third party |
| DIP-09 | Negotiate hostage exchange | Hostile factions with captives or concession leverage | Diplomat, captives | Prisoner release / ceasefire → peace, new claimants, grudges |
| DIP-10 | Reconcile former companions | Historically close people now hostile | `player` | Friendship restored, duel or vendetta → faction reunification, new companions |
| DIP-11 | Arbitrate competing relic claims | Relic of value to two factions; claims can be generated | `player` | Owner or steward selected → favors, theft, research, retaliation |
| DIP-12 | Arbitrate a disputed holding | Land, mine, office, or resource with rival claimants | Diplomat | Changed control/claim recognition → peace, litigation, uprising |
| DIP-13 | Arrange a dynastic marriage | Noble houses and available heirs | Envoy, concessions | Kinship/claim edges → alliances, succession disputes, court intrigue |
| DIP-14 | Fight a border skirmish | War, hostile patrols/frontiers | `player` | Real casualties and positions → reprisals, tactical advantage |
| DIP-15 | Raid / plunder a settlement | Hostile or vulnerable opponent with valuables | Raiders | Loot and damage → retaliation, displaced people, fortification needs |
| DIP-16 | Sabotage enemy logistics | Rival force dependent on supply route | `player` | Broken bridges/depots, lost supplies → slower army, retaliation, repair work |
| DIP-17 | Fortify a mountain pass | Strategic choke point; ability to build | Engineers, stone, garrison | Walls/bastions → defensible battle site, tolls, alternate enemy routes |
| DIP-18 | Launch a conquest campaign | Organized army and viable target | Army plus `player` for campaign run | Territory/occupation → governors, resistance, new polities, relic access |
| DIP-19 | Stage a military coup | Ruler with rival power bloc or disgruntled troops | `player` | Regime change, leader replacement → purges, restoration, civil war |
| DIP-20 | Trigger a schism | Institution/faction with meaningful internal disagreement | Agitators, influence | Faction split and rival leaders → new religions, pretenders, civil conflict |
| DIP-21 | Demand tribute / vassalage | Strong power and independent weaker polity | Envoy, coercive leverage | Tribute or vassal tie—or grievance/war → rebellion, protection, tribute collection |
| DIP-22 | Assassinate an invading commander | Approaching army with identifiable leadership | `player` | Leadership disruption → delay, succession struggle, altered campaign trajectory |
| DIP-23 | Negotiate ceasefire or surrender | Active conflict with negotiable terms | Diplomat, concessions | Peace/occupation/disarmament → borders, resentment, demobilization |
| DIP-24 | Stage a revolt or support rebels | Oppressed/alienated faction with means to organize | Insurgents, resources | Revolt, autonomous polity, crackdown → war, liberation, coups |

## A4. Civic law, institutions, identity, and culture

| ID | Opportunity | Needs | Commit | Changes → further opportunities |
|---|---|---|---|---|
| CIV-01 | Impose a curfew | Settlement with authority and population | Guards, administrators | People retreat at night; patrols → smuggling, secret meetings, violations |
| CIV-02 | Establish checkpoints and surveillance | Government with enforcement/monitoring capability | Guards, informants, devices | Checkpoints, watch posts, inspections, monitoring → espionage, secret rebellion |
| CIV-03 | Abolish slavery | Slavery legally practiced; reform movement or ruling authority | Political support, funds | Freed cohorts, new labor/ownership rules → abolitionist diplomacy, backlash, resettlement |
| CIV-04 | Abolish or reform serfdom | Serfdom exists | Governing authority, coalition | Labor/land obligations change → noble resistance, land reform, free peasants |
| CIV-05 | Prohibit a commodity or practice | Currently legal practice and governing authority | Lawmakers, enforcement | Ban alcohol, magic, technology, worship, etc. → smugglers, black markets, repeal |
| CIV-06 | Repeal a prohibition | Existing ban plus reformist constituency | Political influence | Legal activity resumes → markets, legitimacy, opposing protests |
| CIV-07 | Institute conscription | Population and authority to mobilize | Administration, training capacity | Drafted soldiers, labor diverted → desertion, draft resistance, mass warfare |
| CIV-08 | Reform family / household structures | Population with distinct household customs; governing or cultural influence | Elders, organizers, resources | Communal childcare, shared homes, extended families, changed household generation |
| CIV-09 | Establish free enterprise | Economy not already organized around private commerce | Political authority, merchant support | Private ventures, marketplaces, owners → guilds, monopolies, labor conflicts |
| CIV-10 | Establish communal ownership | Organized group supporting common property | Community organizers, transfers | Shared inventories, commons, collective buildings → cooperation, property disputes |
| CIV-11 | Introduce council rule / elected offices | Local governance open to institutional change | Leaders, influence | New government offices and assemblies → elections, reform, contested legitimacy |
| CIV-12 | Restore or abolish hereditary nobility | Noble institutions exist or rival claimants seek their creation | Political coalition, authority | Courtly privileges/estates created or removed → court intrigue, backlash, pretenders |
| CIV-13 | Establish or dismantle an authoritarian apparatus | Government able to consolidate or relinquish power | Enforcement/influence | Police, decrees, surveillance or freedoms → underground resistance or open politics |
| CIV-14 | Establish a festival or holiday | Community/culture and a meaningful occasion | Organizers, goods, artists | Recurring celebration, decorated sites, social gatherings → tournaments, sabotage, pilgrimage, traditions |
| CIV-15 | Organize public games / tournament | Settlement and audience; skilled participants | Organizers, prize resources | Arenas/events, champions, prestige → rivalries, recruitment, hero quests |
| CIV-16 | Hold a public celebration or memorial | Victory, rescue, founding, loss, or hero worth remembering | Community resources | Statues/rituals/parades, opinion changes → pilgrimages, dissent, cultural identity |
| CIV-17 | Grant local autonomy to a faction | Distinct local group with territorial or political stakes | Authority, concessions | Self-governed district/commune → disputes, alliances, secession, distinctive buildings |
| CIV-18 | Institute rationing / triage | Food, water, medicine, or shelter shortage | Officials, stores, enforcement | Priority allocations, lines and queues, social tensions → riots or survival |

**Predicate guardrails:** A civilization where legal slavery has been abolished cannot get an ordinary **legal-slavery revolt** card. Illegal enslavement requires explicitly represented violations. A polity without noble offices cannot generate its own ordinary hereditary court intrigue, though foreign nobles or pretenders may still matter. A high-surveillance authoritarian faction can generate clandestine conspiracies, secret meetings, and resistance, while visible behavior and buildings respond to its laws. **Civilizations can contain different factions with conflicting institutions and practices.**

## A5. Magic, extraordinary construction, environmental transformation

| ID | Opportunity | Needs | Commit | Changes → further opportunities |
|---|---|---|---|---|
| MAG-01 | Build a ritual site | Appropriate place (node, volcano, sacred ground, etc.) and magical capability | Builders, ritualists, materials | Physical temple/array → location-bound great spells, raiding targets |
| MAG-02 | Raise a city and its landmass into the air | City, major levitation technique, sufficient power | Ritualists, magical resources, ritual time | **Actual floating city and altered terrain** → sky docks, aerial warfare, falling-city risks |
| MAG-03 | Construct mobile or creature-borne city | Huge creature or mobility technology and settlement | Builders, handlers, power | Moving city → migration, siege, extraordinary diplomacy and logistics |
| MAG-04 | Cast world enchantment | Arcane source, prepared ritual and relevant spell | Ritualists, power, components | Climate, biology, terrain or world rules change → counter-rituals, new species, hazards |
| MAG-05 | Establish unending night | Necromantic/dark magic and a sustaining site | Ritualists, magical node | Darkened region, changed living/undead behavior → lich dominion, liberation quests |
| MAG-06 | Raise or command the dead | Necromancy and corpses/burial grounds | Necromancer, power | Physical undead population/army → resistance, desecration, new faction |
| MAG-07 | Consecrate the battlefield dead | Battlefield/dead; burial or consecration practice | Priests, labor, rites | Memorial and purified site → less undead risk, mourning traditions, relics |
| MAG-08 | Grow wilderness over a region | Growth magic / propagating life and viable terrain | Druid, magic, seeds | Overgrowth, roots, new cover/food/obstacles → forest factions, restoration, clearance |
| MAG-09 | Raise volcanoes or open magma vents | Powerful geomancy and suitable region | Ritualists, energy | Actual lava, basalt, eruptions, new terrain and minerals → disasters, bridges, mining |
| MAG-10 | Alter wind and storm patterns | Wind/weather magic and relevant geography | Caster, power | Weather fronts, travel and combat modifiers → fast ships, airborne hazards, drought relief |
| MAG-11 | Make units fly, vanish, or cross realms | Flying/invisibility/phase capability | Enchanter, power, enchanted units | Actual unit statuses changing navigation, detection, combat and access → infiltration, aerial transport |
| MAG-12 | Dispel or destroy an ongoing enchantment | Active world effect and reachable source/anchor | `player` or counter-ritualists | Break night, undead control, weather, or lift magic → liberation, collapse, rebound effects |

## A6. Disaster response, rescue, settlement defense, migration

| ID | Opportunity | Needs | Commit | Changes → further opportunities |
|---|---|---|---|---|
| RES-01 | Evacuate a threatened town | Settlement and emerging danger | Transport, escorts, supplies | Actual refugee agents/movement, empty buildings → resettlement, abandoned ruins, rescue quests |
| RES-02 | Lead a refugee flight | Displaced population, possible route to safety | `player`, supplies, followers | Escort/journey encounter; migration and new home → diplomacy, settlement, pursuit |
| RES-03 | Muster militia | Settlement with recruitable residents | Weapons, trainers, population | Physical local defenders → tactical battles, labor shortages, veteran factions |
| RES-04 | Build settlement fortifications | Settlement exposed to danger | Workers, stone/wood, guards | Walls, barricades, traps → actual battlefield advantage, siege opportunities |
| RES-05 | Restore a beacon network | Warning need and towers/high ground | Builders, signal crews | Actual lit beacons, earlier warning → interception, neighboring cooperation |
| RES-06 | Construct reservoir, wells, or aqueduct | Water scarcity/need, feasible supply source | Engineers, workers, materials | Altered water storage/flow → irrigation, relief, water disputes |
| RES-07 | Divert a river | Waterway and another location that may benefit | Engineers, labor | River course changes → irrigation, downstream shortages, diplomatic grievances |
| RES-08 | Distribute food or emergency supplies | Acute need, some available supplies | Caravans, stores, escorts | Survival of cohorts, social support → new obligations; fewer stores elsewhere |
| RES-09 | Seek an underground aquifer / spring | Water need and plausible terrain | `player` | New usable water source → wells, caverns, irrigation, subterranean adventures |
| RES-10 | Rescue people from flood, fire, siege, or collapse | Threatened real characters or cohort | `player` | Survivors, gratitude, new relationships → recruitment, future assistance |
| RES-11 | Reclaim a deserted settlement | Abandoned town, claimants, return route | Settlers, supplies, guards | Repopulated ruins → rebuilding, disputes with new occupants |
| RES-12 | Rebuild a damaged dam / road / bridge | Damaged infrastructure that matters | Engineers, labor, materials | Restored route or flow → commerce, access, defense; may shift disaster downstream |
| RES-13 | Suppress or negotiate riot | Population with serious grievances/unmet needs | Guards, negotiators, resources | Peace, repression, concessions, deaths → legitimacy, uprising, reform |
| RES-14 | Prepare for frost or failed harvest | Crops/population vulnerable to cold or scarcity | Granaries, fuel, growers, labor | Heat and stores → survival, altered farming, supply shortage elsewhere |

---

# B. Major arc catalog: one per run

**Major arcs are developing situations, not a second kind of opportunity card.** One primary arc anchors a run; its successive incidents can issue ordinary opportunities with the exact same requirement/duration/payoff rules above. Its final challenge may change radically—or be averted—based on what the player does.

| Arc | Broad world-state basis | Visible progression and possible climax |
|---|---|---|
| Approaching army / invasion | Ambitious or hostile power and plausible target | Rumors → mustering → border raids/towns fall → army pawn reaches walls → siege/battle, treaty, sabotage, or intercepted march |
| Drought / food crisis | Water-dependent farms/population and drying climate | Shrinking rivers → crop failures → rationing → riots/migration → survival, abandonment or political overthrow |
| Great freeze | Cold-front hazard and vulnerable communities | Spreading snow/ice → blocked routes, failed crops → heating crisis → evacuation or winter siege |
| Volcanic eruption | Potentially active volcano or geomantic fault | Tremors → ash/gas → lava, collapses and displacement → escape, intervention or destruction |
| Otherworldly arrival | Realm boundary/portal or alien/visitor capability | Strange phenomena → visitors → contact and faction reactions → alliance, invasion, pilgrimage, portal expedition |
| Tribute / forced vassalization | Independent polity and coercive external power | Envoy → demands → intimidation → submission, refusal, negotiation or defense |
| Slave revolt / emancipation | Enslaved population, injustice and potential resistance | Secret organizing → escapes/sabotage → coordinated uprising → liberation, crackdown or new polity |
| Military campaign / conquest | Armed force with strategic territorial objective | Muster → supply → marching and skirmishes → siege or decisive campaign battle |
| Coup / court power struggle | Contested authority, rival elites or military faction | Rumors → defections → conspiracy → coup, countercoup or compromise |
| Political or religious schism | Meaningful ideological division and institutions | Disputes → rival leaders → competing followings → split, reconciliation or civil war |
| Necromancer raising the dead | Powerful being, necromancy and accessible dead | Desecration → graveyard uprisings → undead frontier → battle, cleansing or undead dominion |
| Expedition to unknown land | Unknown destination and compelling motive | Gather supplies → travel and setbacks → discovery/settlement/treasure/return |
| Technological revolution | Breakthrough possibility; researchers and adopters | Discovery → prototypes → factories/competing factions → transformative device, upheaval, or sabotage |
| Plague | Vulnerable population and source/spread mechanism | Cases → quarantines → shortages → mutation, cure, exodus, collapse |
| Natural disaster / flood / storm | Geography and physical hazard | Early signs → infrastructure damage → displacement → rescue, rebuilding or irrecoverable loss |
| Refugee exodus / search for homeland | Persecuted/displaced group and possible destinations | Flight → supply crises, pursuers, diplomacy → sanctuary, ancestral homeland, settlement or defeat |
| Folk hero quest | Specific character plus personal injustice, need or calling | Local deeds → supporters/enemies → confrontation, rescue, vindication or sacrifice |
| Slave escape / revenge | Enslaved individual and captors | Escape → shelter/hunger/pursuit → banditry, rescue, revenge or popular uprising |
| Lich's great dominion | Necromancer capable of building a sustaining ritual system | Temples, undead, expanding night → kingdom transformed → later liberation/dismantling runs |

Arc pacing is **world-state driven**, not necessarily a fixed five-step plot. An advancing pawn/front/track makes the approach legible. There should be enough time for multi-turn investments to mature; consequences accumulate before the terminal encounter. Averted threats should produce legitimate alternative conclusions, not forcibly restore the same boss battle.

---

# C. Worked example 1 — The northern army (military impending challenge)

**Initial world:** The river city of Greyford and the northern empire have strained relations. Greyford has a quarry, several workshops, an old beacon tower, an allied hill clan, a route north, and neighboring griffin habitat. There is **not** yet an army on Greyford's doorstep. The run's one major arc is *Northern Expeditionary Campaign*.

**Illustrative horizon:** Several dozen world turns, adjusted by simulation and player interventions—not an obligatory battle six turns after the opening. Individual construction projects might occupy roughly 3–8 turns; played opportunities take player commitment during their designated encounter. Times below are merely examples for calibration.

| Phase | Actual world progression | Opportunity cards that become plausible |
|---|---|---|
| Early: tension and rumors | Envoys pass between courts; watchtowers sight northern troop gatherings | Build workshop, restore beacons, recover griffin eggs, open a border market, negotiate treaty |
| Middle: mobilization | Empire raises units, forges supply chain, pushes marching army pawn onto real roads | Request allied reinforcements (**only with alliance**), sabotage supply route, fortify pass, investigate missing convoy |
| Late: raids and casualties | Frontier hamlet burns; surviving residents flee; enemy outriders reach nearby roads | Evacuate town, muster militia, rescue captives, raid supply wagons, negotiate ceasefire |
| Climax or interception | Army enters city approaches, **unless diverted, delayed, or dissolved** | Siege/defense; or peace settlement, coup behind enemy lines, slain commander, shattered supply lines |

**Example cards: requirements → mutation → new eligibility**

1. **Restore beacon network** — `Needs: abandoned tower + frontier`; `Commit: builders + timber/stone`; `Duration: several turns`. Towers visibly relight; earlier intelligence reveals the approaching force, enabling *Intercept the Supply Convoy* before it reaches the front.
2. **Recover griffin eggs** — `Needs: griffin habitat`; `Commit: player`; `Duration: a played outing`. Creates eggs; later *Establish Aerie* produces actual griffin mounts and faster pawn travel, opening distant sabotage/rescue opportunities. This is **interesting even if it never wins the war**.
3. **Found university** — `Needs: settlement able to support scholars`; `Commit: funds + builders`; `Duration: several turns`. Campus unlocks research and new equipment/rituals; potentially helpful in the eventual battle but useful in later runs regardless.
4. **Request allied reinforcements** — `Needs: relationship(Greyford, hill_clan) = allied`; `Commit: envoy + favor`; `Duration: travel and response`. Ally's troops march on the map. **Absent the alliance, this card simply cannot appear**; earlier diplomacy might create the relation.
5. **Sabotage supply bridge** — `Needs: invading army depends_on bridge`; `Commit: player`; `Duration: playable encounter`. Broken physical bridge interrupts supply, slowing the army and spawning *Repair Bridge* for the invader. If enough soldiers desert or the campaign becomes untenable, the climactic siege may never occur.
6. **Evacuate frontier hamlet** — `Needs: threatened inhabited site`; `Commit: transport + guards`; `Duration: travel`. People actually depart; an abandoned site remains and can become a future ruin, resettlement, or enemy outpost.

**Possible endings from the same opening:** Greyford holds the walls with griffin knights; Greyford signs a protectorate treaty; the player intercepts and defeats the expedition on the road; a northern coup cancels the invasion; or the city falls while the player has been busy constructing a university and experimenting with magic. **Each outcome alters territory, factions, buildings, survivors, and future opportunities.**

# D. Worked example 2 — A drying river in a mixed city (environmental impending challenge)

**Initial world:** Briar Hollow is a feudal river city containing **noble houses**, **serf farms**, a **merchant guild**, and **communal gnoll burrows** with shared childcare. The polity permits serfdom, while the gnoll cohort practices communal housing; these are not contradictory because laws and customs are scoped to their groups. A downstream town and a neighboring neutral polity depend on the same river. The run's one major arc is *The Long Drought*.

**Visible arc:** River levels and groundwater fall; fields yellow; food inventories shrink; markets empty; queues and patrols appear; migrants move between settlements. There is no mandatory enemy army and no guaranteed final battle. The climax may be a food-distribution challenge, riot, mass evacuation, a dangerous journey to a water source, or the city's survival through competent preparation.

| Arc period | Simulation changes | Eligible opportunities and tradeoffs |
|---|---|---|
| Early: subtle shortage | River narrows, dry patches grow, crop forecasts worsen | Dig wells, construct reservoir, expand mines/workshops, establish festival, seek aquifer |
| Middle: rationing | Harvest and food stocks fall; nobles may hoard stores; gnoll commons share theirs | Institute rationing, distribute food, reform serf obligations, negotiate neighboring imports, divert river |
| Late: fracture | Downstream farms fail, displaced groups arrive, unrest rises | Evacuate hamlet, request allied aid (**requires diplomatic ties**), suppress/negotiate riot, protect granaries |
| Climax / alternative resolution | Actual shortage thresholds or widespread migration are reached | Relief succeeds, communal reorganization, revolt, abandoned city, new settlement, or discovery of deep aquifer |

**Causal chains that emerge without scripting:**

- **Dig aqueduct / divert river** → the city's irrigated farms recover, but the downstream settlement's water decreases → its council gains a `grievance` and `claim: water_access` → **Demand Compensation**, **Sabotage Canal**, or **Negotiate River Treaty** become possible. A civil engineering choice can produce a diplomatic crisis.
- **Build communal burrows** → real housing/nurseries are built and child-rearing shifts to collective care → the gnoll cohort can redistribute labor to water projects and shelter displaced families → **Integrate Refugees** and **Expand Commons** become possible. The change is visible in buildings and daily agent routines.
- **Abolish serfdom** → change the polity's legal tag, land/labor obligations, and faction claims → nobles may resist while formerly bound farmers gain mobility. This enables **Land Reform**, **Noble Conspiracy**, and **New Cooperative Farms**, rather than a generic legal slave-revolt card.
- **Establish annual festival** → creates recurring gatherings, markets, decorations, and civic identity. In early drought the player may do this because it sounds fun; later it can become a relief fundraiser, a protest assembly, or a conspicuous celebration amid hunger. It is **not required to be the optimal crisis-response investment**.
- **Secure an ally** → a diplomatic tie established earlier makes **Request Grain Convoy** plausible. If there is no alliance/trade relation, a new diplomatic opportunity can establish one first; don't conjure allied reinforcements or free trade from nothing.
- **Impose curfew and checkpoints** → patrols and queues visibly reshape city life, possibly containing riots; an authoritarian turn in policy increases the likelihood of **Secret Organizing**, **Smuggling Food**, and **Underground Rebellion**. The same predicament can push different cities into different politics.

**Possible endings:** A rebuilt water network sustains Briar Hollow; most residents survive but the downstream polity becomes an enemy; the city survives via unequal rationing and enters the next run with lasting class grievances; refugees establish a new communal gnoll settlement elsewhere; riots overthrow the nobles; or Briar Hollow is abandoned and its dry canals remain as ruins. The next run inherits all of it.

---

# E. Minimal world-state vocabulary suggested by the catalog

**Do not build a separate type or mechanic for every row.** Start with the lightweight scheme from the companion document and distill the larger catalog into reusable primitives:

| Primitive | Typical facts |
|---|---|
| **Entities** | `person`, `faction`, `cohort`, `polity`, `settlement`, `site`, `route`, `army`, `unit`, `building`, `relic`, `resource_deposit`, `arc` |
| **Scoped tags / traits / statuses** | `species:gnoll`, `communal_childcare`, `hereditary_nobility`, `serfdom_legal`, `slavery_abolished`, `authoritarian`, `curfew`, `research_capable`, `electricity`, `necromancy`, `drought`, `plague` |
| **Typed relationships** | `member_of`, `resident_in`, `controls`, `claims`, `allied_with`, `trades_with`, `at_war_with`, `vassal_of`, `friend_of`, `rival_of`, `depends_on`, `connected_by`, `owes_favor` |
| **Claims** | Claimant + real target (land, object, person, office, resource) + basis (ancestry, treaty, discovery, conquest) + strength; distinct from actual ownership |
| **Simulation / resources** | Population, water levels, food, ore, buildings, roads, terrain, positions, forces, weather, inventories, recipes; these remain authoritative in existing systems |
| **Event history** | Notable founding, betrayal, treaty, rescue, emancipation, death, conversion, discovery, battle, disaster; supports **former friend turned rival** and old claims |
| **Opportunity instance** | Template, bound entities, committed resources, duration/progress, location, setup incident, resolution outcomes |
| **Primary arc instance** | Exactly one per run; phase/progress, world objects/front, major unresolved stakes, potential climaxes and interception conditions |

### Generic template lifecycle

```text
world state
  → test broad eligibility + bind concrete entities
  → optionally seed a plausible incident (missing envoy, disputed mine, rumor)
  → show one relevant card at a location
  → player commits specified resources, including PLAYER only if required
  → time passes; opportunity succeeds, fails, expires, or is intercepted
  → modify actual simulation + tags + relations + claims + event history
  → rerun predicates; new opportunities become plausible
```

**Important guardrails:**

1. No hand-authored *required* quest chains. Use state mutations so unrelated templates can respond to outcomes.
2. The generator may **create incidents**, but it should not fabricate the prerequisite capabilities or relationships (e.g., allied reinforcements require an ally; an ordinary slave revolt requires actual enslavement).
3. Distinguish traits of **species/cohorts**, **factions**, **cities**, and **polities**: communal gnolls can live under a feudal sovereign without the entire kingdom adopting communal life.
4. Require actual entities for claims, histories, and geography; use generic tags for rules and affordances, not as substitutes for the physical simulation.
5. Keep opportunity durations and the main-arc horizon long enough for **engine-building, tangents, costly interventions, and mounting consequences**; never assume a few turns to an unavoidable climax.
6. In visual and playable terms, **construction changes the map, policies change behavior, magic changes physics/world conditions, and discoveries unlock content**.
7. Catalog expansion comes first. Reduce its predicates and effects to the smallest adequate basis *after* collecting many more compelling examples in batches of ten.

**Design test:** If an opportunity adds no interesting world mutation, no meaningful change in relationships or statuses, no physical/simulated consequence, and no new content to play with, it probably needs a more compelling payoff.
