// (Track A, for Track B's unit minds U2/U3 — docs/design/TOWN_CONTRACTS.md; contract: api/contracts/townplaces.ts) The
// town contracts on the GPU: the side map of each town's wall, written into Track B's `agentSides` (sidemap.wgsl), and
// the named-place table (places.wgsl, read through shaders/townplace.wgsl). Both are resolved from citygen's contract
// buffers (CityLots, CityRoutes) and the world's columns where they lie; nothing is read back.
//
// The CPU passes inputs only: which towns are live and their slots (an epoch when that changes), each town's grid place
// in the window (a slide), the towns' clock (the wall's rise), the gate rule. It encodes a fixed list of dispatches a
// frame; whether the side map is solved and for how many rounds, and whether a town's places are solved, is decided on
// the GPU (UC-8).
//
// Every dispatch is DIRECT (phone-idle round 2, 2026-11-15; docs/FRAMECOST.md: on the Pixel 9a an indirect dispatch costs
// ~0.1 ms whether it does 1 workgroup or 0, a direct one ~0.008 ms — 28 indirect a frame with one town were ~2.9 ms of
// nothing). The solves' kernels are dispatched at their full size and gated in the kernel: every thread reads the state
// word (the side map: CTL's SC_STATE; a town's places: its table slot's TP_ON_AT) and returns when no solve is on.
// Why gated on the GPU and not slept on the CPU's word (gpu/settled.ts): each solve has wakes only the GPU sees — the
// side map's are the chunks' shape versions (moved by the sims' own kernels as well as by edits) and the water's class;
// the places' are the spawn candidates' water (plWet) and the hashes of citygen's buffers, whose progress follows the
// towns' clock, which moves every frame — and nothing may be read back each frame to hear them. So: same wakes, same
// frame, same results; no read. The cost at idle is threads that return at once: `idleThreads`.
import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import sidemapWgsl from './sidemap.wgsl?raw';
import placesWgsl from './places.wgsl?raw';
import type { CityLots, CityRoutes } from '../api/contracts/citygen';
import { TOWN_ROOM, type SideGates, type TownContractsApi } from '../api/contracts/townplaces';
import { ROW_H } from '../world/lattice';

const SIDE_PARTS = [commonWgsl, layersWgsl, materialsWgsl, sidemapWgsl];
const PLACE_PARTS = [commonWgsl, layersWgsl, materialsWgsl, placesWgsl];
/** places.wgsl TP_TOWN_WORDS: a town slot's words in the table */
export const TOWN_WORDS = 42240;
/** citygen's lot room and landmark room (REC_LM, LM_ROOM) */
const REC_LOTS = 32768;
const LM_ROOM = 64;
/** sidemap.wgsl SC_*: the control words (state, versions, the rings' boxes) */
export const SC = { state: 12, dirty: 14, solves: 21, lastRounds: 22, box: 32 } as const;
const CTL_WORDS = 64;
/** places.wgsl PC_*: a town slot's watch words (PCTL: the hashes' sum, the seen sum and version, solves, why) */
export const PC = { stride: 12, solves: 3, why: 4 } as const;
/** places.wgsl plClear: its workgroups (3072 threads: the district index's words) */
const CLEAR_GROUPS = 48;
/** places.wgsl TP_ON_AT: a town slot's solve word in the table (1 only within the frame's pass a solve runs in) */
export const TP_ON_AT = 41981;
/** places.wgsl ART_WORDS: the watch's threads cover at least the arterials' words (and the ring's) */
const WATCH_MIN = 2212;
/** places.wgsl plWet: a workgroup an arterial (NART), a thread a spawn candidate */
const WET_GROUPS = 8;
/** hook + jump rounds encoded a frame (their threads return at once when no solve is in its rounds) */
const ROUNDS_PER_FRAME = 8;

/** the side map has no solve running or wanted (its CTL words: SC) — what its gated kernels read as "return" */
export function sideSettled(ctl: Uint32Array): boolean {
  return ctl[SC.state] === 0 && ctl[SC.dirty] === 0;
}

/** a town slot's places have no solve on (its table slot's words) — what its gated kernels read as "return" */
export function placesSettled(slot: Uint32Array): boolean {
  return slot[TP_ON_AT] === 0;
}

/**
 * The gated solves' threads a frame when nothing is solved (each reads one word and returns): the side map's 19
 * window-sized dispatches and one more a town (its raster); a town's places' clear, five lot kernels, scan and head.
 */
