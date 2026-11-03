// ---- play/camera/apply.ts ---------------------------------------------------------------------------------------
// (round 121, herolab) The camera rig at the browser's boundary: the live world as the rig's SightWorld (the world
// API's terrain columns and the plants' trees, cached — a column for the frame, the trees for a second), and a frame
// written into the renderer's Camera (target, zoom, azimuth, elevation, the cut). The rig itself never sees either.

import type { CamFrame, Prop, SightWorld, V2 } from '../../api/contracts/camera';
import type { Plants } from '../../api/plants';
import type { Terrain } from '../../api/terrain';
import type { Camera } from '../../render/camera';
import { BUILT, treeProps } from './props';

type Cols = { z0: number; z1: number }[] | null;

/** The live world as the camera's sight: call `frame()` once a frame (the columns' cache is a frame's). */
export function liveSight(terrain: Terrain, plants: Plants | undefined, bounds: V2, ceiling: number): SightWorld & { frame(): void } {
  let cols = new Map<number, Cols>();
  let lastTop = 0;
  const B = 8;
  let buckets = new Map<number, Prop[]>();
  let bucketAge = 0;
  const bucket = (bx: number, by: number): Prop[] => {
    const k = by * 4096 + bx;
    let l = buckets.get(k);
    if (l) return l;
    l = [];
    if (plants)
      for (let y = by * B + 0.5; y < (by + 1) * B; y += 0.866)
        for (let x = bx * B + 0.5; x < (bx + 1) * B; x += 1) {
          const t = plants.treeAt(x, y);
          // (a tree is found from each of the cells near its own: once a bucket, by its own cell)
          if (!t || l.some((p) => p.x === t.x && p.y === t.y)) continue;
          if (t.x < bx * B || t.x >= (bx + 1) * B || t.y < by * B || t.y >= (by + 1) * B) continue;
          l.push(...treeProps(t, terrain.groundAt(t.x, t.y) ?? 0));
        }
    buckets.set(k, l);
    return l;
  };
  return {
    frame() {
      cols = new Map();
      // (the trees grow and fall slowly: looked at again every second or so)
      if (++bucketAge > 60) {
        buckets = new Map();
        bucketAge = 0;
      }
    },
    solid(x, y) {
      const key = Math.floor(y * 2) * 65536 + Math.floor(x * 2);
      let c = cols.get(key);
      if (c === undefined) {
        c = terrain.layersAt(x, y)?.filter((v) => v.state === 'solid' || v.state === 'loose').map((v) => ({ z0: v.z0, z1: v.z1 })) ?? null;
        cols.set(key, c);
      }
      return c;
    },
    top(x, y) {
      const h = terrain.heightAt(x, y);
      if (h !== null) lastTop = h;
      return h ?? lastTop;
    },
    props(x, y, r) {
      if (!plants) return [];
      const out: Prop[] = [];
      for (let by = Math.floor((y - r) / B); by <= Math.floor((y + r) / B); by++)
        for (let bx = Math.floor((x - r) / B); bx <= Math.floor((x + r) / B); bx++) {
          if (bx < 0 || by < 0 || bx * B > bounds[0] || by * B > bounds[1]) continue;
          for (const p of bucket(bx, by)) out.push(p);
        }
      return out;
    },
    built(x, y) {
      const ls = terrain.layersAt(x, y);
      if (!ls) return false;
      for (let i = ls.length - 1; i >= 0; i--) if (ls[i].state === 'solid' || ls[i].state === 'loose') return BUILT.has(ls[i].material);
      return false;
    },
    ceiling,
    bounds,
  };
}

/** What a frame last wrote, so a mode turned off gives the camera back (the fixed angle, no cut). */
export interface Applied {
  turn: boolean;
  tilt: boolean;
  cut: boolean;
}

/**
 * The frame into the camera: the framing always; the turn, the tilt and the cut only while a mode owns them (or the
 * frame after one let go), so nothing else's cut or turn is overwritten when the rig is only the chase.
 */
export function applyFrame(cam: Camera, f: CamFrame, own: Applied): Applied {
  const v = f.view;
  cam.target[0] = v.target[0];
  cam.target[1] = v.target[1];
  cam.target[2] = v.target[2];
  cam.zoom = v.zoom;
  if (own.turn) cam.azimuth = v.azimuth;
  if (own.tilt) cam.elevation = v.elevation;
  // (round 124, PRE1: the region's presentation look — none unless the present mode wrote one this frame)
  cam.present = f.present ?? null;
  if (own.cut) {
    const s = f.cut.slice;
    cam.cut.slice = s ? s.z : null;
    cam.cut.sliceShape = s ? { x: s.at[0], y: s.at[1], radius: s.radius, rim: s.rim, fade: s.fade, fadeR: s.fadeR, bowl: s.bowl, nearOnly: s.nearOnly, occluders: s.occluders } : null;
    cam.cut.see = f.cut.see.map((p) => [p.at[0], p.at[1], p.at[2], p.r]);
  }
  return own;
}
