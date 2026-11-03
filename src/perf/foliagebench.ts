// The foliage phone bench (round 128, `treegen`; the user's PERF RULE: "benchmarks I run on my phone via the existing
// pattern which keeps the screen awake and generates downloadable reports"; the wind matrix's stop/go rule,
// docs/design/FOLIAGE_WIND.md: "compare the same representation in static and animated mode"). One link, one tap, run
// on the real phone: the forest station (the densest elder wood near the window's middle), the hero parked in front of
// its trunks at the gameplay zoom, the same scripted winds every load — calm, a gust front, a gale, the wind reversed —
// out in the open and held under the canopy; each variant a reload (matched pairs: the same scene, one setting
// different), the static baseline run first and again last (heat and drift show as its two rows differing). Then a
// result card and a JSON to download or copy (frame p50/p95/p99, the GPU's ms where the adapter times it, the flora's
// plants, triangles and draws).
//   /?skipmenu=1&level=atlas&play=lich&forest=lab&fride=0&fseason=0.5&foliagebench=1
//   …&foliagebench=1&variants=fwind:static,fwind:1A1C           (some; a variant is URL settings, '+' between them)
// State between the loads in localStorage (cleared at the end). Every system in play as the deployed page runs it.

import { postDev } from './report-io';
import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, wakeLog } from './bench';

