// Integrity's tick and its analysis pass: what's dirty is read (the columns near, or all), judged into pieces, and
// what fell applied (cut out, sent to the rigid, metal or physics bodies, or turned loose). API: update
// (Integrity.update), wantChunks, judgeCols, pass, apply, syncCopy, withColumns.
import { analyse, isStructural, type Fracture, type Voxel } from '../fracture';
import { type JudgeColumns } from '../judge';
import { ignoreTeardown } from '../../gpu/pipeline';
import { cellPos, ROW_H } from '../../world/lattice';
import { EventKind } from '../../sim/globals';
import { CUTS, editOpOf } from '../../sim/edit-ops';
import { type ColPiece } from '../colbodies';
import { record } from '../../gpu/cpustat'; // (round 100, hitchrec: timing)
import { orphanColumn } from '../../sim/external';
import { type CopyMode } from '../colcopy';
import { type ApplyStage } from '../colapply';
import { rockDraws, spawnRigid, stepRigid, syncRockMeshes } from './rigid';
import { metalBlows, takeMetal } from './metal';
import { externalCols, takeExternal } from './resting';
import { edit, gpuCols, land, touch } from './columns';
import { chips, flushLoose } from './loose';
import { latticeBlows, wakeLattice } from './lattice';
import { PASS, PASS_BUDGET, FALL_EVERY, READ_NEAR, cellsToRuns } from './defs';
import type { Integrity } from '../integrity';

