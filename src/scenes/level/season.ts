// (round 128r, Track A "Next season") The season on the fortress's town: its ledger (season/ledger.ts) over the live
// plan, realised through the fortress, the plants and the live flood (terrain/basin.ts), played as the showcase
// (core.tiers.showcase), its AtlasEvents applied to a world state. API: startSeason(scene, fort) → SeasonPlay, and
// `seasonCards` (the start town's scenario, played on the first Next season while the dealer doesn't feed seasons).
import type { Fortress } from '../../fortress/fortress';
import type { LevelScene } from '../level';
import { LiveFlood } from '../../terrain/basin';
import { SeasonPlay } from '../../season/play';
import { newLedger, play, type PlanView } from '../../season/ledger';
import type { SeasonWorld } from '../../season/realise';
import { startTownCards, type ScenarioSite } from '../../season/scenario';
import { MemoryWorldState } from '../../api/contracts/world-state';
import { cellAt } from '../../world/lattice';
import { worldApiOf } from './world-api';
import type { V2 } from '../../api/contracts/structures';

/** the zoom the camera frames a change at while a season plays (closer than planning's: the stages read) */
export const SEASON_ZOOM = 9;
/** wall seconds a season plays over */
export const SEASON_SECONDS = 8;
/** the pools the start town begins with, and its income a season (DECISIONS round 128r: small counting numbers) */
export const START_POOLS = { magic: 3, might: 2, labor: 4, resources: 3, intel: 1, unrest: 0 };
export const SEASON_INCOME = { magic: 1, labor: 2, resources: 1 };

export interface SeasonOnTown {
  play: SeasonPlay;
  /** the world state the season's AtlasEvents go to (the town's region: 0) */
  world: MemoryWorldState;
  flood: LiveFlood;
  /** the start town's cards played (the first Next season does it; the lab may first) */
  setup(): Promise<void>;
  /** Next season: the scenario set up first if it isn't */
  next(): Promise<void>;
  /** an error the last Next season ended in (shown to the developer, not the player) */
  error: string | null;
  /** a Next season under way: the scenario setting up, the season resolving or playing */
  readonly busy: boolean;
  /** the view a season plays in, set by the fortress's bar (the build view, time stopped); called by `next` */
  enter: () => void;
}

