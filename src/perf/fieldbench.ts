// (U2 FC12) The agents' fields' phone bench: block relaxation on the user's Pixel, one tap, no reloads.
//   /?skipmenu=1&level=atlas&town=1&fresh=1&q=low&fieldbench=1   (&benchsecs=3 a window's seconds)
// The default GPU town (Muru). Two armies are stood up on open ground beside it (bench-only spawns through the Units
// contract): raiders (hostile) against guards, facing each other, so they fight. 100 v 100, then 500 v 500 if the first
// held 30 fps. Each phase is a toggle diff (memory "toggle, don't timestamp": a tiler's per-pass timestamps overlap) —
// the frame's interval and the GPU span with a thing one way, then the other, in alternating windows so heat and clocks
// even out — on fresh armies, so each phase's fight starts the same:
//   block16   relaxBlock with K 16 (the default)        against the fields frozen (relax not dispatched)
//   block8    relaxBlock with K 8                       against frozen
//   front     relax's front kernel (the old relax)      against frozen
//   huntgpu   the hunt field's seeds on the GPU on      against off (the CPU's 8 targets), with block16
// (round 3: K 16 decided — block8 and front only with ?benchrelax=1; at 500 v 500 the per-unit GPU cost by toggling —
// draw (the units drawn or not), notice (dispatched or not: targets held), step (every tick or every other); the
// grounds ?benchground=open,walls (default) | open,town | open,walls,town — the LOS phases on each, open the control)
// (stage 2, line of sight on the obstacle JFA's clearance, units.wgsl aimTick)
//   los             melee straight at a target in sight, archers shooting   against block16 alone
//   seenonly        + seen-only targets (seeds at the last-seen place)      against line of sight
//   los+archers, seenonly+archers: the same with ?ranged=N archers among the raiders (default a fifth)
// and per side: the front's asks a sweep, shots and arrows landed, frames from a target in sight to the first shot.
// The fields' cost is each variant less frozen. Each variant's pipelines are made at the bench's start
// (Agents.benchRelax) and switched between, so the run is one tap. A result card and a JSON to download, copy or share
// (and, on the dev server, kept in perf-reports/).
import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, wakeLog } from './bench';
import { postDev } from './report-io';
import type { LivingTowns } from '../citylife/towns';
import type { Profiler } from '../gpu/profiler';
import type { Agents } from '../agents/agents';
import { F, type AgentUnits } from '../units/agent-units';
import type { UnitId, V2 } from '../api/contracts/units';
import { ROW_H, cellAt, cellPos } from '../world/lattice';

const NL = String.fromCharCode(10);
declare const __BUILD_COMMIT__: string;
declare const __BENCH_BUILD__: string;
const BUILD = { commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev', at: typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev' };
const LAST = 'reclaimed.fieldbench.last';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rec {
  core: { host: Parameters<typeof deviceFacts>[0] & { profiler: Profiler }; onShift: ((dx: number, dy: number, dz: number) => void)[] };
  camera: { elevation: number; zoom: number; target: [number, number, number]; project(x: number, y: number, z: number): readonly [number, number] | null };
  agents: Agents;
  world: { w: number; h: number; ring: { idx(x: number, y: number): number } };
  api: { terrain?: { put(x: number, y: number, material: 'Basalt', amount: number): Promise<number> } };
  scene: { livingTowns?: LivingTowns; units?: AgentUnits };
}

/**
 * Open dry ground for the armies near `near` (window world units): rings out from the town past `minR` cells, the
 * highest patch of `w` x `h` cells whose top surfaces all stand dry (water under 0.05) within 2.5 of each other, with no
 * water within 24 cells round it. The surfaces
 * read back once (Agents.readField: the bench's own read, at its start, never in play).
 */
