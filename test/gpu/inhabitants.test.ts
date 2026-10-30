// The inhabitants' kernels on a tiny world (round 117, docs/INHABITANTS.md): inhabitants.wgsl's behaviour, animation
// and mesh through the real WorldCore on Dawn, read back through InhabitantsGpu.probe. What a player would see, as
// numbers: feet on the ground, legs that keep their length, a herd that bolts from a wolf, the wind knocking a deer
// over, townsfolk on their paths, a mesh with every creature's vertices.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { installInhabitants } from '../../src/inhabitants/install';
import type { InhabitantsGpu } from '../../src/inhabitants/system';
import { SPECIES } from '../../src/inhabitants/species';
import { Role } from '../../src/inhabitants/rig';
import { standInPaths } from '../../src/inhabitants/paths';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 64;
const GROUND = 10;

async function world(slope = 0): Promise<{ w: TinyWorld; life: InhabitantsGpu; step: (n: number, dt?: number) => Promise<void> }> {
  // flat stone at 10, or rising `slope` cells a column along x
  const map = tinyMap(W, W, 48, (x) => [{ z0: 0, z1: GROUND + Math.floor(x * slope), mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const life = installInhabitants(w.core, { maxAgents: 256, maxVerts: 200_000 });
  const step = async (n: number, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      life.update(dt);
      w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'inhabitants');
    }
    await g.device.queue.onSubmittedWorkDone();
  };
  return { w, life, step };
}

const P = (pose: number[], k: number): [number, number, number] => [pose[k * 8], pose[k * 8 + 1], pose[k * 8 + 2]];
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('a walking deer: it moves, its feet stay on the ground or lift a little, its legs keep their length', async () => {
  const { w, life, step } = await world();
  const deer = life.define(SPECIES.deer);
  const rig = life.rig(deer);
  const gid = life.spawnGroup(deer, [32, 28], 1, { spread: 0 });
  life.drive(gid, { kind: 'pace', gait: 'walk', around: [32, 24], radius: 6 });
  await step(30);
  const a = await life.probe(0, 0);
  const feet = rig.points.map((p, i) => (p.role === Role.Foot ? i : -1)).filter((i) => i >= 0);
  const knees = rig.points.map((p, i) => (p.role === Role.Knee ? i : -1)).filter((i) => i >= 0);
  let maxLift = 0;
  let minFoot = Infinity;
  let worstLeg = 0;
  let last = a;
  for (let t = 0; t < 20; t++) {
    await step(6);
    const s = await life.probe(0, 0);
    const full = await probePose(life, 0, rig.points.length);
    feet.forEach((f) => {
      const z = full[f * 8 + 2] - GROUND;
      maxLift = Math.max(maxLift, z);
      minFoot = Math.min(minFoot, z);
    });
    for (const kn of knees) {
      const hip = rig.points[kn].parent;
      const l1 = rig.points[kn].p[1];
      const e = Math.abs(dist(P(full, kn), P(full, hip)) - l1) / l1;
      worstLeg = Math.max(worstLeg, e);
    }
    last = s;
  }
  expect(g.takeErrors()).toEqual([]);
  const moved = Math.hypot(last.agent[0] - a.agent[0], last.agent[1] - a.agent[1]);
  expect(moved).toBeGreaterThan(2);
  // feet: never under the ground, never higher than a step's lift (and they do lift: it walks)
  expect(minFoot).toBeGreaterThan(-0.05);
  expect(maxLift).toBeLessThan(rig.lift * 2.5 + 0.05);
  expect(maxLift).toBeGreaterThan(0.02);
  // the IK keeps the upper leg its length
  expect(worstLeg).toBeLessThan(0.02);
  // the body stands at its height over the ground
  const root = (await probePose(life, 0, 1)).slice(0, 3);
  expect(root[2] - GROUND).toBeGreaterThan(rig.height * 0.8);
  expect(root[2] - GROUND).toBeLessThan(rig.height * 1.2);
  w.destroy();
});

test('on a slope the feet follow the ground', async () => {
  const { w, life, step } = await world(0.25);
  const deer = life.define(SPECIES.deer);
  const rig = life.rig(deer);
  const gid = life.spawnGroup(deer, [30, 28], 1, { spread: 0 });
  life.drive(gid, { kind: 'pace', gait: 'walk', around: [30, 24], radius: 5 });
  await step(120);
  const full = await probePose(life, 0, rig.points.length);
  rig.points.forEach((p, i) => {
    if (p.role !== Role.Foot) return;
    const x = full[i * 8];
    const ground = GROUND + Math.floor(Math.round(x - 0.5 * 0) * 0.25);
    // within a cell's step of the column under it (the hex lattice's rows shift x by half)
    expect(Math.abs(full[i * 8 + 2] - ground)).toBeLessThan(1.6);
  });
  expect(g.takeErrors()).toEqual([]);
  w.destroy();
});

test('a herd bolts from a wolf that comes close', async () => {
  const { w, life, step } = await world();
  const deer = life.define(SPECIES.deer);
  const wolf = life.define(SPECIES.wolf);
  const herd = life.spawnGroup(deer, [24, 28], 6, { spread: 3 });
  life.drive(herd, { kind: 'roam', around: [24, 28], radius: 14 });
  await step(60);
  const calm = await states(life, 6);
  expect(calm.filter((s) => s === 2).length).toBe(0);
  // a wolf running at them from 6 cells
  const pack = life.spawnGroup(wolf, [30, 28], 1, { spread: 0 });
  life.drive(pack, { kind: 'pace', gait: 'run', around: [24, 28], radius: 1 });
  await step(30);
  const alarmed = await states(life, 6);
  expect(alarmed.filter((s) => s === 2).length).toBeGreaterThanOrEqual(3);
  expect(g.takeErrors()).toEqual([]);
  w.destroy();
});

test('a strong wind knocks a deer down; it gets up after', async () => {
  const { w, life, step } = await world();
  const deer = life.define(SPECIES.deer);
  life.spawnGroup(deer, [32, 28], 1, { spread: 0 });
  await step(10);
  w.core.globals.windX = 40;
  // (the wind texture is the wind system's: step it too while the gale blows)
  for (let i = 0; i < 30; i++) {
    life.update(1 / 60);
    w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'inhabitants' || s.name === 'windfield');
  }
  await g.device.queue.onSubmittedWorkDone();
  expect((await states(life, 1))[0]).toBe(6);
  w.core.globals.windX = 0;
  for (let i = 0; i < 300; i++) {
    life.update(1 / 60);
    w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'inhabitants' || s.name === 'windfield');
  }
  await g.device.queue.onSubmittedWorkDone();
  expect((await states(life, 1))[0]).not.toBe(6);
  expect(g.takeErrors()).toEqual([]);
  w.destroy();
});

