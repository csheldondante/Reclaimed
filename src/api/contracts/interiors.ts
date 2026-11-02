// The interiors contract (branch `interiors`, round 125; docs/ARCHITECTURE.md "Interiors").
//
// A building's inside, derived from the structures plan (CityPlan: its tiles, storeys and façades) in the same world
// space as its outside: every storey's floor plan (rooms by purpose, walls, the openings exactly where the façade has its
// doors and windows, stairs where the storeys stack), what furnishes it (props from the CC prop set, by id), where
// people can sit, stand and work, and its lights. Pure data: src/interiors/plan.ts makes it (Node-testable), the draw and
// the people read it. Coordinates are the plan's frame (the settlement box's metres; z absolute world metres): the host
// moves it into the window with `offset`.
//
// Tiles are free quads (Townscaper's irregular tiles), so everything inside one is placed in the tile's unit frame and
// warped bilinearly, as the structures' modules are: (u, v) in [0, 1]², u along side 0 (corner 0 → 1), v toward side 2.

export type V2 = [number, number];
export type V3 = [number, number, number];

export type RoomPurpose = 'hall' | 'kitchen' | 'stores' | 'sleeping' | 'chamber' | 'living' | 'workshop';

export interface InteriorRoom {
  id: number;
  purpose: RoomPurpose;
  /** the tiles it covers (CityPlan tile ids) */
  tiles: number[];
  /** its middle (plan frame) */
  centre: V2;
}

export type OpeningKind = 'door' | 'window' | 'arch' | 'shop' | 'balcony';

/** A hole in a wall: along it (0..1 of its length) and up it (metres over the storey's floor). */
export interface Opening {
  kind: OpeningKind;
  u0: number;
  u1: number;
  z0: number;
  z1: number;
}

/** A wall on one storey along one tile side: `a` → `b` is the side's own direction (the tile's inside on its left). */
export interface InteriorWall {
  tile: number;
  side: number;
  a: V2;
  b: V2;
  /** an outside wall (the façade's line; the structures draw it outside) or a partition between two rooms */
  outer: boolean;
  /** thickness (m), into the tile from the side for an outer wall; centred on the side for a partition */
  thick: number;
  openings: Opening[];
}

/** A straight flight up from one storey to the next, along a tile's side: in the tile's frame, a band `depth` deep off
 *  side `side`, from t0 to t1 along it (rising toward t1). */
export interface InteriorStair {
  tile: number;
  side: number;
  t0: number;
  t1: number;
  /** how far into the tile the band reaches (0..1 of the tile across from that side) */
  depth: number;
  z0: number;
  z1: number;
  /** where people step on and off (plan frame, z at the floors) */
  foot: V3;
  top: V3;
}

export interface PropPlacement {
  /** the prop's id in the CC prop set (data/props/props.json; CREDITS.md) */
  prop: string;
  at: V3;
  /** radians about z (0: the prop's own front toward +x) */
  yaw: number;
  room: number;
  /** a uniform scale on top of the prop set's (1 default) */
  scale?: number;
}

export type SpotKind = 'sit' | 'stand' | 'work' | 'gather' | 'sleep';

/** Where someone can be: at a point, facing a way. */
export interface Spot {
  kind: SpotKind;
  at: V3;
  face: number;
  room: number;
  /** the prop that makes it (a chair, a bed, a stove) */
  prop?: number;
  /** where to walk to before taking it (free floor beside the seat or bed; the spot itself for a standing one) */
  from: V3;
}

export type LightKind = 'candle' | 'torch' | 'hearth' | 'lantern';

export interface InteriorLight {
  kind: LightKind;
  at: V3;
  /** reach (m) */
  radius: number;
  /** linear colour × strength */
  colour: V3;
}

export interface InteriorStorey {
  level: number;
  /** its floor's top (world z) and its ceiling (the next floor's underside) */
  z: number;
  ceiling: number;
  tiles: number[];
  rooms: InteriorRoom[];
  walls: InteriorWall[];
  /** the flights up from this storey */
  stairs: InteriorStair[];
  props: PropPlacement[];
  spots: Spot[];
  lights: InteriorLight[];
}

export interface InteriorPlan {
  building: number;
  /** what it is to its town ('hall', 'house', ...: settle/plan.ts Use) */
  use: string;
  base: number;
  storeyH: number;
  storeys: InteriorStorey[];
  /** the street doors: the opening's middle on the floor, and the way out */
  doors: { at: V3; out: V2; level: number }[];
  /** the tiles' corners (plan frame), per tile id the plan uses: the floors' shapes */
  corners: Map<number, [V2, V2, V2, V2]>;
}
