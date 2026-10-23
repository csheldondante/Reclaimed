// The places API (docs/PLACES.md): `core.places`. The model and the plan's
// rasterization are world/places.ts; this binds them to the live world — it
// uploads the places raster and the room → region table, and turns the
// mutations into what exists: storms (weather, held over the place) and the
// ops masked to a place (sim PlaceOpSystem, placeop.wgsl).

import type { PlaceOpSystem } from '../sim/systems';
import type { WorldGpu } from '../sim/world-gpu';
import type { Weather } from '../weather/weather';
import { MAT } from '../world/materials';
import {
  buildPlaces,
  type Adjacent,
  type Connection,
  type ConnectionKind,
  type Place,
  type PlaceKind,
  type PlaceMap,
  type Plan,
} from '../world/places';

export class Places {
  private m: PlaceMap | null = null;
  /** the ground height at world (x, y) (the level sets it): `at` with a z needs it where a column has an enclosed level */
  groundAt?: (x: number, y: number) => number;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private ops: PlaceOpSystem,
    private weather: Weather,
  ) {}

  /** Build the places from a plan (replacing any) and upload them. */
  load(plan: Plan, seed = 1): this {
    const m = buildPlaces(plan, this.world.w, this.world.h, seed);
    this.m = m;
    this.upload();
    return this;
  }

  /** the raster and table to the GPU (after load, or a change to the regions) */
  private upload(): void {
    const m = this.map;
    this.device.queue.writeBuffer(this.world.places, 0, m.cols);
    this.device.queue.writeBuffer(this.world.placeTable, 0, m.table());
  }

  get loaded(): boolean {
    return !!this.m;
  }

  /** the model (raster, graph); throws before a plan is loaded */
  get map(): PlaceMap {
    if (!this.m) throw new Error('places: no plan loaded (places.load(plan))');
    return this.m;
  }

  // ---- queries -----------------------------------------------------------

  /** by name or id */
  get(key: string | number): PlaceRef {
    return new PlaceRef(this, this.map.place(key).id);
  }

  /** every region and room */
  list(kind?: PlaceKind): PlaceRef[] {
    return this.map
      .all()
      .filter((p) => !kind || p.kind === kind)
      .map((p) => new PlaceRef(this, p.id));
  }

  /** the room at world (x, y) (z: the enclosed level under it, where there is one); null: no place */
  at(x: number, y: number, z?: number): PlaceRef | null {
    const r = this.map.roomAt(x, y, z, this.groundAt);
    return r ? new PlaceRef(this, r) : null;
  }

  children(region: string | number): PlaceRef[] {
    return this.map.place(region).children.map((c) => new PlaceRef(this, c));
  }

  adjacent(key: string | number): Adjacent[] {
    return this.map.adjacent(key);
  }

  connections(key: string | number): (Connection & { to: number })[] {
    return this.map.connectionsOf(key);
  }

  /** the connections the plan's shape suggests (chain / tree): what W1 will carve */
  suggested(): { a: number; b: number }[] {
    return this.map.suggested.slice();
  }

  /** Record a connection (carving it in the terrain is step 2, W1). */
  connect(a: string | number, b: string | number, opt: { kind?: ConnectionKind; width?: number; at?: [number, number] } = {}): Connection {
    return this.map.connect(a, b, opt);
  }

  disconnect(a: string | number, b: string | number, opt: { with?: ConnectionKind } = {}): Connection {
    return this.map.disconnect(a, b, opt);
  }

  // ---- mutations (PlaceRef calls these) -----------------------------------

  /** @internal */
  queue(op: Parameters<PlaceOpSystem['queue']['push']>[0]): void {
    this.ops.queue.push(op);
  }

  /** @internal */
  spawnStorm(p: Place, intensity: number, duration: number): void {
    const s = this.weather.spawn(p.centre[0], p.centre[1]);
    if (!s) throw new Error('place.storm: the sky is full (MAX_STORMS storms already)');
    s.radius = Math.max(12, p.radius * 1.15);
    s.vx = 0;
    s.vy = 0;
    s.hold = { x: p.centre[0], y: p.centre[1], until: duration, strength: Math.min(1, Math.max(0, intensity)) };
  }
}

/** A live handle on one place: its data and its mutations. */
export class PlaceRef {
  constructor(
    private api: Places,
    readonly id: number,
  ) {}

  private get p(): Place {
    return this.api.map.place(this.id);
  }
  get name(): string {
    return this.p.name;
  }
  get kind(): PlaceKind {
    return this.p.kind;
  }
  get parent(): number {
    return this.p.parent;
  }
  get children(): number[] {
    return this.p.children.slice();
  }
  get tags(): string[] {
    return this.p.tags.slice();
  }
  /** columns in its footprint */
  get cells(): number {
    return this.p.cells;
  }
  get centre(): [number, number] {
    return [...this.p.centre];
  }
  get radius(): number {
    return this.p.radius;
  }

  rename(name: string): this {
    this.api.map.rename(this.id, name);
    return this;
  }
  tag(...tags: string[]): this {
    this.api.map.tag(this.id, ...tags);
    return this;
  }
  adjacent(): Adjacent[] {
    return this.api.adjacent(this.id);
  }
  connections(): (Connection & { to: number })[] {
    return this.api.connections(this.id);
  }

  /** A storm held over it for `duration` seconds at `intensity` (0..1), sized to it. */
  storm({ intensity = 1, duration = 30 }: { intensity?: number; duration?: number } = {}): this {
    this.api.spawnStorm(this.p, intensity, duration);
    return this;
  }

  /**
   * Pour loose material over it, `depth` cells (noise 0..1: patchy, up to
   * twice as deep; scale its patches' size in cells), laid over `over`
   * seconds (0: at once).
   */
  bury(material: string | number, depth: number, opt: { noise?: number; scale?: number; over?: number; seed?: number } = {}): this {
    const mat = typeof material === 'number' ? material : MAT[(material[0].toUpperCase() + material.slice(1)) as keyof typeof MAT];
    if (mat === undefined) throw new Error(`place.bury: no material "${material}"`);
    this.spread(depth, opt.over ?? 0, (amount) => ({ op: 1, place: this.id, material: mat, amount, noise: opt.noise ?? 0, scale: opt.scale ?? 8, seed: opt.seed ?? 1 }));
    return this;
  }

  /** Add `depth` cells of water over it (over `over` seconds); it then flows as water does. */
  flood(depth: number, opt: { over?: number } = {}): this {
    this.spread(depth, opt.over ?? 0, (amount) => ({ op: 2, place: this.id, amount }));
    return this;
  }

  /** Take the water there away. */
  drain(): this {
    this.api.queue({ op: 3, place: this.id });
    return this;
  }

  /** (the op runs on every other tick: 30 slices a second) */
  private spread(total: number, over: number, make: (amount: number) => Parameters<Places['queue']>[0]): void {
    const n = Math.max(1, Math.round(over * 30));
    for (let i = 0; i < n; i++) this.api.queue(make(total / n));
  }

  toJSON(): Place {
    return { ...this.p };
  }
}
