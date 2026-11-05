// Rigid rock bodies: spawning a fallen piece as a body, stepping and drawing them, settling one back into the
// columns or resting it as an instance, and their meshes. API: rockGround, spawnRigid, stepRigid, rockDraws,
// toIndex, fastForward, settleRigid, allocRock, restRigid, restingMesh, meshFor, syncRockMeshes.
import { type Interval } from '../../world/layout';
import { MATERIALS, MatState } from '../../world/materials';
import { cellAt, cellPos } from '../../world/lattice';
import { subtract, type ColPiece } from '../colbodies';
import { RB, columnsGround, type RockBody, type RockGround, type V3 } from '../rockbodies';
import { BUILD_FRAMES, type RockDraw } from '../../render/rockmesh';
import { OWNER_ROCK, type ExternalCol } from '../../sim/external';
import { fieldMeshed } from '../../world/materials';
import type { SolverBody } from '../../api/contracts/solver';
import { rockDrawFor } from '../rockdraw';
import { buildBodyMesh, type MeshCell } from '../../render/bodymeshbuild';
import { bakeDust, erodeUnder, restingMass, unrest } from './resting';
import { touchCols, writeColumn } from './columns';
import { toLoose } from './loose';
import { spawnLattice } from './lattice';
import { WAKE_HIT, REST_FILL } from './defs';
import type { Integrity } from '../integrity';

/**
 * (round 95) What the rigid rock knows of the world: the CPU copy of the columns. A point in solid or loose ground
 * is pushed out up when it's within 0.6 of its run's top, else sideways through the nearest face of its column with
 * air beside it at that height (the hex's six); the window's floor holds.
 */
export function rockGround(ig: Integrity): RockGround {
  // (round 110: the rules are rockbodies.ts columnsGround's — shared with the CPU harness, scripts/physfix-cpu.ts)
  return columnsGround(() => (ig.cols.whole ? ig.world : null), ig.core.dims.w, ig.core.dims.h, (x, y, z) => restingMass(ig, x, y, z));
}

/** (round 95) A rock piece (its runs, cut out of the columns by apply) as a rigid body; `tip`: it turns over that edge. */
export function spawnRigid(ig: Integrity, piece: ColPiece[], tip?: { pivot: [number, number, number]; axis: [number, number, number] }): void {
  const rigid = ig.rigid!;
  // (the phone's cap: the oldest comes to rest first)
  while (rigid.list.length >= Math.max(1, RB.maxBodies)) {
    rigid.stats.capped++;
    fastForward(ig, rigid.list[0]);
  }
  // (round 120, JB6: its runs are out of the columns already — apply cut them on the GPU)
  const cells: { x: number; y: number; z: number; mat: number }[] = [];
  let z0 = Infinity;
  for (const c of piece) {
    for (const iv of c.ivs) {
      z0 = Math.min(z0, iv.z0);
      for (let z = Math.round(iv.z0); z < Math.round(iv.z1); z++) cells.push({ x: c.x, y: c.y, z, mat: iv.mat });
    }
  }
  // (the lattice variant: rock and what's built on the voxel lattice too — the tankers' solver for everything)
  if (ig.route.rock === 'lattice' && ig.physics) {
    touchCols(ig, piece, true);
    spawnLattice(ig, cells, () => false);
    return;
  }
  const b = rigid.spawn(cells, tip);
  touchCols(ig, piece, true);
  if (!b) return;
  b.slot = allocRock(ig, cells);
  // (where it tore free watched a few seconds: what the sim lays meanwhile on what was read — lava setting to a
  // basalt skin on its top — is judged, not left in the air where it was)
  const [bx0, by0, bx1, by1] = rigid.box(b);
  ig.watch((bx0 + bx1) / 2, (by0 + by1) / 2, (bx1 - bx0) / 2 + 1, 4);
  ig.stats.bodies++;
  // a cloud where it tore free
  const foot = piece.filter((c) => c.ivs.some((iv) => iv.z0 <= z0 + 1));
  const [fx, fy] = cellPos(Math.round(foot.reduce((s, c) => s + c.x, 0) / foot.length), Math.round(foot.reduce((s, c) => s + c.y, 0) / foot.length));
  ig.onDust?.(fx, fy, z0 + 0.5, Math.min(40, 10 + foot.length), Math.sqrt(foot.length) * 0.6 + 0.5, b.mat);
  ig.onCollapse?.(fx, fy, z0 + 0.5, foot.length);
}