export function idleThreads(windowColumns: number, lotGroups: number[]): { side: number; places: number } {
  const groups = Math.ceil(windowColumns / 64);
  return {
    side: (2 + lotGroups.length + 2 * ROUNDS_PER_FRAME + 1) * groups * 64,
    places: lotGroups.reduce((a, n) => a + CLEAR_GROUPS * 64 + 5 * n * 64 + 256 + 1, 0),
  };
}
/** the deepest water walked (the agents' DEEP: waterclass.wgsl — a walker is never led into it, and its class version
 *  moves when the water crosses it) and the highest step between neighbours (the agents' STEP, fortreach.wgsl R_STEP) */
const WATER_BAR = 0.9;
const STEP = 1.1;
/** places.wgsl TownP: 80 bytes, then a byte a district (its claimed purpose) */
const PLACE_U_BYTES = 80 + 256;
/** citygen's wall: its build span (DISTRICT_SPAN) */
const WALL_SPAN = 7;

/** what the contracts read of a live town (citygen/town.ts FieldTown has it all) */
export interface ContractTown {
  /** its site (id: what the CPU names it by) */
  readonly site: { readonly id: string };
  readonly box: { w: number; h: number; R: number };
  readonly centre: readonly [number, number];
  readonly lots: CityLots;
  readonly routes: CityRoutes;
  /** its run's counts (citygen's one read after it's made): the lot kernels' dispatch covers `lots` + the landmarks */
  readonly times: { lots: number } | null;
  /** its grid's first column in the window (columns, rows: even) and window z less world z */
  gridPlace(): { dx: number; dy: number; dz: number };
}

export interface ContractWorld {
  globals: GPUBuffer;
  chunks: GPUBuffer;
  layers: GPUBuffer;
  water: GPUBuffer;
  w: number;
  h: number;
}

interface Slot {
  town: ContractTown;
  /** its slot: the town's index in orders */
  index: number;
  /** its side uniform as last written (a slide, the epoch) */
  sideKey: string;
  /** its place uniform's contents as last written (the version word 13 left 0): written again only when they change */
  placeLast: Uint32Array | null;
  generation: number;
  sideU: GPUBuffer;
  placeU: GPUBuffer;
  side: GPUBindGroup;
  places: GPUBindGroup;
  /** the watch and wake kernels' group (places.wgsl plWatch, plWake) */
  watch: GPUBindGroup;
  /** (UC-13) the head's group (plHead: the ring, arterials, heights, the table, the world's columns and water) and the
   *  spawn candidates' watch (plWet) */
  head: GPUBindGroup;
  wet: GPUBindGroup;
}

const hashId = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

type SideK = 'sideWatch' | 'sideWake' | 'sideClear' | 'sideRaster' | 'sidePrep' | 'sideAfterPrep' | 'sideHook' | 'sideJump' | 'sideRound' | 'sideFinal' | 'sideDone';
type PlaceK = 'plClear' | 'plCount' | 'plScan' | 'plScatter' | 'plRank' | 'plSeedB' | 'plWriteB' | 'plHead' | 'plWatch' | 'plWake' | 'plWet';

export class TownContracts implements TownContractsApi {
  readonly places: GPUBuffer;
  /** (debug reads, tests) the side map's control words: SC */
  readonly ctl: GPUBuffer;
  /** (debug reads, tests) the places' watch words a town slot (PC); the towns' clock */
  readonly pctl: GPUBuffer;
  private clockU: GPUBuffer;
  private clockLast = NaN;
  /** the place uniforms' writes (each one's version: a new town's first differs from its slot's last) */
  private placeWrites = 0;
  /** (debug reads) the side map's copy and its kernel, made on the first read */
  private dbg?: { buf: GPUBuffer; k: ComputeKernel };
  private mask: GPUBuffer;
  private label: GPUBuffer;
  private top: GPUBuffer;
  private globalU: GPUBuffer;
  private ks = {} as Record<SideK, ComputeKernel>;
  private kp = {} as Record<PlaceK, ComputeKernel>;
  private gCtl: GPUBindGroup;
  private gSolve: GPUBindGroup;
  private slots: (Slot | null)[] = new Array(TOWN_ROOM).fill(null);
  private epoch = 1;
  private generations = 0;
  private globalKey = '';
  private _gates: SideGates;
  /** (an input) the purpose each claimed district was claimed for, by town: what a card made of it */
  private roles: (id: string) => Readonly<Record<number, number>> | undefined;
  private groups: number;

