// Nested scales lab (tests only, NS-86): the store under a seeded random sequence of ops on the sandbox: jumps of the
// view (promotes, demotes), pans (slides), carves on any live level, forced grows and forced shrinks. Every few ops, once
// the pool has settled: the pool's books (Snapshot.audit), every column of every live window has records, and the
// coverage check (every column in view drawn by exactly one level). Readbacks here are test-only.
import type { GpuNest } from './gpu/nest';

interface Api {
  app: { nest: GpuNest; frameCount: number; frozen: boolean };
  setView(v: { tx?: number; ty?: number; d?: number; yaw?: number; pitch?: number }): void;
  state(): { live: number; stats: Record<string, unknown> };
  coverage(): Promise<{ stale: number; missing: number; where: string[] }>;
}

export interface StressResult {
  ops: Record<string, number>;
  checks: number;
  emptyCols: number;
  coverage: number;
  audit: number;
  lines: string[];
}

const W = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function storeStress(api: Api, opt: { n?: number; seed?: number; every?: number; log?: (s: string) => void } = {}): Promise<StressResult> {
  const n = opt.n ?? 300;
  const every = opt.every ?? 25;
  let s = (opt.seed ?? 1) >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const nest = api.app.nest;
  const lines: string[] = [];
  const say = (t: string) => {
    lines.push(t);
    opt.log?.(t);
  };
  const frames = async (k: number) => {
    const f = api.app.frameCount + k;
    while (api.app.frameCount < f) await W(4);
  };
  const settle = async () => {
    for (let i = 0; i < 400 && !nest.settled; i++) await frames(1);
  };
  const ops: Record<string, number> = {};
  const res: StressResult = { ops, checks: 0, emptyCols: 0, coverage: 0, audit: 0, lines };
  let tx = 100;
  let ty = 140;
  type Snap = Awaited<ReturnType<GpuNest['readAll']>>;
  let tops: Snap | null = null;
  const check = async (i: number) => {
    await settle();
    await frames(8);
    await settle();
    // (the levels held still while the readbacks are awaited)
    api.app.frozen = true;
    try {
      const snap = await nest.readAll();
      tops = snap;
      const au = snap.audit(nest.cap);
      const bad = au.overCap + au.shared + au.freeHeld + au.freeTwice + au.pending;
      let empty = 0;
      const where: string[] = [];
      for (let L = 0; L < nest.live; L++) {
        const w = nest.wins[L]!;
        for (let Y = w.gy; Y < w.gy + w.n; Y++)
          for (let X = w.gx; X < w.gx + w.n; X++)
            if (!snap.records(L, X, Y).top.length) {
              empty++;
              if (where.length < 4) where.push(`L${L} ${X},${Y}`);
            }
      }
      const cov = await api.coverage();
      res.checks++;
      res.emptyCols += empty;
      res.audit += bad;
      res.coverage += cov.stale + cov.missing;
      if (bad || empty || cov.stale + cov.missing || res.checks % 4 === 1)
        say(`after op ${i}: ${nest.live} levels, cap ${nest.cap}; books ${bad ? JSON.stringify(au) : 'clean'}; empty columns ${empty} ${where.join(' ')}; coverage stale ${cov.stale} missing ${cov.missing}; stats ${JSON.stringify(api.state().stats)}`);
    } finally {
      api.app.frozen = false;
    }
  };
  for (let i = 1; i <= n; i++) {
    const r = rnd();
    let kind: string;
    if (r < 0.2) {
      // a jump: a new place and height (promotes and demotes)
      kind = 'jump';
      tx = 24 + rnd() * 208;
      ty = 24 + rnd() * 208;
      api.setView({ tx, ty, d: [0.5, 1.2, 3, 8, 30, 120][Math.floor(rnd() * 6)], yaw: rnd() * 6.28, pitch: 0.5 + rnd() * 0.9 });
      await frames(6 + Math.floor(rnd() * 20));
    } else if (r < 0.45) {
      // a pan (slides)
      kind = 'pan';
      tx = Math.min(232, Math.max(24, tx + (rnd() - 0.5) * 8));
      ty = Math.min(232, Math.max(24, ty + (rnd() - 0.5) * 8));
      api.setView({ tx, ty });
      await frames(2 + Math.floor(rnd() * 10));
    } else if (r < 0.75) {
      // a carve on a live level, inside its window, at its surface
      kind = 'carve';
      const L = Math.floor(rnd() * nest.live);
      const w = nest.wins[L]!;
      const x = 8 + rnd() * (w.n - 16);
      const y = 8 + rnd() * (w.n - 16);
      // (world units: 0.2 to 2.7 of that level's columns)
      const radius = (0.2 + rnd() * 2.5) / 8 ** L;
      // (z: an approximation of the surface: the forced hit's height in that level's units, dug from a little above)
      // (the tops from a snapshot taken now and then, read again when this column is not in it: the window moved)
      const top = (sn: Snap) => {
        const c = sn.column(L, w.gx + Math.floor(x), w.gy + Math.floor(y));
        return c.z1.length ? c.z1[c.z1.length - 1] : null;
      };
      let snapTop = tops ? top(tops) : null;
      if (snapTop === null) {
        await settle();
        tops = await nest.readAll();
        snapTop = top(tops) ?? 0;
      }
      let tries = 0;
      await settle();
      while (!nest.edit({ op: rnd() < 0.85 ? 'carve' : 'add', radius, amount: 0, at: { level: L, x, y, z: snapTop - rnd() * 3 } }) && tries++ < 200) await frames(1);
      await frames(1 + Math.floor(rnd() * 4));
    } else if (r < 0.88) {
      // a forced shrink: steps until the pool is at its target (between ops, as the sandbox does)
      kind = 'shrink';
      await settle();
      for (let k = 0; k < 40; k++) {
        await settle();
        if (!nest.shrink()) break;
        await frames(1);
      }
    } else {
      // a forced grow ahead (test only: the private request), applied at the next op's reserve
      kind = 'grow';
      (nest as unknown as { requestGrow(t: number): void }).requestGrow(nest.cap + 256 + Math.floor(rnd() * 1024));
      await frames(2);
    }
    ops[kind] = (ops[kind] ?? 0) + 1;
    if (i % every === 0) await check(i);
  }
  await check(n);
  return res;
}