/** (round 95) the rigid rock a step: hits raise dust (sparks when hard), break it; what came to rest is ground again */
export function stepRigid(ig: Integrity, dt: number): void {
  const rigid = ig.rigid!;
  const { hits, rest, erode } = rigid.update(dt);
  if (erode.length) erodeUnder(ig, erode);
  for (const h of hits) {
    const b = h.body;
    if (!rigid.list.includes(b)) continue;
    const [x, y, z] = h.at;
    const size = Math.sqrt(b.cells.length);
    ig.onDust?.(x, y, z, Math.min(60, Math.round(6 + h.speed * 3 + size)), 0.6 + h.speed * 0.15 + size * 0.15, b.mat);
    if (h.speed > RB.breakSpeed * 0.6) ig.onSparks?.(x, y, z + 0.3, Math.min(30, Math.round(h.speed * 2)), 2 + h.speed * 0.6);
    ig.onCollapse?.(x, y, z, b.cells.length * h.speed * 0.02);
    ig.stats.impacts++;
    // (round 120) the map's metal it struck (a tanker, a car) wakes into the picked variant's body
    if (h.speed > WAKE_HIT) ig.wakeMetalNear(x, y, z, 1.5);
    ig.groundBlow(x, y, z, 0.5 * b.mass * h.speed * h.speed, b.radius * 0.8);
    const br = rigid.breakAt(b, h.speed, h.at);
    if (!br) continue;
    // (its mesh drawn split between the pieces till theirs are built)
    for (const p of br.pieces) p.slot = allocRock(ig, rigid.latCells(p));
    if (b.slot !== undefined) ig.ghosts.push({ slot: b.slot, frames: BUILD_FRAMES, seeds: br.seeds, hit: br.hit, rad: br.rad });
    ig.stats.shatters++;
    ig.stats.shattered += br.rubble.length;
    ig.onDust?.(x, y, z, Math.min(60, 12 + br.rubble.length * 2), 1.5 + h.speed * 0.2, b.mat);
    toLoose(ig, toIndex(ig, br.rubble), h.speed * 1.2);
  }
  for (const b of rest) if (rigid.list.includes(b)) settleRigid(ig, b);
}

