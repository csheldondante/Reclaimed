// The bench on the page: its mode from the URL, the screen kept awake (the wake lock, re-asked when let go), the
// panel and the GPU timer. API: benchMode, keepAwake, letSleep, wakeLog, Panel, GpuTimer (re-exported by bench.ts).
// (The heartbeat and what writes it — benchGpuUp, the watchdog, skipping — stay in bench.ts: ES imports can't be
// assigned.)
import { PageSpec, load, save } from './state';

/** What this page is in the suite: the start screen, a level page, the end — or not the benchmark at all. */
export function benchMode(params: URLSearchParams): 'start' | 'final' | 'level' | 'skip' | null {
  if (params.get('bench') !== '1' && params.get('bench') !== 'pan') return null;
  const page = params.get('benchpage');
  const s = load();
  if (!page || !s || s.done || s.pages[s.step]?.name !== page) return 'start';
  if (page === 'final') return 'final';
  // (v3: a level page loaded a second time never finished the first — the tab killed, the device lost: skipped)
  const ps = s.pages[s.step] as PageSpec & { tries?: number };
  ps.tries = (ps.tries ?? 0) + 1;
  save(s);
  return ps.tries > 1 ? 'skip' : 'level';
}


// (v5, the user: "my phone screen turned off mid run" — the system may let a screen lock go while the page is
// visible (battery saver, a screen timeout policy) and always does when it's hidden; the lock was asked for once a
// page and never again. Now it's asked for again whenever it's let go and the page is visible, and every loss is
// logged (wakeLog: ms since the page's start), so a run whose screen went off says so.)
export type WakeSentinel = { release(): Promise<void>; addEventListener(t: 'release', f: () => void): void };
export let wakeLock: WakeSentinel | null = null;
export let wakeWanted = false;
export let wakeHooked = false;
/** (round 120: the physics bench's too — src/perf/physbench.ts) the wake lock's losses, ms since the page began */
export const wakeLog: string[] = [];
export async function requestWake(): Promise<boolean> {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<WakeSentinel> } }).wakeLock;
  if (!wl) {
    wakeLog.push(`${Math.round(performance.now())}: no wake lock API`);
    return false;
  }
  try {
    const lock = await wl.request('screen');
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
      if (!wakeWanted) return;
      wakeLog.push(`${Math.round(performance.now())}: let go (${document.visibilityState})`);
      if (document.visibilityState === 'visible') void requestWake();
    });
    return true;
  } catch (e) {
    wakeLog.push(`${Math.round(performance.now())}: refused (${(e as Error).name}: ${(e as Error).message})`);
    return false;
  }
}
export async function keepAwake(): Promise<boolean> {
  wakeWanted = true;
  if (!wakeHooked) {
    wakeHooked = true;
    document.addEventListener('visibilitychange', () => {
      if (!wakeWanted) return;
      wakeLog.push(`${Math.round(performance.now())}: ${document.visibilityState}`);
      if (document.visibilityState === 'visible' && !wakeLock) void requestWake();
    });
  }
  return wakeLock ? true : requestWake();
}
export async function letSleep(): Promise<void> {
  wakeWanted = false;
  try {
    await wakeLock?.release();
  } catch {
    // (already let go)
  }
  wakeLock = null;
}

export class Panel {
  readonly el: HTMLDivElement;
  private line: HTMLDivElement;
  constructor(ui: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;left:8px;right:8px;top:max(8px,env(safe-area-inset-top));z-index:60;background:#000d;color:#e6f0e8;font:13px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px;pointer-events:auto;max-height:90vh;overflow:auto';
    this.el.id = 'bench-panel';
    this.line = document.createElement('div');
    this.line.id = 'bench-say';
    this.el.appendChild(this.line);
    for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'mousedown', 'click']) this.el.addEventListener(ev, (e) => e.stopPropagation());
    ui.appendChild(this.el);
  }
  say(s: string): void {
    this.line.textContent = s;
  }
  button(label: string, big: boolean, f: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = big
      ? 'display:block;width:100%;margin:10px 0 4px;padding:16px;font:600 18px system-ui,sans-serif;background:#2d6a4f;color:#fff;border:0;border-radius:8px'
      : 'display:inline-block;margin:6px 6px 0 0;padding:10px 14px;font:15px system-ui,sans-serif;background:#234;color:#fff;border:1px solid #6a8;border-radius:6px';
    b.onclick = (e) => {
      e.stopPropagation();
      f();
    };
    this.el.appendChild(b);
    return b;
  }
  text(s: string, small = false): HTMLDivElement {
    const d = document.createElement('div');
    d.style.cssText = small ? 'font:11px/1.35 ui-monospace,monospace;white-space:pre-wrap;margin-top:6px;color:#bcd' : 'margin-top:6px;white-space:pre-line';
    d.textContent = s;
    this.el.appendChild(d);
    return d;
  }
}

// ---------- GPU timing ----------

/** The suite's own timestamp queries (a Profiler-shaped `timestamps(name)` for the code it lends itself to). */
export class GpuTimer {
  readonly on: boolean;
  private qs?: GPUQuerySet;
  private names: string[] = [];
  private cap = 512;
  constructor(private device: GPUDevice) {
    this.on = device.features.has('timestamp-query');
    if (this.on) this.qs = device.createQuerySet({ type: 'timestamp', count: this.cap });
  }
  timestamps(name: string): GPUComputePassTimestampWrites | undefined {
    if (!this.qs || this.names.length * 2 + 2 > this.cap) return undefined;
    const i = this.names.length * 2;
    this.names.push(name);
    return { querySet: this.qs, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 };
  }
  /** every pass timed since the last read: its ms, by name (after the work was submitted) */
  async read(): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const n = this.names.length;
    if (!this.qs || !n) return out;
    const names = this.names;
    this.names = [];
    const dev = this.device;
    const res = dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const st = dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder({ label: 'bench timestamps' });
    enc.resolveQuerySet(this.qs, 0, n * 2, res, 0);
    enc.copyBufferToBuffer(res, 0, st, 0, n * 16);
    dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const w = new Uint32Array(st.getMappedRange().slice(0));
    st.unmap();
    st.destroy();
    res.destroy();
    const ns = (k: number) => w[k * 2] + w[k * 2 + 1] * 4294967296;
    for (let p = 0; p < n; p++) {
      const ms = (ns(p * 2 + 1) - ns(p * 2)) / 1e6;
      // (a pass the driver didn't time comes back 0 or backwards: left out, not counted as free)
      if (!(ms > 0 && ms < 10000)) continue;
      (out.get(names[p]) ?? out.set(names[p], []).get(names[p])!).push(ms);
    }
    return out;
  }
}