const KEY = 'reclaimed.foliagebench';
const LAST = 'reclaimed.foliagebench.last';
const NL = String.fromCharCode(10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The variants, each a reload (URL settings, '+' between): the wind matrix's rows on the trees as they are (x2), the
 * trees at round 125's size (?treescale=1) static and animated, and the static baseline again at the end.
 */
export const VARIANTS = ['fwind:static', 'fwind:sway', 'fwind:1A', 'fwind:1C', 'fwind:1A1C', 'fwind:static+treescale:1', 'fwind:1A1C+treescale:1', 'fwind:static'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

interface Stage {
  name: string;
  /** the understory's hold: 0 out in the open, 1 under the canopy */
  hold: 0 | 1;
  run: (R: Rec) => void;
  secs: number;
}

/** the scripted winds (forest/lab.ts's chips: the same calls) */
const STAGES: Stage[] = [
  { name: 'open calm', hold: 0, run: () => {}, secs: 6 },
  { name: 'open gust', hold: 0, run: (R) => R.forest.gust(), secs: 6 },
  { name: 'open gale', hold: 0, run: (R) => galeOn(R, true), secs: 6 },
  { name: 'open reversal', hold: 0, run: (R) => reverse(R), secs: 6 },
  { name: 'under calm', hold: 1, run: (R) => galeOn(R, false), secs: 6 },
  { name: 'under gust', hold: 1, run: (R) => R.forest.gust(), secs: 6 },
];

let calm: [number, number] | null = null;
function galeOn(R: Rec, on: boolean): void {
  const W = R.weather;
  if (!calm) calm = [W.params.baseWindX, W.params.baseWindY];
  W.params.baseWindX = calm[0] * (on ? 3 : 1);
  W.params.baseWindY = calm[1] * (on ? 3 : 1);
}
function reverse(R: Rec): void {
  const W = R.weather;
  W.params.baseWindX = -W.params.baseWindX;
  W.params.baseWindY = -W.params.baseWindY;
}

export interface FoliageRow {
  variant: string;
  stage: string;
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  gpu: number | null;
  plants: number | null;
  tris: number | null;
  draws: number | null;
}

interface State {
  variants: string[];
  rows: FoliageRow[];
  startedAt: string;
  device?: Record<string, unknown>;
  wake: { variant: string; held: boolean }[];
  wakeLog: string[];
}

/** a variant's URL settings (fwind:1A+treescale:1 → [[fwind, 1A], [treescale, 1]]) */
export function variantSettings(v: string): [string, string][] {
  return v.split('+').map((kv) => {
    const [k, val] = kv.split(':');
    if (!k || val === undefined) throw new Error(`foliagebench: variant "${v}" is key:value(+key:value)`);
    return [k, val];
  });
}
const KNOWN = ['fwind', 'treescale', 'flod', 'fseason'];

function goTo(v: string, step: number): void {
  const u = new URL(location.href);
  for (const k of KNOWN) u.searchParams.delete(k);
  u.searchParams.set('fseason', '0.5');
  for (const [k, val] of variantSettings(v)) {
    if (!KNOWN.includes(k)) throw new Error(`foliagebench: unknown setting ${k} (one of ${KNOWN.join(', ')})`);
    u.searchParams.set(k, val);
  }
  u.searchParams.set('foliagebenchstep', String(step));
  location.href = u.toString();
}

/** p50 / p95 per variant per hold, as lines for the card (and the static-vs-animated difference) */
export function summaryLines(rows: FoliageRow[]): string[] {
  const out: string[] = [];
  const vs = [...new Set(rows.map((r) => r.variant))];
  const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
  const at = (v: string, hold: string) => rows.filter((r) => r.variant === v && r.stage.startsWith(hold));
  const base = (hold: string, ts: string) => mean(at(ts === '1' ? 'fwind:static+treescale:1' : 'fwind:static', hold).map((r) => r.p50));
  for (const v of vs)
    for (const hold of ['open', 'under']) {
      const rs = at(v, hold);
      if (!rs.length) continue;
      const p50 = mean(rs.map((r) => r.p50));
      const p95 = mean(rs.map((r) => r.p95));
      const gpu = rs.every((r) => r.gpu !== null) ? mean(rs.map((r) => r.gpu as number)) : null;
      const ts = variantSettings(v).find(([k]) => k === 'treescale')?.[1] ?? '2';
      const d = p50 - base(hold, ts);
      out.push(`${v.padEnd(26)} ${hold.padEnd(5)} p50 ${p50.toFixed(1)} p95 ${p95.toFixed(1)}${gpu !== null ? ` gpu ${gpu.toFixed(1)}` : ''} (vs static ${d >= 0 ? '+' : ''}${d.toFixed(1)}) ${rs[0].tris !== null ? `${Math.round((rs[0].tris ?? 0) / 1000)}k tris ${rs[0].plants} plants ${rs[0].draws} draws` : ''}`);
    }
  return out;
}

export async function foliageBench(params: URLSearchParams): Promise<void> {
  const panel = new Panel(document.body);
  const held = await keepAwake();
  let st: State | null;
  try {
    st = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    st = null;
  }
  const asked = (params.get('variants') ?? '').split(',').filter(Boolean);
  const variants = asked.length ? asked : VARIANTS;
  if (!params.get('foliagebenchstep') || !st) {
    for (const v of variants) variantSettings(v);
    // (the first page waits for the world, as every bench page does, so the device's facts have a GPU to ask)
    panel.say('foliage bench: the device…');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let R: Rec = (window as any).reclaimed;
    for (let k = 0; k < 120 && !R?.core; k++) {
      await sleep(500);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      R = (window as any).reclaimed;
    }
    st = { variants, rows: [], startedAt: new Date().toISOString(), wake: [], wakeLog: [] };
    st.device = R?.core ? await deviceFacts(R.core.host) : undefined;
    localStorage.setItem(KEY, JSON.stringify(st));
    goTo(variants[0], 0);
    return;
  }
  const step = Number(params.get('foliagebenchstep'));
  const here = st.variants[step];
  st.wake.push({ variant: here, held });
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'foliagebench', 'Reclaimed foliage bench');
  const tag = `foliage bench ${step + 1}/${st.variants.length} (${here})`;
  panel.say(`${tag} — the forest station coming in (25 s)…`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let R: Rec = (window as any).reclaimed;
  for (let k = 0; k < 240 && !R?.forest?.stand; k++) {
    await sleep(500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    R = (window as any).reclaimed;
  }
  if (!R?.forest?.stand) throw new Error('foliagebench: no forest station (the URL needs level=atlas&play=lich&forest=lab)');
  await sleep(20000);
  // (the hero parked in front of the stand's trunks; the ride off)
  R.forest.ride = false;
  const park = R.forest.stand.park ?? R.forest.stand.at;
  R.play.session.hero.place(park);
  await sleep(3000);
  const P = R.core.host.profiler;
  P.active = true;
  calm = null;
  for (const s of STAGES) {
    panel.say(`${tag} — ${s.name}…`);
    R.forest.d.driver.force = s.hold;
    s.run(R);
    await sleep(1500);
    P.resetTotals();
    const t: number[] = [];
    let on = true;
    const tick = () => {
      t.push(performance.now());
      if (on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await sleep(s.secs * 1000);
    on = false;
    const d: number[] = [];
    for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
    const f = [...d].sort((a, b) => a - b);
    const q = (x: number) => +f[Math.min(f.length - 1, Math.floor(x * f.length))].toFixed(1);
    let plants: number | null = null;
    let tris: number | null = null;
    let draws: number | null = null;
    const mi = R.renderer.meshInst;
    if (mi) {
      const c: number[] = await mi.counts(R.renderer.device, R.renderer.indirect);
      plants = c.reduce((a, b) => a + b, 0);
      draws = c.filter((n) => n > 0).length;
      tris = Math.round(mi.kinds.reduce((a: number, k: { index: Uint32Array }, i: number) => a + (k.index.length / 3) * c[i], 0));
    }
    const fr = P.framesResolved as number;
    st.rows.push({ variant: here, stage: s.name, frames: d.length, fps: +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), worst: +f[f.length - 1].toFixed(1), gpu: fr ? +(P.gpuTotalMs / fr).toFixed(2) : null, plants, tris, draws });
  }
  galeOn(R, false);
  st.wakeLog.push(...wakeLog.map((l) => `${here} ${l}`));
  localStorage.setItem(KEY, JSON.stringify(st));
  if (step + 1 < st.variants.length) {
    panel.say(`foliage bench: next, ${st.variants[step + 1]} (reloading)…`);
    goTo(st.variants[step + 1], step + 1);
    return;
  }
  localStorage.removeItem(KEY);
  await letSleep();
  const report = {
    kind: 'reclaimed-foliagebench',
    version: 1,
    startedAt: st.startedAt,
    finishedAt: new Date().toISOString(),
    url: location.href,
    device: st.device ?? null,
    wakeLock: st.wake,
    wakeLog: st.wakeLog,
    stages: STAGES.map((s) => s.name),
    summary: summaryLines(st.rows),
    rows: st.rows,
  };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { foliageBenchReport: string }).foliageBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (the browser's storage full: the download is the copy)
  }
  panel.say(`Foliage bench done — ${st.variants.length} loads, ${STAGES.length} stages each.`);
  panel.text(summaryLines(st.rows).join(NL), true);
  reportButtons(panel, body, false, 'foliagebench', 'Reclaimed foliage bench', true);
  const dev = await postDev(body, 'bench');
  if (dev) panel.text(`dev server: ${dev}`, true);
  panel.button('Run again', false, () => {
    const u = new URL(location.href);
    u.searchParams.delete('foliagebenchstep');
    location.href = u.toString();
  });
}