/** Integrity.update (the class keeps the method, documented there) */
export function update(ig: Integrity, dt: number): void {
  if (ig.held?.()) return;
  if (ig.cols.whole && dt > 0) {
    ig.bodies.update(dt);
  }
  flushLoose(ig);
  const { data, count } = ig.bodies.pack();
  if (ig.rigid) {
    // (round 95) the rigid rock: a step, its hits (dust, sparks, a break), what came to rest written back
    const tRigid = performance.now(); // (round 100, hitchrec: timing)
    if (ig.rigid?.list.length && ig.cols.whole && dt > 0 && !ig.paused.physics) stepRigid(ig, dt);
    record('rockbodies', performance.now() - tRigid); // (round 100, hitchrec: timing)
    const max = 16384;
    if (ig.packF.length < max * 8) ig.packF = new Float32Array(max * 8);
    const f = ig.packF;
    const u = new Uint32Array(f.buffer);
    f.set(new Float32Array(data.buffer, data.byteOffset, Math.min(count, max) * 8));
    // (round 120, the user: "it switches for rendering as voxels. Rendering and simulation should not be coupled that
    // way": no rock's cells drawn as voxels, moving or resting — what the rock mesh doesn't hold is the body's own
    // mesh, bodyMeshes (it was its cells, from the CPU pose: the round-120 blocks while falling); and no cells only
    // casting the shadow — the meshes cast their own)
    const n = Math.min(count, max);
    ig.core.renderer.setBodies(u, n, n);
    syncRockMeshes(ig);
  } else ig.core.renderer.setBodies(data, count);
  rockDraws(ig);
  metalBlows(ig);
  latticeBlows(ig);
  wakeLattice(ig);
  // (round 86) the pieces falling in the columns: a step, their chunks meshed at once, what came down
  if (ig.cols.whole && dt > 0 && ig.falling.list.length) {
    for (const l of ig.falling.update(dt, ++ig.fallFrame % FALL_EVERY === 0)) land(ig, l);
    for (const b of ig.falling.list) touch(ig, b, false);
  }
  ig.t -= dt;
  for (const w of ig.watches) {
    w.left -= dt;
    w.next -= dt;
    if (w.next <= 0) {
      w.next = 1;
      // (round 96: weighed too — lava setting by what the cut freed props it up, a film of basalt against its side;
      // judged for floating only, it was held by that and never weighed: the user's "basalt that resupports it")
      ig.markCut(w.x, w.y, w.r);
    }
  }
  if (ig.watches.length) ig.watches = ig.watches.filter((w) => w.left > 0);
  // (round 86: a cut waits for its event to be sent — the world API marks it as it's queued — then goes at once)
  const cutQueued = ig.urgent && ig.core.globals.events.some((e) => e.kind === EventKind.Edit && CUTS.has(editOpOf(e.z ?? 0)));
  const due = ((ig.urgent && !cutQueued) || ig.t <= 0) && !ig.paused.judge;
  const rigidN = ig.rigid?.list.length ?? 0;
  if (ig.busy || !due) return;
  const kept = syncCopy(ig) === 'kept';
  // (kept: a pass reads the copy — the first one with nothing to judge too, to have it)
  if (!ig.dirty.length && !ig.rockSeeds.size && !ig.bodies.list.length && !rigidN && !ig.orphanCheck && (!kept || ig.cols.any)) return;
  // (with only sleeping bodies about, a slower pass still checks they're held up; the rigid rock's ground is read round it)
  ig.t = ig.dirty.length || ig.rockSeeds.size || ig.bodies.anyAwake || rigidN ? PASS : 1.0;
  ig.urgent = false;
  ig.busy = true;
  // (round 120b: judge A's whole cost — the readback's latency and bytes, for the judges' battery)
  ig.timing.readStartAt = performance.now();
  const bytes0 = ig.cols.readBytes;
  const measured = () => {
    ig.timing.readAt = performance.now();
    ig.stats.readMs = ig.timing.readAt - ig.timing.readStartAt;
    ig.stats.readKB = (ig.cols.readBytes - bytes0) / 1024;
  };
  const done = () => {
    ig.busy = false;
    ig.timing.doneAt = performance.now();
    ig.stats.readKB = (ig.cols.readBytes - bytes0) / 1024;
  };
  if (!kept) {
    // (round 120, JB6: nothing read before the pass — the judge reads the GPU's columns, the verdict is applied on the
    // GPU; what the pass reads, it fetches: the columns External cells are claimed in near the cut, a box with
    // something built in it)
    measured();
    void pass(ig, false, wantChunks(ig)).then(done, (e) => {
      ig.busy = false;
      ignoreTeardown(e);
    });
    return;
  }
  // the layers (structures, solid ground; the loose ground on them too)
  // (round 128j: the External claims the read can show — those made before it was asked)
  const asOf = ig.external?.epoch ?? 0;
  void ig.cols.readFor(READ_NEAR ? wantChunks(ig) : 'all').then((got) => {
    measured();
    // (round 92: a slide began meanwhile — what was read is of the window before it; judged again after. Round 88: the
    // window slid while it was read — nothing judged on that, the seeds kept for the next look)
    if (got === 'slid' || ig.held?.()) {
      ig.busy = false;
      ig.urgent = true;
      return;
    }
    // (the columns pieces fall through: as they are, not as the readback had them)
    ig.falling.restoreCpu();
    // (round 95) the copy is of the window as it is: the rigid rock moves again
    if (ig.rigid) ig.rigid.frozen = false;
    if (got === 'whole') ig.needChunks.clear();
    // (round 120: judge B answers from the GPU — the pass waits for its verdict, and no other pass starts meanwhile)
    return pass(ig, got === 'whole', null, asOf).then(done);
  }, ignoreTeardown);
}

/**
 * (intread=near) The chunks a pass looks at: round the dirty boxes (6 cells), the cut columns (24: the rock hanging from
 * them), the bodies (4), the rigid rock and what it falls onto, and those a piece reached last pass.
 */
export function wantChunks(ig: Integrity): Set<number> {
  const want = new Set<number>();
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    for (const c of ig.cols.chunksIn(x0, y0 / ROW_H, x1, y1 / ROW_H)) want.add(c);
  };
  for (const [x0, y0, x1, y1] of ig.dirty) box(x0 - 6, y0 - 6, x1 + 6, y1 + 6);
  for (const k of ig.rockSeeds.keys()) {
    const [px, py] = cellPos(k % 65536, Math.floor(k / 65536));
    box(px - 24, py - 24, px + 24, py + 24);
  }
  for (const b of ig.bodies.list) {
    let r = 0;
    for (const v of b.local) r = Math.max(r, Math.hypot(v.p[0], v.p[1], v.p[2]));
    box(b.pos[0] - r - 4, b.pos[1] - r - 4, b.pos[0] + r + 4, b.pos[1] + r + 4);
  }
  // (round 95) round the rigid rock: what it falls onto
  for (const b of ig.rigid?.list ?? []) {
    const [x0, y0, x1, y1] = ig.rigid!.box(b);
    const m = 4 + Math.hypot(b.v[0], b.v[1]) * PASS * 2;
    box(x0 - m, y0 - m, x1 + m, y1 + m);
  }
  for (const ci of ig.needChunks) want.add(ci);
  ig.needChunks.clear();
  // (the pieces falling in the columns need nothing read: what they fall onto is their columns' base)
  return want;
}

