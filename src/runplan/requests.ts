// ---- runplan/requests.ts ----------------------------------------------------------------------------------------
// (runplay, round 119 — the consolidation) The plan's asks of terrain (contracts/run.ts RunTerrainAsk: "request
// obstacles or otherwise request a certain number of exits", in atlas regions) turned into terrain's own requests
// (contracts/terrain.ts TerrainRequest: about the rooms and borders of a stage's land). Why here and when: terrain's
// rooms exist only once a stage's rectangle is sampled (Terrain.graph(rect)), and its edits are stamped into land as
// it's made — so the level calls `askTerrain` when a leg sets out, before the destination's land is precached. Terrain
// may say no (TerrainResult.ok false); the run goes on and the log says why.

import type { ControllerProfile } from '../api/contracts/play';
import type { RunPlan, RunStage, RunTerrainAsk } from '../api/contracts/run';
import type { BarrierKind, Terrain, TerrainGraph, TerrainRequest, V2 } from '../api/contracts';

/** the stage's land the requests are made on: a square this far round its middle (world units: a few screens) */
export const STAGE_HALF = 256;

/** a planned barrier as the obstacle terrain builds for it (absent: terrain has no obstacle of that kind to build) */
export const OBSTACLE: Partial<Record<BarrierKind, 'wall' | 'vegetation' | 'rubble' | 'ravine'>> = {
  cliff: 'wall',
  steep: 'wall',
  ridge: 'wall',
  ravine: 'ravine',
  lava: 'ravine',
  vegetation: 'vegetation',
  tar: 'vegetation',
};

/** the plan's asks that touch a stage's region */
export function asksFor(plan: Pick<RunPlan, 'requests'>, stage: Pick<RunStage, 'region'>): RunTerrainAsk[] {
  return plan.requests.filter((r) => (r.kind === 'exits' ? r.region === stage.region : r.a === stage.region || r.b === stage.region));
}

/** the stage's room: the one under its middle, or the room whose centre is nearest */
export function stageRoom(g: TerrainGraph, at: V2): number {
  const r = g.roomAt(at);
  if (r >= 0) return r;
  let best = -1;
  let bd = Infinity;
  for (const R of g.rooms()) {
    const d = Math.hypot(R.centre[0] - at[0], R.centre[1] - at[1]);
    if (d < bd) (bd = d), (best = R.id);
  }
  return best;
}

/** a border out of `room` whose far room lies in atlas region `toward` (regionAt: terrain's atlas graph's) */
export function borderToward(g: TerrainGraph, room: number, toward: number, regionAt: (p: V2) => number): number | null {
  let best: number | null = null;
  let bl = -1;
  for (const B of g.borders(room)) {
    const other = B.a === room ? B.b : B.a;
    if (regionAt(g.region(other).centre) !== toward) continue;
    if (B.length > bl) (bl = B.length), (best = B.id);
  }
  return best;
}

/** One ask as terrain's requests on the stage's graph (or why none). */
export function toTerrainRequests(ask: RunTerrainAsk, g: TerrainGraph, stage: Pick<RunStage, 'region' | 'at'>, body: ControllerProfile, regionAt: (p: V2) => number): { req: TerrainRequest | null; note: string }[] {
  const room = stageRoom(g, stage.at);
  if (room < 0) return [{ req: null, note: 'no room on the stage’s land' }];
  if (ask.kind === 'exits') {
    const count = Math.max(1, ask.toward.length);
    const now = g.exits(room, body).length;
    // (not closing others: only more ways out when there are too few; closing: exactly this many)
    if (!ask.closeOthers && now >= count) return [{ req: null, note: `exits: ${now} already (≥ ${count})` }];
    return [{ req: { kind: 'exits', room, count, caps: body }, note: `exits: ${count} from room ${room} (${now} now)` }];
  }
  const other = ask.a === stage.region ? ask.b : ask.a;
  const border = borderToward(g, room, other, regionAt);
  if (border === null) return [{ req: null, note: `obstacle ${ask.barrier}: no border of the stage's room toward region ${other}` }];
  const barrier = OBSTACLE[ask.barrier];
  if (!barrier) return [{ req: null, note: `obstacle ${ask.barrier}: terrain builds no such obstacle (${ask.passage})` }];
  return [{ req: { kind: 'obstacle', border, barrier }, note: `obstacle ${barrier} on border ${border} toward region ${other} (${ask.passage})` }];
}

/**
 * The stage's asks made of terrain: its land graphed (a square STAGE_HALF round its middle), each ask turned into
 * terrain's requests and made, a soft barrier laid where the plan put a host. Returns what happened, a line each.
 */
export async function askTerrain(terrain: Terrain, plan: Pick<RunPlan, 'requests'>, stage: Pick<RunStage, 'region' | 'at'>, body: ControllerProfile): Promise<string[]> {
  const asks = asksFor(plan, stage);
  if (!asks.length) return ['no asks'];
  const [x, y] = stage.at;
  const g = await terrain.graph({ x0: x - STAGE_HALF, y0: y - STAGE_HALF, x1: x + STAGE_HALF, y1: y + STAGE_HALF });
  const regionAt = (p: V2) => terrain.atlasGraph().regionAt(p);
  const log: string[] = [];
  for (const ask of asks)
    for (const { req, note } of toTerrainRequests(ask, g, stage, body, regionAt)) {
      if (!req) {
        log.push(note);
        continue;
      }
      const r = terrain.request(g, req);
      log.push(`${note}: ${r.ok ? 'ok' : `no (${r.reason})`}, ${r.edits.length} edits${r.needs.length ? `, needs ${r.needs.map((n) => n.kind).join(' ')}` : ''}`);
    }
  return log;
}