export function rockDraws(ig: Integrity): void {
  const rm = ig.rockMesh;
  if (!rm || !ig.rigid) return;
  // (the solver's bodies cleared — undo, a warp — take the metal's with them)
  if (ig.solver && ig.metal.length) {
    const live = ig.solver.bodies;
    for (const mb of ig.metal) if (!live.has(mb.body)) ig.bodyMeshes?.remove(mb.mesh);
    ig.metal = ig.metal.filter((mb) => live.has(mb.body));
  }
  const draws: RockDraw[] = [];
  const index = new Map<RockBody, number>();
  const waiting = new Set<RockBody>();
  for (const g of ig.ghosts) for (const s of g.seeds) if (s.piece) waiting.add(s.piece);
  for (const b of ig.rigid.list) {
    if (b.slot === undefined && !waiting.has(b)) continue;
    index.set(b, draws.length);
    // (on the node solver its mesh is skinned to its nodes on the GPU — where it is this frame, no readback's lag —
    // and so is a ghost's piece, its part of the parent's mesh, till its own is built: round 120, one pose from its
    // break to its rest, handed to the solver the frame it broke off)
    const rigid = ig.rigid;
    draws.push(rockDrawFor(waiting.has(b) || b.slot === undefined ? -1 : b.slot, rigid.engage(b)?.sb ?? null, () => rigid.drawMatrix(b)));
  }
  for (const a of ig.afterglow) draws.push({ slot: a.slot, m: a.m });
  // (round 120) the rock on the voxel lattice: its mesh skinned to its particles (those gone: let go)
  const phys = ig.physics;
  if (phys && ig.latticeRock.length) {
    if (!ig.particlesBound) {
      ig.core.renderer.setRockParticles({ px: phys.positions, pq: phys.rotations });
      ig.particlesBound = true;
    }
    const live = new Set(phys.bodies);
    ig.latticeRock = ig.latticeRock.filter((r) => {
      const st = phys.state(r.body);
      if (live.has(r.body) && (!st || st.alive > 0)) return true;
      rm.release(r.slot);
      return false;
    });
    for (const r of ig.latticeRock) draws.push({ slot: r.slot, m: [], lattice: { offset: r.body.offset, lo: r.lo, dims: r.dims } });
  }
  // (round 99) the resting rock, where it lies
  for (const r of ig.resting.values()) if (r.slot !== undefined) draws.push({ slot: r.slot, m: r.m });
  // (round 120: the metal is drawn by its own mesh — bodyMeshes — not the rock mesh)
  for (const g of ig.ghosts) {
    const seeds = g.seeds.map((s): [number, number, number, number] => [s.s[0], s.s[1], s.s[2], s.piece && index.has(s.piece) ? index.get(s.piece)! : -1]);
    draws.push({ slot: g.slot, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], ghost: { seeds, hit: g.hit, rad: g.rad } });
  }
  rm.setDraws(draws, ig.core.renderAlpha());
  // (round 120, the user: "the mesh changes appearance and sometimes turns into blocks during falling") how each
  // moving rock is drawn this frame — its mesh skinned to its nodes, its mesh by its matrix, split from its parent's
  // (a ghost), its cubes, or not at all (past RK_N) — for the probes (scripts/drawpath.mjs)
  ig.drawPaths.clear();
  for (const b of ig.rigid.list) {
    const at = index.get(b);
    const skin = at !== undefined && !!draws[at].skin;
    // (no rock mesh: all of it its own body mesh — what's built, a brick house — or, were neither there, its cells)
    const path = at === undefined ? (ig.rockMeshOf.get(b) ? 'mesh' : 'cubes') : waiting.has(b) ? (skin ? 'split-skin' : 'split-matrix') : skin ? 'skin' : 'matrix';
    ig.drawPaths.set(b.id, path);
  }
  for (const a of ig.afterglow) if (--a.frames <= 0) rm.release(a.slot);
  ig.afterglow = ig.afterglow.filter((a) => a.frames > 0);
  for (const g of ig.ghosts) if (--g.frames <= 0) rm.release(g.slot);
  ig.ghosts = ig.ghosts.filter((g) => g.frames > 0);
}

/** (round 95) world points → the column indices + 0.5 toLoose and chips take */
export function toIndex(ig: Integrity, vox: { p: V3; mat: number }[]): { p: [number, number, number]; mat: number }[] {
  return vox.map((v) => {
    const [cx, cy] = cellAt(v.p[0], v.p[1]);
    return { p: [cx + 0.5, cy + 0.5, v.p[2]], mat: v.mat };
  });
}

/** (round 95) a rigid body run on alone until it rests (at most 4 s), then written back */
export function fastForward(ig: Integrity, b: RockBody): void {
  const rigid = ig.rigid!;
  for (let k = 0; k < 120 && !rigid.frozen; k++) if (rigid.update(1 / 30, [b]).rest.includes(b)) break;
  settleRigid(ig, b);
}

/**
 * (round 95) A rigid body is ground again: each cell into the column under its centre, down onto what's under it
 * there (in place of a liquid), and those columns judged (and watched a few seconds).
 */
