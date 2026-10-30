// Play — the game layer's contract (round 117, the `play` track): heroes, their controllers, controls, gear and
// vehicles. The user (round 117 part 3): "I think just make a new layer you own so I can work from one session. I
// want the separation of concerns but I also want to be able to iterate on player controls which is probably the
// most important thing for fun." / "Let's make it another system so it is encapsulated but move it in so we can
// work on it and iterate here."
//
// Why a capability profile: the generators (terrain's passability, flora's soft barriers, runplan's obstacles) must
// reason about what each hero can and can't do without knowing how its controller works — the user: "we plan to make
// an expanding library of controllers to interact with the world. So parameterize it so we can reason about it during
// generation and make not only obstacles but fun ones. A fast bike need races and chases. A combat soldier needs fun
// fights. A force of nature needs spectacle and power fantasy." So a controller is data (its parameters) plus a small
// module, and its profile is DERIVED from the parameters (a bike tuned to launch higher clears wider gaps): change a
// slider in the play sandbox and the profile the generators read changes with it. Nothing here is how a controller
// moves — only what it can cross and what it's fun at.
// - Implementation: src/play/library.ts `library` (the Playbook). The engine never imports src/play; other tracks
//   import only this file (and `library` as a value through it at their boundary).
// - Units: cells, cells/s, rise over run; heights in cells (z), as the world API's.
//
//   const p = library.get('hoverbike')!.profile()            // the defaults, or .profile(tuned)
//   crossCost(p, { slope: 0.8, step: 0, gap: 6, ramp: true })  // 1 = open ground at cruise; Infinity = can't
//   fun(p)                                                    // the obstacles and encounters worth building for it

/** One tunable number of a controller (the sandbox draws a slider for each; a generator may read them too). */
export interface ParamSpec {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** a heading the sandbox groups sliders under ('drive', 'launch', 'slash' …) */
  group?: string;
  help?: string;
}

/** A controller's parameters by id: a flat record of numbers (so one block can go to a GPU kernel later). */
export type Params = Record<string, number>;

/** What a hero can do in the world: the generators' terms. */
export interface ControllerProfile {
  /** cells/s: what it holds on open ground, and the most it reaches (a boost, a downhill) */
  speed: { cruise: number; top: number };
  /** cells: the tightest turn at cruise (a bike's is wide; a walker turns on the spot: ~0) */
  turnRadius: number;
  /**
   * the steepest slope it moves up (rise over run; Infinity: any), the tallest step it takes without a jump (cells:
   * a kerb, a rock; Infinity: it goes up any cliff — a lich floats up the face) and how fast it goes up a step or a
   * face (cells/s; 0: at its stride, no time)
   */
  climb: { slope: number; step: number; rate: number };
  /**
   * a jump: how high it clears (cells) and how far (cells, at top speed); `ramp`: only off a ramp or a crest (a
   * hoverbike's launch), not from flat ground. Zero: no jump.
   */
  jump: { height: number; gap: number; ramp: boolean };
  /** flight or levitation: how high over the ground it can hold (cells; 0: none) — over enemies' reach, over low walls */
  fly: { ceiling: number };
  /** water: the deepest it wades (cells); `over`: it skims or floats over any depth */
  water: { wade: number; over: boolean };
  /** dense vegetation (a thicket, tall reeds — flora's soft barriers): its speed through it as a share of cruise (0: blocked), or it cuts a way */
  vegetation: { through: number; cuts: boolean };
  /** builds a way over a gap (a bridge, a rope) of up to this many cells (0: can't) */
  bridge: number;
  /**
   * how much it breaks, 0..1: 0 nothing; ~0.3 fences, crates, enemies knocked over; ~0.6 walls and ruins; 1 the
   * terrain itself (craters, cutting through a hill)
   */
  destruction: number;
  /** what play suits it, each 0..1 (runplan weighs a run's encounters by these) */
  encounters: Encounters;
}

export interface Encounters {
  /** against the clock or rivals over a course */
  race: number;
  /** pursuing or fleeing */
  chase: number;
  /** close fights */
  fight: number;
  /** destruction, crowds tossed about, power fantasy */
  spectacle: number;
  /** caves, ruins, keys and doors */
  delve: number;
  /** tricks: airtime, spins, slides scored */
  tricks: number;
}

/** A controller in the library: its data and the profile its parameters give. */
export interface ControllerInfo {
  /** 'hoverbike', 'lich', … */
  id: string;
  name: string;
  /** an emoji for the select screen */
  icon: string;
  /** what it's like, one line */
  line: string;
  /** how it's played (touch first), short */
  controls: string;
  params: readonly ParamSpec[];
  defaults: Readonly<Params>;
  /** the profile at these parameters (default: its defaults) */
  profile(params?: Params): ControllerProfile;
}

