// Settlements — DRAFT (round 83, docs/SYSTEMS.md systems 6 and 12). The user: settlements should "use the same
// data structure we plan to expose to the city management game", with agents that are workers or hostile.
// This is a first shape to iterate on with the user's ideas for items, units and diplomacy: it's what the
// region generator places, what agents work in, what the GM's stories name, and what a city game would edit.
// The building cells are build/towngrid.ts's irregular grid (Townscaper-style).

import type { FactionId, RegionId } from './world';

export interface Settlement {
  id: string;
  name: string;
  region: RegionId;
  faction: FactionId | null;
  /** where it stands (world cells) and how far it reaches */
  at: [number, number];
  radius: number;
  /** small camp .. city */
  size: 'camp' | 'hamlet' | 'village' | 'town' | 'city';
  /** its state: thriving, struggling, besieged, abandoned, ruined (the region's ruin, the story's doing) */
  condition: 'thriving' | 'struggling' | 'besieged' | 'abandoned' | 'ruined';
  buildings: Building[];
  /** who lives and works there, by role (the unit generator's roles) */
  people: { role: string; count: number; hostile?: boolean }[];
  /** what it has and makes (a city game's economy: stock and rates per resource) */
  stores: Record<string, { stock: number; rate: number }>;
  /** what work it needs done (agents take these as jobs) */
  needs: Job[];
}

export interface Building {
  id: string;
  /** what it is: house, smithy, granary, wall, gate, tower, shrine, mine, farm … */
  kind: string;
  /** its cells on the town grid (build/towngrid.ts) and its storeys */
  cells: number[];
  storeys: number;
  /** 0 ruin .. 1 whole */
  condition: number;
  /** what it makes or holds (resource → rate or capacity) */
  makes?: Record<string, number>;
  holds?: Record<string, number>;
  /** who works there (roles) */
  workers?: string[];
}

/** Work for agents (docs/AGENTS.md: jobs are fields): build, repair, haul, farm, mine, fell, guard, raid. */
export interface Job {
  kind: 'build' | 'repair' | 'haul' | 'farm' | 'mine' | 'fell' | 'guard' | 'raid' | 'flee';
  at: [number, number];
  /** a building, a resource, a target */
  ref?: string;
  priority: number;
}
