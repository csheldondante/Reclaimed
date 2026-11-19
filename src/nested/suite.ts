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
  eye(): { x: number; y: number; z: number; dHit: number; dNear: number };
  setView(v: { yaw: number; pitch: number; eye?: [number, number, number]; tx?: number; ty?: number; d?: number }): void;
  manifold(): Promise<EdgeReport[]>;
  /** (round 11) the triangles round a pixel */
  holeDiag?(x: number, y: number, w: number, h: number): Promise<string[]>;
  holes(): Promise<{ rows: number[]; h: number; w: number; mask: Uint8Array; at: [number, number][] }>;
  state(): { live: number; stats: Record<string, unknown> };
  cruise?(on: boolean, wps?: number): void;
  sculpt?(op: string, nx: number, ny: number, times?: number, px?: number): void;
  coverage?(): Promise<{ stale: number; missing: number; where: string[] }>;
  fly?(x: number, y: number, z: number): void;
}

/** the hole pixels (no surface) on rays at least 0.1 rad below the horizon, where ground must be, at a pitch (the
 *  screen check's rule, shared by every pose list) */
export async function groundHoles(api: Api, pitch: number, world?: Ground): Promise<{ n: number; at: [number, number][]; w: number; h: number }> {
  const hl = await api.holes();
  const tn = Math.tan((50 * Math.PI) / 360);
  let n = 0;
  if (!world) {
    for (let y = 0; y < hl.h; y++) {
      const ny = 1 - ((y + 0.5) / hl.h) * 2;
      const dz = -Math.sin(pitch) + ny * tn * Math.cos(pitch);
      if (dz / Math.hypot(1, ny * tn) < -0.1) n += hl.rows[y];
    }
    return { n, at: hl.at, w: hl.w, h: hl.h };
  }
  // (round 8) a ray below the horizon from a high eye can leave the world over its edge (the root's 256 columns): ground
  // is expected only where the ray, marched over the root's tops, goes under them inside the world (or starts under
  // them: an eye in a pit or a cave)
  const { mask, w, h } = hl;
  const at: [number, number][] = [];
  const e = api.eye();
  const yaw = world.yaw;
  const f = [-Math.cos(pitch) * Math.cos(yaw), -Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch)];
  const rl = Math.hypot(f[1], f[0]);
  // (as the camera pass: right = normalize(cross(forward, z)), up = cross(right, forward))
  const r = [f[1] / rl, -f[0] / rl, 0];
  const up = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const aspect = w / h;
  const under = e.z < world.top(e.x, e.y);
  for (let y = 0; y < h; y++) {
    if (!hl.rows[y]) continue;
    const ny = 1 - ((y + 0.5) / h) * 2;
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const nx = ((x + 0.5) / w) * 2 - 1;
      const d = [0, 1, 2].map((i) => f[i] + r[i] * nx * tn * aspect + up[i] * ny * tn);
      const dl = Math.hypot(d[0], d[1], d[2]);
      if (d[2] / dl >= -0.1) continue;
      let hit = under;
      for (let t = 0; !hit && t < 2000; t += 0.25) {
        const px = e.x + (d[0] / dl) * t;
        const py = e.y + (d[1] / dl) * t;
        if (px < 0 || py < 0 || px >= world.n0 || py >= world.n0) break;
        // (a root column under the root's top: the finer levels' detail stays within about a root column of it)
        if (e.z + (d[2] / dl) * t < world.top(px, py) - 1.0) hit = true;
      }
      if (!hit) continue;
      n++;
      if (at.length < 8) at.push([x, y]);
    }
  }
  return { n, at, w, h };
}
/** the root's tops for groundHoles (world units = root columns) */
export interface Ground {
  yaw: number;
  n0: number;
  top(x: number, y: number): number;
}
async function rootGround(api: Api): Promise<(yaw: number) => Ground> {
  const s = await api.app.nest.readAll();
  const n0 = 256;
  const tops = new Float32Array(n0 * n0);
  for (let Y = 0; Y < n0; Y++)
    for (let X = 0; X < n0; X++) {
      const c = s.column(0, X, Y);
      tops[Y * n0 + X] = c.z1.length ? c.z1[c.z1.length - 1] : -1e9;
    }
  return (yaw: number) => ({ yaw, n0, top: (x, y) => tops[Math.floor(y) * n0 + Math.floor(x)] });
}

type View = { yaw: number; pitch: number; eye: [number, number, number] };
/** (round 8, the owner's sky-through-ground report) a pit dug by repeated carve taps at the screen's centre at a large
 *  size (frac of the nearest distance), followed down along the aim; at each depth the view down, level all round and
 *  back up and out; then a cave carved sideways from the pit's floor and the view back out of its mouth; then the same
 *  poses again after a cruise away and back, and after a zoom out (demotes) and back. Hole pixels below the horizon. */
