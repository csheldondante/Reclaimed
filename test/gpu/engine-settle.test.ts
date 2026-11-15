// Letter D of the physics engine's round trip (docs/design/PHYSICS_ENGINE.md, build step 2; BACKLOG PE20, PE22, PE26):
// settle — a still deforming body's parts become rigid rows again, each with a compact model and a baked mesh closed
// by break faces; crumbs go to the ground; pages return; a settled row wakes and expands like any row; rows asleep
// cost the frame no mesh work.
// Numbers: BREAK_LOG=1 npx vitest run --project gpu engine-settle --reporter=verbose
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { OCC_AT, POOL } from '../../src/engine/engine';
import { modelMesh } from '../../src/engine/modelmesh';
import { TUNE } from '../../src/tune/params';
import { MAT } from '../../src/world/materials';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, flat, type BreakRig } from './engine-rig';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());
const T = TUNE.engine as Record<string, number>;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));
const ok = () => expect(g.takeErrors()).toEqual([]);

const ALIVE = 1;
const ASLEEP = 2;
const DEFORM = 8;
/** flat ground at 10 with a ridge two cells wide and four high across it (columns 17 and 18) */
const ridge = (x: number) => [{ z0: 0, z1: x === 17 || x === 18 ? 14 : 10, mat: MAT.Stone }];
const log = (s: string) => {
  if (process.env.BREAK_LOG) console.log(s);
};

