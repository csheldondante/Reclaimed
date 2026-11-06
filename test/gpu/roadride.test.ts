// (round 128i, V128-14; round 128o, DA-A7: kinematic trips) The agents ride the roads on the GPU (agents/ride.ts,
// shaders/roadride.wgsl): the next-hop tables made on the GPU equal the CPU's (roadgraph.ts hopsCpu) on a fortress's
// lanes and roads; a unit standing on a road starts a trip and is placed along the route at its kind's speed, node to
// node, to its goal, where it stands, arriving when the route's length at that speed says; a unit of a group that doesn't
// ride is left to its field.
import { describe, expect, test } from 'vitest';
import { RoadRide } from '../../src/agents/ride';
import { edgeCost, hopsCpu, MAX_NODES, nearestNode, nodeCount } from '../../src/agents/roadgraph';
import { packRoadShapes, roadBitsCpu } from '../../src/agents/roads';
import { fortressOn } from '../../src/fortress/testing';
import { laneGraph, roadShapesOf } from '../../src/build/lanes';
import { testGpu } from './dawn';
import { globalsWithDt } from './ride-globals';

/** a tick's seconds */
const DT = 1 / 60;
/** the riders' kind's speed (m/s) */
const SPEED = 2.4;

const W = 160;
const H = 184;
const UNITS = 64;

function town() {
  const f = fortressOn({ origin: [0, 0], w: W, h: H }, { windowOrigin: () => [0, 0], dims: { w: W, h: H, zMax: 999 }, ground: () => 5, stores: () => ({}), townHeap: () => [14, ((H / 2) * Math.sqrt(3)) / 2] });
  f.ready = true;
  const [cx, cy] = [W / 2, ((H / 2) * Math.sqrt(3)) / 2];
  const ring = f.ringCells(cx, cy, 22);
  for (const c of ring) f.paint(c, 0, 'wall');
  [...ring].sort((a, b) => f.centre(b)[0] - f.centre(a)[0]).find((c) => f.setGate(c, true));
  f.paint(f.cellAt(cx, cy), 0, 'fortress');
  f.paint(f.cellAt(cx - 10, cy + 6), 0, 'house');
  f.paint(f.cellAt(cx + 4, cy - 12), 0, 'warehouse');
  f.paint(f.cellAt(cx + 36, cy), 0, 'farm');
  return f;
}

