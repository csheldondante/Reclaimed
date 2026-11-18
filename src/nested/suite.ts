// Nested scales lab: the watertight suite (test only; readbacks), run by ?selftest=1 after the oracle checks and by
// scripts/nested-watertight.mjs. On the sandbox's own scene (k = 8) it builds the test shapes at level 1, each with
// the brushes the sandbox uses (forced hits): a mound with a tunnel through it, a blob on a stalk, a blob in mid-air, an
// arch, and a carve stroke that crosses the rim between level 1 and the root. Then (i) the manifold check of every live
// level's faces at eyes that open the finer levels round each shape (the tunnel crosses the level-2 and level-3 rims),
// and (ii) the screen check: hole pixels below the horizon over 40 poses, sampled 1, 2 and 6 frames after each move
// (promotes and slides happen in those frames) and after it settles.
import type { Check } from './selftest';
import type { EdgeReport } from './watertight';

/** the sandbox's test API (app.ts api()) as the suite uses it */
interface Api {
  app: {
    nest: {
      wins: ({ gx: number; gy: number; n: number } | null)[];
      edit(s: { op: string; radius: number; amount: number; at: { level: number; x: number; y: number; z?: number } }): boolean;
      strokeBegin(): void;
      strokeEnd(): void;
      readAll(): Promise<{ zOrigin(L: number): number; column(lid: number, X: number, Y: number): { z1: number[] } }>;
    };
    forward(): [number, number, number];
    frameCount: number;
  };
  eye(): { x: number; y: number; z: number; dHit: number };
  setView(v: { yaw: number; pitch: number; eye?: [number, number, number]; tx?: number; ty?: number; d?: number }): void;
  manifold(): Promise<EdgeReport[]>;
  holes(): Promise<{ rows: number[]; h: number; at: [number, number][] }>;
  state(): { live: number; stats: Record<string, unknown> };
  cruise?(on: boolean, wps?: number): void;
}

const W = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frames = async (api: Api, n: number) => {
  const f = api.app.frameCount + n;
  while (api.app.frameCount < f) await W(4);
};

export interface SuiteResult {
  checks: Check[];
  lines: string[];
  /** the worst pose (screen check) */
  worst: { n: number; pose: number; view: unknown };
}

