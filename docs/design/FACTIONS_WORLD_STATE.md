# Living World: Factions, Traits, Claims, and Opportunities

**Design handoff · November 2026**

## 1. Goal

Build a large catalog of **parameterized, time-bound opportunities** that emerge from the current world, change it, and thereby make other opportunities possible. Every opportunity should be able to involve actual people, factions, settlements, places, resources, creatures, structures, and history. The result should feel like a deep living civilization without individually scripting every quest or simulating every institution in full detail.

**Core proposal:** Treat the world as existing simulated entities with **tags/traits, resources, typed relationships (including claims), and a small event history**. Opportunity templates query this state and apply ordinary world mutations. Existing simulation and procedural generators make those changes visible and playable.

Do not build a separate elaborate narrative-state ontology or a graph database initially. Extend the existing world state with a lightweight, queryable fact layer.

## 2. The world is not one civilization with one personality

**Civilization/polity**: A governing or political umbrella: a kingdom, republic, empire, city-state, confederation. It has territory, laws, institutions, resources, foreign relationships, and possibly subordinate polities.

**Faction**: Any recognizable group with shared interests or organization *within or across* polities. Examples: nobles, serfs, merchants, guilds, priesthoods, military cliques, abolitionists, necromancers, refugee groups, clans, communes, rebels, and political parties. A faction can have its own traits, leaders, resources, goals, relationships, claims, and members. It need not govern anything. A faction may span several settlements; one settlement may contain many factions.

**Population/cohort**: A group of residents represented in aggregate for economy, housing, social behavior, and agent spawning. Cohorts have species/biology and may participate in one or multiple factions. The terms *faction* and *cohort* can share implementation machinery initially, but don't assume that species, class, ideology, and government are interchangeable.

**Other entities**: People, armies, buildings, sites, settlements, relics, resources/deposits, routes, creatures, and major arc instances. Reuse existing simulation IDs and spatial locations.

### Example: one contradictory, lively city

A single city belongs to a feudal kingdom yet contains:

- A **noble-house faction** with hereditary privileges, estates, retinues, and claims on land and political offices.
- A **serf cohort/faction** with agricultural obligations, grievances against particular lords, and possible emancipation or revolt opportunities.
- A **gnoll communal faction** whose members live in interconnected burrows, collectively raise their young, and share stores. Its customs are distinct from the kingdom's laws and from gnoll biology.
- A **merchant guild** seeking free trade and protection of caravans.

These groups can cooperate, oppose each other, intermarry, compete for sites, or acquire claims on the same resources. If a king abolishes serfdom, nobles may lose privileges while gnoll communal childcare remains unchanged. If the gnolls gain local political authority, their communal burrows might spread through construction and migration, not by silently changing every resident's species or culture.

**Visible simulation:** The composition of a settlement affects architecture (manors, clustered burrows, dormitories), land use, households, storage, rituals, movement patterns, patrols, work assignments, and unit/building recipes. Start with a few strong visual/behavioral effects per tag rather than requiring a complete sociology simulation.

## 3. Traits and tags: the Master of Orion lesson

*Master of Orion II* is a useful precedent: customization separates population traits (e.g., **Aquatic**, **Subterranean**, **Lithovore**) from government choices (**Feudal**, **Dictatorship**, **Democracy**, **Unification**) and special economic, research, military, or diplomatic capabilities (e.g., **Creative**, **Charismatic**, **Fantastic Traders**, **Telepathic**). Its distinction between inherent population traits and empire-level traits is particularly relevant here. The point is **mechanically consequential combinations**, not merely flavor labels or a literal port of its racial bonuses.

Suggested tag domains (examples, not a closed enum):

