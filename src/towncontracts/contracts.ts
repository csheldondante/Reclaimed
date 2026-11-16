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
// Asleep it encodes nothing (phone-idle round 2, 2026-11-15; DESIGN §24: "CPU reads are small, async, and only after
// edits or events"; a sleeping system encodes nothing): no pass, no dispatch, no upload, no read. The side map and the
// places each have a settled gate (gpu/settled.ts). A CPU-known event wakes one or both:
//   the towns live or their slots (the epoch), the gate rule          both
//   a town's grid place (a slide: its side and place uniforms)        both
//   a town's place uniform (its claimed purposes, its lot count)       the places
//   a town's mesh run done (ContractTown.meshRuns: citygen makes its  both
//     claims again every 2 s while districts or the wall rise, and
//     once when they are there — a piece risen, a building)
//   the towns' clock reaching a slot's wake clock (a gate's wall up:   the places
//     the clock the last settled read brought back)
//   an edit near a town (wakeAt: the level's event tap), wake()       both
// While awake the watches and the solve are encoded, then the gate's read: the side map's CTL (256 bytes), the places'
// PCTL (256 bytes) — one in flight at a time, none believed in the HOLD frames after a wake. `sideSettled` /
// `placesSettled` say when to sleep; the places stay awake while the lots' progress moves (something is rising).
// Dropped at rest (the ruling: the solves change only on events), each seen by the watch at the next wake: a chunk's
// shape version moved under a wall by a sim's own kernel; the water's class crossing the walked depth by itself; a
// spawn candidate's standing (plWet); a write to citygen's records, ring or arterials with no mesh run after it.
//
// Awake, every dispatch is direct (on the Pixel 9a an indirect dispatch costs ~0.1 ms whether it does 1 workgroup or 0,
// a direct one ~0.008 ms: docs/FRAMECOST.md): the solves' kernels at their full size, gated in the kernel — every thread
// reads the state word (the side map: CTL's SC_STATE; a town's places: its table slot's TP_ON_AT) and returns when no
// solve is on.
import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import sidemapWgsl from './sidemap.wgsl?raw';
import placesWgsl from './places.wgsl?raw';
import type { CityLots, CityRoutes } from '../api/contracts/citygen';
import { TOWN_ROOM, type SideGates, type TownContractsApi } from '../api/contracts/townplaces';
import { ROW_H } from '../world/lattice';
import { SettledRead } from '../gpu/settled';

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
/** places.wgsl PC_*: a town slot's watch words (PCTL: the hashes' sum, the seen sum and version, solves, why; busy —
 *  bit 0 a solve this frame, bit 1 the lots' progress moved; the table's wake clock, f32 bits) */
export const PC = { stride: 16, solves: 3, why: 4, busy: 11, wake: 12 } as const;
/** frames after a wake before a read's "settled" is believed: an edit or a claim reaches the columns a tick or two on */
const HOLD = 4;
/** an edit this far from a town's grid (window units, past its radius) still wakes it: the spawn points' crowd */
const EDIT_MARGIN = 8;
/** places.wgsl plClear: its workgroups (3072 threads: the district index's words) */
const CLEAR_GROUPS = 48;
/** places.wgsl TP_FILL_AT: a town slot's words before it are what townplace.wgsl reads (after: the solve's own) */
export const TP_PUBLIC_WORDS = 36296;
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