/** (round 120) the columns as the judges read them: the CPU's copy (A), the GPU's own (B) */
export function judgeCols(ig: Integrity): JudgeColumns {
  return { packed: ig.core.packed, vox: ig.cols.mode === 'kept' ? ig.world : undefined, gpu: { device: ig.core.host.gpu.device, slots: ig.core.world.layers, chunks: ig.core.world.chunks } };
}

/**
 * A pass: what other systems own checked, the rock by the cut columns judged and what gave applied, the structures'
 * dirty boxes analysed. `whole`: the copy was just read whole (kept). `want` (sparse): the chunks the pass looks at —
 * what it reads of them it fetches (round 120, JB6): the claimed cells there, a box with something built in it.
 */
export async function pass(ig: Integrity, whole: boolean, want: Set<number> | null, readAsOf?: number): Promise<void> {
  let t0 = performance.now();
  const sparse = ig.cols.mode === 'sparse';
  const ext = ig.external;
  // (round 99) what other systems own, as the columns now have it: an instance that lost cells is cut (its owner told)
  let verified: Promise<unknown> = Promise.resolve();
  if (ext) {
    // (round 128g: what's claimed after the columns were asked for isn't judged by them — they can't show it yet. Round
    // 128j: the epoch when the kept copy's read was asked, not when it came back — a region written with its town's
    // claims meanwhile isn't in it)
    const asOf = readAsOf ?? ext.epoch;
    const check = (known?: (x: number, y: number) => boolean) => {
      const te = performance.now();
      ext.verify(known, undefined, asOf);
      ext.stats.ms = +(performance.now() - te).toFixed(2);
    };
    if (!sparse) {
      const fresh = ig.cols.fresh;
      check(fresh ? (x, y) => fresh.has(ig.cols.chunkOf(x, y)) : undefined);
    } else {
      // (round 120, JB6: the chunks with claimed cells among those the pass looks at, fetched — and checked in the
      // fetch's own task, the columns as they came)
      const near = new Set<number>();
      const { w: W, h: H } = ig.core.dims;
      for (const inst of ext.instances)
        for (const c of inst.cols) {
          // (round 128j: a static thing's columns may lie out of the window)
          if (c.x < 0 || c.y < 0 || c.x >= W || c.y >= H) continue;
          const ci = ig.cols.chunkOf(c.x, c.y);
          if (want!.has(ci)) near.add(ci);
        }
      if (near.size) verified = ig.cols.fetch(near).then((ok) => ok && check((x, y) => ig.cols.has(x, y)));
    }
    // (after a whole read, or a slide or a rewrite of the window: External intervals no one owns are orphans — an undo,
    // a thaw — and go back to ground: on the GPU, and in the copy where it's kept)
    // (round 128j: not while a slide's land is coming in — landPending — and owed till it has)
    const pending = ig.landPending?.() ?? false;
    if (pending && whole) ig.orphanCheck = true;
    if ((whole || ig.orphanCheck) && !pending) {
      ig.orphanCheck = false;
      const claimed = ext.claimedSpans();
      ig.gpuEdit.orphans(gpuCols(ig), claimed);
      if (!sparse)
        for (const k of externalCols(ig)) {
          const x = k % 65536;
          const y = Math.floor(k / 65536);
          const out = orphanColumn(ig.cols.read(x, y), claimed.get(k) ?? []);
          if (out) {
            ext.stats.orphans++;
            ig.cols.mirror(x, y, out);
          }
        }
    }
  }
  // a sleeping body with nothing left under it (broken, dug, washed out) wakes
  for (const b of ig.bodies.list) if (b.asleep && !ig.bodies.supported(b)) ig.bodies.wake(b);
  ig.stats.passes++;
  // (round 120, JB6) the structures' boxes asked of the GPU first (anything built in them?), alongside the rock's judge
  const boxes = ig.dirty;
  ig.dirty = [];
  const built = sparse && boxes.length ? ig.query.count(gpuCols(ig), boxes.map(([x0, y0, x1, y1]) => [x0 - 2, y0 - 2, x1 + 2, y1 + 2]), isStructural) : null;
  // (round 83) rock, by the columns an edit cut: the hanging runs by them, and only those. (Round 88: first —
  // it takes what hangs free whole, whatever it's made of; the structures' boxes then see what's left)
  if (ig.rockSeeds.size) {
    const seeds: [number, number][] = [];
    for (const [k, left] of ig.rockSeeds) {
      seeds.push([k % 65536, Math.floor(k / 65536)]);
      if (left > 1) ig.rockSeeds.set(k, left - 1);
      else ig.rockSeeds.delete(k);
    }
    const cut = new Set(ig.cutSeeds.keys());
    for (const [k, left] of ig.cutSeeds) {
      if (left > 1) ig.cutSeeds.set(k, left - 1);
      else ig.cutSeeds.delete(k);
    }
    const fresh = ig.cols.fresh;
    const known = !sparse && fresh ? (x: number, y: number) => fresh.has(ig.cols.chunkOf(x, y)) : undefined;
    const tj = performance.now();
    const r = await ig.judge.judge({ cols: judgeCols(ig), seeds, known, weigh: (x, y) => cut.has(y * 65536 + x), rotate: !!ig.rigid });
    // (judge B's wait for its verdict isn't the pass's CPU time: the judge's own stats keep it, and its GPU ms)
    if (ig.judge.id === 'sections') t0 += performance.now() - tj;
    ig.stats.judgeMs = ig.judge.stats.ms;
    ig.stats.judgeGpuMs = ig.judge.stats.gpuMs ?? 0;
    record(`judge.${ig.judge.id}`, ig.judge.stats.ms);
    ig.stats.rockSeeds += seeds.length;
    // (round 96: what the last weighing found, for the tests)
    for (const [k, v] of Object.entries(r.why ?? {})) ig.why[k] = (ig.why[k] ?? 0) + v;
    // (round 88) a piece reaching columns not read this pass: they're read, it's judged again at once
    if (r.undecided?.length) {
      for (const [x, y] of r.need ?? []) ig.needChunks.add(ig.cols.chunkOf(x, y));
      for (const [x, y] of r.undecided) {
        const k = y * 65536 + x;
        ig.rockSeeds.set(k, Math.max(1, ig.rockSeeds.get(k) ?? 0));
        if (cut.has(k)) ig.cutSeeds.set(k, Math.max(1, ig.cutSeeds.get(k) ?? 0));
      }
      ig.stats.rereads++;
      ig.urgent = true;
    }
    // (what gave: its columns looked at again, what it held now hanging free)
    const gave = apply(ig, r);
    // (what gave, and (round 96) the columns a piece left: what's left there — a leg's stump, what was joined to
    // the piece — is judged again, weighed: it lost what it held or what held it)
    for (const c of [...(gave ? (r.crumbleRuns ?? []) : []), ...(r.pieces ?? []).flat()]) {
      ig.rockSeeds.set(c.y * 65536 + c.x, 2);
      ig.cutSeeds.set(c.y * 65536 + c.x, 2);
    }
  }
  // the structures' boxes: analysed where something's built (sparse: the GPU said so; their chunks fetched now, after
  // the rock's verdict was applied — the boxes see what's left)
  let look = boxes;
  if (built) {
    const counts = await built;
    look = [];
    boxes.forEach((b, i) => {
      if (counts[i] > 0) look.push(b);
      // (looked at twice: edits reach the GPU a tick after they're queued)
      else if (b[4] > 1) ig.dirty.push([b[0], b[1], b[2], b[3], b[4] - 1]);
    });
  }
  const analyseBoxes = () => {
    for (let b = 0; b < look.length; b++) {
      // (round 100, hitchrec: a pass never holds the main thread for seconds — past its budget the boxes left wait,
      // as they were, for the next pass; a soak saw one pass of 40 s, every arriving town's box solved)
      if (b > 0 && performance.now() - t0 > PASS_BUDGET) {
        for (let k = b; k < look.length; k++) ig.dirty.push(look[k]);
        ig.stats.deferred += look.length - b;
        break;
      }
      const [x0, y0, x1, y1, left] = look[b];
      if (left > 1) ig.dirty.push([x0, y0, x1, y1, left - 1]);
      const r = analyse(ig.world, x0 - 2, y0 - 2, x1 + 2, y1 + 2);
      if (apply(ig, r)) {
        // what the cut held is looked at again next pass (it now hangs free)
        ig.markBox(x0, y0, x1, y1);
      }
      // (round 87) a structure going on past the box wasn't judged: once more over a box twice the size (to 256)
      if (r.beyond && x1 - x0 < 256) {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const h = x1 - x0;
        ig.dirty.push([cx - h, cy - h, cx + h, cy + h, 1]);
      }
    }
  };
  if (!sparse) analyseBoxes();
  else if (look.length) {
    const chunks = new Set<number>();
    for (const [x0, y0, x1, y1] of look) for (const c of ig.cols.chunksIn(x0 - 2, y0 - 2, x1 + 2, y1 + 2)) chunks.add(c);
    // (the window slid meanwhile: looked at again next pass)
    if ((await withColumns(ig, chunks, () => (analyseBoxes(), true))) === undefined) for (const b of look) ig.dirty.push(b);
  }
  await verified;
  ig.stats.lastMs = performance.now() - t0;
  record('judge.pass', ig.stats.lastMs); // (round 100, hitchrec: timing — the pass runs in its readback's continuation)
}