async function openGround(R: Rec, near: V2, minR: number, w: number, h: number): Promise<[number, number, number] | null> {
  const { nav } = await R.agents.readField(F.targets);
  const navF = new Float32Array(nav.buffer);
  const NAV_K = 4;
  const [cx, cy] = cellAt(near[0], near[1]);
  let ground = 0;
  const ok = (x0: number, y0: number) => {
    if (x0 < 4 || y0 < 4 || x0 + w >= R.world.w - 4 || y0 + h >= R.world.h - 4) return false;
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = y0; y < y0 + h; y += 2)
      for (let x = x0; x < x0 + w; x += 2) {
        const s = R.world.ring.idx(x, y) * NAV_K;
        const z = navF[s * 4];
        const water = navF[s * 4 + 3];
        if (!(z >= 0) || water > 0.05) return false;
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
        if (hi - lo > 2.5) return false;
      }
    // (and no water within 24 cells round it: a river or a pond near the patch rises into it and drowns the armies —
    // seen in the first headless runs)
    for (let y = y0 - 24; y < y0 + h + 24; y += 4)
      for (let x = x0 - 24; x < x0 + w + 24; x += 4) {
        if (x < 0 || y < 0 || x >= R.world.w || y >= R.world.h) continue;
        if (navF[R.world.ring.idx(x, y) * NAV_K * 4 + 3] > 0.05) return false;
      }
    ground = lo;
    return true;
  };
  // (of the patches that pass, the highest: water that comes later — a river filling, a thaw — floods the low ones;
  // headless runs drowned every army on low ground ~70 s in)
  let best: [number, number, number] | null = null;
  for (let r = minR; r < minR * 3.5; r += minR * 0.25)
    for (let a = 0; a < 16; a++) {
      const x0 = Math.round(cx + Math.cos((a / 16) * Math.PI * 2) * r - w / 2);
      const y0 = Math.round(cy + Math.sin((a / 16) * Math.PI * 2) * r - h / 2);
      if (ok(x0, y0) && (!best || ground > best[2])) best = [...cellPos(x0 + w / 2, y0 + h / 2), ground];
    }
  return best;
}

interface Side {
  /** the frame's interval (rAF), ms */
  p50: number;
  p95: number;
  mean: number;
  /** the GPU span (the profiler's frame, where the device has timestamps), mean ms */
  gpuMs: number | null;
  frames: number;
  /** the front: chunks that asked to be relaxed, a sweep (Agents.benchCounters) */
  asksPerSweep: number | null;
  /** arrows shot and landed; time to act — the ticks from a shooter's first tick in range and in sight of its target
   *  to its first shot at it (mean; the step records both: units.wgsl AIM_INRANGE); melee steps taken straight at a
   *  target in sight */
  shots: number;
  landed: number;
  toActFrames: number | null;
  directSteps: number;
}
interface Phase {
  name: string;
  /** what "on" and "off" were */
  on: string;
  off: string;
  sides: { on: Side; off: Side };
  /** on less off: frame p50 and mean, GPU span mean (ms) */
  diff: { p50: number; mean: number; gpuMs: number | null };
  /** the fight: alive at the phase's start and end (both armies), deaths in it, and by what (the agents' death events:
   *  a blow or an arrow — the fight — or the world: water, fire, a fall) */
  alive: { start: number; end: number };
  deaths: number;
  causes: Record<string, number>;
  /** the ground it ran on: open (the control), walls (stone walls raised between the armies), town (Muru's streets) */
  ground: string;
  /** of the fighters with a target at the phase's end, the share with it in sight (aimTick's, one read of mail) */
  sightShare: number | null;
  /** engaged: the units with a target at the phase's end (their unit word f.y, one read of the rows a phase — the
   *  bench's own) plus the combat deaths in it */
  targeted: number;
  engaged: number;
  /** a fight: engaged at least MIN_FIGHT of the units. false: "no fight — invalid", its numbers not a fight's (the
   *  phone's first run: no deaths in any phase) */
  valid: boolean;
  /** the fight's chain over the phase, from the agents' events — where it breaks if it does: targets taken (noticed),
   *  swings begun (windup), blows (swing), hurts; and how far 32 of the units moved (mean, cells; observed) */
  chain: { noticed: number; windup: number; swing: number; hurt: number; moved: number };
  /** the headline: the GPU span on and off (ms, mean) and on less off */
  gpu: { on: number | null; off: number | null; diff: number | null };
  /** the frame interval sat at a vsync cap (16.7 / 8.3 ms) on both sides: frame time can't tell them apart */
  vsync: boolean;
  windows: number;
  windowS: number;
}

