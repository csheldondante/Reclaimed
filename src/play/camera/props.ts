// ---- play/camera/props.ts ---------------------------------------------------------------------------------------
// (round 121, herolab) A tree as the camera's sight sees it: the trunk and the crown as two upright cylinders, sized as
// the draw lays them out (vegprep.wgsl: a half-cell trunk; a crown 1.5 cells either side, a birch's 1.15, an old
// giant's 2.5, from the trunk's top). Pure; the browser feeds it world.plants' trees, the Node metrics planTree's.

import type { Prop } from '../../api/contracts/camera';

export interface TreeLike {
  x: number;
  y: number;
  species: string;
  trunk: number;
  crown: number;
}

export function treeProps(t: TreeLike, ground: number): Prop[] {
  const half = t.species === 'giant' ? 2.5 : t.species === 'birch' ? 1.15 : 1.5;
  const base = ground + t.trunk + (t.species === 'giant' ? 0 : 0.5);
  return [
    { x: t.x, y: t.y, z0: ground, z1: ground + t.trunk + 0.5, r: 0.5 },
    { x: t.x, y: t.y, z0: base - (t.species === 'giant' ? 0.5 : 0), z1: base + t.crown, r: half },
  ];
}
