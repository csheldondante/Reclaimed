// (living town, docs/design/LIVING_TOWN.md) The living towns over the field towns (citygen/towns.ts FieldTowns): each
// town that's made gets its people (LivingTown: routes, riders, the works), let go with it. Their GPU work is encoded
// in the renderer's frame (frameCompute) with the profiler's timestamps; their figures are the renderer's voxels. The
// panel (?living=1) is the tuning editor over LIVING_TUNING with a line of counters read twice a second while it's open.
import type { FieldTown } from '../citygen/town';
import { REC_LM } from '../citygen/gpu';
import type { Profiler } from '../gpu/profiler';
import { LivingTown, C, L_C, L_Q, L_F } from './living';
import { Works, type WorksWorld } from './works';
import { LIVING_TUNING } from './params';
import { TunePanel } from '../ui/tunepanel';
import type { CityRouteRead } from '../api/contracts/routes';
import type { TownLogs } from '../citygen/townlog';
import { cellAt } from '../world/lattice';
/** routes.wgsl H_GATES: the arterials' ends */
const H_GATES = 5;

export interface LivingTownsIO {
  device: GPUDevice;
  towns(): ReadonlyMap<string, FieldTown>;
  addVoxels(inst: GPUBuffer, args: GPUBuffer): void;
  removeVoxels(args: GPUBuffer): void;
  addMesh(verts: GPUBuffer, args: GPUBuffer, xform: GPUBuffer): void;
  removeMesh(args: GPUBuffer): void;
  frameCompute: ((enc: GPUCommandEncoder) => void)[];
  profiler?: Profiler;
  dims: { w: number; h: number };
  /** the world's buffers the works use (quarry, clearing, stockpile) */
  world: WorksWorld;
  /** (saving) the towns' edit logs: the works' state laid back when a town's people are made again */
  logs?: TownLogs;
}

interface Live {
  town: FieldTown;
  life: LivingTown;
  works: Works;
  /** the town's mesh runs its graph was built from (a new run: a district's roads appeared — the graph made again) */
  meshRuns: number;
  sinceRebuild: number;
}
/** (saving) the works' words kept: the quarry's head (routes.wgsl Q_*: site, bench, progress, rim, benches …) and the
 *  clearing's (F_CAMP, F_YARD); the quarry's words made again on restore (its ramp's route, its pick, the yard's) */
const WORKS_Q = 20;
const WORKS_F = 8;
const WORKS_REMADE = [4, 9, 10, 15];
/** the least time between the graph's rebuilds for citygen's road redraws (s) */
const REBUILD_S = 10;

export class LivingTowns {
  readonly live = new Map<string, Live>();
  /** (?livingdebug=1) each town's graph drawn over it */
  debugGraph = false;
  panel?: TunePanel;
  private dt = 0;
  private hook = (enc: GPUCommandEncoder) => this.encode(enc);

  constructor(private io: LivingTownsIO) {
    io.frameCompute.push(this.hook);
    // (the panel's shown-road rule: set on every field town — citygen's own parameters)
    LIVING_TUNING.onChange((id) => {
      if (!id || !id.startsWith('roads.')) return;
      const r = LIVING_TUNING.values.roads;
      for (const t of this.io.towns().values()) t.setSkeleton({ skelReach: r.skelReach, skelMargin: r.skelMargin, minorAhead: r.minorAhead });
    });
  }

