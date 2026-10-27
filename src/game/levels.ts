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
import { generateFlowlab, setupFlowlab } from '../levels/flowlab';
import { generateRocklab } from '../levels/rocklab';
import type { FlowKit } from '../flow/install';
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
  /** (round 92) the camera's zoom it opens at (default: from the screen's size) — the rock lab's pieces close */
  zoom?: number;
  /** its height limit (cells; default 64): the wilds' ranges want more (round 64) */
  zMax?: number;
  /** the world is a window onto land without an edge (round 66: scenes/streamer.ts) */
  stream?: boolean;
  /** its land comes from an atlas made when it starts (round 67: atlas/atlas.ts; ?a.<param>=, ?at=x,y) */
  atlas?: boolean;
  /** the field mesh's room a chunk, times its default (rough land) */
  meshRoom?: number;
  /** (?flow=1) its springs and scripts, once the flow model is in (docs/ARCHITECTURE.md "The flow model") */
  flowSetup?: (kit: FlowKit) => { breach: (spring?: number) => void };
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
    id: 'atlas',
    name: 'The Atlas World',
    blurb: 'A whole world made at once — continents, countries, faults — streamed in around you.',
    model: 'sign',
    generate: () => {
      throw new Error('the atlas level is made by LevelScene.create (its atlas is built on the GPU first)');
    },
    sandbox: true,
    hidden: true,
    // (the window's height: the most the 8-bit z holds, less a margin; it slides in z over a taller world)
    zMax: 248,
    stream: true,
    atlas: true,
    meshRoom: 5,
  },
  {
    id: 'flowlab',
    name: 'The Flow Lab',
    blurb: 'A pool on a ledge, a stream in a tunnel, a lava vent: the flow model (?flow=1).',
    model: 'sign',
    generate: (dims) => generateFlowlab(dims),
    sandbox: true,
    hidden: true,
    flowSetup: setupFlowlab,
  },
  {
    id: 'rocklab',
    name: 'The Rock Lab',
    blurb: 'Rock to break: a top on a thin leg, an arm, an arch, a pillar, banded towers (round 92).',
    model: 'sign',
    generate: (dims) => generateRocklab(dims),
    sandbox: true,
    hidden: true,
    zMax: 96,
    zoom: 4.5,
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