export function startSeason(scene: LevelScene, fort: Fortress, townName: string): SeasonOnTown {
  const core = scene.core;
  const flood = new LiveFlood(scene.host.gpu.device, core.world);
  const plan = fort.plan;
  const colOf = (cell: number): [number, number] => {
    const [x, y] = fort.centre(cell);
    return cellAt(x, y);
  };
  const centreOf = (id: number): V2 | null => {
    const s = plan.structure(id);
    if (!s || !s.cells.size) return null;
    let x = 0;
    let y = 0;
    for (const c of s.cells.keys()) {
      const p = fort.centre(c);
      x += p[0];
      y += p[1];
    }
    return [x / s.cells.size, y / s.cells.size];
  };
  const storeysOf = (id: number) => Math.max(0, ...[...plan.structure(id)!.cells.keys()].map((c) => plan.top(c) + 1));
  const view: PlanView = {
    blocks: (id) => {
      const s = plan.structure(id);
      if (!s) return [];
      const out: { cell: number; level: number; standing: boolean }[] = [];
      for (const [c, runs] of [...s.cells].sort((a, b) => a[0] - b[0])) for (const r of runs) for (let l = r.lo; l < r.hi; l++) out.push({ cell: c, level: l, standing: fort.town.has(c, l) });
      return out.sort((a, b) => a.level - b.level || a.cell - b.cell);
    },
    structure: (id) => {
      const s = plan.structure(id);
      const c = centreOf(id);
      return s && c ? { centre: c, base: s.floor ?? 0, storeys: storeysOf(id) } : null;
    },
    // (what a quarter's marks are judged on: the buildings — not walls, fields or yards walked across)
    structures: () =>
      plan
        .structures()
        .filter((s) => s.type !== 'wall' && !fort.plan.defs[s.type].crossed)
        .sort((a, b) => a.id - b.id)
        .map((s) => ({ id: s.id, centre: centreOf(s.id)!, base: s.floor ?? 0, storeys: storeysOf(s.id) })),
  };
  const sim = () => worldApiOf(scene);
  const world: SeasonWorld = {
    scaffold: (c, l) => fort.markStarted(c, l),
    // (a block the builders put up meanwhile stands already: the season's is the same block)
    stand: (c, l) => void (fort.town.has(c, l) || fort.markBuilt(c, l)),
    lowerTo: (id, n) => void fort.lowerTo(id, n),
    setWear: (id, w) => fort.setWear(id, w),
    grow: (x, y, r) => sim().plants!.grow(x, y, { radius: r, strength: 60 }),
    basin: (x, y, level) => flood.basin(x, y, { level }),
    columns: () => {
      const out: { col: [number, number]; structure: number }[] = [];
      for (const s of plan.structures()) for (const c of s.cells.keys()) out.push({ col: colOf(c), structure: s.id });
      return out;
    },
    where: (c) => {
      if (c.kind === 'scaffold' || c.kind === 'stand') return fort.centre(c.cell);
      if (c.kind === 'wear') return centreOf(c.structure);
      if (c.kind === 'grow' || c.kind === 'flood') return [c.x, c.y];
      return null;
    },
  };
  const ws = new MemoryWorldState(0, [{ id: 0, name: townName, kind: 'town' }]);
  const cam = core.camera;
  const seasonPlay = new SeasonPlay(
    {
      world,
      plan: view,
      tiers: core.tiers,
      seconds: Number(scene.host.params.get('seasonsecs') ?? SEASON_SECONDS),
      look: (x, y) => {
        // (eased toward the change: a few frames to arrive, so the cuts between changes don't jump)
        cam.target[0] += (x - cam.target[0]) * 0.12;
        cam.target[1] += (y - cam.target[1]) * 0.12;
        cam.zoom += (SEASON_ZOOM - cam.zoom) * 0.12;
      },
      apply: (e, season) => ws.apply({ ...e, regions: [0], run: season }),
    },
    newLedger(START_POOLS, SEASON_INCOME),
  );
  let ready: Promise<void> | null = null;
  const site: ScenarioSite = {
    heap: fort.storesAt() ?? fort.centre(0),
    structures: () => plan.structures().map((s) => ({ id: s.id, centre: centreOf(s.id)!, district: s.district, type: s.type })),
    footprints: (at, n, most) => {
      const free = (c: number) => c >= 0 && plan.typeAt(c) === null && fort.wetAt(...fort.centre(c)) === false;
      const open = (c: number) => free(c) && [0, 1, 2, 3].every((k) => free(fort.grid.nbr[c * 4 + k]));
      const order = [...Array(fort.grid.count).keys()].filter(open).sort((a, b) => dist(fort.centre(a), at) - dist(fort.centre(b), at) || a - b);
      const out: number[][] = [];
      const used = new Set<number>();
      for (const c of order) {
        if (out.length >= most) break;
        if (used.has(c) || dist(fort.centre(c), at) < 12) continue;
        const group = [c];
        for (let k = 0; k < 4 && group.length < n; k++) {
          const nb = fort.grid.nbr[c * 4 + k];
          if (open(nb) && !used.has(nb)) group.push(nb);
        }
        if (group.length < n) continue;
        group.forEach((g) => used.add(g));
        out.push(group);
      }
      return out;
    },
    planTower: async (cells, levels) => {
      // (the ground floor first, judged by the reach; the storeys over it once it stays)
      for (const c of cells) fort.paint(c, 0, 'fortress');
      await fort.settled();
      const take = () => [...cells].reverse().forEach((c) => [...plan.levels.each(c)].reverse().forEach((l) => fort.erase(c, l)));
      if (!cells.every((c) => plan.has(c, 0))) {
        take();
        return null;
      }
      for (let l = 1; l < levels; l++) for (const c of cells) fort.paint(c, l, 'fortress');
      await fort.settled();
      const s = plan.structureAt(cells[0]);
      if (s && cells.every((c) => plan.has(c, levels - 1) && plan.structureAt(c)?.id === s.id)) return s.id;
      take();
      return null;
    },
    probeFlood: async (at) => {
      const [cx, cy] = cellAt(at[0], at[1]);
      if (cx < 1 || cy < 1 || cx >= core.dims.w - 1 || cy >= core.dims.h - 1) return 0;
      const b = await flood.basin(at[0], at[1]);
      b.destroy();
      return b.level - b.floor;
    },
  };
  let tapped = 0;
  const out: SeasonOnTown = {
    get busy() {
      return tapped > 0 || seasonPlay.playing;
    },
    play: seasonPlay,
    world: ws,
    flood,
    error: null,
    enter: () => undefined,
    setup: () =>
      (ready ??= (async () => {
        let l = seasonPlay.ledger;
        for (const card of await startTownCards(site)) l = play(l, card);
        seasonPlay.ledger = l;
      })()),
    next: async () => {
      tapped++;
      try {
        out.error = null;
        out.enter();
        await out.setup();
        await seasonPlay.next();
      } catch (e) {
        out.error = String(e);
        console.error('season:', e);
        throw e;
      } finally {
        tapped--;
      }
    },
  };
  return out;
}

const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