export function settleRigid(ig: Integrity, b: RockBody): void {
  const rigid = ig.rigid!;
  // (round 112: with or without a mesh — one without is drawn as its cells, as it was while it moved)
  if (ig.external && restRigid(ig, b)) return;
  // (round 110: written back — no mesh for it, or nowhere to claim — is a bake: behind a burst of dust, DECISIONS
  // round 106's "hide every re-mesh or body-to-terrain swap behind a burst of dust")
  {
    const [x0, y0, x1, y1] = rigid.box(b);
    bakeDust(ig, (x0 + x1) / 2, (y0 + y1) / 2, b.pos[2], Math.max(x1 - x0, y1 - y0) / 2, b.cells.length, b.mat);
  }
  // (its mesh stays a few frames where it came to rest, while the ground's own is made there)
  if (b.slot !== undefined) ig.afterglow.push({ slot: b.slot, m: rigid.matrix(b), frames: 6 });
  rigid.remove(b);
  rigid.stats.settled++;
  rigid.stats.baked++;
  const why = b.slot === undefined ? 'no mesh' : ig.external ? 'unclaimed' : 'no registry';
  rigid.bakedWhy[why] = (rigid.bakedWhy[why] ?? 0) + 1;
  const { w: W, h: H, zMax } = ig.core.dims;
  const by = new Map<number, { z: number; mat: number }[]>();
  for (const c of rigid.worldCells(b)) {
    const [cx, cy] = cellAt(c.p[0], c.p[1]);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
    const k = cy * 65536 + cx;
    const l = by.get(k) ?? [];
    l.push({ z: Math.max(0, Math.floor(c.p[2])), mat: c.mat });
    by.set(k, l);
  }
  const matter = (m: number) => {
    const s = MATERIALS[m]?.state;
    return s !== undefined && s !== MatState.Empty && s !== MatState.Liquid;
  };
  const cols: ColPiece[] = [];
  for (const [k, cells] of by) {
    const x = k % 65536;
    const y = Math.floor(k / 65536);
    let col = ig.cols.read(x, y);
    const over: Interval[] = [];
    cells.sort((a, c) => a.z - c.z);
    for (const c of cells) {
      // (down onto what's under it in its column: a cell of a body lying across a gap or a crater's edge, over air
      // in its own column, would float once the ground beside it went — the first try left single cells over a
      // meteor's melting bowl. A heap settles column by column, as rubble would)
      let z0 = 0;
      for (const iv of col) if (matter(iv.mat) && iv.z1 <= c.z + 0.5 && iv.z1 > z0) z0 = iv.z1;
      for (let moved = true, i = 0; moved && i < 64; i++) {
        moved = false;
        for (const iv of col)
          if (matter(iv.mat) && iv.z0 < z0 + 1 - 1e-3 && iv.z1 > z0 + 1e-3) {
            z0 = iv.z1;
            moved = true;
          }
      }
      if (z0 + 1 > zMax - 1e-3) {
        over.push({ z0: Math.max(z0, zMax), z1: Math.max(z0, zMax) + 1, mat: c.mat });
        continue;
      }
      col = subtract(col, [{ z0, z1: z0 + 1 }]);
      col.push({ z0, z1: z0 + 1, mat: c.mat });
      col.sort((a, c2) => a.z0 - c2.z0);
    }
    // (touching intervals of a material: one)
    const merged: Interval[] = [];
    for (const iv of col) {
      const last = merged[merged.length - 1];
      if (last && last.mat === iv.mat && Math.abs(last.z1 - iv.z0) < 1e-4 && (last.aux ?? 0) === (iv.aux ?? 0)) last.z1 = iv.z1;
      else merged.push({ ...iv });
    }
    writeColumn(ig, x, y, merged);
    if (over.length) ig.above?.put(x, y, over);
    cols.push({ x, y, ivs: [] });
    // (judged for what floats, not weighed: a heap lying as it fell isn't tipped or crushed again — round 95's first
    // try weighed it and the heap's pieces were freed, fell and settled over and over)
    ig.rockSeeds.set(k, 2);
  }
  if (cols.length) {
    touchCols(ig, cols, true);
    // (and watched a few seconds: a cell left over air once the ground round it changes — a crater's rim melting
    // and setting, a piece landing beside — is judged again; the first try left single cells floating in a crater)
    const [x0, y0, x1, y1] = rigid.box(b);
    ig.watch((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + 1, 4);
  }
  ig.urgent = true;
}

/**
 * (round 99) A mesh slot for a piece; with no room, the oldest resting rock becomes ground to make some (round 120:
 * its slot given back at once — kept a few frames for its afterglow, the room it made wasn't there yet, and every
 * resting rock went). Past that the window's copy holds nothing but moving pieces: it throws (no other look for it).
 * Undefined: no rock in it (what's built: the body mesh), or no rock mesh at all (no field mesh: nothing is meshed).
 */
export function allocRock(ig: Integrity, all: { x: number; y: number; z: number; mat: number }[]): number | undefined {
  const rm = ig.rockMesh;
  if (!rm) return undefined;
  // (round 112) its mesh is the field mesh's: only what that draws (what's built is the body mesh)
  const cells = all.filter((c) => fieldMeshed(c.mat));
  if (!cells.length) return undefined;
  for (;;) {
    const got = rm.alloc(cells);
    if (got) return got.id;
    const oldest = ig.resting.keys().next();
    if (!oldest.done && ig.external) {
      const inst = ig.external.get(oldest.value);
      if (!inst) ig.resting.delete(oldest.value);
      else unrest(ig, inst, 'room');
      continue;
    }
    // (the afterglows and ghosts: the frames they'd have stayed, given up for it)
    if (ig.afterglow.length || ig.ghosts.length) {
      for (const g of [...ig.afterglow, ...ig.ghosts]) rm.release(g.slot);
      ig.afterglow = [];
      ig.ghosts = [];
      continue;
    }
    throw new Error(`rock mesh: the window's copy is full of moving rock (${rm.held} pieces) — no room for a piece of ${cells.length} cells`);
  }
}

/**
 * (round 99, meshinst) A rigid body come to rest stays its mesh where it lies: the columns its cells are in claimed
 * as External from its lowest to its highest cell in each (down onto the ground under it where that's less than a
 * cell below — what holds it), buried where they're ground already. False: nothing claimed (written back instead).
 */
export function restRigid(ig: Integrity, b: RockBody): boolean {
  const rigid = ig.rigid!;
  const ext = ig.external!;
  const { w: W, h: H, zMax } = ig.core.dims;
  const by = new Map<number, [number, number]>();
  for (const c of rigid.worldCells(b)) {
    const [cx, cy] = cellAt(c.p[0], c.p[1]);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
    const k = cy * 65536 + cx;
    const r = by.get(k);
    const lo = Math.max(0, c.p[2] - 0.5);
    const hi = Math.min(zMax - 1e-3, c.p[2] + 0.5);
    if (r) by.set(k, [Math.min(r[0], lo), Math.max(r[1], hi)]);
    else by.set(k, [lo, hi]);
  }
  const want: ExternalCol[] = [];
  const matter = (m: number) => {
    const s = MATERIALS[m]?.state;
    return s !== undefined && s !== MatState.Empty && s !== MatState.Liquid;
  };
  for (const [k, [lo0, hi]] of by) {
    const x = k % 65536;
    const y = Math.floor(k / 65536);
    let lo = lo0;
    let ground = 0;
    for (const iv of ig.cols.read(x, y)) if (matter(iv.mat) && iv.z1 <= lo + 0.5 && iv.z1 > ground) ground = iv.z1;
    // (round 99: down to the ground under its whole footprint where that's within REST_FILL — the rock judge weighs
    // what stands by the columns under it: a boulder touching at a corner, its centre of mass past that corner, was
    // judged to tip and let go the moment it came to rest)
    if (lo > ground && lo - ground < REST_FILL) lo = ground;
    if (hi - lo > 0.05) want.push({ x, y, z0: lo, z1: hi });
  }
  // (room: the resting rock is held to REST_MAX — the oldest becomes ground)
  while (ig.resting.size >= Math.max(1, RB.restMax)) {
    const id = ig.resting.keys().next().value!;
    const inst = ext.get(id);
    if (inst) unrest(ig, inst, 'room');
    else ig.resting.delete(id);
  }
  const inst = ext.claim(OWNER_ROCK, want, b.mat);
  if (!inst) return false;
  rigid.remove(b);
  rigid.stats.settled++;
  const m = rigid.matrix(b);
  const cells = rigid.latCells(b);
  // (round 120: its own mesh, the same, where it came to rest)
  const mesh = ig.rockMeshOf.get(b) || undefined;
  ig.rockMeshOf.delete(b);
  if (mesh) ig.bodyMeshes?.setPose(mesh, { kind: 'matrix', m });
  ig.resting.set(inst.id, { slot: b.slot, m, mat: b.mat, cells, mesh });
  const cols = inst.cols.map((c) => ({ x: c.x, y: c.y, ivs: [] }));
  touchCols(ig, cols, true);
  // (judged for what floats, not weighed — as a heap written back is)
  for (const c of inst.cols) ig.rockSeeds.set(c.y * 65536 + c.x, 2);
  const [x0, y0, x1, y1] = rigid.box(b);
  ig.watch((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + 1, 4);
  ig.urgent = true;
  return true;
}

/** (round 120) a resting body's own mesh where it lies: what the rock mesh doesn't hold of it (all, without a slot) */
export function restingMesh(ig: Integrity, cells: MeshCell[], m: number[], slot: number | undefined): number | undefined {
  const bm = ig.bodyMeshes;
  const keep = cells.filter((c) => !!RB.cubes || slot === undefined || !fieldMeshed(c.mat));
  if (!bm || !keep.length) return undefined;
  const id = bm.add(buildBodyMesh(keep), { kind: 'matrix', m });
  ig.rockMeshIds.add(id);
  return id;
}

/** (round 120) a solver body's own mesh, bound to its nodes (its cells in the order it was made from) */
export function meshFor(ig: Integrity, body: SolverBody, cells: MeshCell[]): number {
  const bm = ig.bodyMeshes;
  if (!bm || !ig.solver) return 0;
  return bm.add(buildBodyMesh(cells, ig.solver.bindOf(body)), { kind: 'nodes', slot: body.slot, com: body.restCom });
}

/**
 * (round 120) Each moving rock's own mesh, made the first frame it moves (what the rock mesh doesn't hold of it:
 * what's built, or all of it without a slot) and kept to its rest: on the node solver bound to its nodes, else moved
 * by its CPU matrix each frame. Meshes no body or resting rock holds let go.
 */
export function syncRockMeshes(ig: Integrity): void {
  const bm = ig.bodyMeshes;
  const rigid = ig.rigid;
  if (!bm || !rigid) return;
  const live = new Set<number>();
  for (const b of rigid.list) {
    let id = ig.rockMeshOf.get(b);
    if (id === undefined) {
      const sb = rigid.engage(b)?.sb ?? null;
      const all = rigid.latCells(b);
      const idx: number[] = [];
      all.forEach((c, i) => {
        if (!!RB.cubes || b.slot === undefined || !fieldMeshed(c.mat)) idx.push(i);
      });
      id = 0;
      if (idx.length) {
        const cells = idx.map((i) => all[i]);
        if (sb && ig.solver) {
          const bind = ig.solver.bindOf(sb);
          id = bm.add(buildBodyMesh(cells, { nodeRest: bind.nodeRest, cellNode: idx.map((i) => bind.cellNode[i]), g: bind.g }), { kind: 'nodes', slot: sb.slot, com: sb.restCom });
        } else id = bm.add(buildBodyMesh(cells), { kind: 'matrix', m: rigid.drawMatrix(b) });
        ig.rockMeshIds.add(id);
      }
      ig.rockMeshOf.set(b, id);
    } else if (id && !rigid.engineBody(b)) bm.setPose(id, { kind: 'matrix', m: rigid.drawMatrix(b) });
    if (id) live.add(id);
  }
  const inList = new Set(rigid.list);
  for (const b of [...ig.rockMeshOf.keys()]) if (!inList.has(b)) ig.rockMeshOf.delete(b);
  for (const r of ig.resting.values()) if (r.mesh) live.add(r.mesh);
  for (const id of [...ig.rockMeshIds])
    if (!live.has(id)) {
      bm.remove(id);
      ig.rockMeshIds.delete(id);
    }
}
