// The collapse judges' perf battery (round 120, the user: "Performance batteries and feel tests so I can see what is
// improved vs the cost"), in Node on Dawn — opt-in (JUDGE_PERF=1: it takes a minute). A judging of each scene, five
// times, the median:
//   A (runs)      the CPU's readback of the window's columns (what Integrity reads before it judges: the slots of the
//                 window's chunks, copied and mapped) + analyseRock's CPU ms
//   B (sections)  its GPU ms (timestamp queries round its one compute pass) and its wall ms (submit → verdict mapped)
// Scenes: the shapes (an arch cut at a foot, a dome, a 3-thick shelf reaching 16, the mid-span neck, a spire undercut),
// two big real cuts (a mesa 40 across undercut on one side; a cliff 120 long whose 4-thick shelf reaching 20 lets go),
// and scaling: 10, 50, 200 pillars with arms at once. Written to data/perf/judge/node-<adapter>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { RunsJudge, SectionsJudge, type RockJudge } from '../../src/game/judge';
import { cellPos } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';
import type { Interval } from '../../src/world/layout';
import { RockWorld } from '../support/rockworld';
import { gpuCols, judgeWorld } from '../support/judgeworld';
import { testGpu } from './dawn';

const G = 10;

function world(W: number, extra: (x: number, y: number) => [number, number][]): RockWorld {
  return new RockWorld(W, W, 64, (x, y) => {
    const col: Interval[] = [{ z0: 0, z1: G, mat: MAT.Stone }];
    for (const [z0, z1] of extra(x, y).sort((a, b) => a[0] - b[0])) {
      const last = col[col.length - 1];
      if (z0 <= last.z1 + 1e-6) last.z1 = Math.max(last.z1, z1);
      else col.push({ z0, z1, mat: MAT.Stone });
    }
    return col;
  });
}
const dist = (x: number, y: number, cx: number, cy: number) => {
  const [px, py] = cellPos(x, y);
  const [qx, qy] = cellPos(cx, cy);
  return Math.hypot(px - qx, py - qy);
};
const box = (x0: number, y0: number, x1: number, y1: number) => {
  const o: [number, number][] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) o.push([x, y]);
  return o;
};

interface Scene {
  name: string;
  make: () => RockWorld;
  /** the columns marked cut (the seeds) */
  cols: [number, number][];
  cut?: (w: RockWorld) => void;
}

const scenes: Scene[] = [
  {
    name: 'arch, one foot cut',
    make: () => world(64, (x, y) => (y >= 15 && y < 18 && x >= 10 && x < 25 ? [[G + 12, G + 15], ...((x < 13 || x >= 22 ? [[G, G + 12]] : []) as [number, number][])] : [])),
    cols: box(10, 15, 25, 18),
    cut: (w) => box(22, 15, 25, 18).forEach(([x, y]) => w.dig(x, y, G, G + 3)),
  },
  {
    name: 'dome',
    make: () =>
      world(64, (x, y) => {
        const d = dist(x, y, 32, 32);
        if (d > 9) return [];
        return [[Math.floor(d < 7.5 ? G + Math.sqrt(56.25 - d * d) : G), Math.ceil(G + Math.sqrt(81 - d * d))]];
      }),
    cols: box(20, 20, 45, 45).filter(([x, y]) => dist(x, y, 32, 32) <= 9),
  },
  {
    name: 'shelf 3 thick, reach 16',
    make: () => world(64, (x, y) => (y < 20 || y >= 30 ? [] : x < 20 ? [[G, G + 20]] : x < 36 ? [[G + 17, G + 20]] : [])),
    cols: box(18, 20, 36, 30),
  },
  {
    name: 'mid-span neck',
    make: () => world(64, (x, y) => (y < 20 || y >= 30 ? [] : x < 20 ? [[G, G + 20]] : x < 26 ? [[G + 14, G + 20]] : x === 26 ? [[G + 19, G + 20]] : x < 32 ? [[G + 17, G + 20]] : [])),
    cols: box(18, 20, 32, 30),
  },
  {
    name: 'spire undercut',
    make: () => world(64, (x, y) => (dist(x, y, 40, 40) <= 1.6 ? [[G, G + 20]] : [])),
    cols: box(36, 36, 45, 45).filter(([x, y]) => dist(x, y, 40, 40) <= 1.6),
    cut: (w) => box(36, 36, 45, 45).forEach(([x, y]) => dist(x, y, 40, 40) <= 1.6 && cellPos(x, y)[0] > cellPos(40, 40)[0] - 0.75 && w.dig(x, y, G, G + 2)),
  },
  {
    // a mesa 40 across, 30 tall, undercut along one side: a notch 4 high reaching 14 in under its east face
    name: 'mesa undercut (40 × 40 × 30, notch 14 deep)',
    make: () => world(128, (x, y) => (x >= 40 && x < 80 && y >= 40 && y < 80 ? [[G, G + 30]] : [])),
    cols: box(62, 40, 80, 80),
    cut: (w) => box(66, 40, 80, 80).forEach(([x, y]) => w.dig(x, y, G, G + 4)),
  },
  {
    // a cliff 120 long, its 4-thick lip reaching 20 out (past its limit, 14.5): the whole lip lets go
    name: 'cliff collapse (120 long, lip 4 × 20)',
    make: () => world(128, (x, y) => (y < 4 || y >= 124 ? [] : x < 40 ? [[G, G + 24]] : x < 60 ? [[G + 20, G + 24]] : [])),
    cols: box(38, 4, 60, 124),
  },
  ...[10, 50, 200].map(
    (n): Scene => {
      // n pillars (2 × 2, 16 tall) on a grid, each with a 1-thick arm reaching 9 (past its 7.2): all let go at once
      const side = Math.ceil(Math.sqrt(n));
      const W = Math.max(64, Math.ceil((side * 14 + 8) / 16) * 16);
      const at = (i: number) => [4 + (i % side) * 14, 4 + Math.floor(i / side) * 14];
      return {
        name: `${n} arms at once`,
        make: () =>
          world(W, (x, y) => {
            for (let i = 0; i < n; i++) {
              const [px, py] = at(i);
              if (y < py || y >= py + 2) continue;
              if (x >= px && x < px + 2) return [[G, G + 16]];
              if (x >= px + 2 && x < px + 11) return [[G + 15, G + 16]];
            }
            return [];
          }),
        cols: Array.from({ length: n }, (_, i) => at(i)).flatMap(([px, py]) => box(px, py, px + 11, py + 2)),
      };
    },
  ),
];

