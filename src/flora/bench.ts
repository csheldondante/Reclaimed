// The flora phone bench (round 119; the user: "I had some bad performance with the birches on mobile"). One link,
// about two minutes, run on the real phone: the atlas at the birch wood (?at= the showcase), parked, the camera on the
// woodiest block near the start at zoom 14 and then 8, frame times (and the GPU's where the adapter times it) with the
// flora library — then the page reloads with ?flora=0 (the old boxes) and measures the same, and shows both, to copy.
//   /?skipmenu=1&level=atlas&tutorial=0&at=13728,4768&florabench=1
// Every system in play as the deployed page runs it; only the camera is placed. State between the two loads in
// localStorage (cleared at the end).

import { copyText } from '../perf/report-io';

const KEY = 'reclaimed.florabench';
const ROW_H = Math.sqrt(3) / 2;

interface Row {
  flora: string;
  zoom: number;
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  gpu: number | null;
  plants: number | null;
  tris: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function say(el: HTMLElement, text: string): void {
  el.textContent = text;
}

/** Runs the stage this page is (flora on first, then off), then reloads or reports. */
export async function floraBench(params: URLSearchParams): Promise<void> {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:50;background:rgba(20,28,20,.88);color:#eef;font:12px system-ui;padding:8px;border-radius:8px;white-space:pre-wrap;pointer-events:auto';
  document.body.appendChild(box);
  const flora = params.get('flora') ?? '1';
  let rows: Row[] = [];
  try {
    rows = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Row[];
  } catch {
    rows = [];
  }
  if (flora !== '0') rows = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const R = (window as any).reclaimed;
  say(box, `flora bench: flora=${flora} — letting the land come in (20 s)…`);
  await sleep(20000);
  const P = R.core.host.profiler;
  P.active = true;
  // the woodiest 16² block near the start
  const veg: Float32Array = await R.core.readBuffer('veg');
  const { w, h } = R.core.dims;
  const [tx, ty] = R.camera.target;
  let best = { x: tx, y: ty, s: -1e9 };
  for (let by = 2; by < h / 16 - 2; by++)
    for (let bx = 2; bx < w / 16 - 2; bx++) {
      let n = 0;
      for (let y = by * 16; y < by * 16 + 16; y++) for (let x = bx * 16; x < bx * 16 + 16; x++) if (veg[y * w + x] >= 3.6) n++;
      const cx = bx * 16 + 8;
      const cy = by * 16 + 8;
      const s = n - 0.15 * Math.hypot(cx - tx, cy * ROW_H - ty);
      if (s > best.s) best = { x: cx + 0.5, y: cy * ROW_H, s };
    }
  for (const zoom of [14, 8]) {
    R.camera.target = [best.x, best.y, R.camera.target[2]];
    R.camera.zoom = zoom;
    say(box, `flora bench: flora=${flora}, zoom ${zoom} — settling…`);
    await sleep(4000);
    P.resetTotals();
    const t: number[] = [];
    let on = true;
    const tick = () => {
      t.push(performance.now());
      if (on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    say(box, `flora bench: flora=${flora}, zoom ${zoom} — measuring 10 s…`);
    await sleep(10000);
    on = false;
    const d: number[] = [];
    for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
    const f = [...d].sort((a, b) => a - b);
    const q = (x: number) => +f[Math.min(f.length - 1, Math.floor(x * f.length))].toFixed(1);
    let plants: number | null = null;
    let tris: number | null = null;
    const mi = R.renderer.meshInst;
    if (mi) {
      const c: number[] = await mi.counts(R.renderer.device, R.renderer.indirect);
      plants = c.reduce((a, b) => a + b, 0);
      tris = Math.round(mi.kinds.reduce((a: number, k: { index: Uint32Array }, i: number) => a + (k.index.length / 3) * c[i], 0));
    }
    rows.push({ flora, zoom, frames: d.length, fps: +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), gpu: P.framesResolved ? +(P.gpuTotalMs / P.framesResolved).toFixed(2) : null, plants, tris });
  }
  if (flora !== '0') {
    localStorage.setItem(KEY, JSON.stringify(rows));
    const u = new URL(location.href);
    u.searchParams.set('flora', '0');
    say(box, 'flora bench: now the old boxes (reloading)…');
    location.href = u.toString();
    return;
  }
  localStorage.removeItem(KEY);
  const report = JSON.stringify({ bench: 'flora', v: 1, ua: navigator.userAgent, when: new Date().toISOString(), rows }, null, 1);
  const lines = rows.map((r) => `${r.flora === '0' ? 'boxes' : 'flora'} z${r.zoom}: ${r.fps} fps, p50 ${r.p50} ms, p95 ${r.p95} ms${r.gpu !== null ? `, GPU ${r.gpu} ms` : ''}${r.tris !== null ? `, ${r.plants} plants ${Math.round(r.tris / 1000)}k tris` : ''}`);
  say(box, `flora bench done (tap to copy):\n${lines.join('\n')}`);
  box.onclick = async () => say(box, `${await copyText(report)}\n${lines.join('\n')}`);
  (window as unknown as { floraBenchReport: string }).floraBenchReport = report;
}