export async function watertightSuite(api: Api, opt: { manifold?: boolean; screen?: boolean; cruise?: boolean; log?: (s: string) => void } = {}): Promise<SuiteResult> {
  const log = opt.log ?? (() => {});
  const lines: string[] = [];
  const say = (s: string) => {
    lines.push(s);
    log(s);
  };
  const a = api.app;
  // the scene round the point the sandbox looks at
  const e = api.eye();
  const f = a.forward();
  const h: [number, number, number] = [e.x + f[0] * e.dHit, e.y + f[1] * e.dHit, e.z + f[2] * e.dHit];
  const snap = await a.nest.readAll();
  const zo = snap.zOrigin(1);
  const w1 = a.nest.wins[1]!;
  const k = 8;
  const ed = async (op: string, x: number, y: number, z: number, r: number, level = 1) => {
    const w = a.nest.wins[level]!;
    const s = k ** level;
    const zz = level === 0 ? z : (z - zo) * k;
    while (!a.nest.edit({ op, radius: r, amount: 0, at: { level, x: x * s - w.gx, y: y * s - w.gy, z: zz } })) await W(30);
  };
  await ed('add', h[0], h[1], h[2] + 1.2, 2.2);
  for (let t = -3.2; t <= 3.2; t += 0.3) await ed('carve', h[0] - t, h[1], h[2] + 1.3, 0.75);
  for (let z = 0.2; z <= 2.6; z += 0.2) await ed('add', h[0], h[1] + 5, h[2] + z, 0.3);
  await ed('add', h[0], h[1] + 5, h[2] + 3.4, 1.0);
  await ed('add', h[0] + 4, h[1] - 5, h[2] + 3.0, 0.8);
  // the arch: a wall of adds, then a carve under its middle
  for (let t = -1.6; t <= 1.6; t += 0.4) await ed('add', h[0] - 6, h[1] + t, h[2] + 1.0, 1.0);
  await ed('carve', h[0] - 6, h[1], h[2] + 0.3, 0.9);
  // a carve stroke across the rim between level 1 and the root (along x at level 1's left edge, half a root unit deep)
  {
    const s0 = await a.nest.readAll();
    const ry = Math.floor(w1.gy / k + w1.n / k / 2);
    const top = (x: number) => {
      const c = s0.column(0, Math.floor(x), ry);
      return c.z1[c.z1.length - 1];
    };
    const x0 = w1.gx / k;
    a.nest.strokeBegin();
    for (let x = x0 + 2.5; x > x0 - 2.5; x -= 0.25) {
      const lvl = x > x0 + 0.3 ? 1 : 0;
      await ed('carve', x, ry + 0.5, top(x) - 0.2, 0.5, lvl);
    }
    a.nest.strokeEnd();
  }
  await W(300);
  const [hx, hy, hz] = h;
  const tz = hz + 1.3;
  say(`scene at ${h.map((v) => v.toFixed(2)).join(', ')}; stats ${JSON.stringify(api.state().stats)}`);
  const checks: Check[] = [];
  if (opt.manifold !== false) {
    const eyes: Record<string, { yaw: number; pitch: number; eye: [number, number, number] }> = {
      'mound outside': { yaw: 0, pitch: 0.03, eye: [hx + 7, hy, tz + 0.2] },
      'tunnel inside (depth 2-3)': { yaw: 0, pitch: 0.0, eye: [hx + 0.3, hy, tz - 0.1] },
      'tunnel mouth (rim crossing)': { yaw: 0, pitch: 0.05, eye: [hx + 2.6, hy + 0.2, tz] },
      'blob on a stalk': { yaw: 0, pitch: 0.1, eye: [hx + 6, hy + 5, hz + 2.5] },
      'mid-air blob': { yaw: Math.PI / 2, pitch: 0.2, eye: [hx + 4, hy - 8, hz + 3.5] },
      arch: { yaw: Math.PI, pitch: 0.1, eye: [hx - 9, hy, hz + 1.2] },
      'stroke across the rim': { yaw: 0, pitch: 0.6, eye: [w1.gx / k + 3, w1.gy / k + w1.n / k / 2 - 3, hz + 4] },
      'the map': { yaw: 0.6, pitch: 0.7, eye: [hx + 60, hy + 40, hz + 70] },
    };
    let openAll = 0;
    for (const [name, v] of Object.entries(eyes)) {
      api.setView(v);
      await frames(api, 3);
      for (const when of ['3 frames after the move', 'settled']) {
        if (when === 'settled') await W(1500);
        const rep = await api.manifold();
        const open = rep.reduce((s, r) => s + r.open, 0);
        openAll += open;
        say(`manifold ${name} (${when}): ${rep.map((r) => `L${r.depth} ${r.tris} tris, ${r.edges} edges, odd ${r.open}, shared by 4+ ${r.over}, degenerate ${r.degenerate}${r.open ? ` at ${JSON.stringify(r.where.slice(0, 3))}` : ''}`).join('; ')}`);
      }
    }
    checks.push({ name: 'manifold: every edge of every level\'s faces shared by an even number of triangles (open world bottom aside), 8 eyes, just after the move and settled', pass: openAll === 0, detail: `${openAll} odd edges in total` });
  }
  let worst = { n: 0, pose: -1, view: null as unknown };
  if (opt.screen !== false) {
    const poses: { yaw: number; pitch: number; eye: [number, number, number] }[] = [];
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * 2 * Math.PI;
      const r = i % 2 ? 4 : 7;
      poses.push({ yaw: t, pitch: 0.55, eye: [hx + 1 + Math.cos(t) * r, hy + 2.5 + Math.sin(t) * r, hz + 2.5 + (i % 3)] });
    }
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * 2 * Math.PI;
      poses.push({ yaw: t, pitch: 0.9, eye: [hx + Math.cos(t) * 2, hy + Math.sin(t) * 2, hz + 3.5] });
    }
    for (let i = 0; i < 12; i++) poses.push({ yaw: Math.PI / 2 + (i % 2 ? Math.PI : 0), pitch: 0.2 + 0.1 * (i % 3), eye: [hx - 2 + i * 0.35, hy, tz] });
    let all = 0;
    for (let p = 0; p < poses.length; p++) {
      api.setView(poses[p]);
      for (const n of [1, 2, 6, 60]) {
        await frames(api, n === 1 ? 1 : n === 2 ? 1 : n === 6 ? 4 : 54);
        const hl = await api.holes();
        const tn = Math.tan((50 * Math.PI) / 360);
        let c = 0;
        // rows whose ray points 0.1 rad or more below the horizon
        for (let y = 0; y < hl.h; y++) {
          const ny = 1 - ((y + 0.5) / hl.h) * 2;
          const dz = -Math.sin(poses[p].pitch) + ny * tn * Math.cos(poses[p].pitch);
          if (dz / Math.hypot(1, ny * tn) < -0.1) c += hl.rows[y];
        }
        all += c;
        if (c > 0) say(`pose ${p} after ${n} frames: ${c} hole pixels, first at ${JSON.stringify(hl.at)}; live ${api.state().live}`);
        if (c > worst.n) worst = { n: c, pose: p, view: poses[p] };
      }
    }
    checks.push({ name: 'screen: no hole pixels below the horizon over 40 poses, 1, 2, 6 and 60 frames after each move (promotes and slides in between)', pass: all === 0, detail: `${all} hole pixels${worst.pose >= 0 ? `; worst pose ${worst.pose} with ${worst.n}` : ''}` });
  }
  // (round 7) poses sampled during a cruise at 1 and 4 finest-window widths a second (slides, shrinks in between)
  if (opt.screen !== false && opt.cruise !== false && api.cruise) {
    let all = 0;
    let n = 0;
    const tn = Math.tan((50 * Math.PI) / 360);
    for (const wps of [1, 4]) {
      // (1.2 back from the ground along the view: depth 2 open, under its promote distance of 1.8)
      api.setView({ yaw: Math.PI / 2 + 0.4, pitch: 1.0, tx: hx - 3, ty: hy - 6, d: 1.2 });
      // (settled first: every wanted level open, so the speed is in widths of the depth-2 window)
      await frames(api, 240);
      say(`cruise ${wps} w/s from ${api.state().live} levels open`);
      api.cruise(true, wps);
      const t0 = performance.now();
      while (performance.now() - t0 < 4000) {
        await frames(api, 7);
        const hl = await api.holes();
        let c = 0;
        for (let y = 0; y < hl.h; y++) {
          const ny = 1 - ((y + 0.5) / hl.h) * 2;
          const dz = -Math.sin(1.0) + ny * tn * Math.cos(1.0);
          if (dz / Math.hypot(1, ny * tn) < -0.1) c += hl.rows[y];
        }
        n++;
        all += c;
        if (c > 0) say(`cruise ${wps} w/s sample ${n}: ${c} hole pixels, first at ${JSON.stringify(hl.at)}; live ${api.state().live}`);
      }
      api.cruise(false);
    }
    checks.push({ name: 'screen: no hole pixels below the horizon in poses sampled during cruises at 1 and 4 w/s', pass: all === 0, detail: `${all} hole pixels over ${n} samples` });
  }
  return { checks, lines, worst };
}
