// Fine collision between two bodies (src/engine/sdf/fine.ts, sdf-fine.wgsl) on the real device, three ways a scene:
//   1. the GPU's contacts are the CPU mirror's (test/support/sdf-reference.ts: the same samples and field lookup in
//      doubles, over the brute-force distance field): point 0.01 cells, depth 0.005 cells, normal 1°;
//   2. the scene's own geometry: the depth and normal a ball on a ball, a box on a face, an edge, a corner, a box on a
//      tilted box, an L in a notch must give (tolerances at each);
//   3. every contact against the exact voxel geometry (brute-force distance and normal at the sample's point), in
//      voxels of the field's model. The stated tolerances:
//        where the field's model is smooth (no edge, corner or step within REACH voxels of the sample):
//          depth SMOOTH_DEPTH voxels, normal SMOOTH_NORMAL degrees;
//        anywhere: depth ANY_DEPTH voxels. Near an edge the field rounds it: the normal leans towards the next face
//          (the lean is printed with SDF_LOG=1, not bounded: at a model's medial sheet the exact normal itself flips).
// SDF_LOG=1 prints each scene's numbers.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BodyRow, SdfFormat } from '../../src/engine/sdf/contract';
import type { SdfModelSpec } from '../../src/engine/sdf/models';
import { axisAngle, ballShape, bodyOf, boxShape, lShape, massProps, notchShape, shape } from '../../src/engine/sdf/shapes';
import { angleDeg, refModel, rot } from '../support/sdf-reference';
import { testGpu, type TestGpu } from './dawn';
import { expectMirror, judge, makeScene, type Judged, type Scene } from './sdf-harness';

type V3 = [number, number, number];
type Q = [number, number, number, number];

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

/** a sample is on smooth ground when the field's model has no edge within this many voxels: the trilinear cell of
 *  f32 and snorm8 reaches one voxel, grad8's interpolated central differences two */
const REACH: Record<SdfFormat, number> = { f32: 1, snorm8: 1, grad8: 2 };
/** on smooth ground: depth (voxels of the field's model; snorm8 steps are 1/16) and normal (degrees) */
const SMOOTH_DEPTH = 0.04;
const SMOOTH_NORMAL = 1;
/** anywhere: depth, voxels of the field's model */
const ANY_DEPTH = 0.45;

/** a body of `spec` whose model origin (its voxel grid's corner) is at `origin`, turned by `quat` about that corner */
function placed(spec: SdfModelSpec, model: number, origin: V3, quat: Q = [0, 0, 0, 1], more: Partial<BodyRow> = {}): BodyRow {
  const c = massProps(spec).com;
  const r = rot(quat, [c[0] * spec.voxel, c[1] * spec.voxel, c[2] * spec.voxel]);
  return bodyOf(spec, model, [origin[0] + r[0], origin[1] + r[1], origin[2] + r[2]], quat, more);
}

const log = (s: string) => {
  if (process.env.SDF_LOG) console.log(s);
};
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/** a scene run once: the mirror's contacts, and each against the exact geometry within the stated tolerances */
async function check(name: string, scene: Scene): Promise<Judged[]> {
  const r = await scene.run();
  expect(r.dropped).toBe(0);
  expect(r.chunksDropped).toBe(0);
  const m = judge(
    scene,
    expectMirror(r.contacts, r.mirror, (c) => scene.fine.margin / scene.refs[scene.bodies[c.way ? c.a : c.b].model].voxel),
    REACH[scene.store.format],
  );
  const smooth = m.filter((c) => c.smooth);
  const edge = m.filter((c) => !c.smooth);
  log(
    `${scene.store.format} ${name}: ${m.length} contacts (${m.filter((c) => c.ref.way === 0).length} from a's samples, ${m.filter((c) => c.ref.way === 1).length} from b's), ${r.chunks} chunks | smooth ${smooth.length}: depth max ${Math.max(0, ...smooth.map((c) => c.depthErr)).toFixed(3)} voxels, normal max ${Math.max(0, ...smooth.map((c) => c.normalErr)).toFixed(2)}° | near an edge ${edge.length}: depth max ${Math.max(0, ...edge.map((c) => c.depthErr)).toFixed(3)} mean ${mean(edge.map((c) => c.depthErr)).toFixed(3)} voxels, normal mean ${mean(edge.map((c) => c.normalErr)).toFixed(1)}° max ${Math.max(0, ...edge.map((c) => c.normalErr)).toFixed(1)}°`,
  );
  for (const c of smooth) {
    expect(c.depthErr, `${name}: depth on smooth ground, voxels`).toBeLessThan(SMOOTH_DEPTH);
    expect(c.normalErr, `${name}: normal on smooth ground, degrees`).toBeLessThan(SMOOTH_NORMAL);
  }
  for (const c of edge) expect(c.depthErr, `${name}: depth near an edge, voxels`).toBeLessThan(ANY_DEPTH);
  return m;
}

