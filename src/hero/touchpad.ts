// ---- hero/touchpad.ts -----------------------------------------------------------
// A hero's controller for phones first, keys on a desktop (round 88; contracts/hero.ts `HeroController`).
// - A drag anywhere is a stick: it appears where the finger lands, and the hero walks the way it's pushed,
//   relative to the view (up the screen is away from the camera) — a short push walks, a long one runs.
// - A tap is `onTap(sx, sy)`: the game says what it means (talk to the person there, attack what's there,
//   walk to that spot).
// - Two fingers pinch the zoom; the wheel zooms.
// - The ⚔ button swings (held: swings again as soon as it can); a context button (`setAction`) shows what
//   tapping it does (Talk to Ilsa) — E on a keyboard.
// - Keys: WASD or the arrows walk, Space or J swings, E the context action.
// It sits under the rest of the UI (prepended), over the canvas: the level's own pan, tap and gust never see
// its pointers.

import type { HeroController, HeroIntent } from '../api/contracts/hero';
import type { Camera } from '../render/camera';
import './touchpad.css';

const STICK = 56;
const TAP_SLOP = 10;
const TAP_MS = 350;

export class TouchPad implements HeroController {
  /** a tap on the world (CSS px) */
  onTap: ((sx: number, sy: number) => void) | null = null;
  /** the context action (the button or E) */
  onAction: (() => void) | null = null;
  /** a tap or a press of the swing: a goTo the hero had is cancelled by the game */
  private surface: HTMLDivElement;
  private ring: HTMLDivElement;
  private knob: HTMLDivElement;
  private attackBtn: HTMLButtonElement;
  private actionBtn: HTMLButtonElement;
  private runBtn: HTMLButtonElement;
  /** running (the toggle) */
  running = false;
  private bar: HTMLDivElement;
  private fill: HTMLDivElement;
  private stick: { id: number; x0: number; y0: number; x: number; y: number; t0: number; moved: boolean } | null = null;
  private pinch: { a: number; b: number; d: number } | null = null;
  private touches = new Map<number, [number, number]>();
  private keys = new Set<string>();
  private attackHeld = false;
  private attackTap = false;
  private abort = new AbortController();
  /** scripts drive it as a player would: a stick (screen px from its centre) and the swing */
  scripted: { stick?: [number, number]; attack?: boolean } | null = null;