| Domain | Example traits/statuses | Simulated impact and unlocked opportunities |
|---|---|---|
| Biology / physiology | `species:gnoll`, `aquatic`, `subterranean`, `lithovore`, `long_lived`, `flight`, `telepathic` | Food and habitat requirements, population growth, routes, buildings, units, unusual diplomacy |
| Social customs | `communal_childcare`, `communal_housing`, `extended_households`, `clan_based`, `ancestor_veneration` | Homes, work patterns, childcare, festivals, disputes, cultural exchange |
| Economy | `free_enterprise`, `guild_controlled`, `communal_ownership`, `tribute_economy`, `state_planning` | Workplaces, trade, production allocation, markets, monopolies, strikes |
| Government | `hereditary_nobility`, `council_rule`, `elected_offices`, `authoritarian`, `theocracy` | Court intrigue, elections, coups, succession, resistance, faction influence |
| Law / policy | `slavery:legal|abolished`, `serfdom:legal|abolished`, `conscription`, `curfew`, `magic_prohibited`, `prohibition` | Occupations, enforcement, protests, abolition, smuggling, escape missions |
| Culture / disposition | `militarist`, `pacifist`, `mercantile`, `scholarly`, `xenophobic`, `charismatic` | Opportunity weights, recruitment, diplomacy, research, conflict styles |
| Capabilities | `rail_engineering`, `electricity`, `necromancy`, `levitation`, `warp_gates`, `griffin_husbandry` | Construction recipes, equipment, spells, travel systems, rituals |
| Local conditions | `drought`, `plague`, `occupied`, `unrest`, `famine`, `under_surveillance` | Disaster responses, crises, refugee flows, sabotage, uprisings |

**Keep scopes separate.** A polity's law is not automatically every faction's belief; a faction's custom is not every resident's custom; a species' physical abilities are not a political ideology. Policies apply within jurisdiction, with optional local overrides. A legal abolition of slavery disables ordinary *legal* slave-market/revolt opportunities there, but illegal enslavement can still exist **only if represented by explicit violations**, allowing abolition enforcement opportunities. Serfdom is a separate status.

Use boolean/enumerated tags for discrete rules, bounded numbers for intensity (`support`, `unrest`, `enforcement`, `prosperity`), and actual simulation values for quantitative facts (`population`, `food`, `ore`, `distance`, `water`). Avoid inventing hundreds of independent meters.

## 4. Relationships, claims, and history

The main expressive power comes from **typed edges between real entity IDs**:

| Edge family | Examples |
|---|---|
| Membership / jurisdiction | `member_of`, `resident_at`, `part_of_polity`, `governs`, `subject_to_law` |
| Political / personal | `allied_with`, `at_war_with`, `vassal_of`, `loyal_to`, `rival_of`, `friend_of`, `owes_favor_to` |
| Control / rights | `controls`, `owns`, `occupies`, `has_access_to`, `claims` |
| Economic / logistical | `trades_with`, `supplies`, `connected_by`, `employs`, `depends_on` |
| Kinship / narrative | `parent_of`, `heir_to`, `former_ally_of`, `betrayed`, `rescued`, `exiled_by` |

A **claim** is a relationship with a target and *basis*, not a vague opinion. A noble can claim an office; a clan can claim a burial ground; two factions can claim a relic, mine, settlement, person, route, or title. Suggested metadata: `basis` (ancestral, treaty, conquest, religious, debt, discovery), `strength`, `recognized_by`, and an optional expiry. Actual **ownership/control** stays distinct from a **claim**. This single distinction makes border disputes, relic conflicts, contested succession, and emancipation politics natural to generate.

Relationships may be asymmetric. Two factions can have different attitudes toward each other. Store a compact directed attitude score if needed, plus explicit facts such as `at_war_with` or `allied_with`: **don't infer war from a negative relationship number alone**.

Keep an **append-only event history** of notable changes (`betrayal`, `rescue`, `treaty`, `emancipation`, `battle`, `founding`, `relic_discovery`, etc.) referencing actual entities and turns. This supports predicates like *former friends turned rivals* rather than losing the past when current relationship values change. Materialize a few useful historic edge tags (`former_ally_of`) if that makes queries cheap.

## 5. Uniform opportunity model

**There is only one kind of opportunity.** A card specifies its required resources, duration, and potential consequences. If `player` is among the required resources, the player plays the corresponding action/city-building encounter. Otherwise it proceeds with the committed resources. No separate "playable" versus "delegated" card taxonomy or execution system is needed.

Each **template** defines:

