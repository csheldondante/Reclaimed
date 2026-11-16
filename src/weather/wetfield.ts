// The window's river-wetness field (round 109): the storm water each river carries (weather/catchwet.ts), at the
// window's coarse texels (WorldGpu riverWet, RIVER_WET_CELLS cells apart) — each texel its nearest river node's,
// within REACH; 0 past them. riverheld.wgsl riverWetAt reads it (bilinear) and adds the climate's (Globals ocean.w).
// Written only while it changes.
// (mutators round 6, BACKLOG MU-47) The field reaches RIVER_WET_PAD texels past the window on every side: the far
// tiles drawn there read it as the window's columns do, so a river cut dry stays dry past the window's edge.

import { RIVER_WET_CELLS, RIVER_WET_PAD } from '../sim/world-gpu';
import { cellPos, ROW_H } from '../world/lattice';
import type { CatchmentWet } from './catchwet';

/** how far from its node a texel takes the node's water (window units): a river's columns lie within ~2 macro
 *  texels of a node (atlas/compose.wgsl riverAt: the segments from the nodes nearest the four texels round it) */
const REACH = 32;
/** how far past the window the field's nodes are taken (window units: the field's reach and a node's) */
export const FIELD_MARGIN = RIVER_WET_PAD * RIVER_WET_CELLS + REACH;

export class RiverWetField {
  private node: Int32Array;
  private best: Float32Array;
  private vals: Float32Array;
  private wet = false;
  /** the texels' nodes were mapped again since the last upload */
  private fresh = true;
  private fw: number;
  private fh: number;
  /** the writes' cost (ms, a running mean) and the uploads made */
  msMean = 0;
  uploads = 0;
  private writes = 0;
  /** the last write's climate, and whether storm water was in it */
  private climate = NaN;
  private stormy = false;

  constructor(private device: GPUDevice, private tex: GPUTexture) {
    this.fw = tex.width;
    this.fh = tex.height;
    this.node = new Int32Array(this.fw * this.fh).fill(-1);
    this.best = new Float32Array(this.fw * this.fh);
    this.vals = new Float32Array(this.fw * this.fh);
  }

  /** each texel's node: the nearest of the field's nodes (catchwet's, after setWindow). Texel (i, r) is the window's
   *  cell ((i - RIVER_WET_PAD) · F, (r - RIVER_WET_PAD) · F) */
  map(cw: CatchmentWet): void {
    const { fw, fh, node, best } = this;
    node.fill(-1);
    best.fill(REACH * REACH);
    const F = RIVER_WET_CELLS;
    const P = RIVER_WET_PAD;
    for (let j = 0; j < cw.field.length; j++) {
      const x = cw.fieldPos[j * 2];
      const y = cw.fieldPos[j * 2 + 1];
      const i0 = Math.max(0, Math.floor((x - REACH) / F) + P);
      const i1 = Math.min(fw - 1, Math.ceil((x + REACH) / F) + P);
      const r0 = Math.max(0, Math.floor((y - REACH) / ROW_H / F) + P);
      const r1 = Math.min(fh - 1, Math.ceil((y + REACH) / ROW_H / F) + P);
      for (let r = r0; r <= r1; r++)
        for (let i = i0; i <= i1; i++) {
          const [px, py] = cellPos((i - P) * F, (r - P) * F);
          const d = (px - x) * (px - x) + (py - y) * (py - y);
          const t = r * fw + i;
          if (d < best[t]) {
            best[t] = d;
            node[t] = cw.field[j];
          }
        }
    }
    this.wet = true;
    this.fresh = true;
  }

  /** the texels from the nodes' storm water; uploaded if any is wet (or was). (merge124) `inflow` per node: a region's
   *  rivers' inflow factor — the field carries (climate + storm water) × factor − climate, so riverWetAt (climate + field)
   *  gives the river its region's share: a card's drought dries it, a diversion swells it. (mutators round 6) `stormy`
   *  false: no node carries storm water — with the texels' nodes, the inflows (map: every change of them maps again)
   *  and the climate as they were at the last write, nothing is looked at */
  write(ex: Float32Array, inflow?: Float32Array, climate = 1, stormy = true): void {
    if (!this.fresh && !stormy && !this.stormy && Math.abs(climate - this.climate) < 1e-4) return;
    this.stormy = stormy;
    this.climate = climate;
    const t0 = performance.now();
    this.upload(ex, inflow, climate);
    this.writes++;
    this.msMean += (performance.now() - t0 - this.msMean) / Math.min(this.writes, 600);
  }

  private upload(ex: Float32Array, inflow: Float32Array | undefined, climate: number): void {
    const { node, vals } = this;
    let any = false;
    let moved = false;
    for (let t = 0; t < vals.length; t++) {
      const n = node[t];
      const k = n >= 0 && inflow ? inflow[n] : 1;
      const v = n >= 0 ? ex[n] * k + climate * (k - 1) : 0;
      // (mutators round 5: uploaded only when a texel moved — a standing cut used to upload the field every frame)
      if (Math.abs(v - vals[t]) > 1e-4) moved = true;
      vals[t] = v;
      if (Math.abs(v) > 1e-4) any = true;
    }
    if (!moved && !this.fresh) return;
    this.fresh = false;
    if (!any && !this.wet) return;
    this.wet = any;
    this.uploads++;
    this.device.queue.writeTexture({ texture: this.tex }, vals, { bytesPerRow: this.fw * 4 }, [this.fw, this.fh]);
  }
}
