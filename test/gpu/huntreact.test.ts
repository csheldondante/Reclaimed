// (U2 FC11, docs/design/UNIT_MINDS_U2.md §5b) Reaction latency, the acceptance number: frames from a target change to
// the hunter turning toward its new target, by the GPU-seeded hunt field. (FC11 (a), steering straight at a target
// within a radius, was measured and dropped: no faster near a target, where the field is fresh — DEVLOG, U2 §5b.)
//   HUNT_LOG=<file> appends the numbers; SWEEPS=N relax sweeps a tick (default the low tier's 2). FRONTCAP=N, RELAXK=N,
//   BLOCKRELAX=0, JFA=1|2, JFAR=R and JFALOS=bisect run it with ?frontcap / ?relaxk / ?blockrelax / ?jfa / ?jfar /
//   ?jfalos (FC11 (b), FC12): the page's flags are read as the agents module loads, so this file sets them first and
//   imports the game's code after.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { testGpu, type TestGpu } from './dawn';

// (the measurement toggles as the page's flags: FRONTCAP → ?frontcap, RELAXK → ?relaxk, BLOCKRELAX → ?blockrelax)
const flags = new URLSearchParams();
for (const [env, flag] of [['FRONTCAP', 'frontcap'], ['RELAXK', 'relaxk'], ['BLOCKRELAX', 'blockrelax'], ['JFA', 'jfa'], ['JFAR', 'jfar'], ['JFALOS', 'jfalos']] as const) if (process.env[env]) flags.set(flag, process.env[env]!);
if ([...flags].length) Object.defineProperty(globalThis, 'location', { value: new URL(`http://localhost/?${flags}`), configurable: true });
const { MAT } = await import('../../src/world/materials');
const { tinyMap } = await import('../support/tinymap');
const { tinyWorld } = await import('./world');
const { installAgents } = await import('../../src/agents/install');

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 128;
const H = 128;
const UF = 24;
const HUNT = 7;
const slotOf = (id: number) => id % 8192;
const LOG = process.env.HUNT_LOG;
const log = (m: string) => LOG && appendFileSync(LOG, `${m}\n`);
/** the variant's flags, for the log */
const variant = () =>
  `cap ${process.env.FRONTCAP ?? 32} sweeps ${process.env.SWEEPS ?? 2} block ${process.env.BLOCKRELAX ?? 1} k ${process.env.RELAXK ?? 16} jfa ${process.env.JFA ?? 0} r ${process.env.JFAR ?? '-'} los ${process.env.JFALOS ?? 'trace'}`;

/**
 * One hunter between two prey on a flat 128² map: A nearer (its target), B the other way. Once the field has filled
 * and it walks toward A, A dies. The frames until notice gives it B (`retarget`); until its velocity has a part toward B
 * at all (`turning`: > 0.1 cells/s — braking alone never gets there; units.wgsl eases velocity at 6/s, so a unit
 * walking at 3 cells/s that wants B at once crosses in ~7 frames: the floor); until it moves toward B (`moving`: within
 * ~45° of B, faster than 0.5 cells/s). `gap`: cells from the hunter to A (B gap + 2 the other way); `y` its row.
 */
async function reaction(gap: number, y: number) {
  const map = tinyMap(W, H, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  agents.notice.setRules({ on: false, open: false, heightLimit: 1.6, leash: 1000 });
  agents.gpuHunt(HUNT);
  agents.follow(1, -1);
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
  };
  // (SWEEPS=N: relax sweeps a tick — the low tier's 2 by default, as the phone)
  if (process.env.SWEEPS) agents.sweeps = Number(process.env.SWEEPS);
  agents.defineKind(3, { name: 'hunter', height: 1.2, mass: 1, hp: 10, speed: 3, reach: 1.2, damage: 1, swingPeriod: 1, notice: 1000 });
  agents.follow(2, HUNT);
  const P: [number, number] = [64, y];
  const ta: [number, number] = [P[0] + gap, P[1]];
  const tb: [number, number] = [P[0] - gap - 2, P[1]];
  const [a] = agents.spawn(1, ta[0], ta[1], { kind: 0, group: 1, spread: 0 });
  const [b] = agents.spawn(1, tb[0], tb[1], { kind: 0, group: 1, spread: 0 });
  const [h] = agents.spawn(1, P[0], P[1], { kind: 3, group: 2, spread: 0 });
  frame(20);
  agents.notice.set(slotOf(a), { faction: 0, hostile: false, sight: 0 });
  agents.notice.set(slotOf(b), { faction: 0, hostile: false, sight: 0 });
  agents.notice.set(slotOf(h), { faction: 1, hostile: true, sight: 400 });
  const row = async () => {
    const u = new Float32Array(await agents.readRaw('units'));
    const wd = new Uint32Array(u.buffer);
    const o = slotOf(h) * UF;
    return { at: [u[o], u[o + 1]] as const, vel: [u[o + 4], u[o + 5]] as const, target: wd[o + 21] };
  };
  const along = (r: Awaited<ReturnType<typeof row>>, t: readonly [number, number]) => {
    const dx = t[0] - r.at[0];
    const dy = t[1] - r.at[1];
    return (r.vel[0] * dx + r.vel[1] * dy) / Math.hypot(dx, dy);
  };
  const toward = (r: Awaited<ReturnType<typeof row>>, id: number, t: readonly [number, number]) => {
    const sp = Math.hypot(r.vel[0], r.vel[1]);
    return r.target === id + 1 && sp > 0.5 && along(r, t) / sp > 0.7;
  };
  // settled: the field filled (a hostile chases only once the field at its feet is within its notice — units.wgsl
  // WANDER → CHASE), then walking toward A
  frame(30);
  let settled = -1;
  for (let f = 0; f < 240 && settled < 0; f++) {
    frame(1);
    if (toward(await row(), a, ta)) settled = f;
  }
  expect(settled, 'the hunter never walked toward A').toBeGreaterThanOrEqual(0);
  agents.hit({ unit: a, x: 0, y: 0, radius: 0, damage: 1000 });
  let retarget = -1;
  let turning = -1;
  let moving = -1;
  for (let f = 1; f <= 240 && moving < 0; f++) {
    frame(1);
    const r = await row();
    if (retarget < 0 && r.target === b + 1) retarget = f;
    if (turning < 0 && r.target === b + 1 && along(r, tb) > 0.1) turning = f;
    if (toward(r, b, tb)) moving = f;
  }
  expect(g.takeErrors()).toEqual([]);
  return { gap, y, retarget, turning, moving };
}