const WINDOWS = 3;
/** a phase is a fight when at least this share of its units were engaged (a target, or killed in combat) */
const MIN_FIGHT = 0.05;
const pct = (a: number[], q: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : NaN;
};
const r3 = (x: number) => (Number.isFinite(x) ? +x.toFixed(3) : NaN);

/** `set(true)` the thing on; WINDOWS alternating windows each way, `windowS` long */
async function toggled(P: Profiler, agents: Agents, windowS: number, set: (on: boolean) => void): Promise<{ on: Side; off: Side }> {
  const zero = () => ({ asks: 0, sweeps: 0, shots: 0, landed: 0, missed: 0, toActFrames: 0, toActN: 0, direct: 0 });
  const sums = { on: { dt: [] as number[], gpu: [] as number[], c: zero() }, off: { dt: [] as number[], gpu: [] as number[], c: zero() } };
  let side: 'on' | 'off' = 'off';
  let last = 0;
  let live = true;
  let counting = false;
  const tick = (t: number) => {
    if (last && counting) sums[side].dt.push(t - last);
    last = t;
    if (live) requestAnimationFrame(tick);
  };
  P.listen((_f: number, ms: number) => {
    if (live && counting) sums[side].gpu.push(ms);
  });
  requestAnimationFrame(tick);
  for (let k = 0; k < WINDOWS; k++)
    for (const s of ['off', 'on'] as const) {
      set(s === 'on');
      counting = false;
      await sleep(300);
      side = s;
      last = 0;
      // (the counters cleared at the window's start, read at its end: this side's)
      await agents.benchCounters();
      counting = true;
      await sleep(windowS * 1000);
      counting = false;
      const c = await agents.benchCounters();
      const into = sums[s].c as Record<string, number>;
      for (const [k, v] of Object.entries(c)) into[k] += v;
    }
  counting = false;
  live = false;
  const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
  const sideOf = (s: 'on' | 'off'): Side => {
    const c = sums[s].c;
    return {
      p50: r3(pct(sums[s].dt, 0.5)),
      p95: r3(pct(sums[s].dt, 0.95)),
      mean: r3(mean(sums[s].dt)),
      gpuMs: sums[s].gpu.length ? r3(mean(sums[s].gpu)) : null,
      frames: sums[s].dt.length,
      asksPerSweep: c.sweeps ? r3(c.asks / c.sweeps) : null,
      shots: c.shots,
      landed: c.landed,
      toActFrames: c.toActN ? r3(c.toActFrames / c.toActN) : null,
      directSteps: c.direct,
    };
  };
  return { on: sideOf('on'), off: sideOf('off') };
}

/** the archers' kind (agents kind 2, the default ogre's slot AgentUnits doesn't use): a raider who shoots, range 18 */
const ARCHER_KIND = 2;

/** two armies of n facing each other on open ground by the town: raiders (hostile; `archers` of them archers) and
 *  guards */
function armies(units: AgentUnits, agents: Agents, centre: V2, n: number, archers = 0, snap: ((p: V2) => V2) | null = null): UnitId[] {
  const ids: UnitId[] = [];
  const cols = Math.ceil(Math.sqrt(n * 2));
  const grid = (k: number, y0: number, dir: number): V2 => [centre[0] - (cols / 2) * 1.1 + (k % cols) * 1.1, y0 + dir * Math.floor(k / cols) * 1.1 * ROW_H];
  // (the town's ground: each place moved to street level nearby — not a roof)
  const at = (k: number, y0: number, dir: number): V2 => (snap ? snap(grid(k, y0, dir)) : grid(k, y0, dir));
  for (let k = 0; k < n; k++) {
    const id = units.spawn('raider', at(k, centre[1] - 12, -1), 'f-bench-raid', { role: 'raider', hostile: true, sight: 40, health: 3 });
    // (the back rows shoot: made the archers' kind where they stand)
    if (k >= n - archers) agents.rekind(units.recs.get(id)!.gpu, ARCHER_KIND);
    ids.push(id);
  }
  for (let k = 0; k < n; k++) ids.push(units.spawn('guard', at(k, centre[1] + 12, 1), 'f-bench-town', { role: 'guard', sight: 30, health: 3 }));
  return ids;
}

