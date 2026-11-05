// Lattice bodies on the physics voxels: dropped models, the lattice rock, and the blows and wakes they take.
// API: dropModels (Integrity.dropModels), spawnLattice, latticeBlows, wakeLattice.
import { cellPos } from '../../world/lattice';
import { type V3 } from '../rockbodies';
import { fieldMeshed } from '../../world/materials';
import type { PhysBody } from '../../physics/physics';
import { modelColumns, type VoxelModel } from '../../world/models';
import { BM_VERT, buildBodyMesh } from '../../render/bodymeshbuild';
import { bindSkinTo } from '../../physics/mesh';
import { withColumns } from './tick';
import { allocRock } from './rigid';
import type { Integrity } from '../integrity';

/** Integrity.dropModels (the class keeps the method, documented there) */
export async function dropModels(ig: Integrity, models: VoxelModel[], cx: number, cy: number, above: number, wrap = Infinity): Promise<number> {
  if (!ig.rigid) return 0;
  const { w: W, h: H, zMax } = ig.core.dims;
  const GAP = 3;
  const laid = models.map((m) => ({ m, ...modelColumns(m, 0) }));
  // rows: as many as fit in `wrap`
  const rows: (typeof laid)[] = [[]];
  let width = 0;
  for (const l of laid) {
    const row = rows[rows.length - 1];
    if (row.length && width + GAP + l.fw > wrap) {
      rows.push([l]);
      width = l.fw;
    } else {
      width += (row.length ? GAP : 0) + l.fw;
      row.push(l);
    }
  }
  const depth = rows.reduce((s, r) => s + Math.max(...r.map((l) => l.fd)), 0) + GAP * (rows.length - 1);
  const widest = Math.max(...rows.map((row) => row.reduce((s, l) => s + l.fw, 0) + GAP * (row.length - 1)));
  // (round 120, JB6: the ground under them read where it lies — the copy, or fetched)
  const n = await withColumns(ig, ig.cols.chunksIn(cx - widest / 2 - 1, cy - depth / 2 - 2, cx + widest / 2 + 1, cy + depth / 2 + 2), () => {
    // (rows start even: the hex pattern of a model kept as it was built)
    let y = (cy - Math.floor(depth / 2)) & ~1;
    let n = 0;
    for (const row of rows) {
      const rw = row.reduce((s, l) => s + l.fw, 0) + GAP * (row.length - 1);
      let x = cx - Math.floor(rw / 2);
      for (const { m, fw, fd, cols } of row) {
        let top = 0;
        for (let j = y; j < y + fd; j++)
          for (let i = x; i < x + fw; i++) {
            if (i < 0 || j < 0 || i >= W || j >= H) continue;
            const col = ig.cols.read(i, j);
            if (col.length) top = Math.max(top, col[col.length - 1].z1);
          }
        const base = Math.ceil(top) + Math.max(0, above);
        if (base + m.size[2] > zMax - 1) throw new Error(`dropModels: ${m.id} from ${base} would leave the window's height (${zMax})`);
        const cells: { x: number; y: number; z: number; mat: number }[] = [];
        for (let fy = 0; fy < fd; fy++)
          for (let fx = 0; fx < fw; fx++) {
            const i = x + fx;
            const j = y + fy;
            if (i < 0 || j < 0 || i >= W || j >= H) continue;
            for (const r of cols[fx + fw * fy]) for (let z = r.z0; z < r.z1; z++) cells.push({ x: i, y: j, z: base + z, mat: r.mat });
          }
        if (cells.length && ig.dropBody(cells)) n++;
        x += fw + GAP;
      }
      y += Math.max(...row.map((l) => l.fd)) + GAP;
      y += y & 1;
    }
    return n;
  });
  return n ?? 0;
}

