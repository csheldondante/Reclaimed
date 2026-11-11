// A frame's draw: render-prep (instances grown as needed), the terrain cache or the G-buffer, shadows, the opaque,
// plant, body, mesh, structure, water and blend passes, particles and rain, the pick and the counts; and the ceiling
// view's. API: encode, encodeCeiling (Renderer's), syncInst, syncMeshPool.
import { makeBindGroup } from '../../gpu/pipeline';
import { READBACK } from '../fieldmesh';
import { type Camera } from '../camera';
import { MI_ARGS_WORD } from '../meshinst';
import { record } from '../../gpu/cpustat'; // (round 100, hitchrec: timing)
import { archTextures } from '../../archgen/textures';
import { BGCHECK, BgCheck } from '../bgcheck';
import { encodeTerrainCache, terrainCacheMode } from './terrain-cache';
import { encodeGBuffer, encodeShadow, writeLight } from './gbuffer-shadow';
import { drawGrid, gridCull, gridLive } from './grid';
import { VERTS_PER_PRISM, VERTS_PER_BOX, VERTS_PER_TOP, INST_GROW, RenderOptions, SKIP, SHADOW_STILL_BIT, cutOn } from './defs';
import { Renderer } from '../renderer';
import { ARCH_DRAWS, KIND } from '../../archgen/archgen';

