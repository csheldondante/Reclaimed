# Living World — Strategic Map and Opportunity System

(The user's correction to the run-loop draft, round 120, 2026-11-01. Verbatim; authoritative over docs/design/RUN_LOOP.md where they differ.)

The game uses a unified atlas and opportunity system that scales from a lone hero's journey to managing an empire.

## Core Mechanic

Every opportunity has predefined resource requirements, costs, duration, possible outcomes, and a location.

The player selects opportunities and commits the required resources. There is no manual resource allocation or separate category of dispatch opportunities.

- Opportunities requiring the player resource become the playable challenge for that round, using character control or building mechanics.
- Opportunities requiring other resources (knights, diplomats, prospectors, workers, armies, etc.) resolve autonomously over time.
- Committed resources remain unavailable until their opportunity resolves, at which point surviving resources return along with any rewards, consequences, or new opportunities.
- Multiple opportunities can progress concurrently as long as their resource requirements are satisfied.

## Strategic Map

The atlas presents known opportunities and destinations based on the world state, intelligence, the GM's story, and available capabilities.

- The GM can restrict the player to a fixed location, a choice of destinations, a region, or open travel.
- Resources can only be committed from the player's current strategic location.
- Exploration, scouting, rumors, and diplomacy reveal additional opportunities.
- Acquiring new resources enables new types of opportunities. Having a knight creates opportunities requiring a knight; having an army enables military campaigns.
- Known but currently unaffordable opportunities can remain visible.

## Scaling Across Runs

- Lone hero: Only has the player resource, so undertaken opportunities become playable encounters. The atlas presents choices of destinations and challenges.
- Traveling party: Companions enable additional opportunities that resolve while the hero plays their own encounters.
- Ruler: Knights, diplomats, workers, prospectors, armies, and other resources enable many concurrent opportunities, while the player's own turns remain playable.
- Empire: The same system scales to territorial expansion, diplomacy, construction, exploration, and war.

## Three Priority Gameplay Systems

1. Atlas / Opportunity Map: Discover opportunities, choose destinations, commit resources, and track ongoing activities.
2. Character Control: Play opportunities involving combat, exploration, traversal, and character abilities.
3. Building: Play opportunities involving settlement construction, infrastructure, defenses, and rituals.

## Guiding Principle

Opportunities are uniform. Their resource requirements determine who undertakes them; committing the player resource makes an opportunity interactive. All opportunities resolve into consequences for the same persistent world.
