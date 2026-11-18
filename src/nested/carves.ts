// Nested scales lab (round 10, tests only): the owner's rule for edits across levels. "I expect boolean deletion to
// delete parents and all children in those sub cells": a carve at any level removes that volume at every finer level
// too, nothing solid appears at a finer level inside space its parent has as air (beyond what enhance reconstructs at a
// carve's boundary), and nothing floats that an edit did not leave floating. Scenarios run on their own pool (GpuNest
// directly, ops back to back); the measures read the store back (readAll). Readbacks here are test-only.
import { GpuNest, type Snapshot, type Win } from './gpu/nest';
import { DETAIL_AMP } from './oracle';

const K = 8;
const SEED = 7;
const ROOT = 256;
/** a level's window here: 128 columns */
const N = 128;

/** a ball carved (or that must be air at the end) at level d: centre in global columns of d, z in d's local units */
export interface Ball {
  d: number;
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface Measure {
  /** child solid records lying wholly in the air of their parent column and its 8 neighbours (parent units, 0.05 tol) */
  inAir: number;
  /** child columns with solid inside a carved ball shrunk by 1.5 columns of the carving level */
  inBall: number;
  /** solid intervals in components touching neither a first record (the ground) nor the window's rim */
  floating: number;
  /** of those on finer levels, the ones in components whose parent cells hold no floating record */
  fresh: number;
  /** new floaters on finer levels whose parent piece touches its neighbours by less than CONTACT (NS-92) */
  marginal: number;
  where: string[];
  perLevel: string;
}

type Col = { mat: number[]; z0: number[]; z1: number[] };
/** (parent units) a parent piece that touches its neighbours by less than this is held on by a hair: the enhance's seeded
 *  detail moves a child's bounds by up to DETAIL_AMP x (2 + 4) child units = 0.06 parent units each side, so its children
 *  may part (BACKLOG NS-92); counted apart from new floaters */
const CONTACT = (2 * DETAIL_AMP * 6) / K;
const same = (a: Col, b: Col) => a.mat.length === b.mat.length && a.mat.every((v, i) => v === b.mat[i]);

/** level m's columns over its window (solid view) */
function cols(s: Snapshot, m: number, w: Win): Map<number, Col> {
  const out = new Map<number, Col>();
  for (let Y = w.gy; Y < w.gy + w.n; Y++) for (let X = w.gx; X < w.gx + w.n; X++) out.set(Y * 65536 + X, s.column(m, X, Y));
  return out;
}

/** the ball in level m's units (m >= b.d): centre, z, radius */
function ballAt(s: Snapshot, b: Ball, m: number): { x: number; y: number; z: number; r: number } {
  let { x, y, z, r } = b;
  for (let l = b.d + 1; l <= m; l++) {
    x *= K;
    y *= K;
    r *= K;
    z = (z - s.zOrigin(l)) * K;
  }
  return { x, y, z, r };
}

/** union-find floating count over one level's window */
function floatingOf(c: Map<number, Col>, w: Win, where: string[], m: number, parentFloat: Set<number> | null, fcols: Set<number>, contact: ((X: number, Y: number, lo: number, hi: number) => number) | null): { n: number; fresh: number; marginal: number; at: number[] | null } {
  const id = new Map<number, number>();
  const parent: number[] = [];
  const rooted: boolean[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const join = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent[ra] = rb;
    rooted[rb] = rooted[rb] || rooted[ra];
  };
  for (const [key, col] of c) {
    const X = key % 65536;
    const Y = Math.floor(key / 65536);
    const rim = X === w.gx || Y === w.gy || X === w.gx + w.n - 1 || Y === w.gy + w.n - 1;
    id.set(key, parent.length);
    for (let i = 0; i < col.mat.length; i++) {
      parent.push(parent.length);
      rooted.push(i === 0 || rim);
    }
  }
  for (const [key, col] of c) {
    const base = id.get(key)!;
    // touching in the column (two solid records with a shared bound)
    for (let i = 1; i < col.mat.length; i++) if (col.z0[i] <= col.z1[i - 1]) join(base + i, base + i - 1);
    for (const nk of [key + 1, key + 65536]) {
      const nc = c.get(nk);
      if (!nc) continue;
      const nb = id.get(nk)!;
      for (let i = 0; i < col.mat.length; i++)
        for (let j = 0; j < nc.mat.length; j++) if (Math.min(col.z1[i], nc.z1[j]) - Math.max(col.z0[i], nc.z0[j]) > 0) join(base + i, nb + j);
    }
  }
  let n = 0;
  const comps = new Map<number, { n: number; x0: number; x1: number; y0: number; y1: number; lo: number; hi: number; th: number; inherited: boolean; contact: number }>();
  for (const [key, col] of c) {
    const base = id.get(key)!;
    const X = key % 65536;
    const Y = Math.floor(key / 65536);
    for (let i = 0; i < col.mat.length; i++) {
      const r = find(base + i);
      if (rooted[r]) continue;
      n++;
      fcols.add(key);
      const q = comps.get(r) ?? { n: 0, x0: X, x1: X, y0: Y, y1: Y, lo: 1e30, hi: -1e30, th: 0, inherited: false, contact: 0 };
      // (inherited: the parent has a floating record in this column's parent cell or one round it)
      if (parentFloat)
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (parentFloat.has((Math.floor(Y / K) + dy) * 65536 + Math.floor(X / K) + dx)) q.inherited = true;
      q.n++;
      q.x0 = Math.min(q.x0, X);
      q.x1 = Math.max(q.x1, X);
      q.y0 = Math.min(q.y0, Y);
      q.y1 = Math.max(q.y1, Y);
      q.lo = Math.min(q.lo, col.z0[i]);
      q.hi = Math.max(q.hi, col.z1[i]);
      q.th = Math.max(q.th, col.z1[i] - col.z0[i]);
      if (contact) q.contact = Math.max(q.contact, contact(X, Y, col.z0[i], col.z1[i]));
      comps.set(r, q);
    }
  }
  let fresh = 0;
  let marginal = 0;
  for (const q of comps.values()) {
    const thin = !q.inherited && q.contact < CONTACT;
    if (thin) marginal += q.n;
    else if (!q.inherited) fresh += q.n;
    if (where.filter((s) => s.startsWith('float')).length < 6) where.push(`float L${m} ${q.n} records over ${q.x0}..${q.x1}, ${q.y0}..${q.y1}, z ${q.lo.toFixed(2)}..${q.hi.toFixed(2)}, thickest ${q.th.toFixed(3)}${q.inherited ? ' (its parent floats there)' : thin ? ` (its parent holds on by ${q.contact.toFixed(3)})` : ' NEW'}`);
  }
  const first = [...comps.values()].find((q) => !q.inherited);
  return { n, fresh, marginal, at: first ? [first.x0, first.y0] : null };
}

/** the three counts over every live level (balls: carves whose volume must be air at the end, at every finer level) */
export async function measure(g: GpuNest, balls: Ball[], dbg = false): Promise<Measure> {
  const s = await g.readAll();
  const where: string[] = [];
  let inAir = 0;
  let inBall = 0;
  let floating = 0;
  const per: string[] = [];
  let parentCols: Map<number, Col> | null = null;
  let parentFloat: Set<number> = new Set();
  let fresh = 0;
  let marginal = 0;
  for (let m = 0; m < g.live; m++) {
    const w = g.wins[m]!;
    const c = cols(s, m, w);
    let a = 0;
    let b = 0;
    if (m >= 1) {
      const z0 = s.zOrigin(m);
      const pw = g.wins[m - 1]!;
      const pc = (X: number, Y: number): Col | undefined => (X < pw.gx || Y < pw.gy || X >= pw.gx + pw.n || Y >= pw.gy + pw.n ? undefined : parentCols!.get(Y * 65536 + X));
      for (const [key, col] of c) {
        const X = key % 65536;
        const Y = Math.floor(key / 65536);
        const px = Math.floor(X / K);
        const py = Math.floor(Y / K);
        for (let i = 1; i < col.mat.length; i++) {
          const lo = z0 + col.z0[i] / K;
          const hi = z0 + col.z1[i] / K;
          let met = false;
          const own = pc(px, py);
          for (let dy = -1; dy <= 1 && !met; dy++)
            for (let dx = -1; dx <= 1 && !met; dx++) {
              const p = pc(px + dx, py + dy);
              if (!p || !own) {
                met = true;
                break;
              }
              for (let j = 0; j < p.mat.length; j++) if (Math.min(hi, p.z1[j]) - Math.max(lo, p.z0[j]) > -0.05) met = true;
              // (enhance interpolates a record between its parent's and a same-structure neighbour's: within their hull)
              if (same(col, own) && same(p, own) && Math.min(hi, Math.max(own.z1[i], p.z1[i])) - Math.max(lo, Math.min(own.z0[i], p.z0[i])) > -0.05) met = true;
            }
          if (!met) {
            a++;
            const fmt = (c: Col | undefined, f: (v: number) => number) => (c ? c.mat.map((mm, j) => `${mm}:${j ? f(c.z0[j]).toFixed(2) : '-'}..${f(c.z1[j]).toFixed(2)}`).join(' ') : 'none');
            if (where.filter((s) => s.startsWith('inAir')).length < 5) where.push(`inAir L${m} ${X},${Y} rec ${i}: child (parent units) ${fmt(col, (v) => z0 + v / K)} | parent ${fmt(pc(px, py), (v) => v)}`);
          }
        }
      }
    }
    for (const ball of balls) {
      if (ball.d >= m) continue;
      const B = ballAt(s, ball, m);
      const margin = 1.5 * K ** (m - ball.d);
      const r = B.r - margin;
      if (r <= 0) continue;
      for (const [key, col] of c) {
        const X = key % 65536;
        const Y = Math.floor(key / 65536);
        const dd = Math.hypot(X + 0.5 - B.x, Y + 0.5 - B.y);
        if (dd >= r) continue;
        const h = Math.sqrt(r * r - dd * dd);
        if (col.mat.some((_v, i) => Math.min(col.z1[i], B.z + h) - Math.max(col.z0[i], B.z - h) > 0)) {
          b++;
          if (where.filter((s) => s.startsWith('inBall')).length < 3) where.push(`inBall L${m} ${X},${Y} ball ${JSON.stringify(ball)} span [${(B.z - h).toFixed(2)}, ${(B.z + h).toFixed(2)}] col ${JSON.stringify(col.z1.map((v) => +v.toFixed(2)))}`);
        }
      }
    }
    const fc = new Set<number>();
    // (a child record's parent pieces: the parent records under it that its z-range meets, each with its best contact with
    // a lateral neighbour's or a touching record of its own column; the comp's best)
    const zO = m ? s.zOrigin(m) : 0;
    const pcs = parentCols;
    const contact = (X: number, Y: number, lo: number, hi: number) => {
      const px = Math.floor(X / K);
      const py = Math.floor(Y / K);
      const p = pcs!.get(py * 65536 + px);
      if (!p) return 1e9;
      const a = zO + lo / K - 0.1;
      const b = zO + hi / K + 0.1;
      let best = 0;
      for (let j = 0; j < p.mat.length; j++) {
        if (Math.min(b, p.z1[j]) - Math.max(a, p.z0[j]) <= 0) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nq = pcs!.get((py + dy) * 65536 + px + dx);
          if (!nq) continue;
          for (let i = 0; i < nq.mat.length; i++) best = Math.max(best, Math.min(p.z1[j], nq.z1[i]) - Math.max(p.z0[j], nq.z0[i]));
        }
      }
      return best;
    };
    const f = floatingOf(c, w, where, m, m ? parentFloat : null, fc, m ? contact : null);
    if (m && f.at && dbg) {
      // (bisecting) the new floater's parent cell and its four neighbours, and the children either side of its edges
      const [X, Y] = f.at;
      const z0 = s.zOrigin(m);
      const fmt = (q: Col | undefined, t: (v: number) => number) => (q ? q.mat.map((mm, j) => `${mm}:${j ? t(q.z0[j]).toFixed(3) : '-'}..${t(q.z1[j]).toFixed(3)}`).join(' ') : 'none');
      const px = Math.floor(X / K);
      const py = Math.floor(Y / K);
      for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) where.push(`  parent ${px + dx},${py + dy}: ${fmt(parentCols!.get((py + dy) * 65536 + px + dx), (v) => v)}`);
      for (const [cx, cy] of [[X, Y + 3], [X - 1, Y + 3], [X + 3, Y], [X + 3, Y - 1], [X + 7, Y + 3], [X + 8, Y + 3], [X + 3, Y + 7], [X + 3, Y + 8]]) where.push(`  child ${cx},${cy}: ${fmt(c.get(cy * 65536 + cx), (v) => z0 + v / K)}`);
    }
    per.push(`L${m}: inAir ${a}, inBall ${b}, floating ${f.n} (new ${m ? f.fresh : '-'}, held by a hair ${m ? f.marginal : '-'})`);
    if (m) marginal += f.marginal;
    inAir += a;
    inBall += b;
    floating += f.n;
    // (the root's own floating records are what its edits left; a finer level's count only where its parent has none)
    if (m) fresh += f.fresh;
    parentCols = c;
    parentFloat = fc;
  }
  return { inAir, inBall, floating, fresh, marginal, where, perLevel: per.join('; ') };
}