/** The library of controllers (src/play/library.ts). */
export interface Playbook {
  controllers(): readonly ControllerInfo[];
  get(id: string): ControllerInfo | null;
}

/** A piece of ground between two places, in the generators' terms (all optional: absent is easy). */
export interface Crossing {
  /** rise over run of the way */
  slope?: number;
  /** a sheer step up (cells) */
  step?: number;
  /** a gap to cross (a ravine, a river with no ford: cells across) */
  gap?: number;
  /** there's a ramp or crest to take it from */
  ramp?: boolean;
  /** water standing on it (cells deep) */
  water?: number;
  /** dense vegetation 0..1 */
  vegetation?: number;
}

/**
 * How hard a crossing is for a profile: 1 open ground at cruise, higher slower (a time multiplier), Infinity it
 * can't. Pure: terrain's passability per hero, flora's barriers and runplan's gates all call this, so they agree.
 */
export function crossCost(p: ControllerProfile, c: Crossing): number {
  let cost = 1;
  const flies = p.fly.ceiling > 0;
  const step = c.step ?? 0;
  if (step > p.climb.step) {
    // (a step it can't take in its stride: jumped, if it can jump that high from here, or it can't)
    if (p.jump.height >= step && (!p.jump.ramp || c.ramp)) cost += 0.2;
    else return Infinity;
  } else if (step > 0 && p.climb.rate > 0) cost += (step * p.speed.cruise) / p.climb.rate; // (time to go up it, in cells of open ground)
  const slope = c.slope ?? 0;
  if (slope > p.climb.slope && !flies) return Infinity;
  if (!flies) cost *= 1 + Math.max(0, slope) / Math.max(p.climb.slope, 0.1);
  const gap = c.gap ?? 0;
  if (gap > 0 && !flies) {
    if (p.jump.gap >= gap && (!p.jump.ramp || c.ramp)) cost += 0.2;
    else if (p.bridge >= gap) cost += 3;
    else return Infinity;
  }
  const water = c.water ?? 0;
  if (water > p.water.wade && !p.water.over && !flies) return Infinity;
  if (water > 0 && !p.water.over && !flies) cost *= 1 + water / Math.max(p.water.wade, 0.1);
  const veg = Math.max(0, Math.min(1, c.vegetation ?? 0));
  if (veg > 0 && !flies) {
    const through = p.vegetation.cuts ? Math.max(p.vegetation.through, 0.5) : p.vegetation.through;
    if (through <= 0 && veg > 0.5) return Infinity;
    cost /= 1 - veg * (1 - Math.max(through, 0.05));
  }
  return cost;
}

/** A thing worth building for a hero (runplan's "not only obstacles but fun ones"), with the sizes that fit it. */
export type FunFeature =
  /** a ramp or crest to launch off, and the gap beyond it it clears at top speed (cells) */
  | { kind: 'ramp'; gap: number; height: number; weight: number }
  /** a long open run to go flat out on (cells) */
  | { kind: 'straight'; length: number; weight: number }
  /** turns spaced so it has to slide or carve them (cells between) */
  | { kind: 'slalom'; spacing: number; weight: number }
  /** a pack of enemies to fight (how many at once) */
  | { kind: 'pack'; size: number; weight: number }
  /** things to smash or toss (how much destruction they take) */
  | { kind: 'breakables'; strength: number; weight: number }
  /** a cliff or tower to go up (cells) */
  | { kind: 'climb'; height: number; weight: number }
  /** a cave or ruin to go into */
  | { kind: 'delve'; weight: number };

/** The features that make a profile fun, best first (weights 0..1 from its encounters and abilities). */
export function fun(p: ControllerProfile): FunFeature[] {
  const e = p.encounters;
  const out: FunFeature[] = [];
  if (p.jump.gap > 0) out.push({ kind: 'ramp', gap: p.jump.gap * 0.8, height: p.jump.height * 0.8, weight: Math.max(e.tricks, e.race * 0.8) });
  if (p.speed.top > 12) out.push({ kind: 'straight', length: p.speed.top * 4, weight: Math.max(e.race, e.chase) });
  if (p.turnRadius > 2) out.push({ kind: 'slalom', spacing: p.turnRadius * 1.5, weight: e.race * 0.8 });
  if (e.fight > 0.2) out.push({ kind: 'pack', size: Math.round(2 + e.fight * 4 + e.spectacle * 8), weight: e.fight });
  if (p.destruction > 0.2) out.push({ kind: 'breakables', strength: p.destruction, weight: Math.max(e.spectacle, p.destruction * 0.8) });
  if (p.fly.ceiling > 2 || p.climb.slope === Infinity) out.push({ kind: 'climb', height: Math.max(p.fly.ceiling * 2, 6), weight: 0.4 });
  if (e.delve > 0.2) out.push({ kind: 'delve', weight: e.delve });
  return out.sort((a, b) => b.weight - a.weight);
}