describe('the agents ride the roads on the GPU', () => {
  test('the hop tables equal the CPU rule; a rider is placed along its route at its speed and stands at its goal', async () => {
    const g = await testGpu();
    const dev = g.device;
    const f = town();
    const L = f.lanes();
    const graph = laneGraph(L);
    const n = nodeCount(graph);
    expect(n).toBeGreaterThan(20);
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const units = dev.createBuffer({ size: UNITS * 5 * 16, usage: S });
    const words = Math.ceil((W * H) / 32);
    // (two planes: the road shapes' bits, then the network's — made by the ride)
    const roads = dev.createBuffer({ size: words * 8, usage: S });
    dev.queue.writeBuffer(roads, 0, roadBitsCpu(packRoadShapes(roadShapesOf(L, f.ways(), f.grid)), 0, 0, W, H));
    const ride = new RoadRide(dev, globalsWithDt(dev, DT), units, roads, W, UNITS);
    ride.setKindSpeed(0, SPEED);
    ride.setGraph(graph, 0, 0);
    // the doors: group 3 to the warehouse's and the house's
    const doors = f.ways().doors.map((d) => {
      const [ax, ay] = f.grid.corner(d.out, [0, 1, 2, 3].find((e) => f.grid.nbr[d.out * 4 + e] === d.cell)!);
      const [bx, by] = f.grid.corner(d.out, [0, 1, 2, 3].find((e) => f.grid.nbr[d.out * 4 + e] === d.cell)! + 1);
      return [(ax + bx) / 2, (ay + by) / 2] as [number, number];
    });
    const goals = doors.slice(0, 2);
    expect(ride.setGoals(3, goals)).toBe(true);
    // (no roads near: it doesn't ride)
    expect(ride.setGoals(5, [[-500, -500]])).toBe(false);
    const enc = dev.createCommandEncoder();
    ride.encodeHops(enc, UNITS);
    dev.queue.submit([enc.finish()]);
    const hops = new Uint32Array(await g.read(ride.hopsBuffer, 2 * MAX_NODES * 8));
    const hf = new Float32Array(hops.buffer);
    const dests = goals.map((p) => nearestNode(graph, p[0], p[1]).node);
    const cpu = hopsCpu(graph, dests);
    let reachedNodes = 0;
    for (let s = 0; s < dests.length; s++)
      for (let v = 0; v < n; v++) {
        const gd = hf[(s * MAX_NODES + v) * 2];
        const cd = cpu.dist[s][v];
        if (cd >= 1e9) expect(gd).toBeGreaterThanOrEqual(1e9);
        else {
          reachedNodes++;
          expect(Math.abs(gd - cd)).toBeLessThan(1e-2 * Math.max(1, cd));
          // (the next node: one the same cost on, as the CPU's may differ on a tie)
          const nx = hops[(s * MAX_NODES + v) * 2 + 1];
          if (v === dests[s]) expect(nx).toBe(v);
          else {
            let k = graph.start[v];
            while (graph.adj[k * 2] !== nx) k++;
            expect(k).toBeLessThan(graph.start[v] + graph.count[v]);
            expect(Math.abs(cpu.dist[s][nx] + edgeCost(graph, k) - cd)).toBeLessThan(1e-2 * Math.max(1, cd));
          }
        }
      }
    // (most of the network leads to the doors)
    expect(reachedNodes / (n * dests.length)).toBeGreaterThan(0.6);
    // the network's plane: the columns along the edges that lead to a goal — every node reached has its column marked,
    // and none of a node no goal is reached from
    const bits = new Uint32Array(await g.read(roads, words * 8));
    const netAt = (x: number, y: number) => {
      const r = Math.round(y / (Math.sqrt(3) / 2) - 0.5);
      const c = Math.round(x - 0.5 - 0.5 * (r & 1));
      let best = -1;
      let bd = 1e9;
      for (const [dc, dr] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const cc = c + dc;
        const rr = r + dr;
        const d = Math.hypot(cc + 0.5 + 0.5 * (rr & 1) - x, (rr + 0.5) * (Math.sqrt(3) / 2) - y);
        if (d < bd) {
          bd = d;
          best = rr * W + cc;
        }
      }
      return (bits[words + (best >> 5)] >>> (best & 31)) & 1;
    };
    let marked = 0;
    let unreached = 0;
    for (let v = 0; v < n; v++) {
      const on = cpu.dist.some((D) => D[v] < 1e9);
      if (on) marked += netAt(graph.xy[v * 2], graph.xy[v * 2 + 1]);
      else if (graph.count[v] > 0 && !cpu.dist.some((D) => D[v] < 1e9)) unreached++;
    }
    expect(marked).toBe([...Array(n).keys()].filter((v) => cpu.dist.some((D) => D[v] < 1e9)).length);
    // (round 128k: the roads are one tree from the town's gate — every node reached)
    expect(unreached).toBe(0);
    for (let v = 0; v < n; v++) {
      if (cpu.dist.some((D) => D[v] < 1e9)) continue;
      // (a node off the network more than a band from every network edge: unmarked)
      const x = graph.xy[v * 2];
      const y = graph.xy[v * 2 + 1];
      let near = false;
      for (let a = 0; a < n && !near; a++) {
        if (!cpu.dist.some((D) => D[a] < 1e9)) continue;
        for (let k = graph.start[a]; k < graph.start[a] + graph.count[a] && !near; k++) {
          const b = graph.adj[k * 2];
          const ax = graph.xy[a * 2];
          const ay = graph.xy[a * 2 + 1];
          const dx = graph.xy[b * 2] - ax;
          const dy = graph.xy[b * 2 + 1] - ay;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
          near = Math.hypot(ax + dx * t - x, ay + dy * t - y) < 3;
        }
      }
      if (!near) expect(netAt(x, y)).toBe(0);
    }

    // units: 0 on a road node far from the goals (it rides), 1 in a group that doesn't ride
    const far = [...Array(n).keys()].filter((v) => cpu.dist[0][v] < 1e9 && cpu.dist[0][v] > 15 && Math.min(...goals.map((p) => Math.hypot(p[0] - graph.xy[v * 2], p[1] - graph.xy[v * 2 + 1]))) > 8)[0];
    expect(far).toBeDefined();
    const rec = (x: number, y: number, grp: number) => {
      const r = new Float32Array(20);
      const u = new Uint32Array(r.buffer);
      r.set([x, y, 5], 0);
      // group | alive | kind 0 | state chase (1)
      u[3] = grp | (1 << 8) | (1 << 12);
      return r;
    };
    const fx = graph.xy[far * 2];
    const fy = graph.xy[far * 2 + 1];
    dev.queue.writeBuffer(units, 0, rec(fx, fy, 3));
    dev.queue.writeBuffer(units, 80, rec(fx, fy, 7));
    const tick = async (n: number) => {
      const e = dev.createCommandEncoder();
      ride.encodeHops(e, 2);
      for (let k = 0; k < n; k++) {
        const pass = e.beginComputePass();
        ride.encode(pass, 2);
        pass.end();
      }
      dev.queue.submit([e.finish()]);
      return new Float32Array(await g.read(units, 2 * 80));
    };
    // (its route: the table's, from its node to whichever goal is cheaper — the length it rides, then the last stretch)
    const best = cpu.dist[0][far] <= cpu.dist[1][far] ? 0 : 1;
    let len = 0;
    for (let v = far; v !== dests[best]; ) {
      const nx = cpu.next[best][v];
      len += Math.hypot(graph.xy[nx * 2] - graph.xy[v * 2], graph.xy[nx * 2 + 1] - graph.xy[v * 2 + 1]);
      v = nx;
    }
    len += Math.hypot(goals[best][0] - graph.xy[dests[best] * 2], goals[best][1] - graph.xy[dests[best] * 2 + 1]);
    let out = await tick(1);
    const steer = (i: number) => out[i * 20 + 19];
    // (0: on a trip — placed, not steered: a tick's way along its first edge)
    expect(steer(0)).toBe(-2);
    expect(Math.hypot(out[0] - fx, out[1] - fy)).toBeCloseTo(SPEED * DT, 3);
    // (1: not riding — its field)
    expect(steer(1)).toBe(0);
    // (at its goal when the route's length at its speed says, give or take a tick: standing there)
    const ticks = Math.ceil(len / (SPEED * DT));
    out = await tick(ticks - 2);
    expect(steer(0)).toBe(-2);
    out = await tick(3);
    expect(steer(0)).toBe(-1);
    expect(Math.hypot(out[0] - goals[best][0], out[1] - goals[best][1])).toBeLessThan(1e-3);
    expect(g.takeErrors()).toEqual([]);
  });
});
