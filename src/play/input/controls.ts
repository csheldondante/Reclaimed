// ---- play/input/controls.ts -------------------------------------------------------------------------------------
// The thumbs, laid out per hero (its Pad), phone first (ported from GameplayGM runtimes/hoverbike/src/controls.ts,
// round 117, where the bike was playtested "the fun one"):
//   move    'stick': a stick that appears where the left thumb lands in the bottom-left zone (a floating stick: no
//           hunting for a fixed ring); 'none': no stick (the lich goes where it's tapped)
//   right   everything else is the hero's gestures: a drag held, or a gesture let go (core/gestures.ts Stroke)
//   buttons bottom right, stacked up, thumb-sized; their gauges and lights from the hero (ButtonLook)
// Desktop: WASD or the arrows move; Space, E, Q, R the buttons; the mouse is the right thumb.
// Screen pixels only; input/read.ts takes it onto the ground through the camera.

import { Stroke, type Gesture, type Pt } from '../core/gestures';
import type { ButtonLook, Pad } from './types';

/** The stick: its radius (px), dead zone, and the zone a thumb grabs it in (share of the screen from the bottom-left). */
const STICK = { radius: 60, dead: 8, zoneX: 0.45, zoneY: 0.5 };
const BUTTON_KEYS = [' ', 'e', 'q', 'r'];

export class Controls {
  readonly el: HTMLDivElement;
  private keys = new Set<string>();
  private stroke: { id: number; s: Stroke } | null = null;
  private done: Gesture[] = [];
  private held: boolean[];
  private pressed: boolean[];
  private stick: { id: number; centre: Pt; at: Pt } | null = null;
  private ring: HTMLDivElement;
  private knob: HTMLDivElement;
  private btns: { el: HTMLButtonElement; ring: HTMLDivElement }[] = [];
  private abort = new AbortController();
  private off = false;
  /** a scripted thumb (headless tests): the stick and the buttons as if held; null: the player's own */
  script: { stick: Pt; buttons: boolean[] } | null = null;
  /** the last pointer events and gestures (a headless check reads it; the user's bug reports could) */
  readonly trace: string[] = [];
  private note(s: string): void {
    this.trace.push(s);
    if (this.trace.length > 24) this.trace.shift();
  }