export function spawnLattice(ig: Integrity, cells: { x: number; y: number; z: number; mat: number }[], pinned: (c: { x: number; y: number; z: number; mat: number }) => boolean): boolean {
  const phys = ig.physics;
  if (!phys || !cells.length) return false;
  let lo: [number, number, number] = [Infinity, Infinity, Infinity];
  let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    lo = [Math.min(lo[0], c.x), Math.min(lo[1], c.y), Math.min(lo[2], c.z)];
    hi = [Math.max(hi[0], c.x), Math.max(hi[1], c.y), Math.max(hi[2], c.z)];
  }
  const dims: [number, number, number] = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  if (!phys.hasRoom(dims[0] * dims[1] * dims[2])) return false;
  // (round 120, the user: "a lot of things turn into lattices during falling": drawn as its own mesh over its
  // particles — bound to them, torn where they part — its voxels hidden, as the node solver's bodies are drawn. And
  // "The rocks do look better with the nodes but largely because of the meshing": meshing by material, not by solver
  // — its rock is the rock mesh (the field mesh's copy) skinned to its particles, the rest the body mesh)
  const slot = allocRock(ig, cells);
  const verts = buildBodyMesh(slot === undefined ? cells : cells.filter((c) => !fieldMeshed(c.mat)));
  const skin = bindSkinTo(
    verts,
    BM_VERT,
    cells.map((c) => {
      const [px, py] = cellPos(c.x, c.y);
      return { i: c.x - lo[0] + dims[0] * (c.y - lo[1] + dims[1] * (c.z - lo[2])), c: [px, py, c.z + 0.5] as [number, number, number] };
    }),
  );
  if (!phys.hasSkinRoom(skin.tris)) {
    if (slot !== undefined) ig.rockMesh?.release(slot);
    return false;
  }
  const at = new Map(cells.map((c) => [`${c.x - lo[0]},${c.y - lo[1]},${c.z - lo[2]}`, c]));
  const body: PhysBody | null = phys.spawnLattice(
    dims,
    (x, y, z) => at.get(`${x},${y},${z}`)?.mat ?? 0,
    (x, y, z) => {
      const [px, py] = cellPos(lo[0] + x, lo[1] + y);
      return [px, py, lo[2] + z + 0.5];
    },
    { pinned: (x, y, z) => {
      const c = at.get(`${x},${y},${z}`);
      return !!c && pinned(c);
    }, hidden: true },
  );
  if (body && skin.tris && !phys.attachSkin(body, skin)) throw new Error('spawnLattice: its mesh had room a moment ago');
  if (body && slot !== undefined) ig.latticeRock.push({ body, slot, lo, dims });
  else if (slot !== undefined) ig.rockMesh?.release(slot);
  if (body) ig.stats.bodies++;
  return !!body;
}

export function latticeBlows(ig: Integrity): void {
  const phys = ig.physics;
  if (!phys) return;
  for (const body of phys.bodies) {
    const st = phys.state(body);
    if (!st || st.alive <= 0) continue;
    const was = ig.latticeLast.get(body.id);
    if (was && was.tick === st.tick) continue;
    ig.latticeLast.set(body.id, { v: [...st.vel] as V3, tick: st.tick });
    if (!was || was.v[2] > -2) continue;
    const dv = Math.hypot(st.vel[0] - was.v[0], st.vel[1] - was.v[1], st.vel[2] - was.v[2]);
    if (dv < 2.5) continue;
    // (where it struck: under it — the edit pass finds the ground's top there itself; z for its dust)
    ig.groundBlow(st.pos[0], st.pos[1], st.pos[2] - 0.5 * body.dims[2] * body.size, 0.5 * st.alive * 4 * dv * dv, 0.3 * Math.hypot(body.dims[0], body.dims[1]) * body.size);
  }
}

export function wakeLattice(ig: Integrity): void {
  const phys = ig.physics;
  if (!phys) return;
  for (const b of ig.rigid?.list ?? []) if (Math.hypot(b.v[0], b.v[1], b.v[2]) > 1) phys.wakeNear(b.pos[0], b.pos[1], b.radius + 1);
  if (ig.solver)
    for (const mb of ig.metal) {
      const r = ig.solver.read(mb.body);
      if (r && !r.asleep && Math.hypot(r.vel[0], r.vel[1], r.vel[2]) > 1) phys.wakeNear(r.pos[0], r.pos[1], Math.cbrt(mb.body.cells) * 1.2 + 1);
    }
}