/** a window of level L (N columns, whole chunks) centred over world (root) position (x, y) */
function winAt(L: number, x: number, y: number): Win {
  const s = K ** L;
  return { gx: Math.round((x * s - N / 2) / 16) * 16, gy: Math.round((y * s - N / 2) / 16) * 16, n: N };
}

export interface ScenarioResult {
  name: string;
  steps: { at: string; m: Measure }[];
}

/** the scenarios of round 10 (the brief's i-v); each on a fresh chain over one root */
export async function carveScenarios(device: GPUDevice, log: (s: string) => void = () => {}, skip: string[] = []): Promise<ScenarioResult[]> {
  const g = new GpuNest(device, K, SEED, 1024, { syncGrow: true });
  for (const op of ['edit', 'promote', 'slide'] as const) {
    const f = (g[op] as (...a: unknown[]) => boolean).bind(g);
    (g as unknown as Record<string, unknown>)[op] = (...a: unknown[]) => {
      if (!f(...a)) throw new Error(`carves: ${op} refused (${g.stats.error})`);
      return true;
    };
  }
  // (?skip=resClear: the round 9 behaviour, for the before and after counts)
  for (const s of skip) g.skip.add(s);
  // (?skip=oldTop: derive's top surface as round 9 had it)
  if (skip.includes('oldTop')) g.oldTop = 1;
  g.root(ROOT);
  // (?skip=only:ii,only:iv: those scenarios alone, while bisecting)
  const want = (n: string) => !skip.some((s) => s.startsWith('only:')) || skip.includes(`only:${n}`);
  const out: ScenarioResult[] = [];
  const clear = () => {
    for (let m = g.live - 1; m >= 1; m--) g.demote(m);
  };
  /** the top of level m's column under world (x, y), in m's local units */
  const topAt = async (m: number, x: number, y: number) => {
    const s = await g.readAll();
    const c = s.column(m, Math.floor(x * K ** m), Math.floor(y * K ** m));
    return c.z1[c.z1.length - 1];
  };
  /** a ball at level d over world (x, y), z in d's units; carve or add */
  const ball = (op: 'carve' | 'add', d: number, x: number, y: number, z: number, rWorld: number): Ball => {
    const w = g.wins[d]!;
    const s = K ** d;
    g.edit({ op, radius: rWorld, amount: 0, at: { level: d, x: x * s - w.gx, y: y * s - w.gy, z } });
    return { d, x: x * s, y: y * s, z, r: rWorld * s };
  };
  const promoteOver = (L: number, x: number, y: number) => {
    for (let m = g.live - 1; m >= L; m--) g.demote(m);
    for (let m = g.live; m <= L; m++) g.promote(m, winAt(m, x, y));
  };
  const step = async (r: ScenarioResult, at: string, balls: Ball[]) => {
    const m = await measure(g, balls, skip.includes('dbg'));
    r.steps.push({ at, m });
    log(`${r.name} / ${at}: inAir ${m.inAir}, inBall ${m.inBall}, floating ${m.floating}, new floating ${m.fresh}, held by a hair ${m.marginal} (${m.perLevel})${m.where.length ? `\n    ${m.where.join('\n    ')}` : ''}`);
  };

  // (i) carve at the root (a crater, and a cave with a thin roof just under the surface), then a level and two open over it
  if (want('i')) {
    const r: ScenarioResult = { name: '(i) carve at the root, zoom in', steps: [] };
    clear();
    const A = { x: 100.3, y: 140.6 };
    const t = await topAt(0, A.x, A.y);
    const balls = [ball('carve', 0, A.x, A.y, t + 0.5, 3), ball('carve', 0, A.x + 6, A.y + 0.4, (await topAt(0, A.x + 6, A.y)) - 3.3, 3)];
    await step(r, 'root only', balls);
    promoteOver(1, A.x + 3, A.y);
    await step(r, 'level 1 open', balls);
    promoteOver(2, A.x + 2.6, A.y);
    await step(r, 'level 2 over the crater rim', balls);
    promoteOver(2, A.x + 6 - 2.4, A.y + 0.4);
    await step(r, 'level 2 over the cave rim', balls);
    out.push(r);
  }
  // (ii) carve at level 1 (a crater and a cave), drop it, carve the same places at the root (containing, partly
  // overlapping), zoom back in
  if (want('ii')) {
    const r: ScenarioResult = { name: '(ii) fine carve, demote, coarse carve over it, promote', steps: [] };
    clear();
    const B = { x: 130.5, y: 120.5 };
    promoteOver(1, B.x + 2.5, B.y);
    const t1 = await topAt(1, B.x, B.y);
    ball('carve', 1, B.x, B.y, t1 - 1, 0.6);
    const t2 = await topAt(1, B.x + 5, B.y);
    ball('carve', 1, B.x + 5, B.y, t2 - 0.6 * K - 1.5, 0.6);
    await step(r, 'fine carves made', []);
    g.demote(1);
    const T1 = await topAt(0, B.x, B.y);
    const T2 = await topAt(0, B.x + 7.7, B.y);
    // (the first contains the fine crater; the second overlaps the fine cave's end)
    const balls = [ball('carve', 0, B.x, B.y, T1, 3), ball('carve', 0, B.x + 7.7, B.y, T2 - 1, 3)];
    await step(r, 'coarse carves made, level 1 dropped', balls);
    promoteOver(1, B.x + 2.5, B.y);
    await step(r, 'level 1 again', balls);
    promoteOver(2, B.x + 4.8, B.y);
    await step(r, 'level 2 over the partly overlapping carve', balls);
    out.push(r);
  }
  // (iii) add at level 1 (on the ground, and a blob in mid-air), drop it, carve them away at the root, promote
  if (want('iii')) {
    const r: ScenarioResult = { name: '(iii) fine add, demote, coarse carve, promote', steps: [] };
    clear();
    const C = { x: 160.5, y: 100.5 };
    promoteOver(1, C.x, C.y);
    const t = await topAt(1, C.x, C.y);
    ball('add', 1, C.x - 0.5, C.y, t + 1, 0.6);
    ball('add', 1, C.x + 0.5, C.y + 0.3, t + 12, 0.5);
    await step(r, 'fine adds made', []);
    g.demote(1);
    const T = await topAt(0, C.x, C.y);
    const balls = [ball('carve', 0, C.x, C.y, T + 1, 3.5)];
    await step(r, 'coarse carve made, level 1 dropped', balls);
    promoteOver(1, C.x, C.y);
    await step(r, 'level 1 again', balls);
    promoteOver(2, C.x + 0.3, C.y + 0.3);
    await step(r, 'level 2 again', balls);
    out.push(r);
  }
  // (iv) a tunnel through a mound at the root; levels over its mouth and its middle
  if (want('iv')) {
    const r: ScenarioResult = { name: '(iv) a tunnel through a mound at the root', steps: [] };
    clear();
    const s = await g.readAll();
    let best = { x: 0, y: 0, t: -1e9 };
    for (let y = 60; y < 200; y += 2)
      for (let x = 60; x < 200; x += 2) {
        const c = s.column(0, x, y);
        const t = c.z1[c.z1.length - 1];
        if (t > best.t) best = { x, y, t };
      }
    const D = { x: best.x + 0.5, y: best.y + 0.5 };
    const balls: Ball[] = [];
    // the floor height of the tunnel: 4 under the mound's top, straight along x for 24 columns
    for (let i = -12; i <= 12; i++) balls.push(ball('carve', 0, D.x + i, D.y, best.t - 4, 1.6));
    // the mouth: the first ball whose span reaches over the ground
    let mouth = D.x - 12;
    for (let i = -12; i <= 0; i++) {
      const tt = s.column(0, Math.floor(D.x + i), Math.floor(D.y));
      if (tt.z1[tt.z1.length - 1] > best.t - 4 + 1.6) {
        mouth = D.x + i;
        break;
      }
    }
    await step(r, `root only (mound top ${best.t.toFixed(1)} at ${D.x},${D.y}; mouth near x ${mouth})`, balls);
    promoteOver(1, mouth, D.y);
    await step(r, 'level 1 over the mouth', balls);
    promoteOver(2, mouth, D.y + 1.2);
    await step(r, 'level 2 over the mouth', balls);
    promoteOver(1, D.x, D.y);
    await step(r, 'level 1 over the middle', balls);
    promoteOver(2, D.x, D.y + 1.4);
    await step(r, 'level 2 over the middle (the wall)', balls);
    out.push(r);
  }
  // (v) live levels: fine caves at levels 2 and 1, then a root carve containing them while both are open
  if (want('v')) {
    const r: ScenarioResult = { name: '(v) coarse carve over live finer levels with their own edits', steps: [] };
    clear();
    const E = { x: 70.5, y: 180.5 };
    promoteOver(2, E.x, E.y);
    const t2 = await topAt(2, E.x, E.y);
    ball('carve', 2, E.x, E.y, t2 - 0.08 * 64 - 2, 0.08);
    const t1 = await topAt(1, E.x + 0.6, E.y);
    ball('carve', 1, E.x + 0.6, E.y, t1 - 0.4 * K - 1, 0.4);
    ball('add', 1, E.x - 0.6, E.y, t1 + 10, 0.3);
    await step(r, 'fine edits made', []);
    const T = await topAt(0, E.x, E.y);
    const balls = [ball('carve', 0, E.x, E.y, T, 3)];
    await step(r, 'root carve over both live levels', balls);
    g.demote(1);
    promoteOver(2, E.x, E.y);
    await step(r, 'both promoted again', balls);
    out.push(r);
  }
  return out;
}