/** the live town slots' places have nothing to do (PCTL): no solve in the read's frame and no lot's progress moving */
export function placesSettled(pctl: Uint32Array, slots: readonly number[]): boolean {
  return slots.every((i) => pctl[i * PC.stride + PC.busy] === 0);
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
  /** its mesh runs done so far (citygen: the claims made again — while its districts or wall rise, and once at the end):
   *  a change wakes the contracts */
  readonly meshRuns?: number;
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
  /** the town's mesh runs as last seen */
  meshRuns: number;
  /** the clock its places must be solved again by (the last settled read's; Infinity none known) */
  wakeClock: number;
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
  /** the settled gates: the side map's (CTL) and the places' (PCTL) */
  private sideGate: SettledRead;
  private placeGate: SettledRead;
  /** false: never asleep (a test's reference run, the toggle diff) */
  private sleep: boolean;
  /** setTowns calls so far: the GPU's frame count (the water's rate limits are real frames) */
  private frame = 0;
  /** what this frame encodes (decided in setTowns) */
  private encSide = false;
  private encPlaces = false;
  /** (an input) the purpose each claimed district was claimed for, by town: what a card made of it */
  private roles: (id: string) => Readonly<Record<number, number>> | undefined;
  private groups: number;

  constructor(
    private device: GPUDevice,
    private world: ContractWorld,
    /** Track B's side map (agents/notice.ts UnitNotice.sides): written here, read by notice.wgsl */
    readonly sides: GPUBuffer,
    opts: { gates?: SideGates; roles?: (id: string) => Readonly<Record<number, number>> | undefined; sleep?: boolean } = {},
  ) {
    this.roles = opts.roles ?? (() => undefined);
    this.sleep = opts.sleep ?? true;
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
    this.sideGate = new SettledRead(device, 'town sides', this.ctl, 0, CTL_WORDS * 4, sideSettled, HOLD);
    this.placeGate = new SettledRead(device, 'town places', this.pctl, 0, TOWN_ROOM * PC.stride * 4, (w) => this.placesAnswer(w), HOLD);
  }

  /** the places' read came back: each live slot's wake clock kept (the CPU wakes by the towns' clock), then settled? */
  private placesAnswer(pctl: Uint32Array): boolean {
    const f = new Float32Array(pctl.buffer, pctl.byteOffset, pctl.length);
    const live: number[] = [];
    this.slots.forEach((s, i) => {
      if (!s) return;
      live.push(i);
      s.wakeClock = f[i * PC.stride + PC.wake];
    });
    return placesSettled(pctl, live);
  }

  /** a CPU-known event the contracts can't see for themselves: both solves' watches run again until they settle */
  wake(): void {
    this.sideGate.wake();
    this.placeGate.wake();
  }

  /** an edit at (x, y) (window units, as an event's), radius r: wakes when it is in or near a live town's grid */
  wakeAt(x: number, y: number, r: number): void {
    const m = r + EDIT_MARGIN;
    for (const s of this.slots) {
      if (!s) continue;
      const p = s.town.gridPlace();
      const x0 = p.dx;
      const y0 = p.dy * ROW_H;
      if (x < x0 - m || y < y0 - m || x > x0 + s.town.box.w + m || y > y0 + s.town.box.h * ROW_H + m) continue;
      this.wake();
      return;
    }
  }

  /** (tests, the census) awake now, and the gates' counts: wakes and reads so far */
  get state(): { side: boolean; places: boolean; wakes: number; reads: number } {
    const a = this.sideGate.gate;
    const b = this.placeGate.gate;
    return { side: a.awake, places: b.awake, wakes: a.stats.wakes + b.stats.wakes, reads: a.stats.reads + b.stats.reads };
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
    this.wake();
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
    this.frame++;
    if (changed) {
      this.epoch++;
      this.writeGlobal();
      this.wake();
    }
    const clock = Math.fround(now);
    for (const s of this.slots) {
      if (!s) continue;
      // (a slide moves both; the place uniform's other words — the purposes, the lot count — the places)
      if (this.writeSide(s)) this.sideGate.wake();
      if (this.writePlace(s)) this.placeGate.wake();
      const runs = s.town.meshRuns ?? 0;
      if (runs !== s.meshRuns) {
        s.meshRuns = runs;
        this.wake();
      }
      // (a gate's status flips when the clock passes the wake clock the GPU keeps: known here from the last read)
      if (clock >= s.wakeClock) {
        s.wakeClock = Infinity;
        this.placeGate.wake();
      }
    }
    if (!this.sleep) this.wake();
    this.encSide = this.sideGate.awake;
    this.encPlaces = this.placeGate.awake;
    // (what the awake kernels read of this frame: the frame count — the side map's 4 bytes — and the towns' clock)
    if (this.encSide) this.device.queue.writeBuffer(this.globalU, 28, new Uint32Array([this.frame]));
    if (this.encPlaces) {
      this.device.queue.writeBuffer(this.clockU, 0, new Float32Array([now]));
      this.device.queue.writeBuffer(this.clockU, 4, new Uint32Array([this.frame]));
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
    return { town, index: i, sideKey: '', placeLast: null, generation: ++this.generations, meshRuns: town.meshRuns ?? 0, wakeClock: Infinity, sideU, placeU, side, places, watch, head, wet };
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
    u.set([slot, this._gates === 'closed' ? 1 : 0, this.epoch, this.frame], 4);
    f.set([WATER_BAR, STEP, 0, 0], 8);
    return b;
  }

  /** a town's side uniform: its grid's place in the window (a slide); true when written */
  private writeSide(s: Slot): boolean {
    const p = s.town.gridPlace();
    const key = `${p.dx}|${p.dy}|${p.dz}|${this.epoch}|${this._gates}`;
    if (s.sideKey === key) return false;
    s.sideKey = key;
    this.device.queue.writeBuffer(s.sideU, 0, this.sideData(p.dx, p.dy * ROW_H, s.index, p.dz));
    return true;
  }

  /** a town's lot kernels' workgroups: the lots made and the landmarks' room */
  private lotGroups(s: Slot): number {
    return Math.ceil((Math.min(s.town.times?.lots ?? REC_LOTS, REC_LOTS) + LM_ROOM) / 64);
  }

  /** a town's place uniform: its grid's place, its centre, the claimed districts' purposes — built each frame (336
   *  bytes, compared on the CPU), written only when they changed, with a new version: the GPU's wake (a solve); true
   *  when written */
  private writePlace(s: Slot): boolean {
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
    if (last && last.every((v, i) => v === u[i])) return false;
    s.placeLast = u.slice();
    u[13] = ++this.placeWrites;
    this.device.queue.writeBuffer(s.placeU, 0, b);
    return true;
  }

  /** the frame's work (after setTowns): nothing asleep; awake, the side map's watch, wake and solve and every live
   *  town's places — one pass of direct dispatches, the solves' gated in their kernels — then the gates' reads */
  encode(enc: GPUCommandEncoder, timestamps?: () => GPUComputePassTimestampWrites | undefined): void {
    if (!this.encSide && !this.encPlaces) return;
    const live = this.slots.filter((s): s is Slot => s !== null);
    // (the pass's timing asked for only when there is a pass)
    const pass = enc.beginComputePass({ label: 'towncontracts', timestampWrites: timestamps?.() });
    const cs = 16;
    const chunkGroups = Math.ceil(((this.world.w / cs) * (this.world.h / cs)) / 64);
    const all = this.groups;
    const run = (k: ComputeKernel, g: GPUBindGroup, n: number) => {
      pass.setPipeline(k.pipeline);
      pass.setBindGroup(0, g);
      pass.dispatchWorkgroups(n);
    };
    if (this.encSide) {
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
    }
    // (the places: a hash a record, and solved only when the watch woke a solve: plWake writes the slot's solve word,
    // the solve's kernels' threads return when it is 0 — places.wgsl solveOff. UC-8)
    if (this.encPlaces) {
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
    }
    pass.end();
    if (this.encSide) this.sideGate.encode(enc);
    if (this.encPlaces) this.placeGate.encode(enc);
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
    this.sideGate.destroy();
    this.placeGate.destroy();
    for (const s of this.slots) {
      s?.sideU.destroy();
      s?.placeU.destroy();
    }
    for (const b of [this.places, this.ctl, this.mask, this.label, this.top, this.globalU, this.pctl, this.clockU]) b.destroy();
    this.dbg?.buf.destroy();
  }
}
