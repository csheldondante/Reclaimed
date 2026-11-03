# Fortress mode, slice 1 — the build plan (planning agent, round 128c; for the user to approve)

Spec: docs/design/FORTRESS_MODE.md. Read from origin/places ee708e9.

## Corrections to the inventory
1. life.ts builders raise CityPlan SiteSpec storeys, not Town blocks; BuildCrew (agents/buildcrew.ts) uses fields 0-1 and groups 10-12, which SettlementLife also uses: the two can't run together.
2. The agents' limits are full: all 16 groups (MAX_GROUPS), all 12 fields (NFIELDS), 7 of 8 kinds.
3. SituationRun is a hero-route engine (areas, legs, run minutes): reuse the SituationThreat type and the card's expiry instead.
4. No ore or coal in world/materials.ts (recipes have an abstract `ore`).
5. The M128-6 hold isn't needed for the pause: speed 0 already freezes sim, units, settlements and DayNight (level.ts ~2363-2487).
6. Q32 is half stale: units shift on a slide; the Town doesn't (indexed by window column).
7. Town has one wallMat/roofMat and always roofs: walls, farms and the quarry need a style per cell.
8. Building and Job already exist in contracts/settlement.ts; nothing fills them from plans yet.

## Pieces (reuse → new)
- **Start:** `?level=atlas&town=1` + `&fortress=1`; the town's Settlement becomes the fortress; new `Settlements.pin(id)` keeps it live and stops `grow()`.
- **Select what, plan with tiles:** Town.plan/delta/pickBlock + LotGrid/irregularPolys (settle/grids.ts). New: an 8-type picker bar, an erase toggle; each cell owned by a structure id; painting next to the same type adds to it; a `style(c)` hook in Town.design (walls flat crenellated top; farm and quarry cells are yards).
- **Pause while planning:** the existing speed-0 path.
- **Building:** new `FortressLife` (src/fortress/life.ts) adapted from life.ts's phase machine and take/put/fell IO: builders fetch from the warehouse heap, walk to sites in BuildCrew's `todo()` order (made a pure function), work the load in; a block stands when its cost is in (`town.add`).
- **Quarry and lumber camp change the land:** life.ts `yieldOf`; miners dig inside painted quarry cells; woodcutters fell within a reach that grows with camp size.
- **Warehouse:** the pile; stone and logs are real heaps (terrain.put); grain, ore and weapons are ledger numbers; quarry stone yields ore at a set ratio.
- **Houses fill:** beds from house blocks; newcomers walk in from the box edge nearest a way.
- **Jobs:** new pure `JobBoard`: buildings declare slots by size; idle people take them in priority order.
- **Recipes:** new pure `RecipeRunner` over Recipe data (craft/train) in data/recipes/fortress.json; a trained soldier = a villager removed + a `guard` unit at the barracks.
- **Day counter:** DayNight wraps; DAY_S 600 not used for the fortress.
- **The army:** a threat card {SituationThreat, arrivesDay}; on arrival a new `startRaid(force)` spawns raiders at the box edge; existing guard melee and raid end.

## Contracts (sketch, src/api/contracts/fortress.ts)
StructureType (8 types); StructureDef {style, costPerBlock, perBlock {beds, storage, jobs, reach, rate}, recipe, maxLevels}; Structure {id, type, cells, built, planned, inv, buffer, workers}; StructurePlan (cell→structure); Ledger; JobSlot/JobBoard; RecipeRun; FortressClock {day, tod, paused, planning}; FortressThreat {threat, arrivesDay, state}; TownIO with origin(). Size gives cost, capacity and output: blocks × perBlock.

## Where it runs
CPU: the whole economy. GPU only through existing channels (TownStampSystem/ColumnStamp, the Agents API, terrain take/put). Raise NFIELDS 12→14 and MAX_GROUPS 16→20 (groupField array<vec4,5>, mirrored in TS) for the blacksmith and barracks destinations (fallback: one shared workplace field reseeded in turns). The Town covers the fortress's own world-anchored box (~160²) so a slide only changes an offset; the camera stays in the box. FortressLife owns fields 0-6 and groups 8-15+ so SettlementLife must not run alongside.

## Milestones (phone shots at 412x915; unit tests; runner checks in sim time)
1. Plan a typed structure, paused: pick, paint, stack, cost shown, time stopped.
2. Workers build it from the warehouse: blocks stand, stone down by the cost.
3. Quarry, lumber camp, hauling, houses fill: pit deepens, trees fall, stocks grow, population rises to beds.
4. Jobs and recipes: the blacksmith makes weapons from ore; the barracks trains soldiers.
5. Day counter and the army: the counter reaches N, raiders come, the raid ends repelled or looted.

## Risks
Heaps can wash or blow away (snapshot the ledger from them when a build starts); FortressLife duplicates life.ts (merge later); the groups/fields bump changes a contract and adds field memory; box offset vs the hex-lattice parity; old CityPlan buildings beside new blocks.

## Questions for the user
1. Start in the town only, or pick the site on the atlas in slice 1 too?
2. Day length (480 s now) and days until the army?
3. Do people eat grain in slice 1, and does food limit newcomers?
4. Ore: a share of quarry stone, or quarry cells on marked veins?
5. Walls: block stacks (flat top) or following cell edges?
6. Repurposing out of slice 1?

## The user's answers (round 128c, verbatim)

> "1 Town start is fine but these don't seem meaningfully different other than starting with income and resources in stores maybe 2. I think we can tune this once it is payable 3. I would require grain or food per person yes 4. Sure but let's add ore deposits later it sounds pretty easy 5. No you need to make tiles that fit together 6. Yes but I don't think this sounds hard to add"

- Start in a town (a town start mostly means starting with income and stores).
- Day length and the army's timing: tuned once it's playable.
- Food: grain (or food) required per person.
- Ore: a share of quarry stone now; ore deposits soon after (easy).
- Walls: wall TILES that fit together with their neighbours (Townscaper-style, auto-joined), not plain stacks.
- Repurposing: out of slice 1 but soon after (not hard).
