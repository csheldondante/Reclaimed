// Optional draws turned on after construction: the outside band, the rock mesh, structures. API: enableBand,
// enableRockMesh, enableStructures (Renderer's), structGroups.
import { makeModule, renderPipe } from '../../gpu/pipeline';
import commonWgsl from '../../shaders/common.wgsl?raw';
import materialsWgsl from '../../shaders/materials.wgsl?raw';
import terrainShapeWgsl from '../../shaders/terrainshape.wgsl?raw';
import renderWgsl from '../../shaders/render.wgsl?raw';
import structMeshWgsl from '../../shaders/structmesh.wgsl?raw';
import structGameWgsl from '../../shaders/structgame.wgsl?raw';
import { StructureGpu } from '../../structures/gpu';
import { riverMode } from '../../sim/world-gpu';
import { OutsideBand } from '../band';
import { RockMesh } from '../rockmesh';
import { SHADOW_FORMAT, PICK_FORMAT, DEPTH_FORMAT, STRUCT_CULL } from './defs';
import type { Renderer } from '../renderer';

/** Renderer.enableBand (the class keeps the method, documented there) */
export function enableBand(rd: Renderer, zSpan: number): OutsideBand | undefined {
  if (!rd.fieldMesh.on || !rd.meshGroupOf || rd.band) return rd.band;
  rd.band = new OutsideBand(rd.device, rd.world, rd.profiler, zSpan, Math.min(3, rd.meshSlots ?? 3));
  if (rd.edgesOpen) rd.band.mesh.openEdges();
  if (rd.meshWant) rd.band.mesh.setWanted(rd.meshWant);
  rd.bandGroup = rd.meshGroupOf(rd.camBuf, rd.shadowView, { mesh: rd.band.mesh, chunks: rd.band.chunks, layers: rd.band.layers });
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
  rd.rockShadowGroup = rd.noShadowView ? group(rd.lightCamBuf, rd.noShadowView) : undefined;
  rd.rockPoolSeen = rm.mesh.poolVersion;
  // (round 120: its copy and its draws grow on demand — the groups made again on the new buffers)
  rm.onBuffers = () => {
    rd.rockGroup = group();
    rd.rockShadowGroup = rd.noShadowView ? group(rd.lightCamBuf, rd.noShadowView) : undefined;
  };
  return rm;
}

/** Renderer.enableStructures (the class keeps the method, documented there) */
export function enableStructures(rd: Renderer, sg: StructureGpu): void {
  if (rd.structs) throw new Error('renderer: structures enabled twice');
  const device = rd.device;
  const riverFoam = `const RIVER_FOAM_SPEED: bool = ${riverMode() === 'table'};\n`;
  const module = makeModule(device, 'structures', [commonWgsl, materialsWgsl, terrainShapeWgsl, riverFoam, renderWgsl, sg.wgsl(), structMeshWgsl, structGameWgsl]);
  const st: NonNullable<Renderer['structs']> = { sg, version: -1, lod: false };
  rd.structs = st;
  const vertex: GPUVertexState = { module, entryPoint: 'vsStruct', buffers: [StructureGpu.vertexLayout()] };
  renderPipe(device, {
    label: 'structures',
    layout: rd.drawPl,
    vertex,
    fragment: { module, entryPoint: 'fsStruct', targets: [{ format: rd.colorFormat }, { format: PICK_FORMAT }] },
    // (the modules are wound outward and every frame counter-clockwise: back faces culled, half the fragments)
    primitive: { topology: 'triangle-list', cullMode: STRUCT_CULL },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
  }, (p) => (st.pipe = p));
  // (round 120) the lights' pools: added over the lit world (one + one), no depth written, the pick untouched
  renderPipe(device, {
    label: 'structures-glow',
    layout: rd.drawPl,
    vertex: { module, entryPoint: 'vsPool', buffers: [StructureGpu.vertexLayout()] },
    fragment: { module, entryPoint: 'fsPool', targets: [{ format: rd.colorFormat, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }, { format: PICK_FORMAT, writeMask: 0 }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less-equal' },
  }, (p) => (st.glow = p));
  if (rd.noShadowView)
    renderPipe(device, {
      label: 'shadow-structures',
      layout: rd.drawPl,
      vertex,
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
    }, (p) => (st.shadow = p));
}

/** the pieces' groups, made again when their buffer was */
export function structGroups(rd: Renderer): void {
  const st = rd.structs!;
  if (st.version === st.sg.version) return;
  st.group = rd.groupFor(st.sg.data);
  if (rd.noShadowView) st.shadowGroup = rd.groupFor(st.sg.data, rd.lightCamBuf, rd.noShadowView);
  st.version = st.sg.version;
}