const median = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];

describe.skipIf(!process.env.JUDGE_PERF)('the judges\' perf battery (JUDGE_PERF=1)', () => {
  test('every scene, A and B, five times', { timeout: 600_000 }, async () => {
    const gpu = await testGpu();
    const rows: Record<string, unknown>[] = [];
    for (const sc of scenes) {
      const row: Record<string, unknown> = { scene: sc.name };
      for (const make of [() => new RunsJudge(), () => new SectionsJudge()]) {
        const ms: number[] = [];
        const gms: number[] = [];
        const read: number[] = [];
        let freed = 0;
        let passes = 0;
        let runs = 0;
        for (let rep = 0; rep < 5; rep++) {
          const j: RockJudge = make();
          const w = sc.make();
          sc.cut?.(w);
          for (const [x, y] of sc.cols) w.cut.add(y * 65536 + x);
          const cols = gpuCols(gpu.device, w);
          // (A: the readback Integrity makes first — the window's slots from the GPU)
          let rb = 0;
          if (j.id === 'runs') {
            gpu.device.queue.writeBuffer(cols.slots, 0, w.packed.slots);
            const t = performance.now();
            await gpu.read(cols.slots, w.packed.slots.byteLength);
            rb = performance.now() - t;
          }
          const r = await judgeWorld(w, j, j.id === 'sections' ? cols : undefined);
          // (the first pass is the judging of the cut; later passes judge what's left)
          ms.push(r.stats[0].ms + rb);
          read.push(rb);
          gms.push(r.stats[0].gpuMs ?? 0);
          freed = r.freed;
          passes = r.passes.length;
          runs = w.packed.slots.length;
          cols.slots.destroy();
          cols.chunks.destroy();
          j.destroy();
        }
        const k = make().id === 'runs' ? 'A' : 'B';
        row[k] = { ms: +median(ms).toFixed(3), ...(k === 'A' ? { readbackMs: +median(read).toFixed(3) } : { gpuMs: +median(gms).toFixed(3), gpuMinMs: +Math.min(...gms).toFixed(3) }), freed, passes };
        row.slotWords = runs;
      }
      rows.push(row);
    }
    mkdirSync('data/perf/judge', { recursive: true });
    const tag = gpu.adapterInfo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
    writeFileSync(`data/perf/judge/node-${tag}.json`, JSON.stringify({ when: new Date().toISOString(), adapter: gpu.adapterInfo, note: 'median of 5 (the GPU is shared with other agents: gpuMinMs, the least, is the uncontended estimate); A ms = readback + CPU; B ms = wall (submit → verdict), gpuMs = timestamps', rows }, null, 1) + '\n');
    console.log(JSON.stringify(rows, null, 1));
    expect(gpu.takeErrors()).toEqual([]);
  });

  test("where B's time goes: the judge kernel stopped before each phase (min of 7)", { timeout: 600_000 }, async () => {
    const gpu = await testGpu();
    const out: Record<string, Record<string, number>> = {};
    for (const sc of scenes.filter((s) => /dome|cliff|200|shelf/.test(s.name))) {
      const row: Record<string, number> = {};
      for (const stop of [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) {
        const t: number[] = [];
        for (let rep = 0; rep < 7; rep++) {
          const j = new SectionsJudge();
          j.stopAt = stop;
          const w = sc.make();
          sc.cut?.(w);
          const cols = gpuCols(gpu.device, w);
          gpu.device.queue.writeBuffer(cols.slots, 0, w.packed.slots);
          await j.judge({ cols: { packed: w.packed, gpu: cols }, seeds: sc.cols, rotate: true });
          t.push(j.stats.gpuMs ?? 0);
          cols.slots.destroy();
          cols.chunks.destroy();
          j.destroy();
        }
        row[stop ? `before ${stop}` : 'all'] = +Math.min(...t).toFixed(3);
      }
      out[sc.name] = row;
    }
    mkdirSync('data/perf/judge', { recursive: true });
    writeFileSync('data/perf/judge/node-phases.json', JSON.stringify({ when: new Date().toISOString(), adapter: gpu.adapterInfo, note: 'B gpu ms, min of 7, its kernel stopped before phase n (judge.wgsl): before 1 = build + adjacency only', out }, null, 1) + String.fromCharCode(10));
    console.log(JSON.stringify(out, null, 1));
    expect(gpu.takeErrors()).toEqual([]);
  });
});