export async function pitAndCave(api: Api, opt: { frac?: number; taps?: number; d0?: number; tx?: number; ty?: number; images?: boolean; log?: (s: string) => void; shaftsOnly?: boolean; diag?: boolean; rebake?: boolean; after?: boolean } = {}): Promise<{ total: number; firstFrame: number; lines: string[]; poses: number; worstViews: { name: string; n: number; view: View; img?: unknown }[]; coverage: number }> {
  const a = api.app as unknown as Api['app'] & { brushFrac: number; queue: unknown[]; opLog: { what: string; at: number }[]; nest: { live: number; stats: Record<string, number> } };
  const lines: string[] = [];
  const say = (s: string) => {
    lines.push(s);
    opt.log?.(s);
  };
  const frac = opt.frac ?? 1;
  const taps = opt.taps ?? 8;
  const views: { name: string; n: number; view: View; img?: unknown }[] = [];
  let total = 0;
  /** (information, round 18) hole pixels 1 frame after each teleport, summed */
  let firstFrame = 0;
  let poses = 0;
  const look = async (name: string, view: View) => {
    api.setView(view);
    await frames(api, 4);
    let worst = 0;
    let at: [number, number][] = [];
    const per: number[] = [];
    let img: unknown = null;
    // (round 18, orchestrator decision awaiting the owner's ruling, NS-127 / NS-135) the gate counts the SETTLED view:
    // the level ops the pose triggered have finished, then 3 still frames. The count 1 frame after the teleport is
    // reported as information only: with only a coarse level open, a narrow deep shaft is pinched shut by the accepted
    // collapse rule, and a teleported eye sits under that sheet until the finer level opens.
    for (const n of [1, 0]) {
      if (n) await frames(api, n);
      else {
        await settle(api, a);
        await frames(api, 3);
      }
      const h = await groundHoles(api, view.pitch, ground?.(view.yaw));
      per.push(h.n);
      if (n) {
        firstFrame += h.n;
        continue;
      }
      if (h.n > worst) {
        worst = h.n;
        at = h.at;
        img = opt.images && views.length < 6 ? (api as unknown as { holeImage(): unknown }).holeImage() : null;
      }
      // (round 11, NS-97) the triangles round the first hole pixel
      if (opt.diag && h.n > 0 && h.n < 50) {
        const dg = await (api as unknown as { holeDiag(x: number, y: number, w: number, h: number): Promise<string[]> }).holeDiag(h.at[0][0], h.at[0][1], h.w, h.h);
        say(`${name}: diag at ${JSON.stringify(h.at[0])} eye ${JSON.stringify(api.eye())}\n  ${dg.join('\n  ')}`);
      }
      // (round 17, NS-127: the discriminator, test only) at the settled check of a pose with holes: the eye on each level
      // (in its window? inside a solid record?), then every window baked again and the holes counted again: holes that go
      // were a missed bake region, holes that stay are the geometry (the eye where the sheets say solid, or a gap)
      if (opt.rebake && h.n > 0) {
        const x = api as unknown as { probeCam(): Promise<unknown>; rebakeAll(): Promise<void>; holeDiag(x: number, y: number, w: number, h: number): Promise<string[]>; chunkTris(): Promise<Record<string, number>> };
        // (the levels held still for the whole diagnosis: no op may run between the counts)
        const app = api.app as unknown as { frozen: boolean };
        const fz = app.frozen;
        app.frozen = true;
        const winsAt = JSON.stringify((api.state() as unknown as { wins: unknown }).wins);
        const opsAt = (a.opLog as { what: string; depth?: number; win?: { gx: number; gy: number } | null }[]).slice(-8).map((o) => `${o.what} L${o.depth}${o.win ? ` (${o.win.gx},${o.win.gy})` : ''}`).join(', ');
        const pc = await x.probeCam();
        const dg = await x.holeDiag(h.at[0][0], h.at[0][1], h.w, h.h);
        const t0 = await x.chunkTris();
        // first 3 frames with nothing baked (a draw-side transient goes here), then the forced bake
        await frames(api, 3);
        const hStill = await groundHoles(api, view.pitch, ground?.(view.yaw));
        await x.rebakeAll();
        await frames(api, 3);
        const h2 = await groundHoles(api, view.pitch, ground?.(view.yaw));
        // the chunks the forced bake changed (drawn triangles before -> after): the missed region
        const t1 = await x.chunkTris();
        app.frozen = fz;
        const diff = [...new Set([...Object.keys(t0), ...Object.keys(t1)])].filter((key) => (t0[key] ?? 0) !== (t1[key] ?? 0));
        say(`${name} (settled): ${h.n} hole pixels; held still 3 frames, nothing baked: ${hStill.n}${hStill.n ? '' : ' (gone: a draw-side transient, not a bake)'}; after a forced bake of every window: ${h2.n}${h2.n ? ' (stays: geometry)' : hStill.n ? ' (gone: a missed bake region)' : ''}; wins ${winsAt}; ops before ${opsAt}; chunks the forced bake changed (${diff.length}): ${diff.slice(0, 40).map((key) => `${key} ${t0[key] ?? 0}->${t1[key] ?? 0}`).join('; ')}; eye per level ${JSON.stringify(pc)}; first hole ${JSON.stringify(h.at.slice(0, 3))} of ${h.w}x${h.h}; triangles round it:\n  ${dg.slice(0, 12).join('\n  ')}`);
      }
    }
    poses++;
    total += worst;
    if (worst > 0) {
      say(`${name}: ${per.join(' at 1 frame (information), settled ')} hole pixels (live ${api.state().live}, wins ${JSON.stringify((api.state() as unknown as { wins: unknown }).wins)}, eye ${view.eye.map((v) => v.toFixed(3)).join(', ')}, yaw ${view.yaw.toFixed(2)}, pitch ${view.pitch.toFixed(2)}) first at ${JSON.stringify(at.slice(0, 3))}`);
      views.push({ name, n: worst, view, img });
    }
  };
  const here = (): [number, number, number] => {
    const e = api.eye();
    return [e.x, e.y, e.z];
  };
  const edits = () => a.opLog.filter((o) => o.what === 'edit').length;
  const tap = async () => {
    const e0 = edits();
    api.sculpt!('carve', 0, 0);
    for (let i = 0; i < 400 && edits() === e0; i++) await frames(api, 1);
    await frames(api, 20);
  };
  // along the aim by most of the way to the surface at the centre (Fwd), limited by the GPU as any move
  const fwd = async (part: number) => {
    for (let i = 0; i < 40; i++) {
      const f = a.forward();
      const d = api.eye().dHit;
      if (d <= 0) break;
      const s = (part * d) / 40;
      api.fly!(f[0] * s, f[1] * s, f[2] * s);
      await frames(api, 1);
    }
    await frames(api, 30);
  };
  let ground: ((yaw: number) => Ground) | null = null;
  // every column in view drawn by exactly one level (after the pit, the cave, the shafts, a cruise, a demote)
  let covBad = 0;
  const cover = async (when: string) => {
    if (!api.coverage) return;
    const c = await api.coverage();
    covBad += c.stale + c.missing;
    say(`coverage ${when}: ${api.state().live} levels, stale caps ${c.stale}, columns with no cap ${c.missing}${c.where.length ? ` (${c.where.join('; ')})` : ''}`);
    // (round 11) the manifold check and the rim lines here too (the shafts cross level rims): counted with coverage
    const rep = await api.manifold();
    const bad = rep.reduce((s, r) => s + r.open + (r.rim ? r.rim.junctions + r.rim.unflagged : 0), 0);
    covBad += bad;
    say(`manifold ${when}: odd edges ${rep.reduce((s, r) => s + r.open, 0)}, rim ${JSON.stringify(rep.map((r) => r.rim && { lines: r.rim.lines, junctions: r.rim.junctions, unflagged: r.rim.unflagged, where: r.rim.where }))}`);
  };
  const around = async (name: string, eye: [number, number, number], yaw0: number) => {
    ground = await rootGround(api);
    await look(`${name} down`, { yaw: yaw0, pitch: 1.45, eye });
    for (let i = 0; i < 4; i++) await look(`${name} level ${i}`, { yaw: yaw0 + (i * Math.PI) / 2, pitch: 0.25, eye });
    for (let i = 0; i < 4; i++) await look(`${name} out ${i}`, { yaw: yaw0 + (i * Math.PI) / 2, pitch: -0.35, eye });
  };
  const tx = opt.tx ?? 70;
  const ty = opt.ty ?? 120;
  api.setView({ tx, ty, d: opt.d0 ?? 8, yaw: 0.3, pitch: 1.35 });
  await frames(api, 240);
  say(`pit at ${tx}, ${ty}: ${api.state().live} levels open, dNear ${api.eye().dNear.toFixed(3)}; brush ${frac} of the nearest distance`);
  a.brushFrac = frac;
  const pitEyes: [number, number, number][] = [];
  // (round 11: shaftsOnly skips the pit and the cave, for the narrow hole check)
  for (let t = 0; t < (opt.shaftsOnly ? 0 : taps); t++) {
    api.setView({ yaw: 0.3, pitch: 1.35 });
    await frames(api, 3);
    await tap();
    await fwd(0.7);
    const eye = here();
    pitEyes.push(eye);
    say(`tap ${t + 1}: eye ${eye.map((v) => v.toFixed(3)).join(', ')}, dNear ${api.eye().dNear.toFixed(3)}, ${api.state().live} levels`);
    await around(`pit tap ${t + 1}`, eye, 0.3);
  }
  // a cave: carve sideways from the pit's floor (level aim), following it in, then look back out of its mouth
  let cave: [number, number, number] | null = null;
  if (!opt.shaftsOnly) {
    const floor = pitEyes[pitEyes.length - 1];
    api.setView({ yaw: 1.2, pitch: 0.05, eye: floor });
    await frames(api, 30);
    for (let t = 0; t < 4; t++) {
      api.setView({ yaw: 1.2, pitch: 0.05 });
      await frames(api, 3);
      await tap();
      await fwd(0.6);
    }
    cave = here();
    say(`cave: eye ${cave.map((v) => v.toFixed(3)).join(', ')}, ${api.state().live} levels`);
    await around('cave', cave, 1.2 + Math.PI);
    await cover('in the cave');
  }
  // shafts: forced carves straight down far below any level's old bottom (the root's was -8), one inside level 1's
  // window and one across its rim; the eye at the bottom, deep in the ground, looks down, level round and out
  const shafts: { name: string; eye: [number, number, number] }[] = [];
  {
    const snap = await a.nest.readAll();
    const zo = snap.zOrigin(1);
    const w1 = a.nest.wins[1]!;
    const k = 8;
    const ed = async (x: number, y: number, z: number, r: number, level: number) => {
      const w = a.nest.wins[level]!;
      const s = k ** level;
      const zz = level === 0 ? z : (z - zo) * k;
      while (!a.nest.edit({ op: 'carve', radius: r, amount: 0, at: { level, x: x * s - w.gx, y: y * s - w.gy, z: zz } })) await W(30);
    };
    const top = (x: number, y: number) => {
      const c = snap.column(0, Math.floor(x), Math.floor(y));
      return c.z1[c.z1.length - 1];
    };
    const sites: [string, number, number, number][] = [
      ['shaft inside', w1.gx / k + w1.n / k / 2 + 6, w1.gy / k + w1.n / k / 2 - 6, 1],
      ['shaft across the rim', w1.gx / k + 0.3, w1.gy / k + w1.n / k / 2 + 4, 1],
    ];
    for (const [name, x, y, level] of sites) {
      const z0 = top(x, y) + 1;
      for (let z = z0; z > -24; z -= 1.5) await ed(x, y, z, 2.2, level);
      shafts.push({ name, eye: [x + 0.5, y + 0.5, -20] });
      say(`${name}: carved at ${x.toFixed(2)}, ${y.toFixed(2)} from ${z0.toFixed(2)} down to -24 (world), level 1 z origin ${zo.toFixed(2)}`);
    }
    await frames(api, 30);
    for (const s of shafts) {
      for (const z of [-20, -10]) await around(`${s.name} at ${z}`, [s.eye[0], s.eye[1], z], 0.3);
    }
    await cover('in the rim shaft');
  }
  const shrinks = () => (api.state().stats as Record<string, number>).shrinks ?? 0;
  // after a cruise away and back
  if (opt.after === false) {
    say(`shafts: ${total} hole pixels below the horizon over ${poses} poses, settled (1 frame after each teleport, information: ${firstFrame}); coverage faults ${covBad}`);
    return { total, firstFrame, lines, poses, worstViews: views, coverage: covBad };
  }
  if (api.cruise) {
    api.setView({ yaw: 0.3, pitch: 1.0, tx, ty, d: 1.5 });
    await frames(api, 120);
    api.cruise(true, 2);
    await W(4000);
    api.cruise(false);
    await frames(api, 60);
    await cover('after the cruise (slides)');
    say(`after a cruise: pool ${JSON.stringify(api.state().stats)}`);
    for (const [i, e] of pitEyes.entries()) if (i % 3 === 2 || i === pitEyes.length - 1) await around(`post-cruise pit ${i + 1}`, e, 0.3);
    if (cave) await around('post-cruise cave', cave, 1.2 + Math.PI);
    for (const s of shafts) await around(`post-cruise ${s.name}`, [s.eye[0], s.eye[1], -20], 0.3);
  }
  // after a zoom out (demotes), the pool's shrinks, and back
  const s0 = shrinks();
  api.setView({ yaw: 0.3, pitch: 1.0, tx, ty, d: 80 });
  await frames(api, 240);
  for (let i = 0; i < 40 && shrinks() === s0; i++) await frames(api, 30);
  await cover('zoomed out (demoted)');
  say(`zoomed out: ${api.state().live} levels; ${shrinks() - s0} shrink steps since; pool ${JSON.stringify(api.state().stats)}`);
  for (const [i, e] of pitEyes.entries()) if (i % 3 === 2 || i === pitEyes.length - 1) await around(`post-demote pit ${i + 1}`, e, 0.3);
  for (const s of shafts) await around(`post-shrink ${s.name}`, [s.eye[0], s.eye[1], -20], 0.3);
  await cover('back in the shaft after the demote and shrinks');
  views.sort((x, y) => y.n - x.n);
  say(`pit and cave: ${total} hole pixels below the horizon over ${poses} poses, settled (1 frame after each teleport, information: ${firstFrame}); coverage faults ${covBad}`);
  return { total, firstFrame, lines, poses, worstViews: views, coverage: covBad };
}