1. `eligibility`: broad predicates over world state; enough to make the situation *plausible*.
2. `bindings`: how to select real factions, people, locations, sites, assets, and resources.
3. `setup` (optional): instantiate an incident or rumor (e.g., a convoy goes missing) **after** selection; don't require it to exist first.
4. `requirements`: resources/capabilities to commit, possibly including `player`.
5. `duration`: time to resolution or a countdown toward an unwanted result.
6. `outcomes`: changes to entities, tags, relationships, claims, resources, terrain, structures, recipes, agents, etc.; optionally branched by playable success/failure.
7. `presentation`: concise card title, meaningful stakes, relevant map location, visible rewards/consequences.

An **instance** binds this template to specific real entities and holds its progress, state, and reserved resources. All commitments block reuse while occupied, then release on resolution where appropriate. At most **one displayed opportunity per location** at once for map clarity. The opportunity selection system should mix interesting development/discovery possibilities with pressure from the current arc, not require the player to solve everything.

### Illustrative opportunity template (pseudo-YAML, not a prescribed schema)

```yaml
id: disputed_border_mine
eligible:
  all:
    - exists: [deposit, mineral_deposit, accessible]
    - exists: [faction_a, faction, near: deposit]
    - exists: [faction_b, faction, near: deposit, different_from: faction_a]
    - not: { relation: [faction_a, at_war_with, faction_b] }
bind: [deposit, faction_a, faction_b]
setup:
  - add_claim: { claimant: faction_a, target: deposit, basis: discovery }
  - add_claim: { claimant: faction_b, target: deposit, basis: ancestral }
requirements: { player: 1 }    # This opportunity is playable
resolution_time: 2
outcomes:
  settle_claim:
    - set_control: { target: deposit, holder: chosen_faction }
    - modify_relation: { between: [faction_a, faction_b], grievance: -1 }
  escalate:
    - modify_relation: { between: [faction_a, faction_b], grievance: +2 }
    - add_status: { target: deposit, tag: contested }
```

This does **not** require the mine to already be disputed. The generator finds a fertile situation and creates the incident, provided the resulting claims make sense. Likewise, a disappeared convoy needs a trade route and an interested party, not a pre-existing disappearance. Setup is a world event with persistent consequences; it isn't merely text on a card.

### Other short opportunity examples

| Opportunity | Loose eligibility | New state / further opportunities |
|---|---|---|
| Establish communal burrows | Group with communal-housing custom; space and construction ability | Burrows and communal nurseries; altered family housing, labor, and growth |
| Reform serfdom | Serfdom legally exists; governing authority or movement capable of challenging it | Abolition, resistance by lords, labor changes, possible uprising or redistribution |
| Arrange a dynastic marriage | Noble houses and eligible heirs | Kinship/claim relations, possible treaty, rival claimants, succession disputes |
| Open a public rail corridor | Two places, rail capability, materials | Rail line physically built; trade, migration, troop movement, sabotage |
| Impose surveillance | Authority with police or magical monitoring capability | Visible checkpoints/patrols; clandestine resistance and espionage opportunities |
| Raise the city into the sky | City, major levitation ritual, source of magical power | Floating landmass; changed terrain/travel, sky docks, aerial warfare, maintenance risks |
| Investigate missing convoy | Active route and sufficient trade to support convoys | Instantiate missing convoy; reveal bandits, monsters, sabotage, or diplomatic intrigue |
| Contested relic | Valuable relic or credible discovery; multiple interested groups | New claims and relationships; theft, bargaining, expedition, war |

**Cross-mode payoff matters:** Establishing a mine should create physical extraction, yield city-building materials, and enable new unit recipes. Griffin eggs should enable actual griffin mounts and faster pawn travel. A university should exist visibly and create research opportunities. A ritual should affect the simulated world, not just add flavor text.

## 6. One major arc per run

Each run selects **one primary developing arc**, from personal to epic: slave escape, folk-hero quest, refugee flight, coup, vassalization, military campaign, plague, drought, freeze, volcano, expedition, technological revolution, arrival of outsiders, lich raising the dead, etc.

An arc has a sequence of **stages/advancing world events** rather than a short timer to a final fight. Its progress may be represented by an army pawn, disaster front, river drying up, movement of refugees, unrest, or a track, but it should be **legible in the actual map simulation**. Individual threat cards and opportunities appear as situations develop. The eventual climax may be a battle, duel, escape, discovery, construction challenge, political decision, or something avoided entirely through prior interventions.

