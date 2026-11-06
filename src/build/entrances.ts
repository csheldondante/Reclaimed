// How each structure of a town is entered (round 128o, DA-A7's core; DESIGN.md section 12: "Tiles declare all their
// paths"). One rule from the plan, read by the ways (fortress/ways.ts: the roads join every entrance), the routes
// (fortress/lanes.ts), the fortress's doors and stores (Fortress.doorOf) and generation (structures/place.ts: every
// structure but a wall placed with one). By form:
//  - a block or the keep: a door, on a ground-floor side that opens on free ground (else on another block's passage or
//    a field),
//    facing the town's middle (the keep its gates); a courtyard last;
//  - a wall: its gates, each side a gate opens on;
//  - a yard (a farm, an orchard, a pasture, the fountain's square): its edge, the side nearest the middle that opens on
//    free ground; a quarry with tiers its pit's ramp top (only there: the miners haul up the ramps);
//  - a bridge: none here (its decks are the roads' own).
// A structure without one has no way in: the ways count it cut off. Pure.
import type { StructureDef, StructureType } from '../api/contracts/fortress';
import type { V2 } from '../api/contracts/structures';
import type { TownPlan } from './plan';
import { DEFS } from './types';

export interface EntranceGrid {
  readonly count: number;
  readonly nbr: Int32Array;
  centre(c: number): [number, number];
}

export type EntranceKind = 'door' | 'gate' | 'edge' | 'pit';

export interface Entrance {
  structure: number;
  kind: EntranceKind;
  /** the structure's cell and the side it's entered by */
  cell: number;
  side: number;
  /** the cell it's entered from: free ground, or another block's passage */
  out: number;
}

/**
 * whether a cell is ground a walker stands on outside a structure: free, a block's passage (an arch through it), or a
 * yard walked across (a field: StructureDef.crossed)
 */
export function openCell(plan: TownPlan, c: number, defs: Record<StructureType, StructureDef> = DEFS): boolean {
  if (c < 0) return false;
  const t = plan.typeAt(c);
  if (!t) return true;
  return (defs[t].form === 'block' && !!plan.passage[c] && plan.has(c, 0)) || !!defs[t].crossed;
}

/**
 * Every structure's entrances. `courtyards`: free cells shut in by structures (shapes.ts) — a door opens on one only when
 * nothing else is open. `blocked`: free cells no one walks (deep water): nothing opens on them.
 */
export function entrancesOf(
  plan: TownPlan,
  g: EntranceGrid,
  courtyards: readonly number[] = [],
  blocked: (c: number) => boolean = () => false,
  defs: Record<StructureType, StructureDef> = DEFS,
): Entrance[] {
  const nb = (c: number, e: number) => g.nbr[c * 4 + (((e % 4) + 4) % 4)];
  const court = new Set(courtyards);
  const structures = plan.structures();
  const formOf = (c: number) => {
    const t = plan.typeAt(c);
    return t ? defs[t].form : null;
  };
  const free = (c: number) => c >= 0 && plan.owner[c] < 0 && !blocked(c);
  /** entered from: free ground first, a passage after (cost added), a courtyard last */
  const from = (s: number, c: number): number => {
    if (free(c)) return court.has(c) ? 2e6 : 0;
    return plan.owner[c] !== s && openCell(plan, c, defs) ? 1e6 : -1;
  };
  const mean = (cells: number[]): V2 | null => {
    if (!cells.length) return null;
    let x = 0;
    let y = 0;
    for (const c of cells) {
      const [cx, cy] = g.centre(c);
      x += cx / cells.length;
      y += cy / cells.length;
    }
    return [x, y];
  };
  const allCells = structures.flatMap((s) => [...s.cells.keys()]);
  const keepCells = structures.filter((s) => defs[s.type].form === 'keep').flatMap((s) => [...s.cells.keys()]);
  const gates = allCells.filter((c) => formOf(c) === 'wall' && plan.gate[c] && plan.has(c, 0));
  const middle = mean(keepCells) ?? mean(allCells) ?? [0, 0];
  const gateMid = mean(gates);
  const d2 = (c: number, p: V2) => {
    const [x, y] = g.centre(c);
    return (x - p[0]) ** 2 + (y - p[1]) ** 2;
  };
  /** the best side of a structure's cells to enter by (cells filtered by `may`), facing `toward` */
  const best = (sid: number, cells: Iterable<number>, toward: V2, kind: EntranceKind): Entrance | null => {
    let out: Entrance | null = null;
    let bd = Infinity;
    for (const c of cells)
      for (let e = 0; e < 4; e++) {
        const o = nb(c, e);
        const cost = from(sid, o);
        if (cost < 0) continue;
        const d = d2(o, toward) + cost;
        if (d < bd) {
          bd = d;
          out = { structure: sid, kind, cell: c, side: e, out: o };
        }
      }
    return out;
  };
  const out: Entrance[] = [];
  for (const s of structures) {
    const form = defs[s.type].form;
    if (form === 'block' || form === 'keep') {
      // (the keep faces its gates, else the rest of the town; the others face the keep)
      const toward: V2 = form === 'keep' ? (gateMid ?? mean(allCells.filter((c) => plan.owner[c] !== s.id)) ?? middle) : middle;
      const d = best(s.id, [...s.cells.keys()].filter((c) => plan.has(c, 0)), toward, 'door');
      if (d) out.push(d);
    } else if (form === 'wall') {
      for (const c of s.cells.keys()) {
        if (!plan.gate[c] || !plan.has(c, 0)) continue;
        for (let e = 0; e < 4; e++) if (from(s.id, nb(c, e)) >= 0 && formOf(nb(c, e)) !== 'wall') out.push({ structure: s.id, kind: 'gate', cell: c, side: e, out: nb(c, e) });
      }
    } else if (form === 'yard') {
      const pit = s.type === 'quarry' ? plan.pitOf(s.id) : null;
      if (pit && pit.tiers) {
        const o = nb(pit.top, pit.topSide);
        if (from(s.id, o) >= 0) out.push({ structure: s.id, kind: 'pit', cell: pit.top, side: pit.topSide, out: o });
        continue;
      }
      const d = best(s.id, s.cells.keys(), middle, 'edge');
      if (d) out.push(d);
    }
  }
  return out;
}

/** whether a structure needs an entrance: all but walls (a barrier, built from its sides) and bridges */
export function needsEntrance(type: StructureType, defs: Record<StructureType, StructureDef> = DEFS): boolean {
  const f = defs[type].form;
  return f !== 'wall' && f !== 'bridge';
}