  constructor(
    ui: HTMLElement,
    private camera: Camera,
  ) {
    const el = (cls: string, tag = 'div') => {
      const e = document.createElement(tag);
      e.className = cls;
      return e;
    };
    this.surface = el('hero-pad') as HTMLDivElement;
    this.ring = el('hero-stick') as HTMLDivElement;
    this.knob = el('hero-knob') as HTMLDivElement;
    this.ring.append(this.knob);
    this.surface.append(this.ring);
    ui.prepend(this.surface);
    this.attackBtn = el('hero-btn hero-attack', 'button') as HTMLButtonElement;
    this.attackBtn.textContent = '⚔';
    this.attackBtn.title = 'Swing (Space)';
    this.actionBtn = el('hero-btn hero-action', 'button') as HTMLButtonElement;
    // (round 94) run: a toggle (Shift held on a keyboard)
    this.runBtn = el('hero-btn hero-run', 'button') as HTMLButtonElement;
    this.runBtn.textContent = '🏃';
    this.runBtn.title = 'Run (Shift)';
    this.runBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.runBtn.addEventListener('click', () => {
      this.running = !this.running;
      this.runBtn.classList.toggle('on', this.running);
    });
    this.actionBtn.style.display = 'none';
    this.bar = el('hero-health') as HTMLDivElement;
    this.fill = el('hero-health-fill') as HTMLDivElement;
    this.bar.append(this.fill);
    ui.append(this.attackBtn, this.actionBtn, this.runBtn, this.bar);
    const signal = this.abort.signal;
    const stop = (e: Event) => e.stopPropagation();
    for (const b of [this.attackBtn, this.actionBtn]) b.addEventListener('pointerdown', stop, { signal });
    this.attackBtn.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        this.attackHeld = true;
        this.attackTap = true;
      },
      { signal },
    );
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave'])
      this.attackBtn.addEventListener(ev, () => (this.attackHeld = false), { signal });
    this.actionBtn.addEventListener('click', () => this.onAction?.(), { signal });

    const s = this.surface;
    s.addEventListener(
      'pointerdown',
      (e) => {
        s.setPointerCapture(e.pointerId);
        this.touches.set(e.pointerId, [e.clientX, e.clientY]);
        if (this.touches.size === 2) {
          // (a second finger: a pinch, the stick let go)
          const [a, b] = [...this.touches.keys()];
          this.pinch = { a, b, d: this.spread(a, b) };
          this.release();
          return;
        }
        if (!this.stick && this.touches.size === 1) this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), moved: false };
      },
      { signal },
    );
    s.addEventListener(
      'pointermove',
      (e) => {
        if (!this.touches.has(e.pointerId)) return;
        this.touches.set(e.pointerId, [e.clientX, e.clientY]);
        const p = this.pinch;
        if (p) {
          if (!this.touches.has(p.a) || !this.touches.has(p.b)) return;
          const d = this.spread(p.a, p.b);
          this.zoom(d / p.d);
          p.d = d;
          return;
        }
        const st = this.stick;
        if (!st || st.id !== e.pointerId) return;
        st.x = e.clientX;
        st.y = e.clientY;
        if (!st.moved && Math.hypot(st.x - st.x0, st.y - st.y0) > TAP_SLOP) {
          st.moved = true;
          this.ring.style.display = 'block';
          this.ring.style.transform = `translate(${st.x0}px, ${st.y0}px)`;
        }
        if (st.moved) {
          const [kx, ky] = this.knobAt(st);
          this.knob.style.transform = `translate(${kx}px, ${ky}px)`;
        }
      },
      { signal },
    );
    const up = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (this.pinch && (e.pointerId === this.pinch.a || e.pointerId === this.pinch.b)) {
        this.pinch = null;
        return;
      }
      const st = this.stick;
      if (!st || st.id !== e.pointerId) return;
      if (!st.moved && performance.now() - st.t0 < TAP_MS && e.type === 'pointerup') this.onTap?.(e.clientX, e.clientY);
      this.release();
    };
    s.addEventListener('pointerup', up, { signal });
    s.addEventListener('pointercancel', up, { signal });
    s.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(Math.exp(-e.deltaY * 0.0015));
      },
      { signal, passive: false },
    );
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.target instanceof HTMLInputElement) return;
        const k = e.key.toLowerCase();
        // (its own keys go no further: the level's pan, lens and tools don't see them)
        if (!/^(w|a|s|d|e|j| |shift|arrow.*)$/.test(k) || e.ctrlKey || e.metaKey) return;
        e.stopPropagation();
        this.keys.add(k);
        if (k === ' ' || k === 'j') {
          e.preventDefault();
          this.attackTap = true;
        }
        if (k === 'e' && this.actionBtn.style.display !== 'none') this.onAction?.();
      },
      { signal, capture: true },
    );
    // (round 117, revive: in the capture phase, as keydown — a panel that stops its keys' propagation, the hero
    // sandbox's, swallowed the keyup with a button of it focused, and W walked the hero on for ever)
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()), { signal, capture: true });
    window.addEventListener('blur', () => this.keys.clear(), { signal });
  }

  /** what the context button says (null: hidden) */
  setAction(label: string | null): void {
    if (label === null) this.actionBtn.style.display = 'none';
    else {
      this.actionBtn.style.display = '';
      if (this.actionBtn.textContent !== label) this.actionBtn.textContent = label;
    }
  }

  setHealth(h: number, max: number): void {
    this.fill.style.width = `${Math.max(0, (100 * h) / max).toFixed(1)}%`;
    this.bar.classList.toggle('low', h <= max * 0.3);
    this.bar.dataset.hp = `${Math.ceil(h)} / ${max}`;
  }

  /** hide the controls (a talk has the screen) */
  set hidden(on: boolean) {
    for (const e of [this.attackBtn, this.runBtn, this.bar]) e.style.visibility = on ? 'hidden' : '';
    if (on) {
      this.actionBtn.style.display = 'none';
      this.release();
    }
  }

  intent(): HeroIntent {
    let jx = 0;
    let jy = 0;
    const st = this.stick;
    const sc = this.scripted?.stick;
    if (sc) [jx, jy] = [sc[0] / STICK, sc[1] / STICK];
    else if (st?.moved) {
      const [kx, ky] = this.knobAt(st);
      [jx, jy] = [kx / STICK, ky / STICK];
    } else {
      const k = this.keys;
      if (k.has('a') || k.has('arrowleft')) jx -= 1;
      if (k.has('d') || k.has('arrowright')) jx += 1;
      if (k.has('w') || k.has('arrowup')) jy -= 1;
      if (k.has('s') || k.has('arrowdown')) jy += 1;
      const l = Math.hypot(jx, jy);
      if (l > 1) [jx, jy] = [jx / l, jy / l];
    }
    // (screen → ground: right is (−sin az, cos az); up the screen is away from the eye, (−cos az, −sin az))
    const az = this.camera.azimuth;
    const move: [number, number] = [-Math.sin(az) * jx + Math.cos(az) * jy, Math.cos(az) * jx + Math.sin(az) * jy];
    const attack = this.attackTap || this.attackHeld || !!this.scripted?.attack || this.keys.has(' ') || this.keys.has('j');
    this.attackTap = false;
    return { move, attack, sprint: this.running || this.keys.has('shift') };
  }

  dispose(): void {
    this.abort.abort();
    for (const e of [this.surface, this.attackBtn, this.actionBtn, this.runBtn, this.bar]) e.remove();
  }

  private knobAt(st: { x0: number; y0: number; x: number; y: number }): [number, number] {
    const dx = st.x - st.x0;
    const dy = st.y - st.y0;
    const d = Math.hypot(dx, dy);
    const k = d > STICK ? STICK / d : 1;
    return [dx * k, dy * k];
  }

  private release(): void {
    this.stick = null;
    this.ring.style.display = 'none';
    this.knob.style.transform = '';
  }

  private spread(a: number, b: number): number {
    const p = this.touches.get(a)!;
    const q = this.touches.get(b)!;
    return Math.max(1, Math.hypot(p[0] - q[0], p[1] - q[1]));
  }

  private zoom(f: number): void {
    this.camera.zoom = Math.max(4, Math.min(24, this.camera.zoom * f));
  }
}
