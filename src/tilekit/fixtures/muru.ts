// (tilekit step 2) The real grid round Muru's centre as a test fixture (scripts/tilekit-dump.mjs writes the JSON).
import type { GridMesh } from '../grid';
import { finish } from '../grid';
import fixture from './grid-muru.json';

export const MURU_ANCHOR: [number, number] = [fixture.anchor[0], fixture.anchor[1]];

export function muru(): GridMesh {
  const g = fixture as { xy: number[]; cells: number[]; lot: number[]; cls: number[] };
  const m = finish(new Float64Array(g.xy), new Int32Array(g.cells));
  return Object.assign(m, { lot: new Uint32Array(g.lot), cls: new Uint8Array(g.cls) });
}