test('townsfolk walk the paths: on the stairs, the rampart and the lane', async () => {
  const { w, life, step } = await world();
  const paths = standInPaths([32, 28], () => GROUND, { radius: 12, towerH: 6 });
  life.setPaths(paths);
  const tf = life.define(SPECIES.townsfolk);
  const gid = life.spawnGroup(tf, [32, 28], 6);
  life.drive(gid, { kind: 'paths' });
  let up = 0;
  for (let t = 0; t < 30; t++) {
    await step(20);
    for (let i = 0; i < 6; i++) {
      const a = (await life.probe(i, 0)).agent;
      // on some edge of the graph (within a little of its segment)
      let best = Infinity;
      for (const e of paths.edges) {
        const A = paths.nodes[e.a].at;
        const B = paths.nodes[e.b].at;
        const az = A[2] ?? GROUND;
        const bz = B[2] ?? GROUND;
        best = Math.min(best, segDist([a[0], a[1], a[2]], [A[0], A[1], az], [B[0], B[1], bz]));
      }
      expect(best).toBeLessThan(0.3);
      if (a[2] > GROUND + 2) up++;
    }
  }
  // some went up the tower
  expect(up).toBeGreaterThan(0);
  expect(g.takeErrors()).toEqual([]);
  w.destroy();
});

test('the mesh holds every creature in view: vertices a creature × count, all finite', async () => {
  const { w, life, step } = await world();
  const deer = life.define(SPECIES.deer);
  const crow = life.define(SPECIES.crow);
  life.spawnGroup(deer, [30, 28], 4);
  life.spawnGroup(crow, [34, 28], 5);
  life.focus = [32, 28];
  life.focusR = 100;
  await step(20);
  const pr = await life.probe(0, 64);
  expect(pr.args[0]).toBe(4 * life.rig(deer).vertsPerAgent + 5 * life.rig(crow).vertsPerAgent);
  expect(pr.args[1]).toBe(1);
  expect(pr.verts.every(Number.isFinite)).toBe(true);
  // the far LOD: a bone's 24 vertices, not 48
  life.lod = 1;
  await step(1);
  const far = (r: ReturnType<InhabitantsGpu['rig']>) => 6 + r.segments.filter((x) => x.kind === 'bone').length * 24 + r.segments.filter((x) => x.kind === 'tri').length * 3;
  expect((await life.probe(0, 0)).args[0]).toBe(4 * far(life.rig(deer)) + 5 * far(life.rig(crow)));
  life.lod = 0;
  // out of the focus: none
  life.focus = [500, 500];
  life.focusR = 10;
  await step(1);
  expect((await life.probe(0, 0)).args[0]).toBe(0);
  expect(g.takeErrors()).toEqual([]);
  w.destroy();
});

