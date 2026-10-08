// Level registry (BACKLOG C6): every place the player can reclaim, plus the
// sandbox. The title screen shows a small model for each (menumap.ts places
// them; clicking one selects it); each level keeps its own progress.

import type { WorldDims } from '../world/layout';
import type { MapData } from '../world/mapgen';
import { generateMap } from '../world/mapgen';
import { generateSandbox } from '../world/sandbox';

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
  },
  { id: 'highway', name: 'The Highway', blurb: 'A road of ruined cars, buried in dust.', model: 'car' },
  { id: 'city', name: 'The City', blurb: 'A blast crater, and the tents where they tried to help.', model: 'tent' },
  { id: 'port', name: 'The Port', blurb: 'Tankers on the shore, behind a broken seawall.', model: 'ship' },
  {
    id: 'sandbox',
    name: 'Sandbox',
    blurb: 'Build, pour, plant and spill — then let the weather loose.',
    model: 'sign',
    generate: (dims) => generateSandbox(dims),
    sandbox: true,
  },
];

export function levelById(id: string | null | undefined): LevelDef {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}