Runs should provide time for engine-building investments to pay off before pressure mounts. The player can spend time on unrelated opportunities and accept consequences; the arc provides direction, not an exclusive quest chain. World-state changes persist and reshape later runs.

## 7. Cheapest practical implementation

**Build a small fact layer over the existing simulation/ECS.** No dedicated graph database, general rule engine, or full legal/sociological simulation is required initially.

Minimal persisted records:

```text
Entity:       id, kind, world/location ref, attributes, tags
Relation:     source_id, relation_type, target_id, strength?, metadata?
Event:        turn, event_type, participant_ids, payload
Opportunity:  template_id, bound_entity_ids, state, turns_remaining,
              committed_resources, setup_event_ids
```

Reuse existing resource inventories, buildings, roads, map geometry, agent systems, factions, and recipes rather than duplicating their authoritative state in tags. Represent a route as actual map connectivity or network data; the `connected_by` relation may be a cached convenience. Represent a new floating city with actual spatial/terrain changes plus relevant capabilities/status tags.

**Evaluation loop:**

1. On relevant world changes (and periodically), find candidate entities for opportunity templates.
2. Evaluate broad predicates; bind concrete entities and locations. Weight for novelty, thematic relevance, current world state, capability, potential downstream unlocks, urgency, and neglected development options.
3. Present a small, varied set with at most one per location. Only **instantiate optional setup events when the opportunity is actually committed to presentation or activated**, with clear lifecycle rules to prevent invisible repeated incidents.
4. Reserve requirements on acceptance; advance time and the primary arc; resolve or allow expiry; mutate the authoritative simulation; emit events.
5. Changed tags, relations, claims, resources, and geometry naturally enable or disable subsequent cards.

**First-pass queries** can be straightforward code predicates over collections indexed by tag, entity kind, location, and relation type. Evaluate on changed entities/nearby candidates rather than every card against every entity each frame. Add indexes or a declarative DSL only when justified. Store opportunity templates as data and allow a small library of procedural binding/effect helpers for complex cases.

**Guardrails:**

- Treat predicates as *minimum plausible prerequisites*, not elaborate prewritten quest state. Generate plausible incidents when needed.
- Centralize invariant enforcement: no ordinary legal slave revolt where slavery is abolished; no hereditary court succession in a polity without noble offices; avoid mutually exclusive governing policies in the same jurisdiction. Exceptions (illegal slavery, pretenders, foreign courts) must be represented explicitly.
- Allow mixed and contradictory factions within the same city. Laws, practices, compliance, and opinions can differ.
- Avoid arbitrary story-only effects: apply real tags/relations/resources/structures/terrain/agents and let gameplay derive from them.
- Preserve history and provenance; claims should have named claimants and targets.
- Don't hard-code a hand-authored opportunity chain. An outcome is interesting partly because multiple unrelated templates can consume it.
- Prevent opportunity spam: cooldowns, finite subjects, mutually exclusive incident setups, location deduplication, and mission-level presentation balance.

## 8. Recommended first vertical slice

Make one mixed city with **nobles, serfs, a communal gnoll group, and a merchant guild**. Give each a handful of tags, claims, and relationships. Add physical representations of a manor, farms, burrow nursery, and market. Implement four opportunities:

1. **Build communal burrows** → real construction, changed housing and cohort behavior.
2. **Abolish serfdom** → legal tag change, labor changes, noble grievances, potential resistance.
3. **Open a trade corridor** → road/route, changed commerce, guild growth, possible conflict over tolls.
4. **Arbitrate a contested holding** → claims to one actual farm/mine/relic, changes in control and faction relations.

Then add one developing run arc (e.g., an approaching drought or a succession crisis) and verify that these opportunities interact with it without any bespoke chaining. Expand the catalog in batches of ten; later **reduce the many example predicates and effects into a small reusable basis**.

## References

- *Master of Orion II* race traits and government choices: [Orion2 Redone project — allowed values](https://moo2mod.com/redone/doc/generated/configuration/allowed-values.html).
- Population-inherent versus government/empire-level trait distinction: [StrategyWiki — Master of Orion II race design options](https://strategywiki.org/wiki/Master_of_Orion_II%3A_Battle_at_Antares/Race_design_options).
- Further trait effects: [Master of Orion II race picks](https://masteroforion.fandom.com/wiki/Race_picks).
