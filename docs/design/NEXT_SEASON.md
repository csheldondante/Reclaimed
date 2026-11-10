# Next season (Track A, round 128r)

The user: "large visual instant modifiers and time lapse playback not realtime simulation". One tap resolves a season at
once. The town then shows it changing over about 8 seconds, and Skip jumps to the end with the same world. It is built
on the systems docs/SYSTEMS.md names, using its three time scales: the season is atlas scale, realised now in the
window, and shown as the showcase.

## Design (as built)

1. **Resolve (atlas scale, pure).** `season/ledger.ts` `nextSeason(ledger, planView)` works on the pools (Magic, Might,
   Labor, Resources, Intel, Unrest) and the projects. Projects are cards played, each shaped as a card outcome: an
   AtlasEvent. It returns:
   - the next ledger;
   - the season's **AtlasEvents** (flood, drain, ruin, overgrow, mark), applied by `WorldState.apply`;
   - the settlement's **history marks** (`SettlementStoryEvent`: raided, ruined, overgrown, flooded, grew);
   - the ordered **changes** to realise (scaffold, stand, wear, grow, flood, drain), each at a fraction of the season;
   - a plain line saying what happened.
2. **Realise (the window, now).** `season/realise.ts` writes through each change's owner:
   - Fortress `markStarted`/`markBuilt`: the build view's plot, then scaffolding, then block (FT-51);
   - the new `Fortress.lowerTo`/`setWear` (TownPlan.setWear);
   - Plants.grow;
   - the live flood.

   A quarter's marks wear structures by **one rule**, `structures/purpose.ts markWear`. It is the generator's wear(),
   factored out, so the same CityMark makes the same wear in a generated town and on the live plan.
3. **Show.** `SimTiers.showcase(steps, {seconds, frame})` is the showcase SYSTEMS.md listed as missing.
   - Steps are applied as its clock passes them.
   - What they queue (one-tick events) is ticked on the frames after, even with time stopped.
   - `skip` applies the rest at once, in order.
   - The camera eases to each change at zoom 9.
   - The hook for cranes and fast agents is `ShowOpts.frame(t)`, presentation only.
4. **Stage.** Not stored: `season/stage.ts stageOf` derives it.
   - Planned, building and built come from the plan, the Town blocks and the begun set. ST18's progress is blocks
     standing over blocks planned.
   - Damaged, ruined and overgrown come from `wear`, which is extended to
     `'burned' | 'flooded' | 'damaged' | 'ruined' | 'overgrown'` and saved with the plan by toData.
   - There is no parallel field.
5. **The flood.** One fill, no simulation.
   - `terrain/basin.ts` extracts the window's heights on the GPU: the ground plus the water standing on it. The
     outlets are the grid's edge, the sea, held rivers and empty columns.
   - It runs `FloodGpu.run` (flood.wgsl, the terrain track's tool), refactored so its mark stays on the GPU.
   - It writes still water over the mark as **held water**: the depth goes into `riverFlow` (no flow, no discharge)
     and into `water`. riverheld.wgsl holds it. A basin at its spill height has nowhere to run, so nothing flows and
     its chunks sleep.
   - Rising and receding are writes of a level over the final mark, in 12 steps, not a simulation.
   - A GPU query (one word per structure) says which structures it covers.
6. **Order.** The ledger is the truth the instant it resolves. `SeasonPlay.settle()` awaits a resolve and skips the
   showcase. It runs before another season, and must run before any save.

## Readbacks and uploads

All of them happen after a tap; none happen every frame.
- The fill's 4-byte "changed" words, one per batch of 32 passes.
- The spill level: 4 B.
- The seed's ground: 4 B.
- The structures covered: 4 B per structure, about 300 B.
- Uploads: 32 B of params, and the structures' columns (about 5 KB).

All are listed in src/gpu/transfers.ts.

## Measured

Lab `town`, 412x915, q=low, on the desktop iGPU, which other agents were also using, so the GPU numbers are noisy.
- **Flood standing still:** about idle, as asked. Water passes take 0.02 ms and the field mesh 0.15-0.19 ms a frame,
  against 0.08 and 0.30 ms idle before. The derisk's run-off flood cost 1.44 ms for the field mesh.
- **During a showcase:** the frame interval p50 is 10 ms (100 Hz) throughout. The p95 is 20-98 ms, against 10 ms idle.
  The hitches come from the town view remaking all its pieces whenever any block changes (settle/view.ts). The
  builders pay the same cost (BACKLOG NS-8).
- **Resolve:** 190-230 ms for the first season (the flood's fill), 1 ms after that. The scenario's site search takes
  15-30 s, once (NS-12).
- **Skip versus play:** scripts/seasongate.mjs runs three seasons both ways. The ledger, history, plan, wear, blocks
  standing and structures flooded come out identical, and the water and plant probes are equal.

## The scenario

`season/scenario.ts` stands in for the dealer with three cards:
- **The fortress tower:** 3 cells, 6 storeys, 2 a season, on the open ground nearest the stores that the reach
  accepts.
- **The outer quarter:** the densest knot of buildings in the town's outer third. It is raided, then ruined, then
  overgrown.
- **The low ground:** seeds every 12 m within 64 m of the stores; the deepest basin is flooded to its spill height,
  held a season, then drained.

The start town has no dry hollow deeper than 1 m within 100 m of it, so the flood is shallow: about 1 m, at the
tower's foot.

## Rejected

- **A new disc or rect flood op, or a waterSource hold.** Superseded: the fill is the one source of which cells flood,
  and held water is the still-water representation the window already draws.
- **Writing the world at resolve with a render-side reveal.** It would need a second copy of the world's state in
  Track B's renderer.
- **Pausing the sims during a showcase.** That is a special case; the gate compares probes within a tolerance instead.

## Found and reused

Searched with grep and docs/MODULES.md; the code index was still building.
- FloodGpu and flood.wgsl: the fill.
- riverFlow and riverheld.wgsl: held water.
- SettlementStoryEvent, CityMark and purpose.ts wear: history marks become wear.
- The AtlasEvent kinds and MemoryWorldState.apply.
- SimTiers/Tiers: the showcase's home, and its pump.
- Plants.grow.
- Fortress.markStarted/markBuilt and the build view's stages.
- OppEffect 'atlas': the card outcome's shape.
- scripts/lab-gif.mjs: the GIF.

Not written, because these already existed or were superseded: a decay field, a playback system outside SimTiers, a
flood-level op, and a parallel stage counter.

## Open (BACKLOG NS-5 to NS-12)

- Track B's stage looks.
- River surge and drought through the held rivers' wetness.
- Burial fills.
- The view's whole-town remake.
- The flood in the atlas. Terrain.flood reaches only the atlas today. Its addBasin and this live fill are two fills of
  one kernel over two heightmaps (macro texels against live columns), and they can disagree at the edges.
- History marks and AtlasEvents in the real world model.
- Save.
