// Level registry (BACKLOG C6): every place the player can reclaim, plus the
// sandbox. The title screen shows a small model for each (menumap.ts places
// them; clicking one selects it); each level keeps its own progress.

import type { WorldDims } from '../world/layout';
import type { MapData } from '../world/mapgen';
import { generateMap } from '../world/mapgen';
import { generateSandbox } from '../world/sandbox';
import { generateLandforms } from '../world/landforms';
import { generateStreamWindow } from '../world/streamgen';
import { generateTrials } from '../levels/trials';
import type { GateSpec } from '../world/kit';

/** What the title-screen model for a level looks like (menumap.ts builds it). */
export type LevelModel = 'dam' | 'car' | 'tent' | 'ship' | 'sign';

export interface LevelDef {
  id: string;
  name: string;
  /** one line under the name on the title screen */
  blurb: string;
  model: LevelModel;
  /** undefined: not built yet ("coming") */
  generate?: (dims: WorldDims) => MapData;
  /** reclamation goal (game/nature.ts reclamation()); none for the sandbox */
  goal?: number;
  /** first-play intro (the camera director script) on this map */
  intro?: boolean;
  /** free play with the editor (no goal, no progress) */
  sandbox?: boolean;
  /** a story level (round 30): green spreads only by seeds, within its reach; "Free play" opens it with the old rules */
  story?: boolean;
  /** not on the title screen (test beds: ?skipmenu=1&level=<id>, or the sandbox's load list) */
  hidden?: boolean;
  /** its height limit (cells; default 64): the wilds' ranges want more (round 64) */
  zMax?: number;
  /** the world is a window onto land without an edge (round 66: scenes/streamer.ts) */
  stream?: boolean;
}

export const LEVELS: LevelDef[] = [
  {
    id: 'valley',
    name: 'The Dam Valley',
    blurb: 'An industrial plant below a hydro dam.',
    model: 'dam',
    generate: (dims) => generateMap(dims, 1),
    goal: 0.55,
    intro: true,
    story: true,
  },
  { id: 'highway', name: 'The Highway', blurb: 'A road of ruined cars, buried in dust.', model: 'car' },
  { id: 'city', name: 'The City', blurb: 'A blast crater, and the tents where they tried to help.', model: 'tent' },
  { id: 'port', name: 'The Port', blurb: 'Tankers on the shore, behind a broken seawall.', model: 'ship' },
  {
    id: 'trials',
    name: 'The Trial Grounds',
    blurb: 'One of every obstacle, around a last green spring.',
    model: 'sign',
    generate: (dims) => generateTrials(dims),
    story: true,
    hidden: true,
  },
  {
    id: 'wilds',
    name: 'The Wilds',
    blurb: 'Ranges, mesas, rivers and caves: land to shape and build on.',
    model: 'sign',
    generate: (dims) => generateLandforms(dims, { seed: 1 }),
    sandbox: true,
    zMax: 96,
  },
  {
    id: 'stream',
    name: 'The Open Land',
    blurb: 'Land without an edge: the world streams in around you.',
    model: 'sign',
    generate: (dims) => generateStreamWindow(dims, 0, 0, 1),
    sandbox: true,
    hidden: true,
    zMax: 96,
    stream: true,
  },
  {
    id: 'sandbox',
    name: 'Sandbox',
    blurb: 'Build, pour, plant and spill — then let the weather loose.',
    model: 'sign',
    generate: (dims) => generateSandbox(dims),
    sandbox: true,
  },
];

/** The levels on the title screen. */
export const MENU_LEVELS = LEVELS.filter((l) => !l.hidden);

/** A built level's gates (kit levels; none for hand-written maps). */
export function gatesOf(map: MapData): GateSpec[] {
  return (map as MapData & { gates?: GateSpec[] }).gates ?? [];
}

export function levelById(id: string | null | undefined): LevelDef {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}