/** (round 18) wait until the level ops a pose triggered have finished: no promote, slide, demote or refused op for 10
 *  frames running and none in flight (at most 600 frames) */
const settle = async (api: Api, a: { opLog: { what: string; at: number }[]; nest: unknown }) => {
  const app = a as unknown as { refusedAt?: number[]; nest: { settled: boolean } };
  const sig = () => {
    let last = 0;
    for (let i = a.opLog.length - 1; i >= 0; i--)
      if (a.opLog[i].what === 'promote' || a.opLog[i].what === 'slide' || a.opLog[i].what === 'demote') {
        last = a.opLog[i].at;
        break;
      }
    const r = app.refusedAt;
    return `${last}:${r && r.length ? r[r.length - 1] : 0}`;
  };
  let s = sig();
  let still = 0;
  for (let i = 0; i < 600 && still < 10; i++) {
    await frames(api, 1);
    const t = sig();
    still = t === s && app.nest.settled ? still + 1 : 0;
    s = t;
  }
};

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
    let covAll = 0;
    let rimAll = 0;
    let rimLines = 0;
    for (const [name, v] of Object.entries(eyes)) {
      api.setView(v);
      await frames(api, 3);
      for (const when of ['3 frames after the move', 'settled']) {
        if (when === 'settled') await W(1500);
        const rep = await api.manifold();
        const open = rep.reduce((s, r) => s + r.open, 0);
        openAll += open;
        // (round 11, NS-97) no T-junction across a rim line, no parent vertex there in its own units
        const rj = rep.reduce((s, r) => s + (r.rim ? r.rim.junctions + r.rim.unflagged : 0), 0);
        rimAll += rj;
        if (rj) say(`rim lines ${name} (${when}): ${JSON.stringify(rep.map((r) => r.rim))}`);
        if (when === 'settled' && api.coverage) {
          const c = await api.coverage();
          covAll += c.stale + c.missing;
          if (c.stale + c.missing) say(`coverage ${name}: stale caps ${c.stale}, columns with no cap ${c.missing} (${c.where.join('; ')})`);
        }
        rimLines += rep.reduce((s, r) => s + (r.rim?.lines ?? 0), 0);
        say(`manifold ${name} (${when}): ${rep.map((r) => `L${r.depth} ${r.tris} tris, ${r.edges} edges, odd ${r.open}, shared by 4+ ${r.over}, degenerate ${r.degenerate}${r.open ? ` at ${JSON.stringify(r.where.slice(0, 3))}` : ''}${r.rim ? `, rim lines ${r.rim.lines} junctions ${r.rim.junctions} unflagged ${r.rim.unflagged}` : ''}`).join('; ')}`);
      }
    }
    checks.push({ name: 'manifold: every edge of every level\'s faces shared by an even number of triangles (no exemption: round 8 has no world bottom), 8 eyes, just after the move and settled', pass: openAll === 0, detail: `${openAll} odd edges in total` });
    checks.push({ name: 'rim lines (round 11, NS-97): both levels split every rim line at the same heights in the child\'s units (no T-junction across a rim, no parent vertex there in its own units), 8 eyes', pass: rimAll === 0 && rimLines > 0, detail: `${rimAll} faults over ${rimLines} rim lines` });
    if (api.coverage) checks.push({ name: 'coverage: every column in view drawn by exactly one level at the 8 eyes, settled', pass: covAll === 0, detail: `${covAll} faults` });
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
