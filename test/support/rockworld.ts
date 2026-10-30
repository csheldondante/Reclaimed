// A tiny CPU world for the rigid rock and External intervals (docs/TESTING.md): packed columns (world/layout.ts),
// the rock judge's view of them (game/fracture.ts WorldVox, analyseRock), the registry of things that own cells
// (sim/external.ts), and the rigid bodies against those columns (game/rockbodies.ts columnsGround, RockBodies) — the
// production code, no GPU.
//
// What's mirrored here, not shared: Integrity's glue between them (game/integrity.ts takeExternal, wakeResting,
// restRigid, the judge's passes — inside a 2000-line class that also owns the GPU readbacks, so it can't be run
// without a WorldCore). Each mirror says which method it follows; the integration tier (scripts/meshinsttest.mjs,
// physfix.mjs) covers the real one.
import { analyseRock, WorldVox } from '../../src/game/fracture';
import { columnsGround, RockBodies, type RockBody, type V3 } from '../../src/game/rockbodies';
import { subtract } from '../../src/game/colbodies';
import { cutOut, ExternalRegistry, OWNER_ROCK, type ExternalCol, type ExternalInstance } from '../../src/sim/external';
import { cellAt, cellPos } from '../../src/world/lattice';
import { ColumnGrid, columnSlots, packColumn, packColumns, readColumn, SLOT_WORDS, type Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';

export interface Resting {
  inst: ExternalInstance;
  /** its cells (lattice cells of its spawn frame) and transform (RockBodies.matrix's rows) */
  cells: { x: number; y: number; z: number; mat: number }[];
  m: number[];
}

export class RockWorld {
  readonly W: number;
  readonly H: number;
  readonly packed;
  readonly vox: WorldVox;
  readonly ext: ExternalRegistry;
  readonly rigid: RockBodies;
  readonly resting = new Map<number, Resting>();
  /** columns an edit touched since the judge last looked (y · 65536 + x) */
  readonly cut = new Set<number>();
  /** what happened, for a failing test's message */
  readonly log: string[] = [];

  constructor(W = 32, H = 32, zMax = 32, col: (x: number, y: number) => Interval[] = () => [{ z0: 0, z1: 10, mat: MAT.Stone }]) {
    this.W = W;
    this.H = H;
    const grid = new ColumnGrid({ w: W, h: H, zMax });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grid.cols[y * W + x] = col(x, y);
    this.packed = packColumns(grid, 8);
    this.vox = new WorldVox(this.packed, this.packed.slots);
    this.ext = new ExternalRegistry({ read: (x, y) => this.read(x, y), write: (x, y, c) => this.write(x, y, c) });
    // (Integrity.restingMass: a resting rock's cells weigh as it does, not as the ground)
    const massAt = (x: number, y: number, z: number) => {
      const inst = this.ext.at(x, y, z, z + 0.5).find((o) => o.owner === OWNER_ROCK);
      return inst ? this.resting.get(inst.id)?.cells.length : undefined;
    };
    this.rigid = new RockBodies(columnsGround(() => this.vox, W, H, massAt));
    this.ext.owner(OWNER_ROCK, { name: 'rock', onLost: (inst, why) => this.wake(inst, why) });
  }

  read(x: number, y: number): Interval[] {
    return readColumn(this.packed, this.packed.slots, x, y);
  }

  write(x: number, y: number, col: Interval[]): void {
    const { base, k } = columnSlots(this.packed, x, y);
    if (col.length > k) throw new Error(`column ${x},${y}: ${col.length} intervals, room for ${k}`);
    this.packed.slots.set(packColumn(col, k), base * SLOT_WORDS);
  }

  /** the columns whose centre is within r (world units) of (wx, wy) */
  near(wx: number, wy: number, r: number): [number, number][] {
    const out: [number, number][] = [];
    const [x0, y0] = cellAt(wx - r - 1, wy - r - 1);
    const [x1, y1] = cellAt(wx + r + 1, wy + r + 1);
    for (let y = Math.max(0, y0); y <= Math.min(this.H - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(this.W - 1, x1); x++) {
        const [px, py] = cellPos(x, y);
        if (Math.hypot(px - wx, py - wy) <= r) out.push([x, y]);
      }
    return out;
  }

  /** take [z0, z1) out of column (x, y) — ground only: a thing's External cells are left (digging round it) */
  dig(x: number, y: number, z0: number, z1: number): void {
    const col = this.read(x, y);
    const keep = col.filter((iv) => iv.mat === MAT.External);
    const ground = subtract(
      col.filter((iv) => iv.mat !== MAT.External),
      [{ z0, z1 }],
    );
    this.write(x, y, [...ground, ...keep].sort((a, b) => a.z0 - b.z0));
    this.cut.add(y * 65536 + x);
  }

  /**
   * A thing buried in the ground as a region record brings it back (Streamer.things → ExternalRegistry.adopt): its
   * cells External in the columns — the ground where it lies replaced — registered, its transform kept. `cells`:
   * lattice cells; `q` its turn (a skewed statue) about its centre of mass.
   */
  bury(cells: { x: number; y: number; z: number; mat: number }[], q: [number, number, number, number] = [0, 0, 0, 1]): Resting {
    const b = this.rigid.spawn(cells)!;
    b.q = q;
    // (Integrity.restRigid: each column's span of the body's cells)
    const by = new Map<number, [number, number]>();
    for (const c of this.rigid.worldCells(b)) {
      const [cx, cy] = cellAt(c.p[0], c.p[1]);
      const k = cy * 65536 + cx;
      const lo = Math.max(0, c.p[2] - 0.5);
      const hi = c.p[2] + 0.5;
      const r = by.get(k);
      by.set(k, r ? [Math.min(r[0], lo), Math.max(r[1], hi)] : [lo, hi]);
    }
    const cols: ExternalCol[] = [];
    for (const [k, [lo, hi]] of by) {
      const x = k % 65536;
      const y = Math.floor(k / 65536);
      const col = cutOut(this.read(x, y), lo, hi);
      col.push({ z0: lo, z1: hi, mat: MAT.External, aux: b.mat & 0xff });
      this.write(x, y, col.sort((p, r) => p.z0 - r.z0));
      cols.push({ x, y, z0: lo, z1: hi });
    }
    const inst = this.ext.adopt(OWNER_ROCK, cols, b.mat);
    const r: Resting = { inst, cells: this.rigid.latCells(b), m: this.rigid.matrix(b) };
    this.rigid.remove(b);
    this.resting.set(inst.id, r);
    return r;
  }

  /** (Integrity.wakeResting, the hanging-free case) a resting rock whose ground went wakes as a body where it lies */
  private wake(inst: ExternalInstance, why: 'cut' | 'loose'): void {
    const r = this.resting.get(inst.id);
    this.resting.delete(inst.id);
    this.ext.release(inst.id, true);
    for (const c of inst.cols) this.cut.add(c.y * 65536 + c.x);
    if (!r) return;
    const b = this.rigid.revive(r.cells, r.m);
    this.log.push(`woke #${inst.id} (${why}) as body #${b?.id} at z ${b?.pos[2].toFixed(2)}, allowed ${b?.allow.toFixed(2)}`);
  }

  /**
   * The rock judge's passes over what was cut (Integrity's: analyseRock with the cut columns weighed, rotation on),
   * till nothing more gives. External runs in what it frees: their owners told (Integrity.takeExternal); the ground
   * it frees falls as bodies, what crumbles goes.
   */
  judge(): void {
    for (let pass = 0; pass < 12 && this.cut.size; pass++) {
      const seeds: [number, number][] = [...this.cut].map((k) => [k % 65536, Math.floor(k / 65536)]);
      const weighed = new Set(this.cut);
      this.cut.clear();
      const fr = analyseRock(this.vox, seeds, undefined, { weigh: (x, y) => weighed.has(y * 65536 + x), rotate: true });
      // (takeExternal)
      const hit: ExternalCol[] = [];
      const scan = (rp: { x: number; y: number; ivs: Interval[] }[] | undefined) => {
        for (const c of rp ?? []) {
          const keep: Interval[] = [];
          for (const iv of c.ivs) {
            if (iv.mat !== MAT.External) keep.push(iv);
            else if (this.ext.at(c.x, c.y, iv.z0, iv.z1).length) hit.push({ x: c.x, y: c.y, z0: iv.z0, z1: iv.z1 });
            else keep.push({ ...iv, mat: iv.aux || MAT.Stone, aux: 0 });
          }
          c.ivs = keep;
        }
      };
      for (const p of fr.pieces ?? []) scan(p);
      scan(fr.crumbleRuns);
      this.log.push(`judge pass ${pass}: pieces ${(fr.pieces ?? []).length}, tips ${(fr.tips ?? []).length}, External freed ${hit.length}, why ${JSON.stringify(fr.why)}`);
      for (const c of fr.crumbleRuns ?? []) {
        if (!c.ivs.length) continue;
        this.write(c.x, c.y, subtract(this.read(c.x, c.y), c.ivs));
        this.cut.add(c.y * 65536 + c.x);
      }
      const tips = new Map((fr.tips ?? []).map((t) => [t.piece, t]));
      (fr.pieces ?? []).forEach((piece, i) => {
        const cells: { x: number; y: number; z: number; mat: number }[] = [];
        for (const c of piece) {
          if (!c.ivs.length) continue;
          this.write(c.x, c.y, subtract(this.read(c.x, c.y), c.ivs));
          this.cut.add(c.y * 65536 + c.x);
          for (const iv of c.ivs) for (let z = Math.round(iv.z0); z < Math.round(iv.z1); z++) cells.push({ x: c.x, y: c.y, z, mat: iv.mat });
        }
        if (cells.length) this.rigid.spawn(cells, tips.get(i));
      });
      if (hit.length) this.ext.loose(hit);
    }
  }

  /**
   * Step every body at 60 Hz for `secs` (Integrity.update's: hits break, deep cuts erode the ground, what rests is
   * taken out). Per body: its start, how far its centre rose, its fastest upward speed, where it ended.
   */
  step(secs: number): Map<number, Track> {
    const track = new Map<number, Track>();
    const see = (b: RockBody) => {
      let t = track.get(b.id);
      if (!t) track.set(b.id, (t = { id: b.id, cells: b.cells.length, start: [...b.pos] as V3, end: [...b.pos] as V3, rise: 0, vUp: 0, tilt: 0, rested: false, broke: false }));
      t.rise = Math.max(t.rise, b.pos[2] - t.start[2]);
      t.vUp = Math.max(t.vUp, b.v[2]);
      t.end = [...b.pos] as V3;
      // (its tilt from how it was: the angle its frame's z turned through)
      const [x, y] = b.q;
      t.tilt = Math.max(t.tilt, (Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (x * x + y * y)))) * 180) / Math.PI);
      return t;
    };
    for (const b of this.rigid.list) see(b);
    for (let f = 0; f < secs * 60; f++) {
      const { rest, hits, erode } = this.rigid.update(1 / 60);
      for (const b of this.rigid.list) see(b);
      for (const h of hits) {
        const br = this.rigid.breakAt(h.body, h.speed, h.at);
        if (br) {
          track.get(h.body.id)!.broke = true;
          for (const p of br.pieces) see(p);
        }
      }
      for (const { at } of erode) {
        const [cx, cy] = cellAt(at[0], at[1]);
        const z = Math.floor(at[2]);
        this.write(cx, cy, subtract(this.read(cx, cy), [{ z0: z, z1: z + 1 }]));
      }
      for (const b of rest) {
        see(b).rested = true;
        this.rigid.remove(b);
      }
    }
    return track;
  }
}

export interface Track {
  id: number;
  cells: number;
  start: V3;
  end: V3;
  /** the most its centre of mass rose over where it started (cells) */
  rise: number;
  /** its fastest upward speed (cells/s) */
  vUp: number;
  /** the most it turned from how it started (degrees) */
  tilt: number;
  rested: boolean;
  broke: boolean;
}

/** a statue's cells: the columns within `r` of (wx, wy), cells z0 .. z1 - 1 */
export function pillarCells(w: RockWorld, wx: number, wy: number, r: number, z0: number, z1: number, mat: number = MAT.Stone) {
  const cells: { x: number; y: number; z: number; mat: number }[] = [];
  for (const [x, y] of w.near(wx, wy, r)) for (let z = z0; z < z1; z++) cells.push({ x, y, z, mat });
  return cells;
}
