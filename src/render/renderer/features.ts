// Optional draws turned on after construction: the outside band, the rock mesh. API: enableBand, enableRockMesh
// (Renderer's). (Switchover: the old towns' pieces' draw, enableStructures, deleted with them.)
import { OutsideBand } from '../band';
import { RockMesh } from '../rockmesh';
import type { Renderer } from '../renderer';

/** Renderer.enableBand (the class keeps the method, documented there) */
export function enableBand(rd: Renderer, zSpan: number): OutsideBand | undefined {
  if (!rd.fieldMesh.on || !rd.meshGroupOf || rd.band) return rd.band;
  rd.band = new OutsideBand(rd.device, rd.world, rd.profiler, zSpan, Math.min(3, rd.meshSlots ?? 3));
  if (rd.edgesOpen) rd.band.mesh.openEdges();
  if (rd.meshWant) rd.band.mesh.setWanted(rd.meshWant);
  rd.bandGroup = rd.meshGroupOf(rd.camBuf, rd.shadowViews, { mesh: rd.band.mesh, chunks: rd.band.chunks, layers: rd.band.layers });
  rd.tiles?.invalidate();
  return rd.band;
}

/** Renderer.enableRockMesh (the class keeps the method, documented there) */
export function enableRockMesh(rd: Renderer): RockMesh | undefined {
  if (!rd.fieldMesh.on || !rd.makeRockDraw || rd.rockMesh) return rd.rockMesh;
  const rm = new RockMesh(rd.device, rd.world, rd.profiler);
  const { pipe, group, shadow } = rd.makeRockDraw(rm);
  rd.rockMesh = rm;
  rd.rockPipe = pipe;
  rd.rockGroupOf = group;
  rd.rockGroup = group();
  rd.rockShadowPipe = shadow;
  rd.rockShadowGroup = rd.noShadowViews ? group(rd.lightCamBuf, rd.noShadowViews) : undefined;
  rd.rockPoolSeen = rm.mesh.poolVersion;
  // (round 120: its copy and its draws grow on demand — the groups made again on the new buffers)
  rm.onBuffers = () => {
    rd.rockGroup = group();
    rd.rockShadowGroup = rd.noShadowViews ? group(rd.lightCamBuf, rd.noShadowViews) : undefined;
  };
  return rm;
}