test('the window slides: creatures and their bodies move with it', async () => {
  const { w, life, step } = await world();
  const deer = life.define(SPECIES.deer);
  life.spawnGroup(deer, [32, 28], 1, { spread: 0 });
  await step(10);
  const a = await life.probe(0, 0);
  life.shift(-5, 3, 0);
  await step(1);
  const b = await life.probe(0, 0);
  // (the window moved by (-5, 3): what's in it by (5, -3))
  expect(b.agent[0] - a.agent[0]).toBeCloseTo(5, 0);
  expect(b.agent[1] - a.agent[1]).toBeCloseTo(-3, 0);
  expect(b.pose[0] - a.pose[0]).toBeCloseTo(5, 0);
  expect(g.takeErrors()).toEqual([]);
  w.destroy();
});

test('presence: a wolf pack reads as threat where it is', async () => {
  const { w, life, step } = await world();
  const wolf = life.define(SPECIES.wolf);
  life.spawnGroup(wolf, [40, 40], 3, { spread: 1 });
  await step(30);
  const p = life.presence({ x0: 0, y0: 0, x1: 64, y1: 64 }, 16);
  const i = Math.floor(40 / 16) + Math.floor(40 / 16) * p.nx;
  const total = p.threat.reduce((a, b) => a + b, 0);
  expect(total).toBeCloseTo(3 * 0.8, 1);
  expect(p.threat[i]).toBeGreaterThan(total * 0.3);
  w.destroy();
});

async function states(life: InhabitantsGpu, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await life.probe(i, 0)).agent[9]);
  return out;
}

async function probePose(life: InhabitantsGpu, slot: number, points: number): Promise<number[]> {
  return (await life.probe(slot, 0, points)).pose;
}

function segDist(p: number[], a: number[], b: number[]): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = l2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

test('a hunt: the wolves stalk in low, sprint, and the herd scatters away from them', async () => {
  const { w, life, step } = await world();
  const deer = life.define(SPECIES.deer);
  const wolf = life.define(SPECIES.wolf);
  const herd = life.spawnGroup(deer, [20, 28], 8, { spread: 3 });
  life.drive(herd, { kind: 'roam', around: [20, 28], radius: 6 });
  const pack = life.spawnGroup(wolf, [50, 30], 2, { spread: 1 });
  life.drive(pack, { kind: 'roam', around: [50, 30], radius: 4 });
  const seen = new Set<number>();
  const log: string[] = [];
  let caught = false;
  let fled = 0;
  for (let t = 0; t < 70; t++) {
    await step(15);
    const ws = await life.probe(8, 0);
    seen.add(ws.agent[9]);
    let dmin = Infinity;
    const st: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (await life.probe(i, 0)).agent;
      dmin = Math.min(dmin, Math.hypot(a[0] - ws.agent[0], a[1] - ws.agent[1]));
      st.push(a[9]);
    }
    if (st.includes(6)) caught = true;
    // the standing deer's mean distance from the wolf
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 8; i++) {
      const a = (await life.probe(i, 0)).agent;
      if (a[9] !== 6) (sum += Math.hypot(a[0] - ws.agent[0], a[1] - ws.agent[1])), n++;
    }
    fled = n ? sum / n : 0;
    if (process.env.LIFE_LOG) log.push(`${t}: wolf ${ws.agent[9]} at ${ws.agent[0].toFixed(1)},${ws.agent[1].toFixed(1)} nearest deer ${dmin.toFixed(1)} deer ${st.join('')}`);
  }
  if (process.env.LIFE_LOG) console.log(log.join('\n'));
  // it stalked (3) and sprinted (2)
  expect(seen.has(3)).toBe(true);
  expect(seen.has(2)).toBe(true);
  // one was caught (knocked down: the hunt's end reads), the rest got well away
  expect(caught).toBe(true);
  expect(fled).toBeGreaterThan(10);
  expect(g.takeErrors()).toEqual([]);
  w.destroy();
});
