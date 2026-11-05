// The deferred mesh's G-buffer pass and the sun's shadow map (its light camera, what's due: all or the moving, the
// static cache). API: encodeGBuffer, writeLight, encodeShadow.
import { FieldMesh } from '../fieldmesh';
import { CAMERA_BYTES, CAMERA_CUT_BYTES, CAMERA_CUT_OFFSET, type Camera } from '../camera';
import { drawGrid, gridCull, gridLive } from './grid';
import { structGroups } from './features';
import { SHADOW_FORMAT, SKIP, cutOn } from './defs';
import { Renderer } from '../renderer';

/**
 * (perfopt, ?defer=1) The terrain mesh into the G-buffer (meshdraw.wgsl gPack) and the depth: what the
 * resolve shades a pixel at a time. The textures follow the render target's size.
 */
export function encodeGBuffer(rd: Renderer, enc: GPUCommandEncoder, cam: Camera): { resolve: GPURenderPipeline; groups: GPUBindGroup[] } {
  const depth = rd.depth!;
  if (!rd.meshDef || rd.meshDef.tex[0].width !== depth.width || rd.meshDef.tex[0].height !== depth.height) {
    const p = rd.meshDef ?? { ...rd.meshPipes!, groups: [], tex: [] };
    for (const t of p.tex) t.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    p.tex = [
      rd.device.createTexture({ label: 'gbuf0', size: [depth.width, depth.height], format: 'rgba32uint', usage }),
      rd.device.createTexture({ label: 'gbuf1', size: [depth.width, depth.height], format: 'rg32uint', usage }),
    ];
    rd.profiler.trackMemory('gbuffer', depth.width * depth.height * 24);
    p.groups = [];
    rd.meshDef = p;
  }
  const d = rd.meshDef;
  // (the groups: the band's comes and goes — made again when it's missing)
  if (!d.groups.length || d.band !== rd.band) {
    d.band = rd.band;
    const g0 = d.tex[0].createView();
    const g1 = d.tex[1].createView();
    const mk = (src: { mesh: FieldMesh; chunks: GPUBuffer; layers: GPUBuffer }) =>
      rd.device.createBindGroup({
        label: 'mesh-resolve',
        layout: rd.meshResolveLayout!,
        entries: [
          ...rd.meshEntries(src),
          { binding: 40, resource: g0 },
          { binding: 41, resource: g1 },
        ],
      });
    d.groups = [mk({ mesh: rd.fieldMesh, chunks: rd.world.chunks, layers: rd.world.layers })];
    if (rd.band) d.groups.push(mk({ mesh: rd.band.mesh, chunks: rd.band.chunks, layers: rd.band.layers }));
  }
  const pass = enc.beginRenderPass({
    label: 'gbuffer',
    colorAttachments: [
      { view: d.tex[0].createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      { view: d.tex[1].createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
    ],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    timestampWrites: rd.profiler.timestamps('gbuffer'),
  });
  pass.setPipeline(cutOn(cam) ? d.gCut : Renderer.opts.cull ? d.gBack : d.g);
  pass.setBindGroup(0, rd.meshGroup!);
  rd.fieldMesh.draw(pass);
  if (rd.band && !SKIP.has('band')) {
    // (perfopt, ?bandcull=1: the band's faces turned from the eye culled — the land over and under the window seen
    // from outside, its undersides and insides never; not with the cut, which opens them)
    if (Renderer.opts.bandcull && !cutOn(cam)) pass.setPipeline(d.gBack);
    pass.setBindGroup(0, rd.bandGroup!);
    rd.band.mesh.draw(pass);
  }
  if (gridLive(rd)) {
    pass.setPipeline(cutOn(cam) ? rd.gridPipes!.gCut : rd.gridPipes!.g);
    pass.setBindGroup(0, rd.meshGroup!);
    rd.gridDrawn = drawGrid(rd, pass, rd.gridView);
  }
  pass.end();
  return d;
}

/**
 * The sun's view: an orthographic box round the whole map (it's small
 * enough for one map) looking along the light, into both cameras — the
 * view's, to look shadows up, and the sun's own, to draw them.
 */
/** (returns whether the shadow map is drawn this frame — perfopt's shadowEvery — and with shadowCache whether
 *  its static casters are: 'all', 'moving' (the cache copied in, the moving casters over it) or false) */
export function writeLight(rd: Renderer, sun: [number, number, number]): 'all' | 'moving' | false {
  const f = [-sun[0], -sun[1], -sun[2]];
  const fl = Math.hypot(f[0], f[1], f[2]) || 1;
  f[0] /= fl;
  f[1] /= fl;
  f[2] /= fl;
  // (right and up across the light; a sun overhead takes y for its up)
  const up = Math.abs(f[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  let r = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  const rl = Math.hypot(r[0], r[1], r[2]);
  r = r.map((v) => v / rl);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  // the box: the chunks near the view, floor to sky (perf branch; it was the
  // whole map). The light is orthographic, so it holds every caster whose
  // shadow falls in them: those up-sun of the view too.
  const [x0, y0, x1, y1] = SKIP.has('shadowfit') ? [0, 0, rd.world.w + 0.5, rd.world.h * (Math.sqrt(3) / 2)] : rd.fieldMesh.nearRect;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const p = [k & 1 ? x1 : x0, k & 2 ? y1 : y0, k & 4 ? rd.world.zMax + 2 : -2];
    const a = [r, u, f].map((ax) => ax[0] * p[0] + ax[1] * p[1] + ax[2] * p[2]);
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], a[i]);
      hi[i] = Math.max(hi[i], a[i]);
    }
  }
  // clip x, y ∈ [-1, 1] across the box, depth ∈ [0, 1] along the light
  const sx = 2 / (hi[0] - lo[0]);
  const sy = 2 / (hi[1] - lo[1]);
  const sz = 1 / (hi[2] - lo[2]);
  const m = new Float32Array(16);
  m.set([r[0] * sx, u[0] * sy, f[0] * sz, 0, r[1] * sx, u[1] * sy, f[1] * sz, 0, r[2] * sx, u[2] * sy, f[2] * sz, 0]);
  m.set([-(lo[0] + hi[0]) / 2 * sx, -(lo[1] + hi[1]) / 2 * sy, -lo[2] * sz, 1], 12);
  const cf = new Float32Array(rd.camData);
  // (perfopt, ?shadowevery=N: between redraws the map and the matrix it was drawn with are kept — the lookups
  // stay consistent while the camera moves; a slide (the land moved under the window's coordinates) or a new box
  // draws it at once)
  const sc = Math.max(0, Renderer.opts.shadowCache | 0);
  const se = sc > 1 ? sc : Math.max(1, Renderer.opts.shadowEvery | 0);
  const S = rd.shadowAt;
  const rect = `${x0},${y0},${x1},${y1}`;
  if (se > 1 && rd.frameNo - S.frame < se && S.rect === rect && S.slides === rd.fieldMesh.slides && S.cached === sc > 1) {
    cf.set(S.m, CAMERA_BYTES / 4);
    cf[23] = S.bias;
    return sc > 1 ? 'moving' : false;
  }
  rd.shadowAt = { m, bias: 0.25 * sz, frame: rd.frameNo, rect, slides: rd.fieldMesh.slides, cached: sc > 1 };
  cf.set(m, CAMERA_BYTES / 4);
  rd.fieldMesh.castCull(m);
  if (gridLive(rd)) gridCull(rd, m, rd.gridCasts, 1, false);
  // the lookup's depth bias: a quarter of a cell along the light
  cf[23] = 0.25 * sz;
  // the sun's own camera: its matrix as the view, looking from the sun
  const lf = new Float32Array(rd.lightCamData);
  lf.set(cf);
  lf.set(m, 0);
  lf.set([-f[0], -f[1], -f[2], cf[19]], 16);
  // (round 82: no cutaway from the sun — what's cut still casts)
  lf.fill(0, CAMERA_CUT_OFFSET / 4, (CAMERA_CUT_OFFSET + CAMERA_CUT_BYTES) / 4);
  rd.device.queue.writeBuffer(rd.lightCamBuf, 0, rd.lightCamData);
  return 'all';
}

