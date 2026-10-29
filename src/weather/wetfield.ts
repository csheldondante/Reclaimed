// The window's river-wetness field (round 109): the storm water each river carries (weather/catchwet.ts), at the
// window's coarse texels (WorldGpu riverWet, RIVER_WET_CELLS cells apart) — each texel its nearest river node's,
// within REACH; 0 past them. riverheld.wgsl riverWetAt reads it (bilinear) and adds the climate's (Globals ocean.w).
// Written only while it changes.

import { RIVER_WET_CELLS } from '../sim/world-gpu';
import { cellPos, ROW_H } from '../world/lattice';
import type { CatchmentWet } from './catchwet';

/** how far from its node a texel takes the node's water (window units): a river's columns lie within ~2 macro
 *  texels of a node (atlas/compose.wgsl riverAt: the segments from the nodes nearest the four texels round it) */
const REACH = 32;

export class RiverWetField {
  private node: Int32Array;
  private best: Float32Array;
  private vals: Float32Array;
  private wet = false;
  private fw: number;
  private fh: number;
  /** the writes' cost (ms, a running mean) and the uploads made */
  msMean = 0;
  uploads = 0;
  private writes = 0;

  constructor(private device: GPUDevice, private tex: GPUTexture) {
    this.fw = tex.width;
    this.fh = tex.height;
    this.node = new Int32Array(this.fw * this.fh).fill(-1);
    this.best = new Float32Array(this.fw * this.fh);
    this.vals = new Float32Array(this.fw * this.fh);
  }

  /** each texel's node: the nearest of the kept nodes (catchwet's, after setWindow) */
  map(cw: CatchmentWet): void {
    const { fw, fh, node, best } = this;
    node.fill(-1);
    best.fill(REACH * REACH);
    const F = RIVER_WET_CELLS;
    for (let j = 0; j < cw.live.length; j++) {
      const x = cw.livePos[j * 2];
      const y = cw.livePos[j * 2 + 1];
      const i0 = Math.max(0, Math.floor((x - REACH) / F));
      const i1 = Math.min(fw - 1, Math.ceil((x + REACH) / F));
      const r0 = Math.max(0, Math.floor((y - REACH) / ROW_H / F));
      const r1 = Math.min(fh - 1, Math.ceil((y + REACH) / ROW_H / F));
      for (let r = r0; r <= r1; r++)
        for (let i = i0; i <= i1; i++) {
          const [px, py] = cellPos(i * F, r * F);
          const d = (px - x) * (px - x) + (py - y) * (py - y);
          const t = r * fw + i;
          if (d < best[t]) {
            best[t] = d;
            node[t] = cw.live[j];
          }
        }
    }
    this.wet = true;
  }

  /** the texels from the nodes' storm water; uploaded if any is wet (or was) */
  write(ex: Float32Array): void {
    const t0 = performance.now();
    this.upload(ex);
    this.writes++;
    this.msMean += (performance.now() - t0 - this.msMean) / Math.min(this.writes, 600);
  }

  private upload(ex: Float32Array): void {
    const { node, vals } = this;
    let any = false;
    for (let t = 0; t < vals.length; t++) {
      const v = node[t] >= 0 ? ex[node[t]] : 0;
      vals[t] = v;
      if (v > 1e-4) any = true;
    }
    if (!any && !this.wet) return;
    this.wet = any;
    this.uploads++;
    this.device.queue.writeTexture({ texture: this.tex }, vals, { bytesPerRow: this.fw * 4 }, [this.fw, this.fh]);
  }
}
