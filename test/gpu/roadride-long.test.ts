// (round 128l, m4fix; BACKLOG M4-14) A rider on an edge longer than the ride's LOST stays on it. The rule was "lost: over
// 8 m from the node it heads for", so turning at a node onto a longer edge (the lanes have 8.2 m edges on open ground:
// the lab's road to its farms) was lost at once — off, joined again at the node behind, back the way it came; the
// farms' carts never left the stores. Now lost is past the longest edge at that node by LOST (shaders/roadride.wgsl).
import { describe, expect, test } from 'vitest';
import { RoadRide } from '../../src/agents/ride';
import { graphOf } from '../../src/agents/roadgraph';
import { testGpu } from './dawn';

const W = 64;
const H = 64;
const UNITS = 4;

describe('riding a long edge', () => {
  test('a rider turned onto a 12 m edge stays on it to the next node', async () => {
    const g = await testGpu();
    const dev = g.device;
    // a straight road east: nodes 4 m, then 12 m, then 12 m apart
    const y = 20;
    const xs = [10, 14, 26, 38];
    const graph = graphOf(xs.slice(1).map((x, i) => ({ a: [xs[i], y] as const, b: [x, y] as const, cell: i, cost: 1 })));
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const units = dev.createBuffer({ size: UNITS * 5 * 16, usage: S });
    const roads = dev.createBuffer({ size: Math.ceil((W * H) / 32) * 8, usage: S });
    const ride = new RoadRide(dev, units, roads, W, UNITS);
    ride.setGraph(graph, 0, 0);
    expect(ride.setGoals(3, [[38, y]])).toBe(true);
    // a rider of group 3 at the node 14, walking (state chase); its next node is 12 m east
    const rec = new Float32Array(20);
    const u = new Uint32Array(rec.buffer);
    rec.set([14.1, y, 5], 0);
    u[3] = 3 | (1 << 8) | (1 << 12);
    dev.queue.writeBuffer(units, 0, rec);
    const state = (ride as unknown as { state: GPUBuffer }).state;
    const tick = async () => {
      const e = dev.createCommandEncoder();
      ride.encodeHops(e, 1);
      const pass = e.beginComputePass();
      ride.encode(pass, 1);
      pass.end();
      dev.queue.submit([e.finish()]);
      return new Uint32Array(await g.read(state, 16));
    };
    // (it joins, and at the node heads on: the next node is the one 12 m east)
    let st = await tick();
    st = await tick();
    expect(st[0]).toBe(1);
    const next = st[1];
    expect(graph.xy[next * 2]).toBeCloseTo(26, 3);
    // a few ticks on, still riding (before: off at once — 11.9 m from its node, over LOST's 8)
    for (let i = 0; i < 3; i++) st = await tick();
    expect(st[0]).toBe(1);
    expect(st[1]).toBe(next);
    expect(g.takeErrors()).toEqual([]);
  });
});
