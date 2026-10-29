// The sims' tiers (round 108, BACKLOG SM1; DECISIONS round 108). The user: "Yes unless explicitly requested in the
// API. Like water we want to see falling and and blowing dust even if the underlying map isn't changing."
//
// Each slow process that changes the map is either LIVE (it changes the map in play) or BAKED (in play it doesn't
// change the map at all; it's run between runs, or on a story event, by an explicit `bake`). What the player is
// there to see react stays live always and isn't on this list: breakage, collapse, fracture, slumps and falls of
// loose ground, dust and debris particles, falling and flowing water, fire, snow and ice, the agents' work, the
// player's own powers (a grow tap, an edit, a pour), contamination washed by rain and seeds cleaning poison (the
// game's core mechanic, SM3). And round the player's interactions (a power, an edit, a stroke of wind) rain and wind
// erosion run live until the area settles (SM2, round 78's "unfreeze for player interactions"); the game needn't
// ask for that.
//
// Baked never means still: the visuals of a baked process keep running. Rain falls and the water flows; the wind
// lifts dust off loose ground and blows it along as particles; trees still shed seeds and leaves into the breeze —
// they just don't wash the ground away, pile dunes, sprout or grow while baked.
//
// Coordinates: the level's window, as the world API's (x in cells, y in world units). A region is kept with the
// land (in world cells) when the window slides; one wholly off the window does nothing until it's back.
//
//   tiers.tier('windErosion')                          // 'baked' (the default in play)
//   const h = tiers.live(['rainErosion'], { x0, y0, x1, y1 })   // the game asks: rain erodes here, live
//   h.release()
//   await tiers.bake('all', ['rainErosion', 'windErosion', 'vegetation'], 600)   // between runs: ten minutes' worth
//   await tiers.bake(rect, ['vegetation'], 3600)       // a story event: the forest overgrows a ruin

/** The processes with a tier. */
export type TieredProcess =
  /** water washing loose ground downstream (rain's runoff, rivers, floods; sediment.wgsl waterOut) */
  | 'rainErosion'
  /** wind carrying loose ground off and piling it in the lee, dust storms' and cyclones' dust laid down, dust
   *  carried by particles set down where it lands, litter torn off, the wind's easing of loose slopes */
  | 'windErosion'
  /** vegetation growth and spread (ecology), dying back where it browned, seeds sprouting where they land,
   *  green binding dust into soil, leaf fall and rot, moss on structures */
  | 'vegetation';

export const TIERED_PROCESSES: readonly TieredProcess[] = ['rainErosion', 'windErosion', 'vegetation'];

export type Tier = 'live' | 'baked';

/** A rectangle of the window (x in cells, y in world units), half-open. */
export interface TierRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LiveHandle {
  /** the region goes back to the processes' own tiers */
  release(): void;
}

export interface BakeReport {
  /** simulated seconds of the processes run */
  seconds: number;
  /** sim ticks it took */
  ticks: number;
  /** the processes' rate over the bake (simulated seconds a tick over the tick's own) */
  gain: number;
  /** wall time (ms) */
  ms: number;
}

export interface BakeOpts {
  /** the processes' rate over the bake, simulated seconds a tick over the tick's own: higher is fewer ticks and
   *  coarser (per-pass caps hold it stable). Default 8 (BAKE_GAIN). */
  gain?: number;
  /** ticks run a frame (the rest of the frame goes on). Default 30. */
  ticksPerFrame?: number;
}

export interface SimTiers {
  /** the process's tier everywhere (regions asked live aside) */
  tier(p: TieredProcess): Tier;
  /** set it everywhere (the default in play: all baked) */
  setTier(p: TieredProcess, t: Tier): void;
  /** these processes live in this region until released (any number; a chunk is the grain — 16 columns) */
  live(ps: readonly TieredProcess[], region: TierRect): LiveHandle;
  /**
   * Run baked processes for `seconds` of simulated time over a region of the window (or all of it): what
   * between-runs or a story event does. The rest of the sim runs alongside meanwhile (the water flows, so a bake's
   * rain erosion has runoff to work with). Resolves when done; one bake at a time (a second waits for the first).
   */
  bake(region: TierRect | 'all', ps: readonly TieredProcess[], seconds: number, opts?: BakeOpts): Promise<BakeReport>;
}