  constructor(
    private device: GPUDevice,
    private world: ContractWorld,
    /** Track B's side map (agents/notice.ts UnitNotice.sides): written here, read by notice.wgsl */
    readonly sides: GPUBuffer,
    opts: { gates?: SideGates; roles?: (id: string) => Readonly<Record<number, number>> | undefined } = {},
  ) {
    this.roles = opts.roles ?? (() => undefined);
    this._gates = opts.gates ?? 'closed';
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const N = world.w * world.h;
    this.groups = Math.ceil(N / 64);
    this.places = device.createBuffer({ label: 'town places', size: TOWN_ROOM * TOWN_WORDS * 4, usage: S });
    this.ctl = device.createBuffer({ label: 'town sides ctl', size: CTL_WORDS * 4, usage: S });
    this.mask = device.createBuffer({ label: 'town sides mask', size: N * 4, usage: S });
    this.label = device.createBuffer({ label: 'town sides label', size: N * 4, usage: S });
    this.top = device.createBuffer({ label: 'town sides top', size: N * 4, usage: S });
    this.globalU = device.createBuffer({ label: 'town sides params', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const watchSpec: BindSpec = { 0: 'uniform', 1: 'read', 5: 'read', 6: 'rw', 9: 'rw', 11: 'uniform' };
    const solveSpec: BindSpec = { 0: 'uniform', 1: 'read', 3: 'read', 4: 'read', 6: 'rw', 7: 'rw', 8: 'rw', 9: 'rw', 10: 'rw', 11: 'uniform' };
    const ctlSpec: BindSpec = { 0: 'uniform', 9: 'rw', 11: 'uniform' };
    const placeSpec: BindSpec = { 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'read', 8: 'read', 9: 'read', 10: 'rw', 11: 'uniform', 13: 'uniform' };
    // (the watch: the records, counts, progress, ring and arterials it hashes, the table's wake and solve words, its own
    // words — 7 storage buffers)
    const watchPlSpec: BindSpec = { 3: 'read', 4: 'read', 5: 'read', 7: 'read', 8: 'read', 10: 'rw', 11: 'uniform', 12: 'rw', 13: 'uniform' };
    for (const e of ['sideWatch', 'sideRaster'] as SideK[]) this.ks[e] = makeCompute(device, `towncontracts-${e}`, SIDE_PARTS, watchSpec, e);
    for (const e of ['sideWake', 'sideAfterPrep', 'sideRound', 'sideDone'] as SideK[]) this.ks[e] = makeCompute(device, `towncontracts-${e}`, SIDE_PARTS, ctlSpec, e);
    for (const e of ['sideClear', 'sidePrep', 'sideHook', 'sideJump', 'sideFinal'] as SideK[]) this.ks[e] = makeCompute(device, `towncontracts-${e}`, SIDE_PARTS, solveSpec, e);
    // (UC-13: the head — the gates, the spawn points — reads the world's columns and water where a spawn point stands, and
    // plWet hashes the same reads for the watch; neither reads the records, so each has its own layout under the limit)
    const headSpec: BindSpec = { 0: 'uniform', 1: 'read', 7: 'read', 8: 'read', 9: 'read', 10: 'rw', 11: 'uniform', 13: 'uniform', 15: 'read', 16: 'read' };
    const wetSpec: BindSpec = { 0: 'uniform', 1: 'read', 8: 'read', 9: 'read', 11: 'uniform', 12: 'rw', 15: 'read', 16: 'read' };
    for (const e of ['plClear', 'plCount', 'plScan', 'plScatter', 'plRank', 'plSeedB', 'plWriteB'] as PlaceK[]) this.kp[e] = makeCompute(device, `towncontracts-${e}`, PLACE_PARTS, placeSpec, e);
    this.kp.plHead = makeCompute(device, 'towncontracts-plHead', PLACE_PARTS, headSpec, 'plHead');
    this.kp.plWet = makeCompute(device, 'towncontracts-plWet', PLACE_PARTS, wetSpec, 'plWet');
    for (const e of ['plWatch', 'plWake'] as PlaceK[]) this.kp[e] = makeCompute(device, `towncontracts-${e}`, PLACE_PARTS, watchPlSpec, e);
    this.pctl = device.createBuffer({ label: 'town places watch', size: TOWN_ROOM * PC.stride * 4, usage: S });
    this.clockU = device.createBuffer({ label: 'town places clock', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.pctl, 0, new Uint32Array(TOWN_ROOM * PC.stride));
    this.gCtl = makeBindGroup(device, 'towncontracts ctl', this.ks.sideWake.layout, { 0: world.globals, 9: this.ctl, 11: this.globalU });
    this.gSolve = makeBindGroup(device, 'towncontracts solve', this.ks.sidePrep.layout, { 0: world.globals, 1: world.chunks, 3: world.layers, 4: world.water, 6: this.mask, 7: this.label, 8: this.top, 9: this.ctl, 10: sides, 11: this.globalU });
    device.queue.writeBuffer(this.ctl, 0, new Uint32Array(CTL_WORDS));
    this.writeGlobal();
  }

  /** the side map's gate rule: closed (a barrier: the default) or open — an input; the map is solved again */
  get gates(): SideGates {
    return this._gates;
  }
  set gates(g: SideGates) {
    if (g === this._gates) return;
    this._gates = g;
    this.epoch++;
    this.writeGlobal();
    for (const s of this.slots) if (s) this.writeSide(s);
  }

  townIndex(id: string): number {
    return this.slots.findIndex((s) => s?.town.site.id === id);
  }

  /** (Track B, U2 round 6) a live town slot's site id (the CPU's plan: what LivingTowns and the routes are keyed by), or
   *  null for an empty slot */
  townSite(i: number): string | null {
    return this.slots[i]?.town.site.id ?? null;
  }

  /** (Track B, U2 round 5) a live town slot's grid corners in the window (x cells, y world units) — the CPU's own plan
   *  (its grid's place and size), for the agents' scope round an order there; null for an empty slot */
  townArea(i: number): [number, number][] | null {
    const s = this.slots[i];
    if (!s) return null;
    const p = s.town.gridPlace();
    const { w, h } = s.town.box;
    return [
      [p.dx, p.dy * ROW_H],
      [p.dx + w, p.dy * ROW_H],
      [p.dx, (p.dy + h) * ROW_H],
      [p.dx + w, (p.dy + h) * ROW_H],
    ];
  }

  /** the live towns now (a frame: new ones given a slot, let-go ones' slots emptied) and the towns' clock (s) */
  setTowns(towns: Iterable<ContractTown>, now: number): void {
    const live = new Set<ContractTown>(towns);
    let changed = false;
    this.slots.forEach((s, i) => {
      if (!s || live.has(s.town)) return;
      s.sideU.destroy();
      s.placeU.destroy();
      this.slots[i] = null;
      // (its header's live word cleared: townplace.wgsl's townLive — 4 bytes)
      this.device.queue.writeBuffer(this.places, i * TOWN_WORDS * 4, new Uint32Array([0]));
      changed = true;
    });
    for (const t of live) {
      if (this.slots.some((s) => s?.town === t)) continue;
      const i = this.slots.indexOf(null);
      if (i < 0) throw new Error(`town contracts: ${TOWN_ROOM} town slots, all taken (${t.site.id} has none) — the static claims' arena holds as many`);
      this.slots[i] = this.makeSlot(t, i);
      changed = true;
    }
    if (changed) {
      this.epoch++;
      this.writeGlobal();
    }
    // (the towns' clock: 4 bytes as it moves — a gate's status flips when it passes the wake clock the GPU keeps)
    if (now !== this.clockLast) {
      this.clockLast = now;
      this.device.queue.writeBuffer(this.clockU, 0, new Float32Array([now, 0, 0, 0]));
    }
    for (const s of this.slots) {
      if (!s) continue;
      this.writeSide(s);
      this.writePlace(s);
    }
  }

  private makeSlot(town: ContractTown, i: number): Slot {
    const d = this.device;
    const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    const sideU = d.createBuffer({ label: `town sides ${town.site.id}`, size: 48, usage: U });
    const placeU = d.createBuffer({ label: `town places ${town.site.id}`, size: PLACE_U_BYTES, usage: U });
    const w = this.world;
    const side = makeBindGroup(d, `towncontracts watch ${town.site.id}`, this.ks.sideWatch.layout, { 0: w.globals, 1: w.chunks, 5: town.routes.wall, 6: this.mask, 9: this.ctl, 11: sideU });
    const L = town.lots;
    const R = town.routes;
    const places = makeBindGroup(d, `towncontracts places ${town.site.id}`, this.kp.plCount.layout, { 3: L.records, 4: L.counts, 5: L.progress, 6: R.pop, 7: R.wall, 8: R.art, 9: R.heights, 10: this.places, 11: placeU, 13: this.clockU });
    const watch = makeBindGroup(d, `towncontracts places watch ${town.site.id}`, this.kp.plWatch.layout, { 3: L.records, 4: L.counts, 5: L.progress, 7: R.wall, 8: R.art, 10: this.places, 11: placeU, 12: this.pctl, 13: this.clockU });
    const head = makeBindGroup(d, `towncontracts places head ${town.site.id}`, this.kp.plHead.layout, { 0: w.globals, 1: w.chunks, 7: R.wall, 8: R.art, 9: R.heights, 10: this.places, 11: placeU, 13: this.clockU, 15: w.layers, 16: w.water });
    const wet = makeBindGroup(d, `towncontracts places wet ${town.site.id}`, this.kp.plWet.layout, { 0: w.globals, 1: w.chunks, 8: R.art, 9: R.heights, 11: placeU, 12: this.pctl, 15: w.layers, 16: w.water });
    return { town, index: i, sideKey: '', placeLast: null, generation: ++this.generations, sideU, placeU, side, places, watch, head, wet };
  }

  private writeGlobal(): void {
    const key = `${this.epoch}|${this._gates}`;
    if (key === this.globalKey) return;
    this.globalKey = key;
    this.device.queue.writeBuffer(this.globalU, 0, this.sideData(0, 0, 0xffffffff));
  }

  private sideData(x: number, y: number, slot: number, z = 0): ArrayBuffer {
    const b = new ArrayBuffer(48);
    const f = new Float32Array(b);
    const u = new Uint32Array(b);
    f.set([x, y, z, 0], 0);
    u.set([slot, this._gates === 'closed' ? 1 : 0, this.epoch, this.groups], 4);
    f.set([WATER_BAR, STEP, 0, 0], 8);
    return b;
  }

  /** a town's side uniform: its grid's place in the window (a slide) */
  private writeSide(s: Slot): void {
    const p = s.town.gridPlace();
    const key = `${p.dx}|${p.dy}|${p.dz}|${this.epoch}|${this._gates}`;
    if (s.sideKey === key) return;
    s.sideKey = key;
    this.device.queue.writeBuffer(s.sideU, 0, this.sideData(p.dx, p.dy * ROW_H, s.index, p.dz));
  }

  /** a town's lot kernels' workgroups: the lots made and the landmarks' room */
  private lotGroups(s: Slot): number {
    return Math.ceil((Math.min(s.town.times?.lots ?? REC_LOTS, REC_LOTS) + LM_ROOM) / 64);
  }

  /** a town's place uniform: its grid's place, its centre, the claimed districts' purposes — built each frame (336
   *  bytes, compared on the CPU), written only when they changed, with a new version: the GPU's wake (a solve) */
  private writePlace(s: Slot): void {
    const p = s.town.gridPlace();
    const b = new ArrayBuffer(PLACE_U_BYTES);
    const u = new Uint32Array(b);
    const f = new Float32Array(b);
    u.set([s.town.box.w, s.town.box.h, s.index, s.generation], 0);
    f.set([p.dx, p.dy * ROW_H, p.dz, 0], 4);
    f.set([s.town.centre[0], s.town.centre[1], s.town.box.R, 0], 8);
    u.set([hashId(s.town.site.id), 0, this.lotGroups(s), 0], 12);
    f.set([WALL_SPAN, 0, 0, 0], 16);
    // (the claimed districts' purposes: a byte a district, 255 none — the population field's then)
    const roles = new Uint8Array(b, 80, 256).fill(255);
    for (const [k, v] of Object.entries(this.roles(s.town.site.id) ?? {})) if (+k >= 0 && +k < 256) roles[+k] = v;
    const last = s.placeLast;
    if (last && last.every((v, i) => v === u[i])) return;
    s.placeLast = u.slice();
    u[13] = ++this.placeWrites;
    this.device.queue.writeBuffer(s.placeU, 0, b);
  }

  /** (the census, tests) the gated solves' idle threads a frame with the live towns: `idleThreads` */
  idleThreads(): { side: number; places: number } {
    return idleThreads(this.world.w * this.world.h, this.slots.filter((s): s is Slot => s !== null).map((s) => this.lotGroups(s)));
  }

  /** the frame's work: the side map's watch, wake and solve; every live town's places — all direct dispatches, the
   *  solves' gated in their kernels (the file's header) */
  encode(enc: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void {
    const live = this.slots.filter((s): s is Slot => s !== null);
    const pass = enc.beginComputePass({ label: 'towncontracts', timestampWrites });
    const cs = 16;
    const chunkGroups = Math.ceil(((this.world.w / cs) * (this.world.h / cs)) / 64);
    const all = this.groups;
    const run = (k: ComputeKernel, g: GPUBindGroup, n: number) => {
      pass.setPipeline(k.pipeline);
      pass.setBindGroup(0, g);
      pass.dispatchWorkgroups(n);
    };
    for (const s of live) run(this.ks.sideWatch, s.side, chunkGroups);
    run(this.ks.sideWake, this.gCtl, 1);
    // (the solve: each kernel's threads return unless the state is its stage's — sidemap.wgsl stageOff)
    run(this.ks.sideClear, this.gSolve, all);
    for (const s of live) run(this.ks.sideRaster, s.side, all);
    run(this.ks.sidePrep, this.gSolve, all);
    run(this.ks.sideAfterPrep, this.gCtl, 1);
    for (let r = 0; r < ROUNDS_PER_FRAME; r++) {
      run(this.ks.sideHook, this.gSolve, all);
      run(this.ks.sideJump, this.gSolve, all);
      run(this.ks.sideRound, this.gCtl, 1);
    }
    run(this.ks.sideFinal, this.gSolve, all);
    run(this.ks.sideDone, this.gCtl, 1);
    // (the places: watched every frame — a hash a record — and solved only when the watch woke a solve: plWake writes
    // the slot's solve word, the solve's kernels' threads return when it is 0 — places.wgsl solveOff. UC-8)
    for (const s of live) {
      const lots = this.lotGroups(s);
      run(this.kp.plWatch, s.watch, Math.max(lots, Math.ceil(WATCH_MIN / 64)));
      run(this.kp.plWet, s.wet, WET_GROUPS);
      run(this.kp.plWake, s.watch, 1);
      run(this.kp.plClear, s.places, CLEAR_GROUPS);
      run(this.kp.plCount, s.places, lots);
      run(this.kp.plScan, s.places, 1);
      run(this.kp.plScatter, s.places, lots);
      run(this.kp.plRank, s.places, lots);
      run(this.kp.plSeedB, s.places, lots);
      run(this.kp.plWriteB, s.places, lots);
      run(this.kp.plHead, s.head, 1);
    }
    pass.end();
  }

  /** (debug and tests only: the lab, the GPU tests — never an order) a buffer's words read back */
  async debugRead(which: 'places' | 'ctl' | 'pctl' | 'sides' | 'label' | 'top' | 'mask', bytes?: number): Promise<Uint32Array> {
    const enc = this.device.createCommandEncoder({ label: 'towncontracts debug read' });
    let src = { places: this.places, ctl: this.ctl, pctl: this.pctl, label: this.label, top: this.top, mask: this.mask, sides: this.ctl }[which];
    if (which === 'sides') {
      // (Track B's side map isn't a copy source: a kernel copies it into a debug buffer first)
      const N = this.world.w * this.world.h;
      this.dbg ??= { buf: this.device.createBuffer({ label: 'town sides debug', size: N * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }), k: makeCompute(this.device, 'towncontracts-sideCopy', SIDE_PARTS, { 0: 'uniform', 10: 'rw', 13: 'rw' }, 'sideCopy') };
      const p = enc.beginComputePass({ label: 'towncontracts debug copy' });
      p.setPipeline(this.dbg.k.pipeline);
      p.setBindGroup(0, makeBindGroup(this.device, 'towncontracts debug copy', this.dbg.k.layout, { 0: this.world.globals, 10: this.sides, 13: this.dbg.buf }));
      p.dispatchWorkgroups(this.groups);
      p.end();
      src = this.dbg.buf;
    }
    const size = Math.min(bytes ?? src.size, src.size);
    const st = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyBufferToBuffer(src, 0, st, 0, size);
    this.device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(st.getMappedRange().slice(0));
    st.unmap();
    st.destroy();
    return out;
  }

  dispose(): void {
    for (const s of this.slots) {
      s?.sideU.destroy();
      s?.placeU.destroy();
    }
    for (const b of [this.places, this.ctl, this.mask, this.label, this.top, this.globalU, this.pctl, this.clockU]) b.destroy();
    this.dbg?.buf.destroy();
  }
}