  /** each frame: new towns given their people, let-go ones' let go */
  update(dt: number): void {
    this.dt = dt;
    const towns = this.io.towns();
    for (const [id, l] of this.live) {
      if (towns.get(id) === l.town) continue;
      this.drop(id, l);
    }
    for (const [id, t] of towns) {
      if (this.live.has(id) || !t.times) continue;
      const lots = t.lots;
      const r = t.routes;
      const life = new LivingTown(this.io.device, {
        w: t.box.w,
        h: t.box.h,
        ...r,
        records: lots.records,
        counts: lots.counts,
        progress: lots.progress,
        lotRoom: REC_LM,
        centre: t.centre,
        radius: t.box.R,
      });
      // (saving: the works as they were — the quarry's site and benches dug, the camp — so the pit isn't picked anew;
      // its ramp's route made again from them)
      const saved = this.io.logs?.has(t.site.at) ? this.io.logs.of(t.site.at).works : undefined;
      if (saved) {
        const q = [...saved.q];
        for (const k of WORKS_REMADE) q[k] = 0;
        this.io.device.queue.writeBuffer(life.lt, L_Q * 4, new Uint32Array(q));
        this.io.device.queue.writeBuffer(life.lt, L_F * 4, new Uint32Array(saved.f));
      }
      const works = new Works(this.io.device, life, this.io.world);
      life.stages.push(works);
      life.debugGraph = this.debugGraph;
      this.io.addVoxels(life.vox, life.vargs);
      this.io.addVoxels(works.vox, works.vargs);
      this.io.addMesh(life.pmesh, life.pargs, lots.place);
      this.live.set(id, { town: t, life, works, meshRuns: t.meshRuns, sinceRebuild: 0 });
      console.log(`[living] ${t.site.name}: ${life.riders} people, ${((life.bytes + works.bytes) / 1048576).toFixed(1)} MB`);
    }
    // (citygen redrew its roads — a time-lapse does every 2 s: the graph made again at most every REBUILD_S, so routes
    // get traced between; riders on routes already traced ride on meanwhile)
    for (const l of this.live.values()) {
      l.sinceRebuild += dt;
      if (l.town.meshRuns !== l.meshRuns && l.sinceRebuild >= REBUILD_S) {
        l.meshRuns = l.town.meshRuns;
        l.sinceRebuild = 0;
        l.life.rebuild();
      }
    }
  }

  private encode(enc: GPUCommandEncoder): void {
    const ts = this.io.profiler ? (n: string) => this.io.profiler!.timestamps(n) : undefined;
    for (const l of this.live.values()) {
      const p = l.town.gridPlace();
      l.life.frame(enc, this.dt, { dx: p.dx, dy: p.dy, dz: p.dz, winW: this.io.dims.w, winH: this.io.dims.h }, ts);
    }
  }

  /**
   * (season life, U2's `march`) The march routes of a town: from each wall gate (the town grid's frame: FieldTowns
   * wallGates) down the GATES field — along the roads to where the arterial leaves the town — as cached route ids (the
   * living town's route graph; traced if new, a few words read back). The march back is the same route reversed.
   */
  async marchRoutes(town: string, gates: { seg: number; at: [number, number]; art?: number; along?: number }[]): Promise<{ seg: number; route: number; gen: number; length: number; from: [number, number]; to: [number, number] }[]> {
    const l = this.live.get(town);
    if (!l) return [];
    const out = [];
    for (const g of gates) {
      const [cx, cy] = cellAt(g.at[0], g.at[1]);
      if (cx < 0 || cy < 0 || cx >= l.life.input.w || cy >= l.life.input.h) continue;
      // (SL18: a gate on an arterial follows that arterial out, from where the ring crosses it to its last point in the
      // town's box — the atlas road's way; a gate with none, the GATES field's nearest end)
      const r = g.art !== undefined && g.art >= 0 ? await l.life.askRoute(cy * l.life.input.w + cx, 0x100 + g.art, g.along ?? 0) : await l.life.askRoute(cy * l.life.input.w + cx, H_GATES);
      if (r) out.push({ seg: g.seg, route: r.id, gen: r.gen, length: r.length, from: r.from, to: r.to });
    }
    return out;
  }

  /**
   * (season life, SL19) The wall's posts not reached from the town (their segments): a post's piece in a run of
   * risen wall with no stair whose foot is on the town's graph. Empty: every post reached.
   */
  async unreachablePosts(town: string, posts: { seg: number }[]): Promise<number[] | null> {
    const l = this.live.get(town);
    if (!l) return null;
    const r = await l.life.reachedWall();
    if (!r) return null;
    return posts.filter((p) => !r[p.seg]).map((p) => p.seg);
  }

