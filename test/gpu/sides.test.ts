// (U2 round 7, docs/design/UNIT_MINDS_U2.md §9e) Three armies, each its own hunt and threat field (Agents.sideFields)
// and a side relation matrix (notice.relations: A takes on B, B on C, C on A). Each army's targets are its enemy's
// units, its hunt field is seeded at those targets only (0 there, far at the third army), and its threat field at its
// own fighters. The pages each field holds follow its army's ground.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';
import { cellPos } from '../../src/world/lattice';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 128;
const H = 128;
const UF = 24;
const slotOf = (id: number) => id % 8192;

test('three armies: per-side hunt and threat fields, the relation matrix picking each one\'s enemy', async () => {
  const map = tinyMap(W, H, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  agents.keepInScope('test', [cellPos(0, 0), cellPos(W - 1, H - 1)]);
  agents.notice.setRules({ on: false, open: false, heightLimit: 1.6, leash: 1000 });
  // (A takes on B, B on C, C on A)
  agents.notice.relations((a, b) => b === (a + 1) % 3);
  const at = [cellPos(20, 64), cellPos(64, 30), cellPos(108, 64)];
  const fields = [0, 1, 2].map((s) => {
    const hunt = agents.newField()!;
    const threat = agents.newField()!;
    agents.sideFields(s, { hunt, threat });
    agents.follow(3 + s, hunt);
    return { hunt, threat };
  });
  const army: number[][] = [[], [], []];
  for (let s = 0; s < 3; s++)
    for (let i = 0; i < 12; i++) {
      const id = agents.spawn(1, at[s][0] + (i % 4) * 1.5, at[s][1] + Math.floor(i / 4) * 1.5, { kind: 1, group: 3 + s, spread: 0 })[0];
      army[s].push(id);
    }
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (st) => st.name === 'surface' || st.name === 'agents');
  };
  frame(5);
  for (let s = 0; s < 3; s++) for (const id of army[s]) agents.notice.set(slotOf(id), { faction: s, hostile: true, sight: 200 });
  frame(12);
  await g.device.queue.onSubmittedWorkDone();
  const u = new Float32Array(await agents.readRaw('units'));
  const uw = new Uint32Array(u.buffer);
  const sideOf = new Map<number, number>();
  army.forEach((ids, s) => ids.forEach((id) => sideOf.set(slotOf(id), s)));
  // (each unit's target: of the side it takes on)
  let targeted = 0;
  for (let s = 0; s < 3; s++)
    for (const id of army[s]) {
      const t = uw[slotOf(id) * UF + 21];
      if (!t || t & 0x80000000) continue;
      targeted++;
      expect(sideOf.get((t - 1) % 8192), `side ${s}'s unit targets`).toBe((s + 1) % 3);
    }
  expect(targeted).toBeGreaterThan(18);
  const mean = (ids: number[]): [number, number] => {
    let x = 0;
    let y = 0;
    for (const id of ids) {
      x += u[slotOf(id) * UF];
      y += u[slotOf(id) * UF + 1];
    }
    return [x / ids.length, y / ids.length];
  };
  for (let s = 0; s < 3; s++) {
    const hunt = agents.reader(fields[s].hunt);
    await hunt.refresh();
    const threat = agents.reader(fields[s].threat);
    await threat.refresh();
    const prey = mean(army[(s + 1) % 3]);
    const other = mean(army[(s + 2) % 3]);
    const own = mean(army[s]);
    const dPrey = hunt.sample(prey[0], prey[1])?.dist ?? Infinity;
    const dOther = hunt.sample(other[0], other[1])?.dist ?? Infinity;
    const tOwn = threat.sample(own[0], own[1])?.dist ?? Infinity;
    // (its hunt field falls to its prey, not to the third army; its threat field sits on itself)
    expect(dPrey, `side ${s} hunt at its prey`).toBeLessThan(4);
    expect(dOther, `side ${s} hunt at the third army`).toBeGreaterThan(dPrey + 10);
    expect(tOwn, `side ${s} threat on itself`).toBeLessThan(4);
  }
  const st = await agents.fields.stats();
  expect(st.refused).toBe(0);
  expect(g.takeErrors()).toEqual([]);
});
