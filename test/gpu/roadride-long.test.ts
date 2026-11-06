// (round 128l, m4fix; BACKLOG M4-14; round 128o, DA-A7: kinematic trips) A rider on a long edge rides it to the end. The
// steering ride had a "lost" rule (over 8 m from the node it headed for) that threw riders off 8.2 m edges; a trip is
// placed along its edges at its kind's speed, so a 12 m edge is 12 m of riding: no rule to be lost by.
import { describe, expect, test } from 'vitest';
import { RoadRide } from '../../src/agents/ride';
import { graphOf } from '../../src/agents/roadgraph';
import { testGpu } from './dawn';
import { globalsWithDt } from './ride-globals';

const W = 64;
const H = 64;
const UNITS = 4;
const SPEED = 2.4;
const DT = 1 / 60;

describe('riding a long edge', () => {
  test('a rider on a road of 4 m and two 12 m edges arrives at the end in their length at its speed', async () => {
    const g = await testGpu();
    const dev = g.device;
    // a straight road east: nodes 4 m, then 12 m, then 12 m apart
    const y = 20;
    const xs = [10, 14, 26, 38];
    const graph = graphOf(xs.slice(1).map((x, i) => ({ a: [xs[i], y] as const, b: [x, y] as const, cell: i, cost: 1 })));
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const units = dev.createBuffer({ size: UNITS * 5 * 16, usage: S });
    const roads = dev.createBuffer({ size: Math.ceil((W * H) / 32) * 8, usage: S });
    const ride = new RoadRide(dev, globalsWithDt(dev, DT), units, roads, W, UNITS);
    ride.setKindSpeed(0, SPEED);
    ride.setGraph(graph, 0, 0);
    expect(ride.setGoals(3, [[38, y]])).toBe(true);
    // a rider of group 3 on the road's first node, walking (state chase)
    const rec = new Float32Array(20);
    const u = new Uint32Array(rec.buffer);
    rec.set([10, y, 5], 0);
    u[3] = 3 | (1 << 8) | (1 << 12);
    dev.queue.writeBuffer(units, 0, rec);
    const run = async (n: number) => {
      const e = dev.createCommandEncoder();
      ride.encodeHops(e, 1);
      for (let k = 0; k < n; k++) {
        const pass = e.beginComputePass();
        ride.encode(pass, 1);
        pass.end();
      }
      dev.queue.submit([e.finish()]);
      return new Float32Array(await g.read(units, 80));
    };
    // (on the road's band from the first tick: its trip starts there)
    const ticks = Math.ceil(28 / (SPEED * DT));
    let out = await run(ticks - 2);
    // (riding still, well into the 12 m edges — east along the road, on its line)
    expect(out[19]).toBe(-2);
    expect(out[1]).toBeCloseTo(y, 4);
    expect(out[0]).toBeGreaterThan(30);
    out = await run(4);
    expect(out[19]).toBe(-1);
    expect(out[0]).toBeCloseTo(38, 3);
    expect(g.takeErrors()).toEqual([]);
  });
});