test('reaction latency: frames from a target change to the hunter turning toward its new target, by the field', async () => {
  const out = [];
  for (const gap of [6, 40]) for (const y of [40, 60, 80]) out.push(await reaction(gap, y));
  log(`reaction ${variant()} ${JSON.stringify(out)}`);
  for (const r of out) {
    expect(r.retarget, JSON.stringify(r)).toBeGreaterThan(0);
    expect(r.turning, JSON.stringify(r)).toBeGreaterThan(0);
  }
  // (FC12's gate: at the steering's floor, near or 40 cells off, at the low tier's 2 sweeps. The floor: notice's frame,
  // then the velocity's easing at 6/s from 3 cells/s through zero — 8–9 frames measured near. With block relaxation
  // (K 16) a change crosses a chunk a sweep: 40 cells measured 9–10 frames; relax's front kernel took 11–27 there)
  for (const r of out) expect(r.turning, JSON.stringify(r)).toBeLessThanOrEqual(10);
});

// ---- (FC12 variants) the field against a CPU breadth-first search after a target change, on three maps ----
type MapKind = 'open' | 'wall' | 'sbend';
/** a wall column (12 above the ground: no link up, a drop down) */
function walled(kind: MapKind, x: number, y: number): boolean {
  if (kind === 'wall') return x >= 62 && x <= 64 && !(y >= 60 && y <= 64);
  if (kind === 'sbend') return (y >= 40 && y <= 42 && !(x >= 100 && x <= 108)) || (y >= 84 && y <= 86 && !(x >= 20 && x <= 28));
  return false;
}
/** hunter, its first target A (near), the next B (far: across the wall, round the bends) — cells */
const PLACES: Record<MapKind, { h: [number, number]; a: [number, number]; b: [number, number]; rows: [number, number]; cols: [number, number] }> = {
  // (rows, cols: the agents' scope on this map — the units' cells ± SCOPE_MARGIN, whole chunks; outside it every field
  // is FAR. An earlier version compared the S-bend's left 16 columns, outside its scope, and failed there by the timing
  // of the scope's own read)
  open: { h: [20, 64], a: [24, 68], b: [110, 64], rows: [16, H], cols: [0, W] },
  wall: { h: [20, 64], a: [24, 68], b: [110, 64], rows: [16, H], cols: [0, W] },
  sbend: { h: [64, 118], a: [70, 122], b: [64, 10], rows: [0, H], cols: [16, W] },
};

