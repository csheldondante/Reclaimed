// Nested scales lab: the sandbox (docs/design/NESTED_SCALES.md). One root terrain; zoom in near the ground and a finer
// level is promoted round the focus (and a finer one inside it), each drawn in its own units; sculpt on whichever
// level is under the pointer. Everything that touches the columns runs on the GPU (gpu/nest.ts); this file holds the
// camera's inputs, which levels are wanted where, the buttons and the measurements.
import { GpuNest, type Op, type Win } from './gpu/nest';
import { Renderer, type DrawLevel } from './render';

/** a root column, in metres (the info line) */
const ROOT_COLUMN_M = 3.2;
const FOVY = (50 * Math.PI) / 180;

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
  private placeReq: { x: number; y: number; d: number } | null = null;
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
  /** the brush's radius on screen (css px) */
  brushPx = 60;
  /** (the benchmark) the levels left as they are */
  frozen = false;

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
    this.nest = new GpuNest(device, this.k, Number(q.get('seed') ?? 7), 1536);
    this.render = new Renderer(device, ctx, this.nest, Math.max(this.rootN, this.n));
    this.render.tint = q.get('tint') === '1';
    if (q.has('detail')) this.nest.detailAmp = Number(q.get('detail'));
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
    add('size', 'Brush: medium', () => {
      this.brushPx = this.brushPx === 60 ? 110 : this.brushPx === 110 ? 30 : 60;
      this.buttons.get('size')!.textContent = `Brush: ${this.brushPx === 30 ? 'small' : this.brushPx === 60 ? 'medium' : 'large'}`;
    });
    add('orbit', 'Turn', () => this.setMode('orbit'));
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
      if (this.pointers.size === 1 && this.mode !== 'move' && this.mode !== 'orbit' && e.button === 0) this.sculptAt = { x: e.clientX, y: e.clientY };
      if (this.pointers.size === 2) {
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
        return;
      }
      if (this.mode === 'orbit' || e.buttons === 2) this.orbit(dx, dy);
      else this.pan(dx, dy);
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0) this.sculptAt = null;
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
  place(x: number, y: number, d: number): void {
    this.placeReq = { x, y, d };
    this.ex = x;
    this.ey = y;
    this.dNear = d;
    this.dHit = d;
  }

  // ---- levels ----------------------------------------------------------------------------------------------------------
  /** world width of a level's window */
  width(m: number): number {
    return this.n / this.k ** m;
  }
  private desired(m: number): Win {
    const s = this.k ** (m - 1);
    return this.nest.windowAt(m, this.ex * s, this.ey * s, this.n);
  }
  private levels(): void {
    const now = this.nest.now();
    for (let m = 1; m <= this.maxDepth; m++) {
      const live = this.nest.live;
      const W = this.width(m);
      if (m < live) {
        if (this.dNear > 0.6 * W) {
          this.timed('demote', m, () => this.nest.demote(m));
          return;
        }
        const want = this.desired(m);
        const cur = this.nest.wins[m]!;
        // follow the focus by whole chunks (whole parent cells), with a chunk of slack
        if (Math.abs(want.gx - cur.gx) >= 32 || Math.abs(want.gy - cur.gy) >= 32 || !this.nest.fits(m, cur)) {
          this.timed('slide', m, () => this.nest.slide(m, want));
          this.bornAt[m] = Math.max(this.bornAt[m] ?? 0, now - this.render.fadeSeconds + 0.05);
        }
        continue;
      }
      if (m === live && this.dNear < 0.45 * W && now - (this.bornAt[m - 1] ?? 0) > this.render.fadeSeconds + 0.05) {
        const w = this.desired(m);
        this.timed('promote', m, () => this.nest.promote(m, w));
        this.bornAt[m] = now;
      }
      return;
    }
  }
  private timed(what: string, depth: number, fn: () => void): void {
    const t = performance.now();
    fn();
    this.opLog.push({ what, depth, at: t, ms: performance.now() - t });
    if (this.opLog.length > 400) this.opLog.shift();
  }

  private drawList(): DrawLevel[] {
    const live = this.nest.live;
    const out: DrawLevel[] = [];
    for (let m = 0; m < live; m++) {
      const w = this.nest.wins[m]!;
      const c = this.nest.wins[m + 1];
      const k = this.k;
      const inset = 0.75 / k;
      const cut: DrawLevel['cut'] = c ? [c.gx / k - w.gx + inset, c.gy / k - w.gy + inset, (c.gx + c.n) / k - w.gx - inset, (c.gy + c.n) / k - w.gy - inset] : null;
      // (metrics) where the child should be now: the window the level logic keeps (its current one while within the
      // slack) or would move to
      let want: DrawLevel['want'] = null;
      if (m + 1 <= this.maxDepth && (c || this.dNear < 0.45 * this.width(m + 1))) {
        const s = this.k ** m;
        let g = this.nest.windowAt(m + 1, this.ex * s, this.ey * s, this.n);
        if (c && Math.abs(g.gx - c.gx) < 32 && Math.abs(g.gy - c.gy) < 32) g = c;
        want = [g.gx / k - w.gx + inset, g.gy / k - w.gy + inset, (g.gx + g.n) / k - w.gx - inset, (g.gy + g.n) / k - w.gy - inset];
      }
      out.push({ depth: m, cut, want });
    }
    return out;
  }

  // ---- the frame -------------------------------------------------------------------------------------------------------
  private frame(): void {
    const t = performance.now();
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.frames.push(t - this.last);
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
    this.hook?.(dt);
    // fly: WASD or arrows over the ground in the view's heading, Q and E down and up; speed scales with the nearest solid
    const kx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
    const ky = (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0) - (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0);
    const v = 1.5 * this.dNear * dt;
    this.move[0] += v * (-ky * Math.cos(this.yaw) - kx * Math.sin(this.yaw));
    this.move[1] += v * (-ky * Math.sin(this.yaw) + kx * Math.cos(this.yaw));
    this.move[2] += v * ((this.keys.has('e') ? 1 : 0) - (this.keys.has('q') ? 1 : 0));
    // zoom: toward (or away from) the surface at the centre, eased, at most 15 % of that distance a frame
    if (this.zoomLog !== 0) {
      const step = Math.min(Math.log(1.15), Math.max(-Math.log(1.15), this.zoomLog));
      this.zoomLog = Math.abs(this.zoomLog - step) < 1e-4 ? 0 : this.zoomLog - step;
      const f = this.forward();
      const t = this.dRef() * (1 - Math.exp(step));
      for (let i = 0; i < 3; i++) this.move[i] += f[i] * t;
    }
    if (!this.frozen) this.levels();
    const ndc = this.sculptAt ? [(this.sculptAt.x / this.canvas.clientWidth) * 2 - 1, 1 - (this.sculptAt.y / this.canvas.clientHeight) * 2] : [0, 0];
    const qd = this.queue.shift();
    if (qd) ndc.splice(0, 2, qd.nx, qd.ny);
    if (this.placeReq) this.nest.placeEye(this.placeReq.x, this.placeReq.y, this.placeReq.d);
    this.nest.camIn.set([this.move[0], this.move[1], this.move[2], this.placeReq ? 1 : 0, this.yaw, this.pitch, W / H, this.speed, FOVY, ndc[0], ndc[1], dt]);
    this.placeReq = null;
    this.move = [0, 0, 0];
    this.nest.camera();
    const op = qd?.op ?? (this.sculptAt ? (this.mode as Op) : null);
    if (op) {
      const radius = (qd?.px ?? this.brushPx) * this.perPx() * (op === 'carve' || op === 'add' ? 0.5 : 1);
      this.timed('edit', -1, () => this.nest.edit({ op, radius, amount: (op === 'melt' ? 0 : 0.04) * radius, rate: 0.1 }));
    }
    this.render.draw(this.drawList());
    this.post?.();
    this.text();
    requestAnimationFrame(() => this.frame());
  }

  private text(): void {
    const live = this.nest.live;
    const col = (ROOT_COLUMN_M / this.k ** (live - 1)) * 100;
    const st = this.nest.stats;
    const ft = this.frames.slice(-60);
    const avg = ft.reduce((a, b) => a + b, 0) / Math.max(1, ft.length);
    const lines = [
      `Levels open: ${live}. Finest column: ${col >= 100 ? `${(col / 100).toFixed(1)} m` : `${col.toFixed(col < 1 ? 2 : 1)} cm`}.`,
      `Camera ${(this.dNear * ROOT_COLUMN_M).toFixed(this.dNear * ROOT_COLUMN_M < 10 ? 2 : 0)} m from the nearest surface. Frame ${avg.toFixed(1)} ms.`,
      `Pages: ${st.used} used of ${st.cap}.`,
      live < this.maxDepth + 1 ? 'Zoom in close to the ground to open a finer level.' : 'This is the finest level.',
      this.mode === 'move' ? 'Drag to move. Pinch or scroll to zoom. Keys: WASD to fly, Q and E down and up.' : this.mode === 'orbit' ? 'Drag to look around.' : `Drag on the ground to ${this.mode}.`,
    ];
    if (this.lifts) lines.push(`The camera was lifted out of solid ${this.lifts} times.`);
    if (st.refused || st.mismatch || st.tableFull) lines.push(`Error: ${st.refused} pages refused, ${st.mismatch} blocks mismatched, table full ${st.tableFull} times.`);
    this.info.textContent = lines.join('\n');
  }

  private api() {
    return {
      app: this,
      /** turn the view; with tx, ty or d, place the eye back from the ground under (tx, ty) by d */
      setView: (v: { tx?: number; ty?: number; d?: number; yaw?: number; pitch?: number }) => {
        if (v.yaw !== undefined) this.yaw = v.yaw;
        if (v.pitch !== undefined) this.pitch = v.pitch;
        if (v.tx !== undefined || v.ty !== undefined || v.d !== undefined) this.place(v.tx ?? this.ex, v.ty ?? this.ey, v.d ?? this.dRef());
      },
      /** a wished move of the eye (world), limited by the GPU like any input */
      fly: (x: number, y: number, z: number) => {
        this.move[0] += x;
        this.move[1] += y;
        this.move[2] += z;
      },
      zoom: (logRatio: number) => (this.zoomLog += logRatio),
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
      tint: (on: boolean) => {
        this.render.tint = on;
        this.buttons.get('tint')!.classList.toggle('on', on);
      },
    };
  }
}