/** the self-test's checks from the scenarios: nothing of a finer level in its parent's air, nothing left in a carved
 *  ball at any finer level, no floating solid where the sequence left none (a blob added in mid-air floats until carved) */
export async function carveChecks(device: GPUDevice, log: (s: string) => void = () => {}, skip: string[] = []): Promise<{ name: string; pass: boolean; detail: string }[]> {
  const t0 = performance.now();
  const rs = await carveScenarios(device, log, skip);
  const ms = performance.now() - t0;
  // (the steps right after fine edits are not judged: a fine add's blob lies in its parent's air and floats, as made)
  const after = (f: (m: Measure) => number) => (s: { at: string; m: Measure }) => (s.at.startsWith('fine') ? 0 : f(s.m));
  const sum = (f: (s: { at: string; m: Measure }) => number) => rs.reduce((a, r) => a + r.steps.reduce((b, s) => b + f(s), 0), 0);
  const per = (f: (s: { at: string; m: Measure }) => number) => rs.map((r) => `${r.name.split(' ')[0]} ${r.steps.map(f).join('/')}`).join(', ');
  const air = after((m) => m.inAir);
  const fl = after((m) => m.fresh);
  return [
    { name: "carves across levels (round 10): no record of a finer level lies wholly in the air of its parent column and the parent's neighbours (scenarios i-v: coarse carves zoomed into, fine carves and adds under a later coarse carve, a tunnel through a mound, a coarse carve over live levels)", pass: sum(air) === 0, detail: `${sum(air)} records; per step ${per(air)}; ${(ms / 1000).toFixed(1)} s` },
    { name: "carves across levels: a carve removes its volume at every finer level (no solid inside a carved ball shrunk by 1.5 of the carving level's columns)", pass: sum((s) => s.m.inBall) === 0, detail: `${sum((s) => s.m.inBall)} columns; per step ${per((s) => s.m.inBall)}` },
    { name: "carves across levels: no new solid floats on a finer level (every solid interval reaches the ground or the window's rim) where its parent is held (by more than 2 x the detail's reach), after the carves", pass: sum(fl) === 0, detail: `${sum(fl)} intervals; per step ${per(fl)}; children of a parent piece held by a hair (NS-92, not judged) ${per(after((m) => m.marginal))}; all floating (a carve's own slivers at its level and their children included) ${per((s) => s.m.floating)}` },
  ];
}