/** Renderer.encode (the class keeps the method, documented there) */
export function encode(rd: Renderer, enc: GPUCommandEncoder, target: GPUTextureView, cam: Camera, opts: RenderOptions): void {
  syncMeshPool(rd);
  syncInst(rd);
  cam.write(rd.camData);
  // look flags (render.wgsl Camera.eye.w; DA-B7: the static casters' shadow map looked up too)
  new Float32Array(rd.camData)[19] = (rd.flatTops ? 1 : 0) | (rd.fieldMesh.on ? 2 : 0) | (Renderer.opts.noDetail << 2) | (rd.shadowStillOn() ? SHADOW_STILL_BIT : 0);
  rd.fieldMesh.cull(cam);
  for (const f of rd.frameCompute) f(enc);
  // (round 86: the grid's chunks in view, and near it for the terrain cache)
  if (gridLive(rd)) {
    const n = rd.gridOn!.on.length;
    if (rd.gridView.length !== n) {
      rd.gridView = new Uint8Array(n);
      rd.gridNear = new Uint8Array(n);
      rd.gridCasts = new Uint8Array(n);
    }
    gridCull(rd, cam.viewProj, rd.gridView, 1, true);
    gridCull(rd, cam.viewProj, rd.gridNear, 1.5, true);
  }
  // (perfopt, ?cavemesh=near: the caves meshed round the player when the cut slices a roof off; all when flying)
  rd.fieldMesh.setCaves(cam.cut.slice !== null ? [cam.target[0], cam.target[1]] : null, !!cam.fly);
  rd.band?.mesh.cull(cam);
  rd.frameNo++;
  const shadowDue = rd.fieldMesh.on ? writeLight(rd, opts.sun) : false;
  // (perfopt, ?prepevery=N: the instance lists kept from an earlier frame — their counts too)
  const pe = Math.max(1, Renderer.opts.prepEvery | 0);
  const prepDue = pe <= 1 || rd.frameNo - rd.prepAt.frame >= pe || rd.prepAt.slides !== rd.fieldMesh.slides;
  if (prepDue) rd.prepAt = { frame: rd.frameNo, slides: rd.fieldMesh.slides };
  // (perfopt, ?tcache=N: the terrain's cached layer — reused, the camera snapped to its pixels; or drawn again)
  const tcMode = terrainCacheMode(rd, cam);
  rd.device.queue.writeBuffer(rd.camBuf, 0, rd.camData);
  if (rd.world.strVoxels > 0) rd.device.queue.writeBuffer(rd.structIndirect, 0, new Uint32Array([36, 0, 0, 0]));
  if (prepDue)
    rd.device.queue.writeBuffer(
      rd.indirect,
      0,
      new Uint32Array([VERTS_PER_PRISM, 0, 0, 0, VERTS_PER_PRISM, 0, 0, 0, VERTS_PER_BOX, 0, 0, 0, VERTS_PER_TOP, 0, 0, 0, rd.topsBase]),
    );
  if (prepDue && rd.meshInst) rd.device.queue.writeBuffer(rd.indirect, MI_ARGS_WORD * 4, rd.meshInst.argsReset());

  if (!SKIP.has('shore')) rd.shore.encode(enc, performance.now());
  if (!SKIP.has('prep') && prepDue) {
    const pass = enc.beginComputePass({ label: 'renderprep', timestampWrites: rd.profiler.timestamps('renderprep') });
    pass.setPipeline(rd.prep.pipeline);
    pass.setBindGroup(0, rd.prepGroup);
    const [gx, gy] = rd.world.groups;
    pass.dispatchWorkgroups(gx, gy);
    pass.setPipeline(rd.vegPrep.pipeline);
    pass.setBindGroup(0, rd.vegPrepGroup);
    pass.dispatchWorkgroups(gx, gy);
    if (rd.floraField && rd.floraFieldGroup) {
      pass.setPipeline(rd.floraField.pipeline);
      pass.setBindGroup(0, rd.floraFieldGroup);
      pass.dispatchWorkgroups(gx, gy);
    }
    if (rd.world.strVoxels > 0) {
      pass.setPipeline(rd.structPrep.pipeline);
      pass.setBindGroup(0, rd.structPrepGroup);
      pass.dispatchWorkgroups(Math.ceil(rd.world.strVoxels / 64));
      rd.profiler.dispatches++;
    }
    // (round 93: the counts held to the lists' room — the raw ones kept for the CPU)
    pass.setPipeline(rd.clampB.pipeline);
    pass.setBindGroup(0, rd.clampBGroup);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(rd.clampV.pipeline);
    pass.setBindGroup(0, rd.clampVGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    rd.profiler.dispatches += 2;
    if (!SKIP.has('water')) rd.waterSurf?.encode(enc);
  }
  // (round 82: with a band, the window's mesh and the band's look for changes and rebuild on alternate frames —
  // a frame never rebuilds both: on the phone the rebuilds were the biggest share of the p95 spikes)
  const turn = rd.meshTurn++ & 1;
  // (round 86: but chunks marked urgent — an edit's, a falling piece's — are looked at every frame)
  const tMesh = performance.now(); // (round 100, hitchrec: timing)
  if (!SKIP.has('meshprep') && !rd.holdMesh && (!rd.band || turn === 0 || rd.fieldMesh.hasUrgent)) rd.fieldMesh.encode(enc, cam);
  record('mesh', performance.now() - tMesh); // (round 100, hitchrec: timing)
  if (rd.band && !SKIP.has('band') && !rd.holdMesh && turn === 1) rd.band.mesh.encode(enc, cam);
  if (rd.rockMesh) rd.rockMesh.encode(enc, cam);
  if (rd.shadowGroups && !SKIP.has('shadow') && shadowDue) encodeShadow(rd, enc, shadowDue);

  // (round 103, ?tiles=1: the tiles baked this frame, and those drawn past the window — their mask for the rings)
  if (rd.tiles && !SKIP.has('tiles')) {
    rd.tiles.encode(enc, cam, rd.depth!.width);
    rd.tiles.prepare(cam);
    rd.tiles.encodeMask(enc);
  }
  // (perfopt, ?defer=1: the mesh's G-buffer pass, its depth the world pass's)
  if (tcMode === 'refresh') encodeTerrainCache(rd, enc);
  // (the deferred pipelines compile off the main thread from the start: forward until they're in)
  const def = !tcMode && rd.meshPipe && rd.meshPipes && !SKIP.has('mesh') && Renderer.opts.defer ? encodeGBuffer(rd, enc, cam) : undefined;
  // (perfopt: nothing reads the depth after this pass, nor the pick target unless a pick is asked for — on a
  // tile-based GPU a discarded attachment never leaves the tile: 12 bytes a pixel not written out every frame)
  const keepPick = !!rd.pickRequest && !rd.pickBusy;
  const pass = enc.beginRenderPass({
    label: 'world',
    colorAttachments: [
      { view: target, clearValue: { r: opts.clear[0], g: opts.clear[1], b: opts.clear[2], a: 1 }, loadOp: 'clear', storeOp: 'store' },
      { view: rd.pickTex!.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: keepPick || BGCHECK ? 'store' : 'discard' },
    ],
    // (round 112, ?bgcheck=1: both kept for bgcheck.ts)
    depthStencilAttachment: def
      ? { view: rd.depth!.createView(), depthLoadOp: 'load', depthStoreOp: BGCHECK ? 'store' : 'discard' }
      : { view: rd.depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: BGCHECK ? 'store' : 'discard' },
    timestampWrites: rd.profiler.timestamps('draw'),
  });
  if (tcMode) {
    pass.setPipeline(rd.tcPipes!.comp);
    pass.setBindGroup(0, rd.tc!.comp);
    pass.draw(3);
  }
  if (def) {
    pass.setPipeline(def.resolve);
    pass.setBindGroup(0, def.groups[0]);
    pass.draw(3);
    if (rd.band && !SKIP.has('band')) {
      pass.setBindGroup(0, def.groups[1]);
      pass.draw(3);
    }
  }
  // (perfopt, ?prepass=1: the terrain mesh's depth first — its look is then shaded once a pixel, not for
  // every surface behind it drawn before the one in front)
  const pre = !def && rd.meshPipe && !SKIP.has('mesh') && Renderer.opts.prepass ? (rd.meshPre ??= rd.meshPreMake!()) : undefined;
  if (pre) {
    pass.setPipeline(cutOn(cam) ? pre.zCut : pre.z);
    pass.setBindGroup(0, rd.meshGroup!);
    rd.fieldMesh.draw(pass);
    if (rd.band && !SKIP.has('band')) {
      pass.setBindGroup(0, rd.bandGroup!);
      rd.band.mesh.draw(pass);
    }
  }
  pass.setPipeline(rd.opaquePipe);
  pass.setBindGroup(0, rd.opaqueGroup);
  if (!SKIP.has('opaque')) pass.drawIndirect(rd.indirect, 0);
  pass.setBindGroup(0, rd.topsGroup);
  if (!SKIP.has('tops')) pass.drawIndirect(rd.indirect, 48);
  pass.setBindGroup(0, rd.plantGroup);
  if (!SKIP.has('plants')) pass.drawIndirect(rd.indirect, 32);
  // (round 99) the instanced meshes: the trees
  if (rd.meshInst && rd.miPipe && !SKIP.has('trees')) {
    pass.setPipeline(rd.miPipe);
    pass.setBindGroup(0, rd.miGroup!);
    rd.profiler.draws += rd.meshInst.draw(pass, rd.indirect);
    pass.setPipeline(rd.opaquePipe);
  }
  for (const s of SKIP.has('prisms') ? [] : rd.prismSources) {
    pass.setBindGroup(0, s.group);
    pass.drawIndirect(s.indirect, 0);
    rd.profiler.draws++;
  }
  if (rd.meshPipe && !SKIP.has('mesh') && !def && !tcMode) {
    pass.setPipeline(pre ? pre.look : rd.meshPipe);
    pass.setBindGroup(0, rd.meshGroup!);
    rd.fieldMesh.draw(pass);
    rd.profiler.draws++;
    // (round 79: the band outside the window — it casts no shadow yet: the sun's box is the window's)
    if (rd.band && !SKIP.has('band')) {
      pass.setBindGroup(0, rd.bandGroup!);
      rd.band.mesh.draw(pass);
    }
    // (round 86: the grid, forward — not in the depth prepass: it's drawn tested as the rest is)
    if (gridLive(rd)) {
      pass.setPipeline(rd.gridPipes!.fwd);
      pass.setBindGroup(0, rd.meshGroup!);
      rd.gridDrawn = drawGrid(rd, pass, rd.gridView);
    }
  }
  if (rd.tiles && !SKIP.has('tiles')) rd.tiles.draw(pass);
  for (const f of SKIP.has('far') ? [] : rd.extraDraws) f(pass, opts.clear);
  if (rd.bodyShown > 0 && !SKIP.has('bodies')) {
    pass.setPipeline(rd.bodyPipe);
    pass.setBindGroup(0, rd.bodyGroup);
    pass.draw(36, rd.bodyShown);
    rd.profiler.draws++;
  }
  // (round 95) the rigid rock's mesh
  if (rd.rockMesh && rd.rockPipe && rd.rockMesh.count > 0 && !SKIP.has('rock')) {
    pass.setPipeline(rd.rockPipe);
    pass.setBindGroup(0, rd.rockGroup!);
    rd.rockMesh.draw(pass);
  }
  if (rd.world.strVoxels > 0 && !SKIP.has('structs')) {
    pass.setPipeline(rd.bodyPipe);
    pass.setBindGroup(0, rd.structGroup);
    pass.drawIndirect(rd.structIndirect, 0);
    rd.profiler.draws++;
  }
  for (const v of SKIP.has('voxels') ? [] : rd.voxelSources) {
    pass.setPipeline(rd.bodyPipe);
    pass.setBindGroup(0, v.group);
    pass.drawIndirect(v.indirect, 0);
    rd.profiler.draws++;
  }
  for (const v of SKIP.has('skins') ? [] : rd.meshSources) {
    pass.setPipeline(rd.skinPipe);
    pass.setBindGroup(0, v.group);
    pass.drawIndirect(v.indirect, 0);
    rd.profiler.draws++;
  }
  // (archgen) the building generator's parts: a draw a part kind
  if (rd.archSources.length) pass.setBindGroup(1, archTextures(rd.device).group);
  for (const v of SKIP.has('arch') ? [] : rd.archSources) {
    pass.setBindGroup(0, v.group);
    ARCH_DRAWS.forEach(([k], i) => {
      if ((k === KIND.win && !rd.archWindows) || rd.archSkip.has(k)) return;
      pass.setPipeline(rd.archPipes![i]);
      pass.drawIndirect(v.args, k * 16);
    });
    rd.profiler.draws += ARCH_DRAWS.length;
  }
  // (watersurf) the water's surface, then the blended prisms (oil, ice and crystal; without the field mesh the water)
  const flat = SKIP.has('waterflat');
  if (rd.waterSurf && rd.waterSurfPipe && !SKIP.has('water')) {
    pass.setPipeline(flat ? rd.waterFlatPipe : rd.waterSurfPipe);
    pass.setBindGroup(0, rd.blendGroup);
    rd.waterSurf.draw(pass);
  }
  pass.setPipeline(flat && !rd.waterSurf ? rd.waterFlatPipe : rd.blendPipe);
  pass.setBindGroup(0, rd.blendGroup);
  if (!SKIP.has(rd.waterSurf ? 'blend' : 'water')) pass.drawIndirect(rd.indirect, 16);
  for (const s of SKIP.has('blend') || SKIP.has('water') ? [] : rd.blendSources) {
    pass.setBindGroup(0, s.group);
    pass.drawIndirect(s.indirect, 0);
    rd.profiler.draws++;
  }
  pass.setPipeline(rd.partPipe);
  pass.setBindGroup(0, rd.partGroup);
  if (!SKIP.has('particles')) pass.draw(6, rd.world.particleCap);
  rd.profiler.draws++;
  if (opts.rainParticles > 0 && !SKIP.has('rain')) {
    pass.setPipeline(rd.rainPipe);
    pass.setBindGroup(0, rd.rainGroup);
    pass.draw(6, opts.rainParticles);
    rd.profiler.draws++;
  }
  pass.end();
  rd.profiler.draws += 3;
  if (BGCHECK) (rd as { bgCheck?: BgCheck }).bgCheck ??= new BgCheck(rd.device);
  rd.bgCheck?.encode(enc, rd.depth!, rd.pickTex!, rd.profiler.timestamps('bgcheck'));

  if (rd.pickRequest && !rd.pickBusy) {
    const { x, y, resolve } = rd.pickRequest;
    rd.pickRequest = undefined;
    const tex = rd.pickTex!;
    if (x >= 0 && y >= 0 && x < tex.width && y < tex.height) {
      enc.copyTextureToBuffer({ texture: tex, origin: [Math.floor(x), Math.floor(y)] }, { buffer: rd.pickBuf, bytesPerRow: 256 }, [1, 1]);
      rd.pickBusy = true;
      rd.pickPending = resolve;
    } else resolve(null);
  }
  if (!rd.countBusy) {
    enc.copyBufferToBuffer(rd.indirect, 0, rd.countBuf, 0, 96);
    rd.countBusy = true;
    // (round 93: the lists' growth reads them too)
    rd.countNeeded = READBACK && (rd.profiler.active || INST_GROW);
  }
}

/** Renderer.encodeCeiling (the class keeps the method, documented there) */
export function encodeCeiling(rd: Renderer, enc: GPUCommandEncoder, target: GPUTextureView, cam: Camera, clear: [number, number, number], draw: (pass: GPURenderPassEncoder) => void): void {
  cam.write(rd.camData);
  rd.device.queue.writeBuffer(rd.camBuf, 0, rd.camData);
  const pass = enc.beginRenderPass({
    label: 'ceiling',
    colorAttachments: [{ view: target, clearValue: { r: clear[0], g: clear[1], b: clear[2], a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: { view: rd.depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    timestampWrites: rd.profiler.timestamps('draw'),
  });
  draw(pass);
  pass.end();
  rd.profiler.draws += 2;
}

/** (round 93) Let the meshes grow their page pools; a pool's buffer replaced, the groups that bind it are made again. */
/**
 * (round 93, instgrow) Grow the instance lists the last count asked to: new buffers (what's in them is made
 * again every frame — nothing to copy), the groups that bind them made again. The old ones go a few frames on.
 */
export function syncInst(rd: Renderer): void {
  const g = rd.instGrowTo;
  if (!g.opaque && !g.plant && !g.blend) return;
  rd.instGrowTo = { opaque: 0, plant: 0, blend: 0 };
  const N = rd.world.cells;
  const old: GPUBuffer[] = [];
  if (g.opaque) {
    old.push(rd.instOpaque);
    rd.opaqueCapacity = g.opaque;
    rd.topsBase = Math.ceil(g.opaque / 16) * 16;
    rd.instOpaque = rd.world.buf('instOpaque', (rd.topsBase + 2 * N) * 16, GPUBufferUsage.STORAGE);
  }
  if (g.plant) {
    old.push(rd.instPlant);
    rd.plantCapacity = g.plant;
    rd.instPlant = rd.world.buf('instPlant', g.plant * 16, GPUBufferUsage.STORAGE);
  }
  if (g.blend) {
    old.push(rd.instBlend);
    rd.blendCapacity = g.blend;
    rd.instBlend = rd.world.buf('instBlend', g.blend * 16, GPUBufferUsage.STORAGE);
  }
  const dev = rd.device;
  rd.prepGroup = makeBindGroup(dev, 'renderprep', rd.prep.layout, rd.prepEntries());
  rd.clampBGroup = makeBindGroup(dev, 'renderprep-clamp', rd.clampB.layout, rd.prepEntries());
  rd.vegPrepGroup = makeBindGroup(dev, 'vegprep', rd.vegPrep.layout, rd.vegEntries());
  rd.clampVGroup = makeBindGroup(dev, 'vegprep-clamp', rd.clampV.layout, rd.vegEntries());
  rd.opaqueGroup = rd.groupFor(rd.instOpaque);
  rd.topsGroup = rd.groupFor({ buffer: rd.instOpaque, offset: rd.topsBase * 16 });
  rd.plantGroup = rd.groupFor(rd.instPlant);
  rd.blendGroup = rd.groupFor(rd.instBlend);
  if (rd.shadowGroups && rd.noShadowViews) {
    const L = rd.lightCamBuf;
    rd.shadowGroups.opaque = rd.groupFor(rd.instOpaque, L, rd.noShadowViews);
    rd.shadowGroups.tops = rd.groupFor({ buffer: rd.instOpaque, offset: rd.topsBase * 16 }, L, rd.noShadowViews);
    rd.shadowGroups.plants = rd.groupFor(rd.instPlant, L, rd.noShadowViews);
  }
  // (the instance lists, kept from an earlier frame with ?prepevery, are made again now)
  rd.prepAt.frame = -1e9;
  rd.instGrown++;
  setTimeout(() => old.forEach((b) => b.destroy()), 1000);
}

export function syncMeshPool(rd: Renderer): void {
  // (round 95) the rigid rock's mesh: its group made again when its pool grows
  if (rd.rockMesh && rd.rockGroupOf) {
    const rv = rd.rockMesh.mesh.maintain();
    if (rv !== rd.rockPoolSeen) {
      rd.rockPoolSeen = rv;
      rd.rockGroup = rd.rockGroupOf();
      rd.rockShadowGroup = rd.noShadowViews ? rd.rockGroupOf(rd.lightCamBuf, rd.noShadowViews) : undefined;
    }
  }
  const v = rd.fieldMesh.maintain() + (rd.band?.mesh.maintain() ?? 0);
  if (v === rd.meshPoolSeen || !rd.meshGroupOf) return;
  rd.meshPoolSeen = v;
  const win = { mesh: rd.fieldMesh, chunks: rd.world.chunks, layers: rd.world.layers };
  rd.meshGroup = rd.meshGroupOf(rd.camBuf, rd.shadowViews, win);
  if (rd.band) rd.bandGroup = rd.meshGroupOf(rd.camBuf, rd.shadowViews, { mesh: rd.band.mesh, chunks: rd.band.chunks, layers: rd.band.layers });
  if (rd.shadowGroups) rd.shadowGroups.mesh = rd.meshGroupOf(rd.lightCamBuf, rd.noShadowViews!, win);
  if (rd.meshDef) rd.meshDef.groups = [];
  rd.tiles?.invalidate();
  if (rd.tc) {
    for (const t of Object.values(rd.tc.tex)) t.destroy();
    rd.tc = undefined;
  }
}