  constructor(
    parent: HTMLElement,
    readonly pad: Pad,
  ) {
    const sig = { signal: this.abort.signal };
    this.el = div('play-pad', parent);
    this.ring = div('play-stick', this.el);
    this.knob = div('play-knob', this.ring);
    this.held = pad.buttons.map(() => false);
    this.pressed = pad.buttons.map(() => false);
    pad.buttons.forEach((action, i) => {
      const btn = document.createElement('button');
      btn.className = 'play-btn';
      btn.style.bottom = `calc(${20 + i * 92}px + env(safe-area-inset-bottom))`;
      btn.innerHTML = `<span>${action.icon}</span><small>${action.name}</small>`;
      this.el.append(btn);
      this.btns.push({ el: btn, ring: div('play-btn-ring', btn) });
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.held[i] = true;
        this.pressed[i] = true;
        btn.classList.add('on');
      }, sig);
      const release = () => {
        this.held[i] = false;
        btn.classList.remove('on');
      };
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, release, sig);
    });
    const el = this.el;
    el.addEventListener('contextmenu', (e) => e.preventDefault(), sig);
    el.addEventListener('pointerdown', (e) => {
      if (this.off) return;
      e.preventDefault();
      const p: Pt = [e.clientX, e.clientY];
      this.note(`down ${e.pointerId} ${e.pointerType} ${p.map(Math.round)}`);
      // (the mouse is the right thumb: it never grabs the stick)
      if (pad.move === 'stick' && !this.stick && e.pointerType !== 'mouse' && this.inZone(p)) {
        this.stick = { id: e.pointerId, centre: p, at: p };
        this.drawStick();
        return;
      }
      if (this.stroke) return;
      this.stroke = { id: e.pointerId, s: new Stroke(p, e.timeStamp / 1000) };
    }, sig);
    el.addEventListener('pointermove', (e) => {
      const p: Pt = [e.clientX, e.clientY];
      if (this.stick?.id === e.pointerId) {
        this.stick.at = p;
        this.drawStick();
      } else if (e.pointerId === this.stroke?.id) {
        this.stroke.s.move(p, e.timeStamp / 1000);
        this.note(`move ${e.pointerId} ${p.map(Math.round)}`);
      }
    }, sig);
    const up = (e: PointerEvent) => {
      this.note(`${e.type} ${e.pointerId}`);
      if (this.stick?.id === e.pointerId) {
        this.stick = null;
        this.drawStick();
      } else if (e.pointerId === this.stroke?.id) {
        this.stroke.s.move([e.clientX, e.clientY], e.timeStamp / 1000);
        const g = this.stroke.s.end(e.timeStamp / 1000);
        this.note(`gesture ${g.kind} ${Math.round((e.timeStamp / 1000 - this.stroke.s.samples[0].t) * 1000)} ms ${Math.round(this.stroke.s.length)} px`);
        this.done.push(g);
        this.stroke = null;
      }
    };
    el.addEventListener('pointerup', up, sig);
    el.addEventListener('pointercancel', up, sig);
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
      const key = e.key.toLowerCase();
      this.keys.add(key);
      const b = BUTTON_KEYS.indexOf(key);
      if (b >= 0 && b < this.pressed.length) this.pressed[b] = true;
    }, sig);
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()), sig);
    window.addEventListener('blur', () => this.keys.clear(), sig);
  }

  private inZone(p: Pt): boolean {
    return p[0] < window.innerWidth * STICK.zoneX && p[1] > window.innerHeight * (1 - STICK.zoneY);
  }

  private drawStick(): void {
    const s = this.stick;
    this.ring.style.display = s ? 'block' : 'none';
    if (!s) return;
    this.ring.style.left = `${s.centre[0]}px`;
    this.ring.style.top = `${s.centre[1]}px`;
    let dx = s.at[0] - s.centre[0];
    let dy = s.at[1] - s.centre[1];
    const l = Math.hypot(dx, dy);
    if (l > STICK.radius) [dx, dy] = [(dx / l) * STICK.radius, (dy / l) * STICK.radius];
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /** Hidden (another screen has it): its touches and keys let go. */
  set hidden(on: boolean) {
    if (on === this.off) return;
    this.off = on;
    this.el.style.visibility = on ? 'hidden' : '';
    if (on) {
      this.keys.clear();
      this.stroke = null;
      this.stick = null;
      this.done = [];
      this.held.fill(false);
      this.drawStick();
    }
  }
  get hidden(): boolean {
    return this.off;
  }

  /** The move stick (keys first): a screen direction (x right, y down), length 0..1. */
  stickDir(): Pt {
    if (this.script) return this.script.stick;
    const k = this.keys;
    const x = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const y = (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0);
    if (x || y) {
      const l = Math.hypot(x, y);
      return [x / l, y / l];
    }
    const s = this.stick;
    if (!s) return [0, 0];
    const dx = s.at[0] - s.centre[0];
    const dy = s.at[1] - s.centre[1];
    const l = Math.hypot(dx, dy);
    if (l < STICK.dead) return [0, 0];
    const m = Math.min(1, l / STICK.radius);
    return [(dx / l) * m, (dy / l) * m];
  }

  /** Each button (or its key) held, or pressed since the last call. */
  buttons(): boolean[] {
    if (this.script) return this.held.map((_, i) => !!this.script!.buttons[i]);
    const b = this.held.map((h, i) => h || this.pressed[i] || this.keys.has(BUTTON_KEYS[i] ?? ''));
    this.pressed.fill(false);
    return b;
  }

  /** Draw the buttons' gauges and lights. */
  show(looks: ButtonLook[]): void {
    looks.forEach((l, i) => {
      const b = this.btns[i];
      if (!b) return;
      b.ring.style.display = l.gauge === undefined ? 'none' : '';
      if (l.gauge !== undefined) b.ring.style.setProperty('--g', String(Math.max(0, Math.min(1, l.gauge))));
      b.el.classList.toggle('lit', !!l.lit);
    });
  }

  /** The right thumb, while it's down. */
  drag(): { from: Pt; at: Pt } | null {
    if (!this.stroke) return null;
    return { from: this.stroke.s.from, at: this.stroke.s.at };
  }

  /** The gestures finished since the last call. */
  gestures(): Gesture[] {
    const g = this.done;
    this.done = [];
    return g;
  }

  /** a gesture as if a finger made it (headless tests) */
  inject(g: Gesture): void {
    this.done.push(g);
  }

  dispose(): void {
    this.abort.abort();
    this.el.remove();
  }
}

function div(cls: string, parent: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  parent.append(d);
  return d;
}
