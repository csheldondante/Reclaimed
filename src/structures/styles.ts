// Styles: which modules a look uses and its palette (the shader colours a module's parts from it). A style is data:
// adding one is a palette and a few choices, the modules and the rules stay shared.
// The looks are our own (the user, round 117: the tile systems are techniques; "readable and pretty and look integrated
// with the world"). 'hearth' first: a hill town of limewashed timber-framed houses under terracotta and slate — warm
// against the terrain's greys and greens, lit windows at dusk.
import { Part, PARTS } from './modules';
import type { StructureStyleId } from '../api/contracts/structures';

export type RGB = [number, number, number];

export interface Style {
  id: StructureStyleId;
  /** module name prefixes: the ground floor's walls, the upper floors', ramparts and towers' */
  walls0: string;
  walls: string;
  roof: 'tile' | 'slate';
  /** roof rise per metre of tile (a half tile's run rises pitch × half a tile) */
  pitch: number;
  /** gable ends where a ridge ends (else hipped) */
  gables: boolean;
  /** storeys at the centre and the rim */
  storeys: [number, number];
  /** most tiles a building grows to */
  maxTiles: number;
  /** landmark towers */
  towers: number;
  /** chimneys a roof tile */
  chimneys: number;
  /** corner posts (timber) or quoins (stone) */
  corners: 'post' | 'quoins';
  /** per part its colours (variants picked per building by its look) */
  palette: RGB[][];
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

function palette(p: Partial<Record<Part, string[]>>): RGB[][] {
  const out: RGB[][] = [];
  for (let i = 0; i < PARTS; i++) out.push((p[i as Part] ?? ['#ff00ff']).map(hex));
  return out;
}

export const STYLES: Record<StructureStyleId, Style> = {
  hearth: {
    id: 'hearth',
    walls0: 'plaster0',
    walls: 'plaster',
    roof: 'tile',
    pitch: 0.95,
    gables: true,
    storeys: [3.6, 1.4],
    maxTiles: 5,
    towers: 1,
    chimneys: 0.22,
    corners: 'post',
    palette: palette({
      [Part.Wall]: ['#efe6d2', '#e9d9b8', '#f1e1cf', '#dfe3d3', '#ead1b3', '#f3eee4', '#e0c9a6'],
      [Part.Trim]: ['#4a3426', '#5a3f2b', '#3d2c22'],
      [Part.Roof]: ['#b4553a', '#a24a35', '#c0683f', '#7b5d57', '#556066', '#9a4b3c'],
      [Part.Glass]: ['#1d2a33'],
      [Part.Stone]: ['#9c958a', '#a89f90', '#8e8a82'],
      [Part.Door]: ['#5b3b26', '#3f4f3a', '#6a3428', '#2f4250'],
      [Part.Shutter]: ['#3d5c48', '#5f7f8a', '#7a3d2f', '#5d6b3a', '#8a6a3a'],
      [Part.Pave]: ['#8a8174', '#80786c'],
      [Part.Awning]: ['#b8443a', '#d9b25a', '#3f6e6a', '#e8e0cc'],
      [Part.Metal]: ['#2c2a28'],
      [Part.RoofUnder]: ['#3b2a20'],
      [Part.Water]: ['#4f8fa0'],
      [Part.Plant]: ['#5b7a3a', '#4f6e34'],
      [Part.Lamp]: ['#ffd48a'],
      [Part.Dome]: ['#5f9a86', '#6aa58f'],
    }),
  },
  bastion: {
    id: 'bastion',
    walls0: 'stone',
    walls: 'stone',
    roof: 'slate',
    pitch: 1.25,
    gables: false,
    storeys: [4.5, 2],
    maxTiles: 4,
    towers: 2,
    chimneys: 0.1,
    corners: 'quoins',
    palette: palette({
      [Part.Wall]: ['#b9b2a4'],
      [Part.Trim]: ['#3a332d', '#4a3d31'],
      [Part.Roof]: ['#4c5560', '#56606b', '#465058', '#5d5a63'],
      [Part.Glass]: ['#1a2128'],
      [Part.Stone]: ['#a7a090', '#b3ab9a', '#9a9384', '#a59c8c'],
      [Part.Door]: ['#4a3220', '#3a2a1e'],
      [Part.Shutter]: ['#3a332d'],
      [Part.Pave]: ['#7d776d', '#857e72'],
      [Part.Awning]: ['#7a2f2a', '#2f4a5a'],
      [Part.Metal]: ['#25282b'],
      [Part.RoofUnder]: ['#2a2622'],
      [Part.Water]: ['#4c7d8c'],
      [Part.Plant]: ['#566f38'],
      [Part.Lamp]: ['#ffcf80'],
      [Part.Dome]: ['#4f5860', '#5a8a7a'],
    }),
  },
  terrace: {
    id: 'terrace',
    walls0: 'plaster0',
    walls: 'plaster',
    roof: 'slate',
    pitch: 0.6,
    gables: false,
    storeys: [5, 2],
    maxTiles: 6,
    towers: 0,
    chimneys: 0.05,
    corners: 'quoins',
    palette: palette({
      [Part.Wall]: ['#e8e2d6', '#d8d0c0', '#cfd6d8', '#e6d3c0'],
      [Part.Trim]: ['#5a5650', '#45423e'],
      [Part.Roof]: ['#5e6870', '#6a6e72', '#7a6058'],
      [Part.Glass]: ['#1c2630'],
      [Part.Stone]: ['#bdb6a8', '#aaa395'],
      [Part.Door]: ['#2f3c48', '#5a2e28'],
      [Part.Shutter]: ['#4f5a60', '#6b4a3a'],
      [Part.Pave]: ['#8c867c'],
      [Part.Awning]: ['#2f5a4f', '#a8483a', '#d8c690'],
      [Part.Metal]: ['#2a2c2e'],
      [Part.RoofUnder]: ['#34302c'],
      [Part.Water]: ['#4f8fa0'],
      [Part.Plant]: ['#5b7a3a'],
      [Part.Lamp]: ['#ffd48a'],
      [Part.Dome]: ['#6f9f8e'],
    }),
  },
};

export function styleOf(id: StructureStyleId): Style {
  const s = STYLES[id];
  if (!s) throw new Error(`structures: no style "${id}"`);
  return s;
}

export const STYLE_IDS = Object.keys(STYLES) as StructureStyleId[];
/** the variants a palette slot has at most (the shader's table is styles × parts × this) */
export const VARIANTS = 8;
