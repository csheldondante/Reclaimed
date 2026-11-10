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
  core: { host: Parameters<typeof deviceFacts>[0] & { profiler: Profiler } };
  camera: { elevation: number; zoom: number; target: [number, number, number] };
  agents: Agents;
  world: { w: number; h: number; ring: { idx(x: number, y: number): number } };
  scene: { livingTowns?: LivingTowns; units?: AgentUnits };
}

/**
 * Open dry ground for the armies near `near` (window world units): rings out from the town past `minR` cells, the first
 * patch of `w` x `h` cells whose top surfaces all stand dry (water under 0.05) within 2.5 of each other. The surfaces
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
    ground = lo;
    return true;
  };
  for (let r = minR; r < minR * 3.5; r += minR * 0.25)
    for (let a = 0; a < 16; a++) {
      const x0 = Math.round(cx + Math.cos((a / 16) * Math.PI * 2) * r - w / 2);
      const y0 = Math.round(cy + Math.sin((a / 16) * Math.PI * 2) * r - h / 2);
      if (ok(x0, y0)) return [...cellPos(x0 + w / 2, y0 + h / 2), ground];
    }
  return null;
}

interface Side {
  /** the frame's interval (rAF), ms */
  p50: number;
  p95: number;
  mean: number;
  /** the GPU span (the profiler's frame, where the device has timestamps), mean ms */
  gpuMs: number | null;
  frames: number;
}
interface Phase {
  name: string;
  /** what "on" and "off" were */
  on: string;
  off: string;
  sides: { on: Side; off: Side };
  /** on less off: frame p50 and mean, GPU span mean (ms) */
  diff: { p50: number; mean: number; gpuMs: number | null };
  /** the fight: alive at the phase's start and end (both armies), deaths in it */
  alive: { start: number; end: number };
  deaths: number;
  windows: number;
  windowS: number;
}

const WINDOWS = 3;
const pct = (a: number[], q: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : NaN;
};
const r3 = (x: number) => (Number.isFinite(x) ? +x.toFixed(3) : NaN);

/** `set(true)` the thing on; WINDOWS alternating windows each way, `windowS` long */
async function toggled(P: Profiler, windowS: number, set: (on: boolean) => void): Promise<{ on: Side; off: Side }> {
  const sums = { on: { dt: [] as number[], gpu: [] as number[] }, off: { dt: [] as number[], gpu: [] as number[] } };
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
      counting = true;
      await sleep(windowS * 1000);
    }
  counting = false;
  live = false;
  const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
  const sideOf = (s: 'on' | 'off'): Side => ({ p50: r3(pct(sums[s].dt, 0.5)), p95: r3(pct(sums[s].dt, 0.95)), mean: r3(mean(sums[s].dt)), gpuMs: sums[s].gpu.length ? r3(mean(sums[s].gpu)) : null, frames: sums[s].dt.length });
  return { on: sideOf('on'), off: sideOf('off') };
}