export async function fieldBench(params: URLSearchParams): Promise<void> {
  const R = (window as unknown as { reclaimed: Rec }).reclaimed;
  const panel = new Panel(document.body);
  const held = await keepAwake();
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'fieldbench', 'Reclaimed field bench');
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const windowS = Number(params.get('benchsecs') ?? 3);
  panel.text(`build ${BUILD.commit} (${BUILD.at})`);
  const device = await deviceFacts(R.core.host);
  panel.say('field bench — waiting for the town…');
  let LT: LivingTowns | undefined;
  for (let k = 0; k < 600 && !((LT = R.scene.livingTowns)?.live.size && R.scene.units); k++) await sleep(250);
  const units = R.scene.units;
  if (!LT?.live.size || !units) throw new Error('field bench: no town or no units (the default link: ?skipmenu=1&level=atlas&town=1&fresh=1)');
  const [townId, l] = LT.live.entries().next().value!;
  const agents = R.agents;
  // (the armies on open dry ground near the town, past its radius — big enough for 500 v 500 — and the camera on them)
  const t = R.camera.target;
  const found = (await openGround(R, [t[0], t[1]], l.town.box.R * 1.1, 44, 80)) ?? (await openGround(R, [t[0], t[1]], l.town.box.R * 1.1, 30, 50));
  if (!found) throw new Error('field bench: no open dry ground near the town for the armies');
  const centre: V2 = [found[0], found[1]];
  // (the town's middle, where the level opened: the town ground's place)
  const townAt: [number, number, number] = [t[0], t[1], t[2]];
  R.camera.target = [found[0], found[1], found[2]];
  R.camera.elevation = Math.PI / 3;
  R.camera.zoom = Number(params.get('benchzoom') ?? 14);
  // (the armies' ground in the agents' scope, as a raid's place would be (Agents.keepInScope): the scope otherwise
  // follows the units' box read back every 8 ticks, and fields outside it read no way — no chase, no fight)
  const keep = () => agents.keepInScope('fieldbench', [-30, 30].flatMap((dx) => [-40, 40].map((dy) => [centre[0] + dx, centre[1] + dy] as [number, number])));
  keep();
  // (the camera held on the armies: the season loop's own camera eases toward its districts otherwise — ?seasoncam=0)
  const look: [number, number, number] = [found[0], found[1], found[2]];
  // (the window slides as the camera nears its edge: the armies' place and the camera's move with it, as units do)
  R.core.onShift.push((dx, dy, dz) => {
    townAt[0] -= dx;
    townAt[1] -= dy;
    townAt[2] -= dz;
    look[0] -= dx;
    look[1] -= dy;
    look[2] -= dz;
    centre[0] -= dx;
    centre[1] -= dy;
    keep();
  });
  let holding = true;
  const hold = () => {
    if (!holding) return;
    R.camera.target = [look[0], look[1], look[2]];
    requestAnimationFrame(hold);
  };
  requestAnimationFrame(hold);
  // (the season sheet folded, as its ▾ does: the armies are under where it opens)
  const sheet = document.querySelector('.season-sheet');
  if (sheet && !sheet.classList.contains('folded')) (sheet.querySelector('.s-fold') as HTMLButtonElement | null)?.click();
  // (the GPU-seeded hunt field: the toggle's — and every variant's pipelines made now, before any window)
  agents.gpuHunt(F.targets);
  units.huntGpu = true;
  agents.huntOn = true;
  // (the front's asks and the arrows counted without ?agentprof=1; the archers' kind)
  agents.benchProbe = true;
  agents.defineKind(ARCHER_KIND, { name: 'archer', height: 1.5, mass: 1, hp: 10, speed: 2.8, reach: 0, damage: 1, swingPeriod: 1.2, notice: 160, range: 18 });
  await sleep(3000);
  const P = R.core.host.profiler;
  P.active = true;
  const deaths = { n: 0 };
  units.died.push(() => deaths.n++);
  // (what killed them, and the fight's chain: the agents' events, tapped on their way to AgentUnits — the bench's own tap)
  let causes: Record<string, number> = {};
  let chain = { noticed: 0, windup: 0, swing: 0, hurt: 0 };
  const sync = agents.sync.bind(agents);
  agents.sync = async (o) => {
    const r = await sync(o);
    for (const e of r.events)
      if (e.type === 'death') {
        // (combat: a blow or an arrow — a hit's id or a unit's; the rest is the world's: water, fire, a fall, lava)
        const k = typeof e.by === 'number' ? 'combat' : e.by;
        causes[k] = (causes[k] ?? 0) + 1;
      } else if (e.type === 'noticed' && e.target) chain.noticed++;
      else if (e.type === 'windup') chain.windup++;
      else if (e.type === 'swing') chain.swing++;
      else if (e.type === 'hurt') chain.hurt++;
    return r;
  };
  const aliveOf = (ids: UnitId[]) => ids.filter((id) => units.get(id)?.alive).length;
  const phases: Record<string, Phase[]> = {};
  let ground = 'open';
  let snap: ((p: V2) => V2) | null = null;
  const phase = async (n: number, name: string, on: string, off: string, setOn: (on: boolean) => void, rest: () => void, archers = 0): Promise<Phase> => {
    // (fresh armies a phase: each phase's fight from the same start)
    const ids = armies(units, agents, centre, n, archers, snap);
    await sleep(3000);
    const a0 = aliveOf(ids);
    const d0 = deaths.n;
    causes = {};
    chain = { noticed: 0, windup: 0, swing: 0, hurt: 0 };
    // (32 of them observed: how far they move over the phase — a fight that never starts stands still)
    const watched = ids.filter((_, k) => k % Math.max(1, Math.floor(ids.length / 32)) === 0).slice(0, 32);
    const release = units.observe(watched);
    await sleep(200);
    const at0 = new Map(watched.map((id) => [id, units.get(id)?.at ?? null]));
    panel.say(`field bench — ${n} v ${n}: ${name} (${on} vs ${off}, ${WINDOWS} × ${windowS} s each way)…`);
    const sides = await toggled(P, agents, windowS, setOn);
    // (the windows end on the "on" side: what's read below is read with the thing on; rest() after)
    const losOn = agents.los;
    const moves: number[] = [];
    for (const id of watched) {
      const a = at0.get(id);
      const b = units.get(id)?.at;
      if (a && b) moves.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    release();
    const dead = deaths.n - d0;
    // (how many of them have a target now: one read of the rows, the bench's own, once a phase)
    const rows = new Uint32Array(await agents.readRaw('units'));
    let targeted = 0;
    for (const id of ids) {
      const r = units.recs.get(id);
      if (r && r.v.alive && rows[(r.gpu % 8192) * 24 + 21] !== 0) targeted++;
    }
    const engaged = targeted + (causes.combat ?? 0);
    // (of those with a target, how many have it in sight — aimTick's flags; only with line of sight on)
    let sightShare: number | null = null;
    if (losOn) {
      const mail = new Uint32Array(await agents.readRaw('mail'));
      let withT = 0;
      let seen = 0;
      for (const id of ids) {
        const r = units.recs.get(id);
        if (!r || !r.v.alive) continue;
        const o = 16 + (r.gpu % 8192) * 12;
        if (mail[o + 3] === 0) continue;
        withT++;
        if (mail[o + 7] & 1) seen++;
      }
      sightShare = withT ? r3(seen / withT) : null;
    }
    rest();
    const capped = (s: Side) => [16.667, 8.333].some((c) => Math.abs(s.p50 - c) < 0.35);
    const p: Phase = {
      name,
      on,
      off,
      sides,
      diff: { p50: r3(sides.on.p50 - sides.off.p50), mean: r3(sides.on.mean - sides.off.mean), gpuMs: sides.on.gpuMs !== null && sides.off.gpuMs !== null ? r3(sides.on.gpuMs - sides.off.gpuMs) : null },
      alive: { start: a0, end: aliveOf(ids) },
      deaths: dead,
      causes,
      ground,
      sightShare,
      targeted,
      engaged,
      valid: engaged >= MIN_FIGHT * a0,
      chain: { ...chain, moved: moves.length ? r3(moves.reduce((a, b) => a + b, 0) / moves.length) : 0 },
      gpu: { on: sides.on.gpuMs, off: sides.off.gpuMs, diff: sides.on.gpuMs !== null && sides.off.gpuMs !== null ? r3(sides.on.gpuMs - sides.off.gpuMs) : null },
      vsync: capped(sides.on) && capped(sides.off),
      windows: WINDOWS,
      windowS,
    };
    for (const id of ids) units.remove(id);
    await sleep(500);
    return p;
  };
  const relaxed = (on: boolean) => {
    agents.benchFrozen = !on;
  };
  const restDefault = () => {
    agents.benchFrozen = false;
    agents.benchNoDraw = false;
    agents.benchNoNotice = false;
    agents.benchStepHalf = false;
    agents.huntOn = true;
    units.huntGpu = true;
    agents.los = false;
    agents.seenOnly = false;
  };
  // (the walls ground: on the open patch, stone walls between the armies — two long segments with a gap in the middle
  // and two short ones staggered behind — through the world API's put, as the battle playground's raised wall will)
  const raiseWalls = async () => {
    const T = R.api.terrain;
    if (!T) {
      errors.push('walls: no world terrain API');
      return;
    }
    panel.say('field bench — raising the walls…');
    const segs: [number, number, number][] = [
      [-26, -5, 0],
      [5, 26, 0],
      [-14, -6, -5],
      [6, 14, 5],
    ];
    const cols: [number, number][] = [];
    for (const [x0, x1, dy] of segs) for (let x = x0; x <= x1; x++) for (const r of [0, 1]) cols.push([centre[0] + x, centre[1] + dy + r * ROW_H]);
    for (let i = 0; i < cols.length; i += 48) await Promise.all(cols.slice(i, i + 48).map(([x, y]) => T.put(x, y, 'Basalt', 5)));
    await sleep(2000);
  };
  // (the town ground: the armies either side of the town's middle, through its streets and lots — each place moved to
  // street level nearby (a surface within 1.5 of the town's ground), not a roof; read once, the bench's own)
  const toTown = async () => {
    panel.say('field bench — to the town…');
    const { nav } = await agents.readField(F.targets);
    const navF = new Float32Array(nav.buffer);
    const top = (x: number, y: number) => navF[R.world.ring.idx(x, y) * 4 * 4];
    const [cx, cy] = cellAt(townAt[0], townAt[1]);
    // (the street level: the lowest of the town's middle's tops)
    let street = Infinity;
    for (let y = cy - 20; y <= cy + 20; y += 2) for (let x = cx - 20; x <= cx + 20; x += 2) street = Math.min(street, top(x, y) >= 0 ? top(x, y) : Infinity);
    snap = (p: V2): V2 => {
      const [x, y] = cellAt(p[0], p[1]);
      for (let r = 0; r <= 5; r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const z = top(x + dx, y + dy);
            if (z >= 0 && z <= street + 1.5) return cellPos(x + dx, y + dy);
          }
      return p;
    };
    centre[0] = townAt[0];
    centre[1] = townAt[1];
    look[0] = townAt[0];
    look[1] = townAt[1];
    look[2] = street;
    keep();
  };
  // (stage 2: line of sight — melee straight at a target in sight, archers shooting — and seen-only targets, each
  // also with archers: ?ranged=N a side, default a fifth of the army)
  const los = (on: boolean) => {
    agents.los = on;
    agents.seenOnly = false;
  };
  const seen = (on: boolean) => {
    agents.los = true;
    agents.seenOnly = on;
  };
  // (the grounds: open — the control — and, by default, one cluttered (?benchground=open,walls | open,town |
  // open,walls,town). K 16 is decided (the phone's run): the relax variants only with ?benchrelax=1)
  const grounds = (params.get('benchground') ?? 'open,walls').split(',').filter((g) => ['open', 'walls', 'town'].includes(g));
  const warm = async (n: number) => {
    // (a warm-up fight first, not measured: the first armies at a place fill every field round them — a cost the
    // first measured phase would carry alone; the phone's first run showed block16, first, at +2.7 ms)
    panel.say(`field bench — ${ground} ${n} v ${n}: warm-up…`);
    const ids = armies(units, agents, centre, n, 0, snap);
    await sleep(6000);
    for (const id of ids) units.remove(id);
    await sleep(500);
  };
  const losPhases = async (n: number, list: Phase[]) => {
    const archers = Math.min(n, Number(params.get('ranged') ?? Math.round(n / 5)));
    list.push(await phase(n, 'los', 'line of sight', 'block16 alone', los, restDefault));
    list.push(await phase(n, 'seenonly', 'line of sight + seen-only', 'line of sight', seen, restDefault));
    list.push(await phase(n, 'los+archers', `line of sight, ${archers} archers`, `block16 alone, ${archers} archers`, los, restDefault, archers));
    list.push(await phase(n, 'seenonly+archers', `line of sight + seen-only, ${archers} archers`, `line of sight, ${archers} archers`, seen, restDefault, archers));
  };
  let instances: number | null = null;
  let alive = 0;
  let onScreen = 0;
  const drawFacts = () => {
    const d = phases['open:500']?.find((p) => p.name === 'draw');
    const ms = d?.gpu.diff ?? null;
    return { instances, alive, onScreen, instancesPerUnit: instances !== null && alive ? r3(instances / alive) : null, gpuMsPerVisibleUnit: ms !== null && onScreen ? +(ms / onScreen).toFixed(6) : null, drawGpuMs: ms };
  };
  for (const g of grounds) {
    ground = g;
    if (g === 'walls') await raiseWalls();
    if (g === 'town') await toTown();
    for (const n of [100, 500]) {
      const list: Phase[] = [];
      await warm(n);
      if (g === 'open') {
        list.push(await phase(n, 'pages', 'the fields on pages (relax K 16)', 'fields frozen', relaxed, restDefault));
        // (500 v 500 only if 100 v 100 held 30 fps with the default on)
        if (n === 500 && phases['open:100']?.[0] && phases['open:100'][0].sides.on.p50 > 33.4) {
          errors.push(`500 v 500 skipped: 100 v 100 ran at ${phases['open:100'][0].sides.on.p50} ms (p50) with the fields on`);
          break;
        }
        list.push(
          await phase(
            n,
            'huntgpu',
            'hunt seeds on the GPU',
            "hunt seeds the CPU's 8",
            (on) => {
              agents.huntOn = on;
              units.huntGpu = on;
            },
            restDefault,
          ),
        );
        if (n === 500) {
          // (the per-unit GPU cost at 1,000 units, each by toggling: the draw, notice, the step)
          list.push(await phase(n, 'draw', 'units drawn', 'units not drawn', (on) => (agents.benchNoDraw = !on), restDefault));
          {
            const ids = armies(units, agents, centre, n, 0, snap);
            await sleep(2000);
            instances = await agents.benchInstances();
            // (the units alive and on screen now: one read of the rows, each projected by the camera)
            const rows = new Float32Array(await agents.readRaw('units'));
            const ru = new Uint32Array(rows.buffer);
            const [vw, vh] = [innerWidth, innerHeight];
            alive = 0;
            onScreen = 0;
            for (const id of ids) {
              const r = units.recs.get(id);
              if (!r) continue;
              const o = (r.gpu % 8192) * 24;
              if (!((ru[o + 3] >>> 8) & 1)) continue;
              alive++;
              const sp = R.camera.project(rows[o], rows[o + 1], rows[o + 2]);
              if (sp && sp[0] >= 0 && sp[1] >= 0 && sp[0] <= vw && sp[1] <= vh) onScreen++;
            }
            for (const id of ids) units.remove(id);
            await sleep(500);
          }
          list.push(await phase(n, 'notice', 'notice dispatched', 'notice not dispatched (targets held)', (on) => (agents.benchNoNotice = !on), restDefault));
          list.push(await phase(n, 'step', 'the step every tick', 'the step every other tick', (on) => (agents.benchStepHalf = !on), restDefault));
        }
      }
      await losPhases(n, list);
      phases[`${g}:${n}`] = list;
    }
  }
  holding = false;
  agents.keepInScope('fieldbench', []);
  await letSleep();
  const report = {
    kind: 'reclaimed-fieldbench',
    version: 1,
    build: BUILD,
    startedAt,
    finishedAt: new Date().toISOString(),
    url: location.href,
    device,
    wakeLock: held,
    wakeLog: [...wakeLog],
    town: townId,
    // (where the armies stood: the patch's middle and ground, the raiders' and the guards' first rows, the gap)
    patch: { centre, ground: found[2] },
    grounds,
    townAt,
    /** at 500 v 500: the voxel instances the units' draw made (unitDraw has no view cull: every unit, on screen or not),
     *  the units alive and on screen then, instances a unit, and the draw's GPU ms (the draw phase's on less off) a
     *  unit on screen */
    draw: drawFacts(),
    armies: { raiders: [centre[0], centre[1] - 12], guards: [centre[0], centre[1] + 12], gap: 24 },
    phases,
    errors,
  };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { fieldBenchReport: string }).fieldBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (storage full: the download is the copy)
  }
  // (the headline is the GPU span: the frame interval sits at the display's vsync on a phone; a phase with no fight says so)
  const line = (n: string, p: Phase) =>
    `${p.valid ? '' : 'NO FIGHT — INVALID: '}${p.ground} ${n.split(':')[1]} v ${n.split(':')[1]} ${p.name}: GPU ${p.gpu.off ?? 'n/a'} → ${p.gpu.on ?? 'n/a'} ms (${p.gpu.diff !== null && p.gpu.diff >= 0 ? '+' : ''}${p.gpu.diff ?? 'n/a'}) ${p.off} → ${p.on}; frame p50/p95 ${p.sides.off.p50}/${p.sides.off.p95} → ${p.sides.on.p50}/${p.sides.on.p95}${p.vsync ? ' (at the vsync cap)' : ''}; asks/sweep ${p.sides.off.asksPerSweep ?? '–'} → ${p.sides.on.asksPerSweep ?? '–'}${p.sides.on.shots || p.sides.off.shots ? `; shots ${p.sides.off.shots} → ${p.sides.on.shots}, landed ${p.sides.off.landed} → ${p.sides.on.landed}, to act ${p.sides.off.toActFrames ?? '–'} → ${p.sides.on.toActFrames ?? '–'} ticks` : ''}${p.sightShare !== null ? `; in sight ${p.sightShare}` : ''}; alive ${p.alive.start} → ${p.alive.end}, ${p.deaths} died (${Object.entries(p.causes).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}); engaged ${p.engaged} (with a target ${p.targeted}); chain: noticed ${p.chain.noticed}, windups ${p.chain.windup}, blows ${p.chain.swing}, hurts ${p.chain.hurt}, moved ${p.chain.moved} cells`;
  panel.say(`field bench done — town ${townId}; armies at ${centre.map((v) => v.toFixed(1)).join(', ')} (ground ${found[2].toFixed(1)}), 24 apart.`);
  const df = drawFacts();
  const drawLine = `draw at 500 v 500: ${df.instances ?? 'n/a'} voxel instances for ${df.alive} units (${df.instancesPerUnit ?? 'n/a'} a unit; ${df.onScreen} on screen, no view cull); the draw ${df.drawGpuMs ?? 'n/a'} ms GPU, ${df.gpuMsPerVisibleUnit ?? 'n/a'} ms a unit on screen`;
  panel.text([...Object.entries(phases).flatMap(([n, list]) => list.map((p) => line(n, p))), drawLine, ...errors.map((e) => `error: ${e}`)].join(NL), true);
  const kept = await postDev(body, 'fieldbench');
  if (kept) panel.text(kept, true);
  reportButtons(panel, body, false, 'fieldbench', 'Reclaimed field bench', true);
}
