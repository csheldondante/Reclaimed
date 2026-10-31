// What a settlement is for (round 120, `cities`; BACKLOG STR30, STR36). The user, verbatim (DECISIONS round 120):
//   "I do want to make it so different settlements have different purposes like trading posts, mines, lumber camps, etc.
//    towns should have stories."
// Read from the land and the world state, never rolled: the atlas placed each site for its setting (a port at a river
// mouth, a cliffside town on a plateau rim, a mountain flank, a crater rim, a river town, a plain), and its region says
// what the land is (rock or soil, forest, rivers, how dry, how high, what's stamped in it: craters, crystal), its roads
// say whether it's a crossroads or a ford, the factions' presence whether it needs to be a hold. Each purpose is scored
// from those and the highest wins; the scores are kept so the GM can see a near thing ("a mining town that could have
// been a port"). Pure: the wiki calls it while it's built (gm/wiki.ts), so the GM reads a settlement's purpose before
// its land ever comes in; the planner (plan.ts) then reads the box's ground for where exactly the purpose's work goes.
import type { SettlementPurpose, SettlementPurposeRec } from '../api/contracts/settlement';
import type { KindTraits } from '../atlas/kind-traits';



export const PURPOSES: SettlementPurpose[] = ['port', 'mining', 'lumber', 'farming', 'trading', 'hold'];

/** What the atlas and the world state say about a site (gm/atlas-facts.ts, the wiki). */
export interface PurposeFacts {
  /** the atlas's setting: cliffside, port, river, mountain flank, crater rim, plain */
  setting: string;
  /** village, town, city, metropolis */
  size: string;
  /** roads that meet here */
  roads: number;
  /** its roads' bridges in its own region (a ford, a crossing: trade passes through) */
  crossings: number;
  region: {
    kind: string;
    tier: string | null;
    /** river nodes in it */
    rivers: number;
    /** 0 wet .. 1 dry; °C at sea level */
    dryness: number;
    temp: number;
    ground: { min: number; mean: number; max: number };
    /** atlas stamps whose centre is in it (impact craters, crystal facets …) */
    stamps: string[];
    /** what its kind of land is (atlas/regions.ts KINDS, via the atlas facts) */
    traits: KindTraits;
  };
  /** the site's ground (world z) and the sea's */
  ground: number;
  sea: number;
  /** the strongest hostile faction presence in its region (0..1) */
  hostile: number;
  /** a realm's seat */
  seat: boolean;
}

/** Each purpose's score from the land (higher: more what the land makes it). */
export function purposeScores(f: PurposeFacts): Record<SettlementPurpose, number> {
  const k = f.region.traits;
  const big = f.size === 'city' || f.size === 'metropolis';
  const low = f.ground - f.sea;
  const span = Math.max(1, f.region.ground.max - f.region.ground.min);
  /** how high the site stands in its region (0 its lowest, 1 its highest) */
  const height = Math.max(0, Math.min(1, (f.ground - f.region.ground.min) / span));
  const river = f.setting === 'river' || f.setting === 'port' || f.region.rivers > 0;
  // ore: rock showing (a stony top or thin cover), crystal veins (an accent), cave-riddled ground, craters' rubble
  const rocky = (k.rockTop ? 1 : 0) + (k.cover < 1 ? 0.4 : 0);
  const ore = rocky + (k.accent ? 0.6 : 0) + (k.cave >= 0.8 ? 0.3 : 0) + (f.region.stamps.some((s) => /crater|crystal|facet/.test(s)) ? 0.5 : 0);
  // forest: the kind's growth, a wet enough and warm enough climate
  const forest = k.veg * Math.max(0, 1 - f.region.dryness) * (f.region.temp > 0 ? 1 : 0.3);
  const settingOre = f.setting === 'mountain flank' ? 2.2 : f.setting === 'crater rim' ? 2 : f.setting === 'cliffside' ? 1 : 0;
  // (the flats are the lowlands'; an upland's rolling ground less so)
  const flat = f.region.tier === 'lowland' ? 1 : f.region.tier === 'upland' ? 0.7 : 0;
  return {
    // (the atlas calls any site within reach of the sea a port, even one on a plateau 200 over it: a harbour needs the
    // town down by the water — full under 6 over the sea, none past 18 — and a big town makes more of one)
    port: f.setting === 'port' ? 2.4 * Math.max(0, Math.min(1, (18 - low) / 12)) + (big ? 0.4 : 0) : f.setting === 'river' && low < 8 ? 1.1 : 0,
    mining: settingOre > 0 || ore >= 1.2 ? settingOre + ore : 0,
    // "forest plus a river": both, or it's a woodcutters' hamlet at most
    lumber: 2.4 * forest * (river ? 1 : 0.35),
    farming: flat * (1.1 + 0.5 * Math.min(1.3, k.veg) + (f.setting === 'plain' ? 0.6 : f.setting === 'river' ? 0.4 : 0) - 0.9 * f.region.dryness) + (k.soilTop ? 0.3 : 0),
    trading: (f.roads >= 3 ? 0.75 + 0.6 * (f.roads - 3) : 0) + (f.crossings > 0 ? 0.9 : 0) + (big && f.roads >= 2 ? 0.4 : 0),
    hold: (f.setting === 'cliffside' ? 1.8 : 0) + (height > 0.6 ? 0.8 : 0) + (f.seat ? 0.9 : 0) + 0.9 * f.hostile + (big ? 0.3 : 0),
  };
}

const TRADES: Record<SettlementPurpose, string[]> = {
  port: ['docker', 'sailor', 'fisher', 'trader'],
  mining: ['miner', 'carter', 'smith'],
  lumber: ['woodcutter', 'sawyer', 'raftsman'],
  farming: ['farmer', 'miller'],
  trading: ['trader', 'stablehand', 'carter'],
  hold: ['guard', 'smith'],
};

/** Why the land made it this (a sentence for the GM and the wiki). */
function why(p: SettlementPurpose, f: PurposeFacts): string {
  const kind = f.region.kind;
  switch (p) {
    case 'port':
      return f.setting === 'port' ? 'a harbour where the land meets the sea' : 'a river landing low by the water';
    case 'mining':
      return f.setting === 'mountain flank' ? `ore in the cliffs of the ${kind} flank` : f.setting === 'crater rim' ? 'ore thrown up round a crater' : `ore in the ${kind}'s rock`;
    case 'lumber':
      return `the ${kind}'s forest and a river to float the logs down`;
    case 'farming':
      return `fertile ${f.setting === 'river' ? 'river flats' : 'ground'} in the ${kind}`;
    case 'trading':
      return f.roads >= 3 ? `a crossroads where ${f.roads} roads meet` : 'a crossing where the road fords the river';
    case 'hold':
      return f.setting === 'cliffside' ? 'a defensible height over its cliff' : f.seat ? "its realm's seat on the high ground" : 'high ground held against its enemies';
  }
}

/** A site's purpose from the land: the highest score (ties: PURPOSES' order), why, and what its people do. */
export function purposeOf(f: PurposeFacts): SettlementPurposeRec {
  const scores = purposeScores(f);
  let best: SettlementPurpose = 'farming';
  let bs = -Infinity;
  for (const p of PURPOSES)
    if (scores[p] > bs) {
      bs = scores[p];
      best = p;
    }
  for (const p of PURPOSES) scores[p] = +scores[p].toFixed(2);
  return { kind: best, why: why(best, f), scores, trades: TRADES[best] };
}
