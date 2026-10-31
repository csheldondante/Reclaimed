// The node solver's contract (BACKLOG AR4, the physics design: DECISIONS rounds 106, 120). One GPU constraint solver
// for everything that breaks free — rock, buildings, metal, wood. What goes in: a body's cells (where they stood). What
// comes out: node transforms for the last two fixed steps (drawn between them), a summary per body read back a tick or
// two late, and events — impacts with their energy, bonds that broke, bodies come to rest, ground to erode.
//
// The judge (game/integrity.ts, fracture.ts) decides what lets go and hands it over; rendering skins meshes to the node
// transforms without touching the solver's state. Agents' reaction profiles (push, knockdown, burial) are a later
// track: the hook for them is `impulse` in and `impact` out (a contact pass reporting agents a body overlaps is not
// here yet).

export type V3 = [number, number, number];
export type Q = [number, number, number, number];

/** A cell of what a body is made of: column x, row y (storage, the window's), cell z; its material (world/materials.ts) */
export interface SolverCell {
  x: number;
  y: number;
  z: number;
  mat: number;
}

/** What to make a body of. Its rest shape is where its cells stood (the spawn frame: world cells). */
export interface BodySpec {
  cells: readonly SolverCell[];
  /** where it is now, if not where it stood (a resting rock woken): its centre of mass and rotation (spawn → world) */
  pose?: { pos: V3; q: Q };
  /** cells/s; and its spin (rad/s, about its centre of mass) */
  vel?: V3;
  spin?: V3;
  /** cells held where they are (a foundation): their nodes don't move */
  pinned?: (c: SolverCell) => boolean;
  /** overlap with the ground it was freed with (cells): kept, never pushed out, shrinking as it moves clear */
  allow?: number;
  /** rigid (rock: never deforms, the host breaks it) or deformable (metal, wood: bends, dents, snaps); default by its
   *  main material */
  kind?: 'rigid' | 'deformable';
}

/** A body as the solver last reported it (a tick or two late: `tick`). */
export interface BodyRead {
  tick: number;
  /** centre of mass (world cells), rotation (spawn frame → world), velocity (cells/s), spin (rad/s, an estimate) */
  pos: V3;
  q: Q;
  vel: V3;
  spin: V3;
  asleep: boolean;
  /** contact points touching something; s it has been still */
  touching: number;
  still: number;
  /** the hardest approach this tick (cells/s) and where (world), or null */
  impact: { speed: number; at: V3 } | null;
  /** ground it cut too deep into this tick (world points): the host erodes it (dust and rubble), it isn't pushed */
  erode: V3[];
  /** connected parts of its bond graph (> 1: it has snapped apart), bonds broken this tick */
  parts: number;
  broke: number;
  /** its mass (cells × density) */
  mass: number;
}

export interface SolverBody {
  readonly slot: number;
  readonly id: number;
  /** its cells' centre of mass where they stood (the spawn frame) */
  readonly restCom: V3;
  readonly cells: number;
  readonly nodes: number;
  readonly kind: 'rigid' | 'deformable';
}

export interface NodeSolver {
  /** a body in the solver (null: none — no cells) */
  add(spec: BodySpec): SolverBody | null;
  remove(b: SolverBody): void;
  /** a velocity change over the next tick (cells/s): a throw, a blast, a hero's power */
  impulse(b: SolverBody, dv: V3): void;
  wake(b: SolverBody): void;
  /** what the last readback said (undefined: not read back yet) */
  read(b: SolverBody): BodyRead | undefined;
  /** called after each readback, with the tick it was of */
  onRead?: (tick: number) => void;
  readonly bodies: ReadonlySet<SolverBody>;
}