type Drawn = Awaited<ReturnType<BreakRig['drawn']>>;
/** a row's drawn triangles, 9 floats each, in the list's order (collapsed ones left out) */
function trisOf(d: Drawn, row: number): number[][] {
  const out: number[][] = [];
  for (let t = 0; t < d.tris; t++) {
    if (d.row[t] !== row) continue;
    const p = [...d.p.subarray(t * 9, t * 9 + 9)];
    if (Math.hypot(p[3] - p[0], p[4] - p[1], p[5] - p[2]) < 1e-6) continue;
    out.push(p);
  }
  return out;
}
/** edges of a triangle set that are not shared by exactly two triangles, vertices welded within `tol` */
function openEdges(tris: number[][], tol = 0.02): number {
  const ids = new Map<string, number>();
  const pts: number[][] = [];
  const idOf = (x: number, y: number, z: number) => {
    const c = [Math.round(x / tol), Math.round(y / tol), Math.round(z / tol)];
    // (a point near a cell's edge may round either way: look in the cells round it)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const id = ids.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`);
          if (id !== undefined && Math.hypot(pts[id][0] - x, pts[id][1] - y, pts[id][2] - z) < tol) return id;
        }
    ids.set(c.join(','), pts.length);
    pts.push([x, y, z]);
    return pts.length - 1;
  };
  const edges = new Map<string, number>();
  for (const t of tris) {
    const v = [idOf(t[0], t[1], t[2]), idOf(t[3], t[4], t[5]), idOf(t[6], t[7], t[8])];
    for (let k = 0; k < 3; k++) {
      const a = v[k];
      const b = v[(k + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const n of edges.values()) if (n !== 2) open++;
  return open;
}
/** the farthest a triangle of `a` is from the triangle of `b` nearest to it (vertex for vertex); -1: one has no match within 0.5 */
function worstMove(a: number[][], b: number[][]): { worst: number; missing: number; over: number } {
  const key = (t: number[]) => `${Math.round((t[0] + t[3] + t[6]) / 1.5)},${Math.round((t[1] + t[4] + t[7]) / 1.5)},${Math.round((t[2] + t[5] + t[8]) / 1.5)}`;
  const grid = new Map<string, number[][]>();
  for (const t of b) {
    const k = key(t);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(t);
  }
  let worst = 0;
  let missing = 0;
  let over = 0;
  for (const t of a) {
    const c = key(t).split(',').map(Number);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const u of grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) {
            let d = 0;
            for (let k = 0; k < 9; k++) d = Math.max(d, Math.abs(t[k] - u[k]));
            best = Math.min(best, d);
          }
    if (best > 0.5) missing++;
    else worst = Math.max(worst, best);
    if (best > 0.05 && best <= 0.5) over++;
  }
  return { worst, missing, over };
}

/** stepped till nothing deforms any more (every still body settled); the frame drawn while it last deformed */
async function settleAll(R: BreakRig, most = 900): Promise<{ ticks: number; before: Drawn | null }> {
  let before: Drawn | null = null;
  let began = false;
  for (let t = 0; t < most; t++) {
    await R.step(1);
    const P = await R.pool();
    if (P[POOL.deforming] > 0) {
      began = true;
      if (P[POOL.settling] > 0) before = await R.drawn();
    } else if (began) return { ticks: t, before };
  }
  throw new Error('settleAll: a body never settled');
}

test('D: a stone block dropped from height across a ridge breaks into parts that become rows; row masses and what went to the ground make the mass it had; its pages return', async () => {
  // (dropped flat on flat ground a stone block cracks and sheds voxels but its bonds still hold it in one part — the
  // numbers run below; across a ridge it snaps in two)
  const R = await breakRig(g, ridge);
  const cells = box(12, 12, 40, 12, 4, 3);
  const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
  const { ticks, before } = await settleAll(R);
  const P = await R.pool();
  const rows = await R.rows();
  log(`stone 12x4x3 from 30 cells across a ridge: settled after ${ticks} ticks into ${P[POOL.parts]} rows, ${P[POOL.crumbs]} voxels to the ground; failed settles ${P[POOL.failSettle]}`);
  expect(P[POOL.parts]).toBeGreaterThanOrEqual(2);
  // the body's own row is freed, its parts are rows the GPU made (odd ones), asleep where they lay
  expect(rows.find((r) => r.row === b.row)).toBeUndefined();
  const parts = rows.filter((r) => r.row % 2 === 1);
  expect(parts.length).toBe(P[POOL.parts]);
  for (const r of parts) expect(r.flags & (ALIVE | ASLEEP | DEFORM)).toBe(ALIVE | ASLEEP);
  // mass: the rows, and a voxel's mass for each one that went to the ground
  const mass = parts.reduce((s, r) => s + r.mass, 0);
  expect(mass + P[POOL.crumbs] * 2.7).toBeCloseTo(144 * 2.7, 1);
  let voxels = 0;
  for (const r of parts) {
    const m = await R.model(r.model);
    expect(m.solid).toBeGreaterThanOrEqual(T.crumb);
    voxels += m.solid;
  }
  expect(voxels + P[POOL.crumbs]).toBe(144);
  // every page and slot back on its free stack
  expect(P[POOL.pageTop]).toBe(P[POOL.pageNext]);
  expect(P[POOL.slotTop]).toBe(P[POOL.slotNext]);
  // the parts' meshes: each closed (the break is capped: no edge with one triangle), and where the body's skin was
  await R.step(2);
  const d = await R.drawn();
  let open = 0;
  let all: number[][] = [];
  for (const r of parts) {
    const t = trisOf(d, r.row);
    expect(t.length).toBeGreaterThan(0);
    open += openEdges(t);
    all = all.concat(t);
  }
  log(`${parts.length} parts, ${all.length} triangles drawn, ${open} open edges`);
  expect(open).toBe(0);
  expect(trisOf(d, b.row).length).toBe(0);
  // The frame before: what was drawn of the deforming body is still there after. While it deforms a face is placed by
  // the voxels its own cell is still bonded to; baked, by its voxels that are the part's — so where a bond inside a
  // part had snapped the hairline between two faces closes (a known, measured move: BACKLOG PE31).
  const was = trisOf(before!, b.row);
  const mv = worstMove(was, all);
  log(`of ${was.length} triangles drawn while it deformed, ${mv.missing} have none within half a cell after, ${mv.over} moved more than 0.05 cells, the most ${mv.worst.toFixed(4)}`);
  expect(mv.missing).toBe(0);
  expect(mv.worst).toBeLessThan(0.35);
  ok();
  R.w.destroy();
});

test('D: a steel beam bent over a post settles as one row with a compact model of its bent shape; no vertex moves at settle, nor when it expands again', async () => {
  const R = await breakRig(g, (x, y) => (x >= 15 && x <= 16 && y >= 14 && y <= 17 ? [{ z0: 0, z1: 16, mat: MAT.Stone }] : [{ z0: 0, z1: 10, mat: MAT.Stone }]));
  const cells = box(6, 15, 32, 20, 2, 1, MAT.Steel);
  const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
  const { before } = await settleAll(R);
  const P = await R.pool();
  expect(P[POOL.parts]).toBe(1);
  expect(P[POOL.crumbs]).toBe(0);
  const rows = await R.rows();
  expect(rows.length).toBe(1);
  const part = rows[0];
  expect(part.row % 2).toBe(1);
  expect(part.mass).toBeCloseTo(40 * 7.8, 1);
  // its compact model: 40 voxels, bent — the ends' rest places lie below the middle's
  const m = await R.model(part.model);
  expect(m.solid).toBe(40);
  expect(m.verts).toBe(b.model.verts);
  const zs: number[] = [];
  const n = m.dims[0] * m.dims[1] * m.dims[2];
  let lowX = Infinity;
  let highX = -Infinity;
  const rec: { x: number; z: number }[] = [];
  for (let k = 0; k < n; k++) {
    if (!(new Uint32Array(m.recs.buffer)[k * 4 + 3] & 63)) continue;
    rec.push({ x: m.recs[k * 4], z: m.recs[k * 4 + 2] });
    lowX = Math.min(lowX, m.recs[k * 4]);
    highX = Math.max(highX, m.recs[k * 4]);
    zs.push(m.recs[k * 4 + 2]);
  }
  const ends = rec.filter((r) => r.x < lowX + 1.5 || r.x > highX - 1.5).reduce((s, r) => s + r.z, 0) / rec.filter((r) => r.x < lowX + 1.5 || r.x > highX - 1.5).length;
  const mid = rec.filter((r) => Math.abs(r.x - (lowX + highX) / 2) < 1.5).reduce((s, r) => s + r.z, 0) / rec.filter((r) => Math.abs(r.x - (lowX + highX) / 2) < 1.5).length;
  log(`steel beam: compact model ${m.dims.join(' x ')}, ${m.solid} voxels, ${m.verts} vertices; rest places: middle ${mid.toFixed(2)}, ends ${ends.toFixed(2)} about its centre; ${(m.dims[0] * m.dims[1] * m.dims[2] * 16 + m.verts * 48 + 64) / m.solid} B a voxel with its mesh`);
  expect(mid - ends).toBeGreaterThan(1);
  // settle moved no vertex
  await R.step(2);
  const after = await R.drawn();
  const was = trisOf(before!, b.row);
  const now = trisOf(after, part.row);
  // (every face of its skin is in the part's mesh: the ones the deforming draw had dropped as stretched past the
  // tear limit, where it creased over the post, are drawn again — no bond snapped there)
  expect(now.length).toBe(b.model.verts / 3);
  expect(now.length).toBeGreaterThanOrEqual(was.length);
  const mv = worstMove(was, now);
  log(`settle: ${was.length} triangles drawn while it deformed, ${now.length} after (its whole skin); the largest vertex move ${mv.worst.toExponential(2)} cells`);
  expect(mv.missing).toBe(0);
  expect(mv.worst).toBeLessThan(1e-3);
  expect(openEdges(now)).toBe(0);
  // expanded again (a second hit): its particles are made from the compact model — bent as it lay, no vertex moves
  R.e.expand({ row: part.row });
  await R.step(1);
  expect((await R.row(part.row)).flags & DEFORM).toBe(DEFORM);
  const again = trisOf(await R.drawn(), part.row);
  expect(again.length).toBe(now.length);
  let worst = 0;
  for (let t = 0; t < now.length; t++) for (let k = 0; k < 9; k++) worst = Math.max(worst, Math.abs(now[t][k] - again[t][k]));
  log(`expanded again: the largest vertex move ${worst.toExponential(2)} cells`);
  expect(worst).toBeLessThan(2e-4);
  const p = await R.particles(part.row);
  expect(p.cells).toBe(n);
  ok();
  R.w.destroy();
});

test('D: a body expanded and never broken or bent gives its row back on the shared model: no part, no heap taken', async () => {
  const R = await breakRig(g, flat);
  const cells = box(12, 12, 10, 4, 3, 3);
  const b = R.e.add({ cells, mesh: modelMesh(cells) })!;
  await R.step(60);
  const rigid = trisOf(await R.drawn(), b.row);
  R.e.expand(b);
  await settleAll(R);
  const P = await R.pool();
  expect(P[POOL.expands]).toBe(1);
  expect(P[POOL.parts]).toBe(0);
  expect(P[POOL.heapNext]).toBe(0);
  expect(P[POOL.pageTop]).toBe(P[POOL.pageNext]);
  const rows = await R.rows();
  expect(rows.length).toBe(1);
  expect(rows[0].row).toBe(b.row);
  expect(rows[0].model).toBe(b.model.id);
  expect(rows[0].flags & (ALIVE | ASLEEP | DEFORM)).toBe(ALIVE | ASLEEP);
  await R.step(2);
  const back = trisOf(await R.drawn(), b.row);
  expect(back.length).toBe(rigid.length);
  let worst = 0;
  for (let t = 0; t < back.length; t++) for (let k = 0; k < 9; k++) worst = Math.max(worst, Math.abs(back[t][k] - rigid[t][k]));
  log(`back on the shared model: the largest vertex move against the rigid body before ${worst.toExponential(2)} cells`);
  expect(worst).toBeLessThan(0.02);
  ok();
  R.w.destroy();
});

test('D: a settled part wakes by an impulse like any row, and a hard hit expands it from its compact model with no vertex jump', async () => {
  const R = await breakRig(g, flat);
  const cells = box(12, 12, 34, 6, 6, 4);
  R.e.add({ cells, mesh: modelMesh(cells) })!;
  await settleAll(R);
  await R.step(2);
  const parts = (await R.rows()).filter((r) => r.row % 2 === 1).sort((a, c) => c.mass - a.mass);
  const big = parts[0];
  const still = await R.row(big.row);
  expect(still.flags & ASLEEP).toBe(ASLEEP);
  // a nudge: awake, moving, not deforming
  R.e.impulse({ row: big.row }, [0, 0, 2]);
  await R.step(2);
  const up = await R.row(big.row);
  expect(up.flags & (ALIVE | ASLEEP | DEFORM)).toBe(ALIVE);
  expect(up.pos[2]).toBeGreaterThan(still.pos[2]);
  // (asleep again where it comes down)
  await R.step(180);
  expect((await R.row(big.row)).flags & ASLEEP).toBe(ASLEEP);
  // a hard hit: thrown at the ground it lies on
  const before = trisOf(await R.drawn(), big.row);
  const expands = (await R.pool())[POOL.expands];
  R.e.impulse({ row: big.row }, [0, 0, -30]);
  let hit = false;
  for (let t = 0; t < 4 && !hit; t++) {
    await R.step(1);
    hit = ((await R.row(big.row)).flags & DEFORM) !== 0;
  }
  expect(hit).toBe(true);
  expect((await R.pool())[POOL.expands]).toBe(expands + 1);
  const after = trisOf(await R.drawn(), big.row);
  expect(after.length).toBe(before.length);
  let worst = 0;
  for (let t = 0; t < before.length; t++) for (let k = 0; k < 9; k++) worst = Math.max(worst, Math.abs(before[t][k] - after[t][k]));
  log(`a settled part of ${(big.mass / 2.7).toFixed(0)} voxels hit again: ${before.length} triangles, the largest vertex move as it expands ${worst.toExponential(2)} cells`);
  expect(worst).toBeLessThan(0.05);
  // and it settles again: every voxel a row's or the ground's
  await settleAll(R);
  const P = await R.pool();
  let voxels = 0;
  for (const r of (await R.rows()).filter((r) => r.row % 2 === 1)) voxels += (await R.model(r.model)).solid;
  expect(voxels + P[POOL.crumbs]).toBe(144);
  expect(P[POOL.pageTop]).toBe(P[POOL.pageNext]);
  ok();
  R.w.destroy();
});

test('D: rows asleep cost the frame no mesh work — their triangles are placed once and stand (PE26)', async () => {
  const R = await breakRig(g, flat);
  const a = box(8, 8, 10, 3, 3, 2);
  const c = box(16, 16, 10, 2, 2, 4);
  const ba = R.e.add({ cells: a, mesh: modelMesh(a) })!;
  const bc = R.e.add({ cells: c, mesh: modelMesh(c) })!;
  const args = async () => {
    const A = new Uint32Array(await g.read(R.e.debugBuffers.dl, 48));
    return { verts: A[0], groups: A[4], listed: A[7], awake: A[11] };
  };
  await R.step(2);
  await R.drawn();
  const moving = await args();
  expect(moving.awake).toBe(moving.listed);
  expect(moving.groups).toBeGreaterThan(0);
  // both asleep: after the frame that places the new list, a frame dispatches no workgroup, and the triangles stand
  await R.step(120);
  expect((await R.row(ba.row)).flags & ASLEEP).toBe(ASLEEP);
  const first = await R.drawn();
  const asleep = await args();
  expect(asleep.verts).toBe(moving.verts);
  expect(asleep.awake).toBe(0);
  expect(asleep.groups).toBe(0);
  const second = await R.drawn();
  expect(Buffer.from(second.p.buffer).equals(Buffer.from(first.p.buffer))).toBe(true);
  expect(trisOf(second, ba.row).length).toBe(ba.model.verts / 3);
  // one wakes: only its triangles are placed each frame again, and they follow it
  R.e.impulse(bc, [0, 0, 4]);
  await R.step(3);
  const third = await R.drawn();
  const one = await args();
  expect(one.awake).toBe(bc.model.verts / 3);
  expect(one.groups).toBe(Math.ceil(one.awake / 64));
  const t0 = trisOf(first, bc.row);
  const t1 = trisOf(third, bc.row);
  expect(t1[0][2]).toBeGreaterThan(t0[0][2] + 0.05);
  expect(trisOf(third, ba.row)).toEqual(trisOf(first, ba.row));
  ok();
  R.w.destroy();
});

test('D: a row\'s occupancy at its model\'s resolution, for the collision branch', async () => {
  const R = await breakRig(g, flat);
  const cells = [...box(12, 12, 10, 3, 2, 2), { x: 15, y: 12, z: 10, mat: MAT.Steel }];
  const b = R.e.add({ cells })!;
  await R.step(2);
  const out = g.device.createBuffer({ size: (OCC_AT + 64) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const enc = g.device.createCommandEncoder();
  R.e.occupancy(enc, b.row, out);
  g.device.queue.submit([enc.finish()]);
  const O = new Uint32Array(await g.read(out, (OCC_AT + 64) * 4));
  expect([...O.slice(0, 4)]).toEqual([4, 2, 2, 13]);
  const occ = [...O.slice(OCC_AT, OCC_AT + 16)];
  expect(occ.filter((m) => m === MAT.Stone).length).toBe(12);
  expect(occ[3]).toBe(MAT.Steel);
  expect(occ[7]).toBe(0);
  out.destroy();
  ok();
  R.w.destroy();
});

// ---- numbers for the DEVLOG and the lab's heights (BREAK_LOG=1) ------------------------------------------------------------
test.runIf(!!process.env.BREAK_LOG)('numbers: what a drop leaves, by shape, material and height', async () => {
  for (const [name, w, d, h, drop, mat] of [
    ['stone 6x6x4', 6, 6, 4, 6, MAT.Stone],
    ['stone 6x6x4', 6, 6, 4, 12, MAT.Stone],
    ['stone 6x6x4', 6, 6, 4, 24, MAT.Stone],
    ['stone 6x6x4', 6, 6, 4, 40, MAT.Stone],
    ['stone 3x3x8', 3, 3, 8, 24, MAT.Stone],
    ['stone 8x8x2', 8, 8, 2, 24, MAT.Stone],
    ['stone 12x4x2 over a ridge', 12, 4, 2, 24, MAT.Stone],
    ['stone 12x4x3 over a ridge', 12, 4, 3, 30, MAT.Stone],
    ['brick 6x3x6', 6, 3, 6, 16, MAT.Brick],
    ['brick 6x3x6', 6, 3, 6, 30, MAT.Brick],
  ] as [string, number, number, number, number, number][]) {
    const R = await breakRig(g, name.includes('ridge') ? ridge : flat);
    const cells = box(12, 12, 10 + drop, w, d, h, mat);
    R.e.add({ cells, mesh: modelMesh(cells), spin: name.includes('brick') ? [0.6, 0, 0] : [0, 0, 0] });
    let ticks = -1;
    try {
      ticks = (await settleAll(R, 1200)).ticks;
    } catch {
      // (never deformed: under its threshold)
    }
    const P = await R.pool();
    const parts = (await R.rows()).filter((r) => r.row % 2 === 1);
    const sizes: number[] = [];
    for (const r of parts) sizes.push((await R.model(r.model)).solid);
    console.log(`${name} from ${drop} cells: ${P[POOL.expands] ? `settled after ${ticks} ticks, parts of ${sizes.sort((a, b) => b - a).join(', ') || 'none (its own row back)'} voxels, ${P[POOL.crumbs]} to the ground` : 'stayed rigid'}`);
    R.w.destroy();
  }
  ok();
});

test.runIf(!!process.env.BREAK_LOG)('numbers: what settling costs (GPU time by kernel, the most a tick), and what a settled part holds', async () => {
  for (const [name, cells] of [
    ['stone 12x4x3 across a ridge', box(12, 12, 40, 12, 4, 3)],
    ['stone 16x16x8 across a ridge', box(10, 8, 40, 16, 16, 8)],
  ] as [string, ReturnType<typeof box>][]) {
    const R = await breakRig(g, ridge);
    R.e.add({ cells, mesh: modelMesh(cells) });
    const most = new Map<string, number>();
    let began = false;
    for (let t = 0; t < 1500; t++) {
      const P = R.e.seen;
      if (began && P[POOL.settling] > 0) {
        const m = await R.gpuTick();
        if (!m) break;
        for (const [k, v] of m) most.set(k, Math.max(most.get(k) ?? 0, v));
      } else await R.step(1);
      await R.pool();
      if (R.e.seen[POOL.deforming] > 0) began = true;
      else if (began) break;
    }
    const P = await R.pool();
    const sum = (re: RegExp) => [...most].filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v, 0);
    console.log(`${name} (${cells.length} voxels): ${P[POOL.parts]} parts, ${P[POOL.crumbs]} voxels to the ground. Settle, the most a tick took: labels ${sum(/^label/).toFixed(2)} ms (8 passes), the parts' numbers, models, samples and rows ${sum(/^part(Scan|Count|Alloc|Samples|Recs|Row)/).toFixed(2)} ms, the baked outer mesh ${sum(/^tri/).toFixed(2)} ms, the break faces ${sum(/^partFaces/).toFixed(2)} ms`);
    for (const r of (await R.rows()).filter((r) => r.row % 2 === 1)) {
      const m = await R.model(r.model);
      const box = m.dims[0] * m.dims[1] * m.dims[2];
      const bytes = 64 + box * 16 + m.verts * 48;
      console.log(`  a part of ${m.solid} voxels: box ${m.dims.join(' x ')} (${box} cells, 16 B each), ${m.verts / 3} triangles (48 B a vertex): ${bytes} B, ${(bytes / m.solid).toFixed(0)} B a voxel (${((64 + box * 16) / m.solid).toFixed(0)} without the mesh); a row 160 B and 80 B a surface sample besides`);
    }
    R.w.destroy();
  }
  ok();
});