/** The sun's shadow map: every built mesh chunk, the prisms, plants, structures and bodies, depth only. */
export function encodeShadow(rd: Renderer, enc: GPUCommandEncoder, due: 'all' | 'moving'): void {
  const g = rd.shadowGroups!;
  // (perfopt, ?shadowcache=N: the static casters into their own map every Nth frame, copied in every frame)
  const cache = Renderer.opts.shadowCache > 1;
  if (cache && (!rd.shadowStatic || rd.shadowStatic.width !== rd.shadowTex.width)) {
    rd.shadowStatic?.destroy();
    rd.shadowStatic = rd.device.createTexture({ label: 'shadow-static', size: [rd.shadowTex.width, rd.shadowTex.height], format: SHADOW_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    due = 'all';
  }
  const statics = (pass: GPURenderPassEncoder) => {
    pass.setPipeline(Renderer.opts.cull ? rd.shadowMeshCullPipe! : rd.shadowMeshPipe!);
    pass.setBindGroup(0, g.mesh);
    rd.fieldMesh.drawCasters(pass);
    if (gridLive(rd) && rd.gridCasts.length) {
      pass.setPipeline(rd.gridPipes!.shadow);
      drawGrid(rd, pass, rd.gridCasts);
    }
    pass.setPipeline(rd.shadowOpaquePipe!);
    pass.setBindGroup(0, g.opaque);
    pass.drawIndirect(rd.indirect, 0);
    pass.setBindGroup(0, g.tops);
    pass.drawIndirect(rd.indirect, 48);
  };
  if (cache && due === 'all') {
    const sp = enc.beginRenderPass({
      label: 'shadow-static',
      colorAttachments: [],
      depthStencilAttachment: { view: rd.shadowStatic!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      timestampWrites: rd.profiler.timestamps('shadow-static'),
    });
    statics(sp);
    sp.end();
  }
  if (cache) enc.copyTextureToTexture({ texture: rd.shadowStatic! }, { texture: rd.shadowTex }, [rd.shadowTex.width, rd.shadowTex.height]);
  const pass = enc.beginRenderPass({
    label: 'shadow',
    colorAttachments: [],
    depthStencilAttachment: { view: rd.shadowView, depthClearValue: 1, depthLoadOp: cache ? 'load' : 'clear', depthStoreOp: 'store' },
    timestampWrites: rd.profiler.timestamps('shadow'),
  });
  if (!cache) statics(pass);
  pass.setPipeline(rd.shadowOpaquePipe!);
  pass.setBindGroup(0, g.plants);
  pass.drawIndirect(rd.indirect, 32);
  // (round 99) the instanced meshes
  if (rd.meshInst && rd.miShadowPipe && rd.miShadowGroup) {
    pass.setPipeline(rd.miShadowPipe);
    pass.setBindGroup(0, rd.miShadowGroup);
    // (round 117, flora: only the kinds that cast a shadow worth its triangles — trees and thickets, not the grass)
    rd.meshInst.draw(pass, rd.indirect, rd.flora?.shadowKinds);
  }
  if (rd.structs?.shadow && rd.structs.sg.ranges.length) {
    structGroups(rd);
    pass.setPipeline(rd.structs.shadow);
    pass.setBindGroup(0, rd.structs.shadowGroup!);
    // (the sun's map: always the far look — its texels are bigger than a window frame)
    rd.structs.sg.draw(pass, true);
  }
  pass.setPipeline(rd.shadowBodyPipe!);
  if (rd.world.strVoxels > 0) {
    pass.setBindGroup(0, g.struct);
    pass.drawIndirect(rd.structIndirect, 0);
  }
  if (rd.bodyCount > 0) {
    pass.setBindGroup(0, g.bodies);
    pass.draw(36, rd.bodyCount);
  }
  for (const v of rd.voxelSources) {
    if (!v.shadow) continue;
    pass.setBindGroup(0, v.shadow);
    pass.drawIndirect(v.indirect, 0);
  }
  // (round 99) the rock's mesh (the resting rock has no cubes casting its shadow)
  if (rd.rockMesh && rd.rockShadowPipe && rd.rockShadowGroup && rd.rockMesh.count > 0) {
    pass.setPipeline(rd.rockShadowPipe);
    pass.setBindGroup(0, rd.rockShadowGroup);
    rd.rockMesh.draw(pass);
  }
  if (rd.meshSources.length) pass.setPipeline(rd.shadowSkinPipe!);
  for (const v of rd.meshSources) {
    if (!v.shadow) continue;
    pass.setBindGroup(0, v.shadow);
    pass.drawIndirect(v.indirect, 0);
  }
  pass.end();
  rd.profiler.draws += 4;
}