async function mapCase(kind: MapKind) {
  const { cellPos, nbr } = await import('../../src/world/lattice');
  const map = tinyMap(W, H, 32, (x: number, y: number) => [{ z0: 0, z1: walled(kind, x, y) ? 22 : 10, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  agents.notice.setRules({ on: false, open: false, heightLimit: 1.6, leash: 1000 });
  agents.gpuHunt(HUNT);
  // (U2 round 5: seen-only is on by default — the hunt seeds only what a hunter saw. This test measures the field's
  // answer to a seed change against a BFS, behind a wall the hunter can't see through: every noticed target seeds it,
  // as before — seen-only off, made explicit. What seen-only seeds is los.test.ts's)
  agents.seenOnly = false;
  agents.follow(1, -1);
  agents.follow(2, -1);
  if (process.env.SWEEPS) agents.sweeps = Number(process.env.SWEEPS);
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
  };
  const P = PLACES[kind];
  const at = (c: [number, number]) => cellPos(c[0], c[1]);
  const [a] = agents.spawn(1, ...at(P.a), { kind: 0, group: 1, spread: 0 });
  const [b] = agents.spawn(1, ...at(P.b), { kind: 0, group: 1, spread: 0 });
  const [h] = agents.spawn(1, ...at(P.h), { kind: 1, group: 2, spread: 0 });
  frame(20);
  agents.notice.set(slotOf(a), { faction: 0, hostile: false, sight: 0 });
  agents.notice.set(slotOf(b), { faction: 0, hostile: false, sight: 0 });
  agents.notice.set(slotOf(h), { faction: 1, hostile: true, sight: 400 });
  frame(60);
  // the BFS from B over the ground (the wall's columns blocked)
  const ref = new Float32Array(W * H).fill(Infinity);
  ref[P.b[1] * W + P.b[0]] = 0;
  let q: [number, number][] = [P.b];
  while (q.length) {
    const next: [number, number][] = [];
    for (const [x, y] of q)
      for (let k = 0; k < 6; k++) {
        const [nx, ny] = nbr(x, y, k);
        if (nx < P.cols[0] || ny < P.rows[0] || nx >= P.cols[1] || ny >= P.rows[1] || walled(kind, nx, ny) || ref[ny * W + nx] !== Infinity) continue;
        ref[ny * W + nx] = ref[y * W + x] + 1;
        next.push([nx, ny]);
      }
    q = next;
  }
  const cells: number[] = [];
  // (inside the scope, the window's outer ring left out)
  for (let y = Math.max(P.rows[0], 1); y < P.rows[1] - 1; y++) for (let x = Math.max(P.cols[0], 1); x < P.cols[1] - 1; x++) if (!walled(kind, x, y) && Number.isFinite(ref[y * W + x])) cells.push(y * W + x);
  const worstGap = async () => {
    const reader = agents.reader(HUNT);
    await reader.refresh();
    let worst = 0;
    let under = 0;
    let ok = 0;
    for (const c of cells) {
      const [px, py] = cellPos(c % W, Math.floor(c / W));
      const got = reader.sample(px, py)?.dist ?? Infinity;
      worst = Math.max(worst, Math.abs(got - ref[c]));
      if (got < ref[c] - 0.01) under++;
      if (Math.abs(got - ref[c]) <= 1) ok++;
    }
    if (process.env.HUNT_DIAG && worst > 1) {
      const bad = cells.filter((c) => {
        const [px, py] = cellPos(c % W, Math.floor(c / W));
        return Math.abs((reader.sample(px, py)?.dist ?? Infinity) - ref[c]) > 1;
      });
      log(`diag ${kind} bad ${bad.length} e.g. ${bad.slice(0, 6).map((c) => { const [px, py] = cellPos(c % W, Math.floor(c / W)); return `${c % W},${Math.floor(c / W)} got ${reader.sample(px, py)?.dist.toFixed(1)} want ${ref[c]}`; }).join('; ')}`);
    }
    // (ok: the share of the ground within a step of the BFS — the first frame's is how much the start got right)
    return { worst, under, ok: +(ok / cells.length).toFixed(3) };
  };
  /** the JFA's resolved ground (?jfa=1/2: plane 5) and how many of its values sit under the BFS's — never allowed */
  const resolved = async () => {
    const u = new Float32Array(await agents.readRaw('jfa'));
    const o = 8 + 5 * W * H;
    let n = 0;
    let under = 0;
    let over = 0;
    for (const c of cells) {
      const v = u[o + c];
      if (!(v < 1e8)) continue;
      n++;
      if (v < ref[c] - 0.01) under++;
      over = Math.max(over, v / Math.max(ref[c], 1));
    }
    return { fraction: +(n / cells.length).toFixed(3), under, over: +over.toFixed(2) };
  };
  const row = async () => new Uint32Array(await agents.readRaw('units'))[slotOf(h) * UF + 21];
  agents.hit({ unit: a, x: 0, y: 0, radius: 0, damage: 1000 });
  let retarget = -1;
  let first: { worst: number; under: number; ok: number } | null = null;
  let jfa: Awaited<ReturnType<typeof resolved>> | null = null;
  let match = -1;
  for (let f = 1; f <= 120 && match < 0; f++) {
    frame(1);
    if (retarget < 0) {
      if ((await row()) === b + 1) retarget = f;
      continue;
    }
    const gap = await worstGap();
    if (!first) {
      first = gap;
      if (process.env.JFA) jfa = await resolved();
    }
    if (gap.worst <= 1) match = f;
  }
  expect(g.takeErrors()).toEqual([]);
  return { kind, retarget, match, first, jfa };
}

test('the hunt field against a breadth-first search after a target change: open ground, a wall with one gap, an S-bend', async () => {
  const out = [];
  for (const kind of ['open', 'wall', 'sbend'] as const) out.push(await mapCase(kind));
  log(`maps ${variant()} ${JSON.stringify(out)}`);
  for (const r of out) {
    expect(r.match, JSON.stringify(r)).toBeGreaterThan(0);
    // (a JFA start is an achievable path: never under the BFS)
    if (r.jfa) expect(r.jfa.under, JSON.stringify(r)).toBe(0);
  }
});
