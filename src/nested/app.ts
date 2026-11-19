// Nested scales lab: the sandbox (docs/design/NESTED_SCALES.md). One root terrain; zoom in near the ground and a finer
// level is promoted round the focus (and a finer one inside it), each drawn in its own units; sculpt on whichever
// level is under the pointer. Everything that touches the columns runs on the GPU (gpu/nest.ts); this file holds the
// camera's inputs, which levels are wanted where, the buttons and the measurements.
import { GpuNest, type Op, type Win } from './gpu/nest';
import { Renderer, type DrawLevel } from './render';
import { coverage, holePixels, lastImage, manifold, rayDiag, rimJunctions } from './watertight';

/** a root column, in metres (the info line) */
const ROOT_COLUMN_M = 3.2;
const FOVY = (50 * Math.PI) / 180;
/** a number with two significant decimals at most */
const A2 = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(2));

type Mode = Op | 'move' | 'orbit';

export class App {
  readonly nest: GpuNest;
  readonly render: Renderer;
  readonly k: number;
  readonly n: number;
  readonly maxDepth: number;
  readonly rootN = 256;
  /** the eye (world) and the nearest solid's distance, as the GPU last reported them (a frame or two old: the windows
   *  and the input scales use them; the collision itself is the GPU's, every frame) */
  ex = 128;
  ey = 128;
  ez = 0;
  dNear = 260;
  /** the centre ray's first solid (world), -1: none */
  dHit = -1;
  lifts = 0;
  yaw = -Math.PI / 2;
  pitch = 0.75;
  /** the move wished this frame (world), sent to the camera pass, which limits it */
  move = [0, 0, 0];
  /** zoom still to apply (log of the distance ratio to the centre's surface; eased, at most 15 % a frame) */
  zoomLog = 0;
  /** the camera's speed limit: nearest-solid distances a second */
  speed = 4;
  private placeReq: { x: number; y: number; d: number; z: number } | null = null;
  mode: Mode = 'move';
  private bornAt: number[] = [];
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; cx: number; cy: number } | null = null;
  private sculptAt: { x: number; y: number } | null = null;
  private last = performance.now();
  private canvas: HTMLCanvasElement;
  private info: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  /** frame times (ms), the last 600 */
  readonly frames: number[] = [];
  /** scripted edits (window.nested.sculpt) */
  private queue: { op: Op; nx: number; ny: number; px?: number }[] = [];
  /** per level, when its last promote or slide was submitted, and that op's CPU time (encode + submit) */
  readonly opLog: { what: string; depth: number; at: number; ms: number }[] = [];
  hook: ((dt: number) => void) | null = null;
  /** after the frame's draw was submitted (the measurements) */
  post: (() => void) | null = null;
  private keys = new Set<string>();
  /** the brush's radius as a fraction of the eye's distance to the nearest surface (the size slider; round 7: "relative
   *  to the current camera distance from the nearest surface so click is instant") */
  brushFrac = 0.25;
  /** the Fwd (1) or Back (-1) button held */
  aimHold = 0;
  /** cruise: on, its speed (finest live window widths a second) */
  cruiseOn = false;
  cruiseWps = 1;
  private cruiseKeep = false;
  private speedText: HTMLSpanElement | null = null;
  private cruiseSent = false;
  /** a pool shrink under way, and when its last step ran */
  private shrinking = false;
  private shrinkAt = 0;
  /** (?shrink=0: off, for comparison) */
  shrinkOn = true;
  /** when ops were refused whole (the pool growing ahead: they retry) */
  readonly refusedAt: number[] = [];
  setCruise(on: boolean): void {
    this.cruiseOn = on;
    this.cruiseKeep = on;
    this.cruiseFor = null;
    this.buttons.get('cruise')?.classList.toggle('on', on);
    (document.getElementById('cruise') as HTMLElement).style.display = on ? 'block' : 'none';
  }
  /** the cruise's speed in world units a second: the slider's widths of the finest live window as it was when the cruise
   *  began or the slider last moved (held through promotes and demotes: a demote mid-cruise would otherwise make it 8 x
   *  faster, higher, and demote again) */
  cruiseSpeed(): number {
    if (this.cruiseFor?.wps !== this.cruiseWps) this.cruiseFor = { wps: this.cruiseWps, w: this.width(this.nest.live - 1) };
    return this.cruiseWps * this.cruiseFor.w;
  }
  private cruiseFor: { wps: number; w: number } | null = null;
  /** (the benchmark) the levels left as they are */
  frozen = false;
  private limitsText = '';
  frameCount = 0;

  static async start(device: GPUDevice, q: URLSearchParams): Promise<App> {
    const app = new App(device, q);
    (window as unknown as { nested: unknown }).nested = app.api();
    requestAnimationFrame(() => app.frame());
    if (q.get('fly') === '1') {
      const log = document.getElementById('log')!;
      const { flyThrough, opBench } = await import('./fly');
      setTimeout(async () => {
        const bench = q.get('bench') === '0' ? [] : await opBench(app);
        const rows = await flyThrough(app, (s) => console.log(`[fly] ${s}`));
        (window as unknown as { __fly: unknown }).__fly = { done: true, rows, bench };
        log.style.display = 'block';
        log.style.inset = 'auto 8px 70px 8px';
        log.textContent = rows.map((r) => `${r.zoom}: frame p50 ${r.frameP50.toFixed(1)} ms, p95 ${r.frameP95.toFixed(1)}, holes ${r.holesMax}, coarse ${(r.coarseMean * 100).toFixed(1)} %`).join('\n');
      }, 1500);
    }
    return app;
  }

  constructor(
    readonly device: GPUDevice,
    q: URLSearchParams,
  ) {
    this.k = Number(q.get('k') ?? 8);
    this.n = Number(q.get('n') ?? 256);
    this.maxDepth = Number(q.get('depth') ?? 3);
    this.canvas = document.getElementById('view') as HTMLCanvasElement;
    this.info = document.getElementById('info')!;
    const ctx = this.canvas.getContext('webgpu');
    if (!ctx) throw new Error('This browser has WebGPU but would not give the page a WebGPU canvas.');
    // (the pool starts small and grows by need, ahead of the ops: NS-13)
    this.nest = new GpuNest(device, this.k, Number(q.get('seed') ?? 7), 1024);
    const lim = device.limits;
    this.limitsText = `${Math.round(Math.min(lim.maxBufferSize, lim.maxStorageBufferBindingSize) / 2 ** 20)} MB${q.has('maxbuf') ? `, clamped by ?maxbuf` : ''}`;
    this.render = new Renderer(device, ctx, this.nest);
    this.render.tint = q.get('tint') === '1';
    if (q.has('detail')) this.nest.detailAmp = Number(q.get('detail'));
    this.shrinkOn = q.get('shrink') !== '0';
    if (q.has('yaw')) this.yaw = Number(q.get('yaw'));
    if (q.has('pitch')) this.pitch = Number(q.get('pitch'));
    this.nest.root(this.rootN);
    this.place(Number(q.get('tx') ?? 128), Number(q.get('ty') ?? 128), Number(q.get('d') ?? 260));
    this.bornAt[0] = this.nest.now();
    this.ui();
  }

  // ---- input -----------------------------------------------------------------------------------------------------------
  private ui(): void {
    const bar = document.getElementById('bar')!;
    const add = (id: string, label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = fn;
      bar.appendChild(b);
      this.buttons.set(id, b);
    };
    add('carve', 'Carve', () => this.setMode('carve'));
    add('add', 'Add', () => this.setMode('add'));
    add('raise', 'Raise', () => this.setMode('raise'));
    add('dig', 'Dig', () => this.setMode('dig'));
    add('melt', 'Melt', () => this.setMode('melt'));
    add('move', 'Move', () => this.setMode('move'));
    add('orbit', 'Turn', () => this.setMode('orbit'));
    // the brush's size: a fraction of the distance to the nearest surface (log scale, 2 % to 100 %), its radius in world
    // units beside it
    this.sizeText = this.slider(bar, 'Size', 65, (v) => (this.brushFrac = 0.02 * 50 ** (v / 100)));
    // cruise: fly along the heading over the ground at the height kept when it was switched on; the speed in widths of
    // the finest live window a second (scale-free: the same feel at every depth), log scale 0.05 to 4
    add('cruise', 'Cruise', () => this.setCruise(!this.cruiseOn));
    this.speedText = this.slider(bar, 'Speed', 68, (v) => (this.cruiseWps = 0.05 * 80 ** (v / 100)));
    // move along the aim: two hold buttons at the right edge (R and V on a keyboard; WASD stay the flight over the ground)
    const aim = document.getElementById('aim')!;
    for (const [label, dir] of [['Fwd', 1], ['Back', -1]] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      const off = () => {
        if (this.aimHold === dir) this.aimHold = 0;
        b.classList.remove('on');
      };
      b.addEventListener('pointerdown', (e) => {
        b.setPointerCapture(e.pointerId);
        this.aimHold = dir;
        b.classList.add('on');
      });
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      b.addEventListener('lostpointercapture', off);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      aim.appendChild(b);
    }
    add('tint', 'Colour levels', () => {
      this.render.tint = !this.render.tint;
      this.buttons.get('tint')!.classList.toggle('on', this.render.tint);
    });
    this.buttons.get('tint')!.classList.toggle('on', this.render.tint);
    this.setMode(this.mode);
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1 && this.mode !== 'move' && this.mode !== 'orbit' && e.button === 0) {
        this.sculptAt = { x: e.clientX, y: e.clientY };
        if (this.mode === 'carve' || this.mode === 'add') this.beginStroke();
      }
      if (this.pointers.size === 2) {
        this.endStroke();
        this.sculptAt = null;
        this.pinch = this.pinchOf();
      }
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 2) {
        const now = this.pinchOf();
        if (this.pinch && now) {
          this.zoomLog += Math.log(this.pinch.d / now.d);
          this.pan(now.cx - this.pinch.cx, now.cy - this.pinch.cy);
        }
        this.pinch = now;
        return;
      }
      if (this.sculptAt) {
        this.sculptAt = { x: e.clientX, y: e.clientY };
        if (this.strokeOn) this.strokeMoved = true;
        return;
      }
      // (while cruising a drag turns: the cruise moves the eye)
      if (this.mode === 'orbit' || e.buttons === 2 || this.cruiseOn) this.orbit(dx, dy);
      else this.pan(dx, dy);
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0) {
        this.sculptAt = null;
        this.endStroke();
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomLog += e.deltaY * 0.0012;
    }, { passive: false });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase());
      const m: Record<string, () => void> = { c: () => this.setMode('carve'), f: () => this.setMode('add'), '1': () => this.setMode('raise'), '2': () => this.setMode('dig'), '3': () => this.setMode('melt'), '4': () => this.setMode('move'), '5': () => this.setMode('orbit'), t: () => this.buttons.get('tint')!.click() };
      m[e.key.toLowerCase()]?.();
    });
  }
  /** a labelled range input (0..100) in the bar; returns the span for its readout */
  private slider(bar: HTMLElement, label: string, v0: number, fn: (v: number) => void): HTMLSpanElement {
    const box = document.createElement('label');
    box.className = 'slider';
    const name = document.createElement('span');
    name.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = '0';
    inp.max = '100';
    inp.value = String(v0);
    const out = document.createElement('span');
    out.className = 'val';
    inp.oninput = () => fn(Number(inp.value));
    fn(v0);
    box.append(name, inp, out);
    bar.appendChild(box);
    return out;
  }
  private sizeText: HTMLSpanElement | null = null;
  /** the brush's radius now (world units) */
  brushRadius(): number {
    return this.brushFrac * this.dNear;
  }
  /** world units as text (a root column is ROOT_COLUMN_M) */
  static metres(w: number): string {
    const cm = w * ROOT_COLUMN_M * 100;
    return cm >= 100 ? `${(cm / 100).toFixed(cm >= 1000 ? 0 : 2)} m` : cm >= 1 ? `${cm.toFixed(1)} cm` : `${(cm * 10).toFixed(2)} mm`;
  }
  /** one column of the finest live level (world units) */
  finestCell(): number {
    return 1 / this.k ** (this.nest.live - 1);
  }

  // ---- strokes (carve, add): a tap is the whole ball at once; a drag sweeps it along the surface as it was when the
  // stroke began (round 7: the radius is the size slider's, fixed at the stroke's start; no hold to grow) --------------
  strokeOn = false;
  private strokeMoved = false;
  private strokeFirst = false;
  /** the stroke's radius (world), fixed when it began */
  strokeR = 0;
  private ring: HTMLDivElement | null = null;
  private beginStroke(): void {
    this.strokeOn = true;
    this.strokeFirst = true;
    this.strokeMoved = false;
    this.strokeR = this.brushRadius();
    this.nest.strokeBegin();
  }
  private endStroke(): void {
    if (!this.strokeOn) return;
    this.strokeOn = false;
    this.nest.strokeEnd();
  }
  /** the ball's radius as a ring round the finger (screen size at the distance of the screen's centre: NS-25) */
  private ringShow(): void {
    if (!this.ring) {
      this.ring = document.createElement('div');
      this.ring.style.cssText = 'position:fixed;pointer-events:none;border:2px solid rgba(255,255,255,0.85);border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,0.4);display:none';
      document.body.appendChild(this.ring);
    }
    const on = this.strokeOn && this.sculptAt;
    this.ring.style.display = on ? 'block' : 'none';
    if (!on) return;
    const r = this.strokeR / this.perPx();
    Object.assign(this.ring.style, { left: `${this.sculptAt!.x - r}px`, top: `${this.sculptAt!.y - r}px`, width: `${2 * r}px`, height: `${2 * r}px` });
  }

  private setMode(m: Mode): void {
    this.mode = m;
    for (const id of ['carve', 'add', 'raise', 'dig', 'melt', 'move', 'orbit']) this.buttons.get(id)!.classList.toggle('on', id === m);
  }
  private pinchOf(): { d: number; cx: number; cy: number } | null {
    const p = [...this.pointers.values()];
    if (p.length < 2) return null;
    return { d: Math.max(1, Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)), cx: (p[0].x + p[1].x) / 2, cy: (p[0].y + p[1].y) / 2 };
  }
  /** the distance that scales a drag and a zoom: the surface at the screen's centre (or, looking at the sky, a few
   *  nearest-solid distances) */
  private dRef(): number {
    return this.dHit > 0 ? this.dHit : 6 * this.dNear;
  }
  /** world units a CSS pixel at the surface in the screen's centre */
  private perPx(): number {
    return (2 * this.dRef() * Math.tan(FOVY / 2)) / Math.max(1, this.canvas.clientHeight);
  }
  /** the eye moves so that the surface under the finger follows it (the GPU then limits the move) */
  pan(dx: number, dy: number): void {
    const s = this.perPx();
    const rx = -Math.sin(this.yaw);
    const ry = Math.cos(this.yaw);
    const fx = -Math.cos(this.yaw);
    const fy = -Math.sin(this.yaw);
    let mx = (-rx * dx + (fx * dy) / Math.max(0.3, Math.sin(this.pitch))) * s;
    let my = (-ry * dx + (fy * dy) / Math.max(0.3, Math.sin(this.pitch))) * s;
    const len = Math.hypot(mx, my);
    const max = 0.25 * this.dRef();
    if (len > max) {
      mx *= max / len;
      my *= max / len;
    }
    this.move[0] += mx;
    this.move[1] += my;
  }
  /** turn the view round the eye */
  orbit(dx: number, dy: number): void {
    this.yaw -= dx * 0.006;
    this.pitch = Math.min(1.5, Math.max(-1.3, this.pitch + dy * 0.005));
  }
  /** the view direction */
  forward(): [number, number, number] {
    const c = Math.cos(this.pitch);
    return [-c * Math.cos(this.yaw), -c * Math.sin(this.yaw), -Math.sin(this.pitch)];
  }
  /** put the eye back from the ground under (x, y) by d along the view (the GPU places it; then it is collided) */
  place(x: number, y: number, d: number, z = 0): void {
    // (d < 0: the eye at (x, y, z) itself)
    this.placeReq = { x, y, d, z };
    this.ex = x;
    this.ey = y;
    this.dNear = Math.abs(d);
    this.dHit = Math.abs(d);
  }

  // ---- levels ----------------------------------------------------------------------------------------------------------
  /** world width of a level's window */
  width(m: number): number {
    return this.n / this.k ** m;
  }
  /** the eye's velocity over the ground (world units a second; smoothed over ~0.25 s from the reported eye) */
  vx = 0;
  vy = 0;
  private lastEye: [number, number] | null = null;
  /** where level m's window centres (world x, y), round 7's streaming policy: the eye, led ahead along the view (toward
   *  what it looks at, up to 0.2 of the window) and along the eye's velocity (0.6 s of travel), the lead at most 0.4 of
   *  the window, so the strips that enter are far ahead of the eye (where the view sees them small, or not at all). The
   *  window is a level of one grid's chain, in that grid's frame (one root grid today). */
  focus(m: number): [number, number] {
    const W = this.width(m);
    const c = Math.cos(this.pitch);
    const reach = Math.min((this.dHit > 0 ? this.dHit : 4 * this.dNear) * Math.abs(c), 0.2 * W);
    let lx = -Math.cos(this.yaw) * Math.sign(c) * reach + this.vx * App.LEAD_S;
    let ly = -Math.sin(this.yaw) * Math.sign(c) * reach + this.vy * App.LEAD_S;
    const len = Math.hypot(lx, ly);
    if (len > App.LEAD_MAX * W) {
      lx *= (App.LEAD_MAX * W) / len;
      ly *= (App.LEAD_MAX * W) / len;
    }
    return [this.ex + lx, this.ey + ly];
  }
  /** the lead at most (of the window's width): the eye stays 0.1 W inside the window's rear edge */
  static readonly LEAD_MAX = 0.4;
  /** the window leads the eye by this much travel time */
  static readonly LEAD_S = 0.6;
  /** a window slides toward its target when the target is this many columns away along the travel (eager), or this
   *  many against it or with no travel (the hysteresis band: no slide back and forth on a jittering focus) */
  static readonly SLIDE_AHEAD = 32;
  static readonly SLIDE_BACK = 64;
  /** a level is demoted only when the eye has been past the band for this long */
  static readonly DEMOTE_HOLD_S = 0.5;
  private farSince: (number | undefined)[] = [];
  private desired(m: number): Win {
    const s = this.k ** (m - 1);
    const [fx, fy] = this.focus(m);
    return this.nest.windowAt(m, fx * s, fy * s, this.n);
  }
  private levels(): void {
    const now = this.nest.now();
    for (let m = 1; m <= this.maxDepth; m++) {
      const live = this.nest.live;
      const W = this.width(m);
      if (m < live) {
        // the zoom band: promote under 0.45 W, demote over 0.6 W held for DEMOTE_HOLD_S (round 7: a fast cruise over
        // a drop crossed 0.6 W for a moment and demoted and promoted again)
        if (this.dNear > 0.6 * W) {
          this.farSince[m] ??= now;
          if (now - this.farSince[m]! >= App.DEMOTE_HOLD_S) {
            this.farSince[m] = undefined;
            this.timed('demote', m, () => this.nest.demote(m));
            return;
          }
        } else this.farSince[m] = undefined;
        const want = this.desired(m);
        const cur = this.nest.wins[m]!;
        // follow the led focus by whole chunks (whole parent cells): eagerly along the travel, lazily against it (round 7)
        const s = this.k ** m;
        const go = (d: number, v: number) => Math.abs(d) >= App.SLIDE_BACK || (Math.abs(d) >= App.SLIDE_AHEAD && Math.sign(d) === Math.sign(v) && Math.abs(v * s) > 0.02 * this.n);
        const gx = go(want.gx - cur.gx, this.vx);
        const gy = go(want.gy - cur.gy, this.vy);
        if (gx || gy || !this.nest.fits(m, cur)) {
          let to = { gx: gx ? want.gx : cur.gx, gy: gy ? want.gy : cur.gy, n: cur.n };
          if (!this.nest.fits(m, to)) to = want;
          // (refused while the pool grows ahead: tried again next frame). One level op a frame: the next waits.
          this.timed('slide', m, () => this.nest.slide(m, to));
          return;
        }
        continue;
      }
      // (one promote a frame at most, a level's child after the level itself: no fade, the parent draws until the child
      // is baked in the same submit)
      if (m === live && this.dNear < 0.45 * W && now - (this.bornAt[m - 1] ?? 0) > 0.05) {
        const w = this.desired(m);
        if (this.timed('promote', m, () => this.nest.promote(m, w))) this.bornAt[m] = now;
      }
      return;
    }
  }
  /** an op, logged when it ran (false: refused whole, nothing changed) */
  private timed(what: string, depth: number, fn: () => boolean | void): boolean {
    const t = performance.now();
    const ok = fn() !== false;
    if (ok) this.opLog.push({ what, depth, at: t, ms: performance.now() - t });
    else this.refusedAt.push(t);
    if (this.refusedAt.length > 400) this.refusedAt.shift();
    if (this.opLog.length > 400) this.opLog.shift();
    return ok;
  }

  private drawList(): DrawLevel[] {
    const live = this.nest.live;
    const out: DrawLevel[] = [];
    // (metrics) the child is wanted nearer the eye than the band's promote distance, 0.45 of the child's window width:
    // in this level's units 0.45 n / k
    for (let m = 0; m < live; m++) out.push({ depth: m, want: m + 1 <= this.maxDepth ? (0.45 * this.n) / this.k : 0 });
    return out;
  }

  // ---- the frame -------------------------------------------------------------------------------------------------------
  private frame(): void {
    const t = performance.now();
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.frames.push(t - this.last);
    this.frameCount++;
    if (this.frames.length > 600) this.frames.shift();
    this.last = t;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const H = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    // the camera's last report: the eye and the nearest solid
    const rep = this.nest.camOut;
    if (rep[1] === 1 && !this.placeReq) {
      this.ex = rep[20] + rep[24];
      this.ey = rep[21] + rep[25];
      this.ez = rep[22] + rep[26];
      this.dNear = rep[28];
      this.dHit = rep[29];
      this.lifts = rep[27];
    }
    // the eye's velocity over the ground (the streaming lead), smoothed; a placement starts it again
    if (this.placeReq || rep[1] !== 1) {
      this.lastEye = null;
      this.vx = this.vy = 0;
    } else if (this.lastEye && dt > 0) {
      const a = 1 - Math.exp(-dt / 0.25);
      this.vx += a * ((this.ex - this.lastEye[0]) / dt - this.vx);
      this.vy += a * ((this.ey - this.lastEye[1]) / dt - this.vy);
    }
    if (!this.placeReq && rep[1] === 1) this.lastEye = [this.ex, this.ey];
    this.hook?.(dt);
    // fly: WASD or arrows over the ground in the view's heading, Q and E down and up; speed scales with the nearest solid
    const kx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
    const ky = (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0) - (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0);
    const v = 1.5 * this.dNear * dt;
    this.move[0] += v * (-ky * Math.cos(this.yaw) - kx * Math.sin(this.yaw));
    this.move[1] += v * (-ky * Math.sin(this.yaw) + kx * Math.cos(this.yaw));
    this.move[2] += v * ((this.keys.has('e') ? 1 : 0) - (this.keys.has('q') ? 1 : 0));
    // along the aim (the Fwd and Back buttons, R and V): the same speed, collided by the camera pass like any move
    const ka = this.aimHold + (this.keys.has('r') ? 1 : 0) - (this.keys.has('v') ? 1 : 0);
    if (ka) {
      const f = this.forward();
      for (let i = 0; i < 3; i++) this.move[i] += ka * v * f[i];
    }
    // zoom: toward (or away from) the surface at the centre, eased, at most 15 % of that distance a frame
    if (this.zoomLog !== 0) {
      const step = Math.min(Math.log(1.15), Math.max(-Math.log(1.15), this.zoomLog));
      this.zoomLog = Math.abs(this.zoomLog - step) < 1e-4 ? 0 : this.zoomLog - step;
      const f = this.forward();
      const t = this.dRef() * (1 - Math.exp(step));
      for (let i = 0; i < 3; i++) this.move[i] += f[i] * t;
    }
    // at most one op in flight: an op runs only once the pool's header has come back after the last one (its pages
    // known exactly, so the next reserve is exact and no op piles up behind another)
    // (levels hold still during a stroke: its snapshot is of the levels open when it began)
    if (!this.frozen && this.nest.settled && !this.strokeOn) this.levels();
    // give pool pages back (NS-67): when the pool holds a good margin more than a shrink would leave, a step a frame
    // (at most 4 a second) between ops, never in a frame that started another op or during a stroke
    if (this.shrinkOn && !this.frozen && this.nest.settled && !this.strokeOn && !this.sculptAt && t - this.shrinkAt > 250) {
      if (!this.shrinking && this.nest.cap > this.nest.shrinkTarget() + 256) this.shrinking = true;
      if (this.shrinking) {
        this.shrinking = this.nest.shrink();
        if (this.shrinking) this.opLog.push({ what: 'shrink', depth: -1, at: t, ms: performance.now() - t });
        this.shrinkAt = t;
      }
    }
    const ndc = this.sculptAt ? [(this.sculptAt.x / this.canvas.clientWidth) * 2 - 1, 1 - (this.sculptAt.y / this.canvas.clientHeight) * 2] : [0, 0];
    const qd = this.nest.settled ? this.queue.shift() : undefined;
    if (qd) ndc.splice(0, 2, qd.nx, qd.ny);
    if (this.placeReq) this.nest.placeEye(this.placeReq.x, this.placeReq.y, this.placeReq.d, this.placeReq.z);
    // cruise: the camera pass moves the eye along the heading and follows the ground (no readback); the speed limit is
    // raised to let the cruise's speed through (the per-frame limit, the nearest solid less the margin, still holds)
    let speed = this.speed;
    if (this.cruiseOn || this.cruiseSent) {
      const cs = this.cruiseSpeed();
      this.nest.cruise(this.cruiseOn, cs, this.cruiseKeep || !!this.placeReq);
      this.cruiseKeep = false;
      this.cruiseSent = this.cruiseOn;
      if (this.cruiseOn) speed = Math.max(speed, (1.5 * cs) / Math.max(1e-9, this.dNear));
    }
    this.nest.camIn.set([this.move[0], this.move[1], this.move[2], this.placeReq ? 1 : 0, this.yaw, this.pitch, W / H, speed, FOVY, ndc[0], ndc[1], dt]);
    this.placeReq = null;
    this.move = [0, 0, 0];
    this.nest.camera();
    // a stroke (carve, add): the whole ball at the first frame (a tap), then an edit each time the finger moved
    const strokeEdit = this.strokeOn && !!this.sculptAt && (this.strokeFirst || this.strokeMoved);
    this.ringShow();
    const held = this.sculptAt && this.nest.settled && (!this.strokeOn || strokeEdit);
    const op = qd?.op ?? (held ? (this.mode as Op) : null);
    if (op) {
      const ballOp = op === 'carve' || op === 'add';
      // (scripted edits: px, a radius in css px at the centre's surface; otherwise the size slider's)
      const radius = qd?.px !== undefined ? qd.px * (ballOp ? 0.5 : 1) * this.perPx() : qd ? this.brushRadius() : this.strokeOn ? this.strokeR : this.brushRadius();
      if (this.strokeOn && !qd) {
        this.strokeFirst = false;
        this.strokeMoved = false;
      }
      const ok = this.timed('edit', -1, () => this.nest.edit({ op, radius, amount: (op === 'melt' ? 0 : 0.04) * radius, rate: 0.1 }));
      if (!ok && qd) this.queue.unshift(qd);
    }
    if (!this.benchPause) this.render.draw(this.drawList());
    this.post?.();
    this.text();
    requestAnimationFrame(() => this.frame());
  }
  /** (measurement) the frame's draw left out, so an op's GPU time is measured alone */
  benchPause = false;

  private text(): void {
    const live = this.nest.live;
    const col = (ROOT_COLUMN_M / this.k ** (live - 1)) * 100;
    const st = this.nest.stats;
    const ft = this.frames.slice(-60);
    const avg = ft.reduce((a, b) => a + b, 0) / Math.max(1, ft.length);
    const lines = [
      `Levels open: ${live}. Finest column: ${col >= 100 ? `${(col / 100).toFixed(1)} m` : `${col.toFixed(col < 1 ? 2 : 1)} cm`}.`,
      `Camera ${(this.dNear * ROOT_COLUMN_M).toFixed(this.dNear * ROOT_COLUMN_M < 10 ? 2 : 0)} m from the nearest surface. Frame ${avg.toFixed(1)} ms.`,
      `Pages: ${st.used} used of ${st.held} reserved (${st.mb} MB in ${st.segs} of ${st.segSlots} buffers; the device's largest buffer ${this.limitsText}).`,
      live < this.maxDepth + 1 ? 'Zoom in close to the ground to open a finer level.' : 'This is the finest level.',
      this.mode === 'move' ? 'Drag to move. Pinch or scroll to zoom. Fwd and Back move along the aim. Keys: WASD to fly, Q and E down and up, R and V along the aim.' : this.mode === 'orbit' ? 'Drag to look around.' : `Drag on the ground to ${this.mode}.`,
    ];
    const br = this.strokeOn ? this.strokeR : this.brushRadius();
    if (this.sizeText) this.sizeText.textContent = App.metres(br);
    if (br < this.finestCell() && this.mode !== 'move' && this.mode !== 'orbit')
      lines.push(`The brush (${App.metres(br)}) is smaller than one column of the finest level (${App.metres(this.finestCell())}): it may change nothing. Move Size up or zoom out.`);
    if (this.lifts) lines.push(`The camera was lifted out of solid ${this.lifts} times.`);
    if (st.refused || st.mismatch || st.tableFull) lines.push(`Error: ${st.refused} pages refused, ${st.mismatch} blocks mismatched, table full ${st.tableFull} times.`);
    if (st.error) lines.push(`Memory: ${st.error}`);
    this.info.textContent = lines.join('\n');
    if (this.speedText) this.speedText.textContent = `${this.cruiseWps.toFixed(2)} w/s`;
    if (this.cruiseOn) document.getElementById('cruise')!.textContent = this.cruiseText();
  }
  /** the cruise readout (the owner judges panning and loading on the phone): the last 2 s */
  cruiseText(): string {
    const now = performance.now();
    const ops = this.opLog.filter((o) => now - o.at < 2000);
    const n = (w: string) => ops.filter((o) => o.what === w).length / 2;
    let worst = 0;
    for (let i = this.frames.length - 1, acc = 0; i >= 0 && acc < 2000; i--) {
      acc += this.frames[i];
      worst = Math.max(worst, this.frames[i]);
    }
    const st = this.nest.stats;
    const refused = this.refusedAt.filter((t) => now - t < 2000).length;
    return [
      `Cruise ${A2(this.cruiseSpeed() * ROOT_COLUMN_M)} m/s (${this.cruiseWps.toFixed(2)} w/s)`,
      `slides ${n('slide').toFixed(1)}/s  promotes ${n('promote').toFixed(1)}/s  demotes ${n('demote').toFixed(1)}/s`,
      `ops waiting ${refused} (2 s)${this.nest.settled ? '' : ', one in flight'}${st.refused ? `  PAGES REFUSED ${st.refused}` : ''}`,
      `pool ${st.used} used / ${st.held} reserved (${(st.held / Math.max(1, st.used)).toFixed(1)}x)`,
      `worst frame ${worst.toFixed(1)} ms (2 s)`,
    ].join('\n');
  }

  private api() {
    return {
      app: this,
      /** turn the view; with tx, ty or d, place the eye back from the ground under (tx, ty) by d */
      setView: (v: { tx?: number; ty?: number; d?: number; yaw?: number; pitch?: number; eye?: [number, number, number] }) => {
        if (v.yaw !== undefined) this.yaw = v.yaw;
        if (v.pitch !== undefined) this.pitch = v.pitch;
        if (v.eye) return this.place(v.eye[0], v.eye[1], -1, v.eye[2]);
        if (v.tx !== undefined || v.ty !== undefined || v.d !== undefined) this.place(v.tx ?? this.ex, v.ty ?? this.ey, v.d ?? this.dRef());
      },
      /** a wished move of the eye (world), limited by the GPU like any input */
      fly: (x: number, y: number, z: number) => {
        this.move[0] += x;
        this.move[1] += y;
        this.move[2] += z;
      },
      zoom: (logRatio: number) => (this.zoomLog += logRatio),
      /** cruise on or off; wps: its speed in finest live window widths a second */
      cruise: (on: boolean, wps?: number) => {
        if (wps !== undefined) this.cruiseWps = wps;
        this.setCruise(on);
      },
      eye: () => ({ x: this.ex, y: this.ey, z: this.ez, dNear: this.dNear, dHit: this.dHit, lifts: this.lifts, level: this.nest.camOut[30], margin: this.nest.camOut[31] }),
      /** queue `times` edits at a screen point (ndc), one a frame */
      /** px: the brush's radius in css px (default: the brush button's) */
      sculpt: (op: Op, nx: number, ny: number, times = 1, px?: number) => {
        for (let i = 0; i < times; i++) this.queue.push({ op, nx, ny, px });
      },
      state: () => ({ live: this.nest.live, wins: this.nest.wins.slice(0, this.nest.live), dNear: this.dNear, ex: this.ex, ey: this.ey, stats: { ...this.nest.stats }, queue: this.queue.length }),
      /** (diagnostics, a readback) the eye on each level and the column under it */
      probeCam: async () => {
        const cam = await this.nest.readCam();
        const snap = await this.nest.readAll();
        const out = [];
        for (let m = 0; m < this.nest.live; m++) {
          const b = 32 + m * 24;
          const e = [cam[b + 16], cam[b + 17], cam[b + 18]];
          const w = this.nest.wins[m]!;
          const X = w.gx + Math.floor(e[0]);
          const Y = w.gy + Math.floor(e[1]);
          const inWin = e[0] >= 0 && e[1] >= 0 && e[0] < w.n && e[1] < w.n;
          const col = inWin ? snap.column(m, X, Y) : null;
          const inside = col ? col.z0.some((z0, i) => (i === 0 || e[2] >= z0) && e[2] <= col.z1[i]) : null;
          out.push({ m, eye: e.map((v) => +v.toFixed(3)), inWin, top: col ? col.z1[col.z1.length - 1] : null, inside, near: cam[b + 19] });
        }
        return { eyeZ: cam[2], dNear: cam[28], dHit: cam[29], lifts: cam[27], level: cam[30], levels: out };
      },
      /** (measurement) the draw alone, uncapped: n draws of the current levels back to back, ms each (GPU done) */
      benchDraw: async (n = 20) => {
        const list = this.drawList();
        this.render.draw(list);
        await this.device.queue.onSubmittedWorkDone();
        const t = performance.now();
        for (let i = 0; i < n; i++) this.render.draw(list);
        await this.device.queue.onSubmittedWorkDone();
        return (performance.now() - t) / n;
      },
      /** (measurement) one frame's GPU work with nothing changing: the camera pass and the draw, n times, ms each */
      benchFrame: async (n = 20) => {
        const list = this.drawList();
        await this.device.queue.onSubmittedWorkDone();
        const t = performance.now();
        for (let i = 0; i < n; i++) {
          this.nest.camera();
          this.render.draw(list);
        }
        await this.device.queue.onSubmittedWorkDone();
        return (performance.now() - t) / n;
      },
      /** (measurement) an edit's GPU time with and without the bakes (ms; the edit is applied twice) */
      benchEdit: async (spec: Parameters<GpuNest['edit']>[0]) => {
        const run = async (off: boolean) => {
          // (the frames' draws and the level logic held back while it runs: the time is the edit's own)
          this.benchPause = true;
          const fz = this.frozen;
          this.frozen = true;
          await new Promise((r) => requestAnimationFrame(r));
          await this.device.queue.onSubmittedWorkDone();
          this.nest.bakeOff = off;
          const t = performance.now();
          // (refused while the pool grows ahead: tried again)
          while (!this.nest.edit(spec)) {
            this.nest.bakeOff = false;
            await new Promise((r) => setTimeout(r, 30));
            this.nest.bakeOff = off;
          }
          await this.device.queue.onSubmittedWorkDone();
          this.nest.bakeOff = false;
          this.benchPause = false;
          this.frozen = fz;
          return performance.now() - t;
        };
        const without = await run(true);
        const withBake = await run(false);
        return { withBake, without };
      },
      /** (test only, readbacks) the manifold check of every level's drawn faces */
      manifold: async () => {
        // (the levels held still while the capture's readbacks are awaited: it sees one frame's faces, not a slide's
        // half)
        const was = this.frozen;
        this.frozen = true;
        try {
          const caps = await this.render.capture(this.drawList());
          const rim = rimJunctions(caps, this.nest.wins.slice(0, this.nest.live) as { gx: number; gy: number; n: number }[], this.k);
          return caps.map((c) => ({ ...manifold(c), rim: rim.find((r) => r.depth === c.depth) }));
        } finally {
          this.frozen = was;
        }
      },
      /** (test only, readbacks) every column drawn by exactly one level (watertight.ts coverage) */
      coverage: async () => {
        const was = this.frozen;
        this.frozen = true;
        try {
          const caps = await this.render.capture(this.drawList());
          const c = coverage(caps, this.nest.wins.slice(0, this.nest.live) as { gx: number; gy: number; n: number }[], this.k);
          // (a flagged column's records, for the report)
          if (c.where.length) {
            const s = await this.nest.readAll();
            c.where = c.where.map((w) => {
              const m = /L(\d+) (?:column|stale cap at) (-?\d+),(-?\d+)/.exec(w);
              return m ? `${w} ${JSON.stringify(s.column(+m[1], +m[2], +m[3]))}` : w;
            });
          }
          return c;
        } finally {
          this.frozen = was;
        }
      },
      /** (test only) pixels with no surface in the last frame */
      holes: () => holePixels(this.device, this.render, () => this.render.draw(this.drawList())),
      holeImage: () => lastImage,
      /** (round 11, NS-97, test only) the triangles of every level round screen pixel (px, py) (watertight.ts rayDiag) */
      holeDiag: async (px: number, py: number, w: number, h: number, tol?: number) => {
        const was = this.frozen;
        this.frozen = true;
        try {
          const cam = await this.nest.readCam();
          const caps = await this.render.capture(this.drawList());
          const s = await this.nest.readAll();
          return rayDiag(caps, cam, px, py, w, h, tol, (L, z) => s.zOrigin(L + 1) + z / this.k);
        } finally {
          this.frozen = was;
        }
      },
      tint: (on: boolean) => {
        this.render.tint = on;
        this.buttons.get('tint')!.classList.toggle('on', on);
      },
    };
  }
}