/** two armies of n facing each other on open ground east of the town: raiders (hostile) and guards */
function armies(units: AgentUnits, centre: V2, n: number): UnitId[] {
  const ids: UnitId[] = [];
  const cols = Math.ceil(Math.sqrt(n * 2));
  const at = (k: number, y0: number, dir: number): V2 => [centre[0] - (cols / 2) * 1.1 + (k % cols) * 1.1, y0 + dir * Math.floor(k / cols) * 1.1 * ROW_H];
  for (let k = 0; k < n; k++) ids.push(units.spawn('raider', at(k, centre[1] - 12, -1), 'f-bench-raid', { role: 'raider', hostile: true, sight: 40, health: 3 }));
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
  R.camera.target = [found[0], found[1], found[2]];
  R.camera.elevation = Math.PI / 3;
  R.camera.zoom = Number(params.get('benchzoom') ?? 14);
  // (the season sheet folded, as its ▾ does: the armies are under where it opens)
  const sheet = document.querySelector('.season-sheet');
  if (sheet && !sheet.classList.contains('folded')) (sheet.querySelector('.s-fold') as HTMLButtonElement | null)?.click();
  // (the GPU-seeded hunt field: the toggle's — and every variant's pipelines made now, before any window)
  agents.gpuHunt(F.targets);
  units.huntGpu = true;
  agents.huntOn = true;
  for (const v of ['front', 'block8', 'block16'] as const) agents.benchRelax(v);
  await sleep(3000);
  const P = R.core.host.profiler;
  P.active = true;
  const deaths = { n: 0 };
  units.died.push(() => deaths.n++);
  const aliveOf = (ids: UnitId[]) => ids.filter((id) => units.get(id)?.alive).length;
  const phases: Record<string, Phase[]> = {};
  const phase = async (n: number, name: string, on: string, off: string, setOn: (on: boolean) => void, rest: () => void): Promise<Phase> => {
    // (fresh armies a phase: each phase's fight from the same start)
    const ids = armies(units, centre, n);
    await sleep(3000);
    const a0 = aliveOf(ids);
    const d0 = deaths.n;
    panel.say(`field bench — ${n} v ${n}: ${name} (${on} vs ${off}, ${WINDOWS} × ${windowS} s each way)…`);
    const sides = await toggled(P, windowS, setOn);
    rest();
    const p: Phase = {
      name,
      on,
      off,
      sides,
      diff: { p50: r3(sides.on.p50 - sides.off.p50), mean: r3(sides.on.mean - sides.off.mean), gpuMs: sides.on.gpuMs !== null && sides.off.gpuMs !== null ? r3(sides.on.gpuMs - sides.off.gpuMs) : null },
      alive: { start: a0, end: aliveOf(ids) },
      deaths: deaths.n - d0,
      windows: WINDOWS,
      windowS,
    };
    for (const id of ids) units.remove(id);
    await sleep(500);
    return p;
  };
  const relaxed = (v: 'front' | 'block8' | 'block16') => (on: boolean) => {
    agents.benchRelax(v);
    agents.benchFrozen = !on;
  };
  const restDefault = () => {
    agents.benchRelax('block16');
    agents.benchFrozen = false;
    agents.huntOn = true;
    units.huntGpu = true;
  };
  for (const n of [100, 500]) {
    const list: Phase[] = [];
    list.push(await phase(n, 'block16', 'relaxBlock K 16', 'fields frozen', relaxed('block16'), restDefault));
    // (500 v 500 only if 100 v 100 held 30 fps with the default on)
    if (n === 500 && phases['100']?.[0] && phases['100'][0].sides.on.p50 > 33.4) {
      errors.push(`500 v 500 skipped: 100 v 100 ran at ${phases['100'][0].sides.on.p50} ms (p50) with block16`);
      break;
    }
    list.push(await phase(n, 'block8', 'relaxBlock K 8', 'fields frozen', relaxed('block8'), restDefault));
    list.push(await phase(n, 'front', "relax's front kernel (old)", 'fields frozen', relaxed('front'), restDefault));
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
    phases[String(n)] = list;
  }
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
    centre,
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
  const line = (n: string, p: Phase) =>
    `${n} v ${n} ${p.name}: ${p.off} ${p.sides.off.p50}/${p.sides.off.p95} → ${p.on} ${p.sides.on.p50}/${p.sides.on.p95} ms p50/p95 (${p.diff.p50 >= 0 ? '+' : ''}${p.diff.p50}; GPU ${p.diff.gpuMs ?? 'n/a'}); alive ${p.alive.start} → ${p.alive.end}, ${p.deaths} died`;
  panel.say(`field bench done — ${townId}.`);
  panel.text([...Object.entries(phases).flatMap(([n, list]) => list.map((p) => line(n, p))), ...errors.map((e) => `error: ${e}`)].join(NL), true);
  const kept = await postDev(body, 'fieldbench');
  if (kept) panel.text(kept, true);
  reportButtons(panel, body, false, 'fieldbench', 'Reclaimed field bench', true);
}
