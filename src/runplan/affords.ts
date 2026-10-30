// ---- runplan/affords.ts -----------------------------------------------------------------------------------------
// (round 117, runplan) What kinds of play a region affords (0..1 each), from its ground and its state as the world
// left it. The planner multiplies these by the hero's likes (HeroCapabilities.likes) to pick where a run goes: open
// flats for a bike's races, gorges and badlands for chases, ruins and pillars for the lich to break, caves and rifts
// for the knight to delve, a town for talk, the walking dead for a horde.
// Why from the region and its state, not a fixed table per kind: the world changes between runs (a region sunk,
// overrun by the dead, ruined) and the next run should go where that left something to do — the user: "Decisions
// should impact the world for the next run."

import type { EncounterKind, RegionNode } from '../api/contracts/run';
import type { Faction, RegionState } from '../api/contracts/world';

const OPEN = new Set(['plains', 'dunes', 'tundra', 'glacier', 'badlands']);
const BROKEN = new Set(['badlands', 'mesa', 'hills', 'rift', 'basalt', 'escarpment']);
const DEEP = new Set(['range', 'karst', 'cenotes', 'rift', 'escarpment', 'highlands', 'craters']);
const SPECTACLE = new Set(['lavafield', 'craters', 'crystalfield', 'spires', 'basalt', 'glacier', 'cenotes']);
const BREAKABLE = new Set(['karst', 'spires', 'crystalfield', 'basalt', 'mesa']);

export type Affordances = Record<EncounterKind, number>;

const clamp = (v: number) => Math.max(0, Math.min(1, v));

export function affordances(n: RegionNode, s: RegionState, factions: Map<string, Faction>, captives = 0): Affordances {
  const relief = n.ground.max - n.ground.min;
  const big = clamp(n.area / 800);
  const towns = n.settlements.length;
  // who's hostile here: presence weighted by how much they dislike the player
  let hostile = 0;
  let friendly = 0;
  for (const [id, p] of Object.entries(s.presence)) {
    const a = factions.get(id)?.attitude ?? 0;
    if (a < -0.2) hostile += (p ?? 0) * (-a);
    else if (a > 0) friendly += (p ?? 0) * a;
    // the Hollow Court (the dead's own faction in the wiki) counts as hostile whatever its attitude
    if (id === 'f-hollow-court') hostile += (p ?? 0) * 0.5;
  }
  const a: Affordances = {
    race: (OPEN.has(n.kind) ? 0.6 : 0) + (relief < 30 ? 0.3 : 0) + 0.2 * big - 0.4 * s.ruin,
    chase: (BROKEN.has(n.kind) ? 0.6 : 0.1) + 0.3 * clamp(relief / 80) + 0.3 * clamp(hostile),
    fight: 0.2 + 0.5 * clamp(hostile) + (towns ? 0.2 : 0) + 0.3 * s.undead,
    horde: 0.8 * s.undead + 0.5 * clamp(hostile) + (n.stamps.includes('crater') ? 0.1 : 0),
    spectacle: (SPECTACLE.has(n.kind) ? 0.6 : 0) + 0.3 * clamp(n.lava / 20) + 0.4 * s.storm.strength + 0.3 * s.shadow,
    destruction: (towns ? 0.4 : 0) + (BREAKABLE.has(n.kind) ? 0.4 : 0) + 0.5 * s.ruin + 0.2 * s.overgrowth,
    delve: (DEEP.has(n.kind) ? 0.6 : 0) + 0.3 * clamp(relief / 120) + (s.marks.length ? 0.2 : 0) + 0.3 * clamp(s.buried.depth / 8),
    talk: towns ? 0.5 + 0.4 * clamp(friendly) : 0.05,
    explore: 0.2 + 0.3 * clamp(n.rivers / 30) + (s.marks.length ? 0.3 : 0) + 0.2 * s.overgrowth + (s.flooded !== null || s.sunk > 0 ? 0.3 : 0),
    rescue: captives ? 1 : 0,
  };
  for (const k of Object.keys(a) as EncounterKind[]) a[k] = clamp(a[k]);
  return a;
}