  /** (saving, a save point) each town's works read back (its state words' head: a few hundred bytes) into its log */
  async saveWorks(): Promise<void> {
    if (!this.io.logs) return;
    for (const l of this.live.values()) {
      const h = await l.life.counters();
      if (!h) continue;
      this.io.logs.of(l.town.site.at).works = { q: [...h.slice(L_Q, L_Q + WORKS_Q)], f: [...h.slice(L_F, L_F + WORKS_F)] };
    }
  }

  /** the panel (?living=1): the parameters and a line of counters */
  mountPanel(parent: HTMLElement, claim?: () => void): void {
    const top = document.createElement('div');
    if (claim) {
      // (citygen's own hook: a district claimed — its lots rise on the GPU, and the builders go to them)
      const btn = document.createElement('button');
      btn.textContent = 'claim a housing district';
      btn.title = 'citygen claimDistrict: the best housing district not begun starts building; its lots are the builders’ sites';
      btn.onclick = claim;
      top.append(btn);
    }
    this.panel = new TunePanel(parent, {
      registry: LIVING_TUNING,
      store: 'reclaimed.living.presets',
      urlParam: 'living-tune',
      label: 'living',
      cls: 'lab',
      top,
      open: ['roads', 'people', 'quarry', 'forest'],
      shown: !matchMedia('(pointer: coarse)').matches,
      stats: () => this.stats(),
    });
  }

  /** the panel's line: the first town's counters (read again in the background) */
  stats(): string {
    const l = this.live.values().next().value as Live | undefined;
    if (!l) return 'no town yet';
    void l.life.counters();
    const h = l.life.head;
    const c = (k: keyof typeof C) => h[L_C + C[k]];
    const m3 = (v: number) => (v / 1000).toFixed(1);
    const phase = ['building the graph', 'relaxing', 'checking reach', 'laying passages', 'connected', 'laying passages'][h[0]] ?? '?';
    return [
      `${l.town.site.name}: ${l.life.riders} people, routes ${h[4]} (${phase}, ${h[7]} relax frames), points ${h[3]}, misses ${c('miss')}`,
      `reach: ${c('passages')} passages in ${c('rounds')} rounds · cut off: ${c('cutLeft')} columns, ${c('doorsCut')} doors`,
      `riding ${c('riding')} · working ${c('working')} · arrivals ${c('arrivals')}`,
      `quarry: bench ${h[L_Q + 2]} · dug ${m3(c('dug'))} m³ · at the face ${m3(c('face'))} · in carts ${m3(c('cartStone'))} · stores' inbox ${m3(c('inbox'))} · piled ${m3(c('deposited'))}`,
      `clearing: ${h[L_F + 1] ? 'camp' : 'no camp yet'} · trees listed ${c('trees')} · felled ${c('felled')} · logs at the camp ${c('logCamp')}, carts ${c('logCart')}, stores ${c('logStores')} · regrown ${c('regrown')}`,
      `produce ${c('produce')} · building sites ${c('sites')} · build work ${c('buildWork')}`,
    ].join('\n');
  }

  /** (api/contracts/routes.ts) a town's routes for systems that ride them; null when it has no living town */
  routeRead(id: string): CityRouteRead | null {
    const l = this.live.get(id);
    return l ? { buffer: l.life.routes } : null;
  }

  /** (scripts, the perf overlay) the living town's passes' smoothed GPU ms (the profiler's: with ?perf=1) */
  gpuMs(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.io.profiler?.passMs ?? []) if (k.startsWith('living-')) out[k] = +v.toFixed(3);
    return out;
  }

  private drop(id: string, l: Live): void {
    this.io.removeVoxels(l.life.vargs);
    this.io.removeVoxels(l.works.vargs);
    this.io.removeMesh(l.life.pargs);
    l.works.dispose();
    l.life.dispose();
    this.live.delete(id);
  }

  dispose(): void {
    const i = this.io.frameCompute.indexOf(this.hook);
    if (i >= 0) this.io.frameCompute.splice(i, 1);
    for (const [id, l] of this.live) this.drop(id, l);
  }
}