/** What an analysis found, done: what crumbles crumbles, what breaks free falls. Did anything crumble? */
export function apply(ig: Integrity, r: Fracture): boolean {
  // (round 96) metal isn't the judges': it's woken into the physics voxels, whole, where they found it
  if (ig.rigid && (ig.route.metal === 'nodes' ? ig.solver : ig.physics)) takeMetal(ig, r);
  // (round 99) what other systems own found hanging free or giving: their owners told (the rock lets go: its cells
  // are ground again, and fall here with the rest as they do)
  if (ig.external) takeExternal(ig, r);
  // (round 120, JB6) the columns changed on the GPU, in order: the rock's runs that gave cut out whole (fractional ends
  // too) and their volume spilled as rubble beside them (round 87), the structures' crushed cells likewise, then what
  // broke free taken out of the ground for its body
  const stages: ApplyStage[] = [];
  const gave = r.crumbleRuns ?? [];
  if (gave.length) {
    const cells: Voxel[] = [];
    for (const c of gave) for (const iv of c.ivs) for (let z = Math.floor(iv.z0); z < iv.z1 - 0.25; z++) cells.push({ x: c.x, y: c.y, z, mat: iv.mat });
    stages.push({ cuts: gave.map((c) => ({ x: c.x, y: c.y, cuts: c.ivs })), spill: cells });
    ig.stats.crumbled += cells.length;
    chips(ig, cells.map((c) => [c.x + 0.5, c.y + 0.5, c.z + 0.5]), 4);
  }
  if (r.crumble.length) {
    stages.push({ cuts: r.crumble.map((c) => ({ x: c.x, y: c.y, cuts: [{ z0: c.z, z1: c.z + 1 }] })), spill: r.crumble });
    ig.stats.crumbled += r.crumble.length;
    chips(ig, r.crumble.map((c) => [c.x + 0.5, c.y + 0.5, c.z + 0.5]), 4);
  }
  // (round 86) what broke free falls in the columns' own format: the rock's pieces by their runs, the
  // structures' by their cells (a column's cells one run each, touching ones of a material joined)
  const zTop = ig.core.dims.zMax - 1e-3;
  const above = (piece: ColPiece[]) => {
    // (round 87: a run reaching the window's top goes on above it — Streamer.outside, the band draws it: that comes
    // down with it)
    if (ig.above) for (const c of piece) if (c.ivs.some((iv) => iv.z1 >= zTop)) c.ivs.push(...ig.above.take(c.x, c.y));
    return piece;
  };
  // (round 95) the rock's pieces as rigid bodies; (solver step 2, AR11: the falling pieces folded into the one solver)
  // what the structure judge frees — concrete, brick — falls as rigid bodies too, body against body, toppling
  const rigidPieces: { piece: ColPiece[]; tip?: { pivot: [number, number, number]; axis: [number, number, number] } }[] = [];
  if (ig.rigid && r.pieces?.length) {
    const tips = new Map((r.tips ?? []).map((t) => [t.piece, t]));
    r.pieces.forEach((piece, i) => rigidPieces.push({ piece: above(piece), tip: tips.get(i) }));
  }
  if (ig.rigid && ig.route.structures === 'rock') for (const body of r.bodies) rigidPieces.push({ piece: above(cellsToRuns(body)) });
  // (what came from above the window isn't in its columns: only the window's runs cut)
  if (rigidPieces.length) stages.push({ cuts: rigidPieces.flatMap(({ piece }) => piece.map((c) => ({ x: c.x, y: c.y, cuts: c.ivs.filter((iv) => iv.z0 < zTop) }))) });
  edit(ig, stages);
  for (const { piece, tip } of rigidPieces) spawnRigid(ig, piece, tip);
  if (rigidPieces.length) ig.timing.spawnedAt = performance.now();
  // (the pieces falling in the columns — no rigid rock here, or the old variant's structures: colbodies.ts reads and
  // writes the copy's columns itself; the copy is kept for it)
  const pieces: ColPiece[][] = ig.rigid && ig.route.structures === 'rock' ? [] : [...(ig.rigid ? [] : (r.pieces ?? [])), ...r.bodies.map(cellsToRuns)];
  for (const piece of pieces) {
    above(piece);
    const b = ig.falling.spawn(piece);
    if (!b) continue;
    // a cloud where it tore free (its foot: the columns with a run within a cell of its lowest), to soften the moment
    let z0 = Infinity;
    for (const c of b.cols) for (const iv of c.ivs) z0 = Math.min(z0, iv.z0);
    const foot = b.cols.filter((c) => c.ivs.some((iv) => iv.z0 <= z0 + 1));
    const [fx, fy] = cellPos(Math.round(foot.reduce((s, c) => s + c.x, 0) / foot.length), Math.round(foot.reduce((s, c) => s + c.y, 0) / foot.length));
    ig.onDust?.(fx, fy, z0 + 0.5, Math.min(40, 10 + foot.length), Math.sqrt(foot.length) * 0.6 + 0.5, b.mat);
    ig.onCollapse?.(fx, fy, z0 + 0.5, foot.length + r.crumble.length + gave.length);
    ig.stats.bodies++;
    touch(ig, b, true);
  }
  if (pieces.length) ig.timing.spawnedAt = performance.now();
  return r.crumble.length > 0 || gave.length > 0;
}

/** the copy held as keepsCopy says (a change drops what it held: kept, the next read is whole) */
export function syncCopy(ig: Integrity): CopyMode {
  const mode: CopyMode = ig.keepsCopy ? 'kept' : 'sparse';
  if (ig.cols.mode !== mode) {
    ig.cols.mode = mode;
    ig.cols.drop();
  }
  return mode;
}

/**
 * (round 120, JB6) Columns readable on the CPU now: kept, the copy (read once if there's none yet); sparse, these
 * chunks fetched. `then` runs in the same task, the columns readable; false: the window slid meanwhile (not run).
 */
export async function withColumns<T>(ig: Integrity, chunks: Iterable<number>, then: () => T): Promise<T | undefined> {
  if (syncCopy(ig) === 'kept') {
    if (!ig.cols.any) await ig.cols.readFor('all');
    return ig.cols.any ? then() : undefined;
  }
  return (await ig.cols.fetch(chunks)) ? then() : undefined;
}