const deepest = <T extends { gpu: { depth: number } }>(m: T[]): T => m.reduce((a, b) => (b.gpu.depth > a.gpu.depth ? b : a));

describe.each(['f32', 'snorm8', 'grad8'] as SdfFormat[])('fine collision, %s', (format) => {
  test('ball ↔ ball: depth 1 along the line of centres; the energy of a head-on approach', async () => {
    const ball = ballShape(12);
    const dir: V3 = [1 / 3, 2 / 3, 2 / 3];
    const back = dir.map((v) => -v);
    // (a moves at b at 2 cells a second)
    const a = bodyOf(ball, 0, [0, 0, 0], axisAngle([1, 2, 3], 0.7), { lin: [dir[0] * 2, dir[1] * 2, dir[2] * 2], material: 3 });
    const b = bodyOf(ball, 0, [dir[0] * 11, dir[1] * 11, dir[2] * 11], axisAngle([3, 1, -2], 1.9), { material: 5 });
    const scene = makeScene(g, format, [ball], [a, b], [0, 1]);
    const m = await check('ball on ball', scene);
    expect(m.length).toBeGreaterThan(20);
    const d = deepest(m);
    // radii 6 + 6, centres 11 apart: 1 deep; a voxel ball's surface is within half a voxel of the true one, both balls
    expect(Math.abs(d.gpu.depth - 1)).toBeLessThan(0.7);
    // the true balls' normals are radial: each contact's against the line from the field ball's centre through it
    const radial = m.map((c) => {
      const o = c.ref.way ? a.pos : b.pos;
      const v = [c.gpu.point[0] - o[0], c.gpu.point[1] - o[1], c.gpu.point[2] - o[2]];
      const l = Math.hypot(...v) * (c.ref.way ? -1 : 1);
      return angleDeg(c.gpu.normal, [v[0] / l, v[1] / l, v[2] / l]);
    });
    log(`${format} ball on ball: against the true balls' radial normals: mean ${mean(radial).toFixed(1)}° max ${Math.max(...radial).toFixed(1)}°; the pair's mean normal ${angleDeg(norm(sum(m.map((c) => c.gpu.normal))), back).toFixed(1)}° off the line of centres`);
    // (a ball of 12 voxels is steps. Against the true ball: the trilinear field's own gradient is within 20° on
    // average and 40° at worst; the kept, interpolated gradient of grad8 within 10° and 20°)
    expect(mean(radial)).toBeLessThan(format === 'grad8' ? 10 : 20);
    expect(Math.max(...radial)).toBeLessThan(format === 'grad8' ? 20 : 40);
    // from b towards a, summed over the contacts: along the line of centres
    expect(angleDeg(norm(sum(m.map((c) => c.gpu.normal))), back)).toBeLessThan(5);
    expect([d.gpu.matA, d.gpu.matB]).toEqual([3, 5]);
    // head on, the contact nearest the line of centres has almost no lever arm: effective mass m / 2, energy ½ (m / 2) 2² = m
    const mass = massProps(ball).mass;
    const axis = m.reduce((p, c) => (angleDeg(c.gpu.normal, back) < angleDeg(p.gpu.normal, back) ? c : p));
    expect(axis.gpu.closing).toBeGreaterThan(1.9);
    expect(axis.gpu.closing).toBeLessThanOrEqual(2.001);
    expect(axis.gpu.energy / mass).toBeGreaterThan(0.8);
    expect(axis.gpu.energy / mass).toBeLessThan(1.05);
    scene.destroy();
  });

  test('box ↔ box, face on face: 0.3 deep along the face normal', async () => {
    const box = boxShape(8, 8, 8);
    const scene = makeScene(g, format, [box], [bodyOf(box, 0, [0, 0, 0]), bodyOf(box, 0, [2.13, 1.21, 7.7])], [0, 1]);
    const m = await check('box face', scene);
    // a's top samples under b and b's bottom samples over a
    expect(m.length).toBeGreaterThan(60);
    const smooth = m.filter((c) => c.smooth);
    expect(smooth.length).toBeGreaterThan(format === 'grad8' ? 15 : 35);
    for (const c of smooth) {
      expect(Math.abs(c.gpu.depth - 0.3)).toBeLessThan(0.02);
      expect(angleDeg(c.gpu.normal, [0, 0, -1])).toBeLessThan(1);
    }
    // the rim of the overlap (samples within a voxel or two of the other box's side): the normal leans outwards, never past 60°
    for (const c of m) expect(angleDeg(c.gpu.normal, [0, 0, -1])).toBeLessThan(60);
    // the pair as a whole: b sits over a's corner, so the leans of the two rims there add up instead of cancelling:
    // the mean normal is 9° off the face normal (BACKLOG PF3). Bounded here so a change that worsens it shows.
    log(`${format} box face: the pair's mean normal ${angleDeg(norm(sum(m.map((c) => c.gpu.normal))), [0, 0, -1]).toFixed(1)}° off the face normal`);
    expect(angleDeg(norm(sum(m.map((c) => c.gpu.normal))), [0, 0, -1])).toBeLessThan(12);
    scene.destroy();
  });

  test('box ↔ box, an edge in a face: the edge’s samples 0.4 deep along the face normal', async () => {
    const box = boxShape(8, 8, 8);
    const scene = makeScene(g, format, [box], [bodyOf(box, 0, [0, 0, 0]), bodyOf(box, 0, [0.3, 0.37, 4 + 4 * Math.SQRT2 - 0.4], axisAngle([0, 1, 0], Math.PI / 4))], [0, 1]);
    const m = await check('box edge', scene);
    // b's edge samples in a's flat top: exact, wherever they are along the edge
    const edge = m.filter((c) => c.ref.way === 1 && c.gpu.depth > 0.3);
    // b's edge is 8 voxels long, all but its end over a
    expect(edge.length).toBeGreaterThanOrEqual(6);
    for (const c of edge.filter((x) => x.smooth)) {
      expect(Math.abs(c.gpu.depth - 0.4)).toBeLessThan(0.05);
      expect(angleDeg(c.gpu.normal, [0, 0, -1])).toBeLessThan(2);
    }
    expect(edge.filter((x) => x.smooth).length).toBeGreaterThanOrEqual(format === 'grad8' ? 3 : 5);
    // nothing pushes a up into b
    for (const c of m) expect(c.gpu.normal[2]).toBeLessThan(-0.5);
    scene.destroy();
  });

  test('box ↔ box, a corner in a face: found by the corner’s own sample, 0.5 deep along the face normal', async () => {
    const box = boxShape(8, 8, 8);
    // (1, 1, 1) turned onto z: the corner (-4, -4, -4) points straight down, 4 √3 from the centre
    const q = axisAngle([1, -1, 0], Math.acos(1 / Math.sqrt(3)));
    const scene = makeScene(g, format, [box], [bodyOf(box, 0, [0, 0, 0]), bodyOf(box, 0, [0.3, 0.2, 4 + 4 * Math.sqrt(3) - 0.5], q)], [0, 1]);
    const m = await check('box corner', scene);
    const d = deepest(m);
    expect(d.ref.way).toBe(1);
    expect(d.smooth).toBe(true);
    expect(Math.abs(d.gpu.depth - 0.5)).toBeLessThan(0.05);
    expect(angleDeg(d.gpu.normal, [0, 0, -1])).toBeLessThan(2);
    // (why both bodies give samples: a's face samples alone see nothing of this corner, or only its shallow flanks)
    const fromA = m.filter((c) => c.ref.way === 0);
    log(`${format} box corner: a's own samples give ${fromA.length} contacts, the deepest ${fromA.length ? Math.max(...fromA.map((c) => c.gpu.depth)).toFixed(3) : 'none'} (the corner is 0.5 deep)`);
    expect(fromA.every((c) => c.gpu.depth < 0.35)).toBe(true);
    scene.destroy();
  });

  test('a box resting on a tilted box: 0.2 deep along the tilted face’s normal', async () => {
    const slab = boxShape(16, 16, 4);
    const box = boxShape(6, 6, 6);
    const q = axisAngle([0, 1, 0], (20 * Math.PI) / 180);
    const up = rot(q, [0, 0, 1]);
    const at = rot(q, [1.13, 0.37, 2 + 3 - 0.2]);
    const scene = makeScene(g, format, [slab, box], [bodyOf(box, 1, [10 + at[0], 10 + at[1], 10 + at[2]], q), bodyOf(slab, 0, [10, 10, 10], q, { invMass: 0, invInertia: [0, 0, 0] })], [0, 1]);
    const m = await check('box on a tilted box', scene);
    expect(m.length).toBeGreaterThan(60);
    // the box's whole underside is on smooth ground in the slab's field (the slab's edges are far)
    const under = m.filter((c) => c.ref.way === 0);
    expect(under.length).toBeGreaterThanOrEqual(36);
    for (const c of under) {
      expect(Math.abs(c.gpu.depth - 0.2)).toBeLessThan(0.02);
      expect(angleDeg(c.gpu.normal, up)).toBeLessThan(1);
    }
    // (the slab's samples near the box's sides lean, as on any rim)
    for (const c of m) expect(angleDeg(c.gpu.normal, up)).toBeLessThan(60);
    log(`${format} box on a tilted box: the pair's mean normal ${angleDeg(norm(sum(m.map((c) => c.gpu.normal))), up).toFixed(1)}° off the face normal`);
    expect(angleDeg(norm(sum(m.map((c) => c.gpu.normal))), up)).toBeLessThan(6);
    scene.destroy();
  });

  test('an L in a notch (concave): the floor, the top and both walls, each with its own normal and depth', async () => {
    const block = notchShape(24, 20, 14, 8, 8);
    const l = lShape(16);
    // the L upside down (half a turn about y): its leg, 8 wide and 8 long, hangs from the corner at `origin` down into
    // the slot (x 8..16, floor at z 6, top at z 14); 0.2 into the floor and the top, 0.15 into the wall at x = 16, 0.15
    // clear of the wall at x = 8
    const scene = makeScene(g, format, [block, l], [placed(l, 1, [16.15, 2.13, 21.8], axisAngle([0, 1, 0], Math.PI)), placed(block, 0, [0, 0, 0], [0, 0, 0, 1], { invMass: 0, invInertia: [0, 0, 0] })], [0, 1]);
    const m = await check('L in a notch', scene);
    const family = (n: V3) => m.filter((c) => angleDeg(c.gpu.normal, n) < 5);
    const up = family([0, 0, 1]);
    const pushLeft = family([-1, 0, 0]);
    const nearRight = family([1, 0, 0]);
    log(`${format} L in a notch: ${m.length} contacts: ${up.length} up, ${pushLeft.length} off the wall at x = 16, ${nearRight.length} near the wall at x = 8, ${m.length - up.length - pushLeft.length - nearRight.length} between (the inner and outer corners)`);
    expect(up.length).toBeGreaterThan(300);
    expect(pushLeft.length).toBeGreaterThan(150);
    expect(nearRight.length).toBeGreaterThan(120);
    for (const c of up) expect(Math.abs(c.gpu.depth - 0.2)).toBeLessThan(0.06);
    for (const c of pushLeft) expect(Math.abs(c.gpu.depth - 0.15)).toBeLessThan(0.06);
    for (const c of nearRight) expect(Math.abs(c.gpu.depth + 0.15)).toBeLessThan(0.06);
    // no contact pushes the L down into the block, or pulls it into a wall it overlaps
    for (const c of m) expect(c.gpu.normal[2]).toBeGreaterThan(-0.1);
    scene.destroy();
  });

  test('a separated pair gives no contact; a gap inside the margin gives contacts with a negative depth', async () => {
    const box = boxShape(8, 8, 8);
    const ball = ballShape(12);
    // bound spheres overlap, the faces are 0.3 apart (margin 0.25)
    const scene = makeScene(g, format, [box, ball], [bodyOf(box, 0, [0, 0, 0]), bodyOf(box, 0, [2, 1, 8.3])], [0, 1]);
    let r = await scene.run();
    expect(r.chunks).toBeGreaterThan(0);
    expect(r.mirror.length).toBe(0);
    expect(r.asked).toBe(0);
    // a box turned 45° about z, its edge 0.5 from the other's face: bound spheres deep in each other
    scene.setBodies([bodyOf(box, 0, [0, 0, 0], axisAngle([0, 0, 1], Math.PI / 4)), bodyOf(box, 0, [4 * Math.SQRT2 + 0.5 + 4, 0.4, 0.7])]);
    r = await scene.run();
    expect(r.chunks).toBeGreaterThan(0);
    expect(r.mirror.length).toBe(0);
    expect(r.asked).toBe(0);
    // far apart: the bound spheres miss, not one sample is tested
    scene.setBodies([bodyOf(box, 0, [0, 0, 0]), bodyOf(box, 0, [2, 1, 30])]);
    r = await scene.run();
    expect([r.chunks, r.asked]).toEqual([0, 0]);
    // balls 0.5 apart at their nearest voxels (centres along y: both have flat voxel caps there)
    scene.setBodies([bodyOf(ball, 1, [0, 0, 0]), bodyOf(ball, 1, [0, 12.5, 0])]);
    r = await scene.run();
    expect(r.chunks).toBeGreaterThan(0);
    expect(r.asked).toBe(0);
    // boxes 0.2 apart: inside the margin
    scene.setBodies([bodyOf(box, 0, [0, 0, 0]), bodyOf(box, 0, [2.13, 1.21, 8.2])]);
    r = await scene.run();
    expect(r.asked).toBeGreaterThan(30);
    for (const c of r.contacts) {
      expect(c.depth).toBeLessThan(0);
      expect(c.depth).toBeGreaterThanOrEqual(-0.25 - 1e-3);
    }
    expect(r.contacts.filter((c) => Math.abs(c.depth + 0.2) < 0.02 && angleDeg(c.normal, [0, 0, -1]) < 1).length).toBeGreaterThan(format === 'grad8' ? 15 : 30);
    scene.destroy();
  });

  test('models at different resolutions: a quarter-cell ball on a one-cell box, a one-cell box on a half-cell slab', async () => {
    // a ball of 16 quarter-cell voxels (radius 2 cells) 0.3 into the top of an 8-cell box
    const ball = ballShape(16, 0.25);
    const box = boxShape(8, 8, 8, 1);
    const slab = boxShape(16, 16, 4, 0.5);
    const small = boxShape(4, 4, 4, 1);
    const scene = makeScene(
      g,
      format,
      [ball, box, slab, small],
      [
        bodyOf(ball, 0, [0.3, 0.4, 4 + 2 - 0.3], axisAngle([1, 0, 1], 0.4)),
        bodyOf(box, 1, [0, 0, 0]),
        // a 4-cell box turned 30° about z, 0.15 into the top of a slab 8 × 8 × 2 cells
        bodyOf(small, 3, [40.2, 0.3, 1 + 2 - 0.15], axisAngle([0, 0, 1], Math.PI / 6)),
        bodyOf(slab, 2, [40, 0, 0]),
      ],
      [0, 1, 2, 3],
    );
    const m = await check('mixed resolutions', scene);
    // the ball's fine samples in the box's coarse field: smooth ground, exact against the voxel ball
    const ballInBox = m.filter((c) => c.gpu.a === 0 && c.ref.way === 0);
    expect(ballInBox.length).toBeGreaterThan(20);
    const d = deepest(ballInBox);
    // the voxel ball's lowest voxels are within half a quarter-cell voxel of the true ball's lowest point
    expect(Math.abs(d.gpu.depth - 0.3)).toBeLessThan(0.15);
    for (const c of ballInBox) expect(angleDeg(c.gpu.normal, [0, 0, 1])).toBeLessThan(1);
    // and the box's coarse face samples in the ball's fine field
    expect(m.some((c) => c.gpu.a === 0 && c.ref.way === 1)).toBe(true);
    // the box's underside in the slab's half-cell field: smooth ground
    const onSlab = m.filter((c) => c.gpu.a === 2 && c.ref.way === 0);
    expect(onSlab.length).toBeGreaterThanOrEqual(16);
    for (const c of onSlab) {
      expect(Math.abs(c.gpu.depth - 0.15)).toBeLessThan(0.02);
      expect(angleDeg(c.gpu.normal, [0, 0, 1])).toBeLessThan(1);
    }
    scene.destroy();
  });

  test('a model baked again after voxels are removed: the contacts follow the new shape', async () => {
    const box = boxShape(8, 8, 8);
    const small = boxShape(4, 4, 4);
    // the small box 0.3 into the big one's top
    const bodies = [bodyOf(small, 1, [0.13, 0.17, 4 + 2 - 0.3]), bodyOf(box, 0, [0, 0, 0])];
    const scene = makeScene(g, format, [box, small], bodies, [0, 1]);
    let m = await check('before the bite', scene);
    let under = m.filter((c) => c.ref.way === 0);
    expect(under.length).toBeGreaterThanOrEqual(16);
    for (const c of under) expect(Math.abs(c.gpu.depth - 0.3)).toBeLessThan(0.02);
    // the big box loses its top two layers (its centre of mass kept where the body's pose has it)
    const eaten: SdfModelSpec = { ...shape([8, 8, 8], 1, (_x, _y, z) => z < 6), com: [4, 4, 4] };
    scene.store.update(scene.ids[0], eaten);
    scene.store.flush();
    scene.refs[scene.ids[0]] = refModel(eaten, format);
    const r = await scene.run();
    expect(r.mirror.length).toBe(0);
    expect(r.asked).toBe(0);
    // the small box let down two cells: on the new top
    scene.setBodies([bodyOf(small, 1, [0.13, 0.17, 2 + 2 - 0.3]), bodies[1]]);
    m = await check('after the bite', scene);
    under = m.filter((c) => c.ref.way === 0);
    expect(under.length).toBeGreaterThanOrEqual(16);
    for (const c of under) {
      expect(Math.abs(c.gpu.depth - 0.3)).toBeLessThan(0.02);
      expect(angleDeg(c.gpu.normal, [0, 0, 1])).toBeLessThan(1);
    }
    scene.destroy();
  });

  test('contacts past the buffer’s room are counted as dropped; a pair list longer than the count is not read', async () => {
    const box = boxShape(8, 8, 8);
    // (the second pair is past the count: rows that must not be tested)
    const scene = makeScene(g, format, [box], [bodyOf(box, 0, [0, 0, 0]), bodyOf(box, 0, [2.13, 1.21, 7.7])], [0, 1, 0, 1], { maxContacts: 16, maxPairs: 4 });
    g.device.queue.writeBuffer(scene.inputs.pairCount, 0, new Uint32Array([1]));
    const r = await scene.run();
    const want = r.mirror.length / 2;
    expect(want).toBeGreaterThan(60);
    expect(Math.abs(r.asked - want)).toBeLessThanOrEqual(1);
    expect(r.dropped).toBe(r.asked - 16);
    expect(r.contacts.length).toBe(16);
    scene.destroy();
  });

  test('the sample cap: a big body tests at most `cap` samples a pass, and over the ticks every sample has its turn', async () => {
    const ball = ballShape(16);
    const a = bodyOf(ball, 0, [0, 0, 0]);
    const b = bodyOf(ball, 0, [0.2, 0.3, 14.6]);
    const key = (c: { point: number[] }) => c.point.map((v) => v.toFixed(2)).join();
    const full = makeScene(g, format, [ball], [a, b], [0, 1]);
    const all = await full.run();
    const count = full.refs[0].samples.length;
    full.destroy();
    const cap = 128;
    const scene = makeScene(g, format, [ball], [a, b], [0, 1], { cap });
    const seen = new Set<string>();
    const stride = Math.ceil(count / cap);
    let most = 0;
    for (let tick = 0; tick < stride; tick++) {
      const r = await scene.run(tick);
      // two half pairs of `cap` samples in chunks of 64
      expect(r.chunks).toBe(2 * Math.ceil(cap / 64));
      most = Math.max(most, r.asked);
      for (const c of r.contacts) seen.add(key(c));
    }
    log(`${format} cap ${cap} of ${count} samples: at most ${most} contacts a pass, ${seen.size} different contacts over ${stride} ticks; uncapped ${all.asked}`);
    expect(most).toBeLessThan(all.asked);
    expect(most).toBeGreaterThan(0);
    // every sample tested once in ceil(count / cap) ticks: the same contacts as the uncapped pass
    expect([...seen].sort()).toEqual([...new Set(all.contacts.map(key))].sort());
    scene.destroy();
  });
});

function sum(v: readonly (readonly number[])[]): V3 {
  return v.reduce<V3>((s, x) => [s[0] + x[0], s[1] + x[1], s[2] + x[2]], [0, 0, 0]);
}
function norm(v: V3): V3 {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}
