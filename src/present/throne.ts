// ---- present/throne.ts ------------------------------------------------------------------------------------------
// (round 124, `presentation`; BACKLOG PRE5) Scene D: the throne room — a separate, small, composed interior drawn in
// 2.5D (Canvas2D, isometric), entered from a real building's doorway on the atlas. The handoff: "Create a small,
// attractive isometric throne room (standalone representation is explicitly acceptable) ... Give it one recognizable
// doorway or facade/entrance anchor from the overworld; a fully mapped interior is not required."
//
// What it maps from the world (the anchors only): the settlement (its name, purpose and condition: the floor's stone,
// the banners' colour, the light), the door it was entered by (the arch at the front shows the street's daylight), and
// its petitioners — made from the settlement's own record (its people's roles, its needs, its story). A petition opens
// a CLEARLY LABELLED STUB of the opportunity UI: the real one is on `facts` / merge124 and isn't on this branch's base;
// nothing here is a second opportunity system (it only shows the record and says so).
//
// The transitions in and out (present/lab.ts drives them): a dithered dissolve opening from the door's point on the
// screen (an iris), or an even one, over a zoom into the door; or a short dark cut (the loading fallback).

import type { Settlement } from '../api/contracts/settlement';

export interface Petition {
  who: string;
  role: string;
  issue: string;
  ask: string;
  offer: string;
  /** where its record came from (the stub says) */
  from: string;
}

/** The petitions a settlement's record gives (its people, its needs, its story, its state): at most four. */
export function petitionsOf(s: Pick<Settlement, 'name' | 'people' | 'needs' | 'condition' | 'story' | 'purpose' | 'faction'>): Petition[] {
  const out: Petition[] = [];
  const roles = s.people.filter((p) => !p.hostile && p.count > 0).map((p) => p.role);
  const role = (i: number) => roles[i % Math.max(1, roles.length)] ?? 'townsfolk';
  const names = ['Ada', 'Brannoc', 'Cele', 'Doran', 'Ewin', 'Fen'];
  const jobs = new Map<string, number>();
  for (const j of s.needs) jobs.set(j.kind, (jobs.get(j.kind) ?? 0) + 1);
  const top = [...jobs.entries()].sort((a, b) => b[1] - a[1]);
  for (const [kind, n] of top.slice(0, 2))
    out.push({ who: names[out.length], role: role(out.length), issue: `${n} ${kind} job${n > 1 ? 's' : ''} stand undone in ${s.name}`, ask: `hands for the ${kind}`, offer: 'a share of the stores', from: `needs (${kind} x${n})` });
  const raid = s.story?.events.filter((e) => e.what === 'raided' || e.what === 'burned').at(-1);
  if (raid) out.push({ who: names[out.length], role: role(out.length), issue: raid.note, ask: 'that the road be made safe', offer: "the guard's thanks and a horse", from: `story (${raid.what})` });
  if (s.condition !== 'thriving') out.push({ who: names[out.length], role: role(out.length), issue: `${s.name} is ${s.condition}`, ask: 'help before the winter', offer: 'their oath', from: `condition (${s.condition})` });
  if (s.purpose && out.length < 4) out.push({ who: names[out.length], role: role(out.length), issue: `the ${s.purpose.kind} trade falters`, ask: 'a new market', offer: 'a cut of the trade', from: `purpose (${s.purpose.kind})` });
  if (!out.length) out.push({ who: names[0], role: role(0), issue: `${s.name} asks nothing of you yet`, ask: '-', offer: '-', from: 'nothing in the record' });
  return out.slice(0, 4);
}

const PURPOSE_STONE: Record<string, [string, string]> = {
  mining: ['#6d6a66', '#57544f'],
  port: ['#b9b2a0', '#9c9584'],
  lumber: ['#7a5a3c', '#664a30'],
  farming: ['#b49c6e', '#9a845a'],
  trading: ['#a88c6a', '#8e7456'],
  hold: ['#8a8c94', '#70727a'],
};
const ROLE_COL = ['#c0563a', '#3f7a9a', '#c9a23a', '#5d8a3a', '#8a4a8a', '#cfcfcf'];

/** the 4 x 4 ordered dither, 0..1 */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

export class ThroneRoom {
  readonly canvas: HTMLCanvasElement;
  private room: HTMLCanvasElement;
  private mask: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** 0 outside .. 1 in (the dissolve) */
  shown = 0;
  /** the door's point on the screen (CSS px): the iris opens from it */
  from: [number, number] = [0, 0];
  /** the dissolve's form: 0 an iris from the door, 1 even */
  even = 0;
  private t = 0;
  private spots: { p: Petition; x: number; y: number }[] = [];
  private panel: HTMLElement | null = null;
  onExit: (() => void) | null = null;
  readonly petitions: Petition[];

  constructor(
    private parent: HTMLElement,
    readonly s: Pick<Settlement, 'name' | 'people' | 'needs' | 'condition' | 'story' | 'purpose' | 'faction'>,
  ) {
    this.petitions = petitionsOf(s);
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', zIndex: '8', pointerEvents: 'none', imageRendering: 'pixelated' });
    parent.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.room = document.createElement('canvas');
    this.mask = document.createElement('canvas');
    this.canvas.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.tap(e.offsetX, e.offsetY);
    });
  }

  /** each frame: the room drawn (moving light, flames) and composited by the dissolve */
  frame(dt: number): void {
    this.t += dt;
    const w = this.parent.clientWidth;
    const h = this.parent.clientHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = this.room.width = w;
      this.canvas.height = this.room.height = h;
    }
    const c = this.ctx;
    c.clearRect(0, 0, w, h);
    this.canvas.style.pointerEvents = this.shown >= 1 ? 'auto' : 'none';
    if (this.shown <= 0) return;
    this.drawRoom(this.room.getContext('2d')!, w, h);
    if (this.shown >= 1) {
      c.drawImage(this.room, 0, 0);
      return;
    }
    // (the dissolve: a 3 px block's 4 x 4 dither threshold against the transition, by its distance from the door)
    const B = 3;
    const mw = Math.ceil(w / B);
    const mh = Math.ceil(h / B);
    if (this.mask.width !== mw || this.mask.height !== mh) {
      this.mask.width = mw;
      this.mask.height = mh;
    }
    const mc = this.mask.getContext('2d')!;
    const img = mc.createImageData(mw, mh);
    const far = Math.hypot(w, h);
    for (let y = 0; y < mh; y++)
      for (let x = 0; x < mw; x++) {
        const d = Math.hypot(x * B - this.from[0], y * B - this.from[1]) / far;
        const local = this.even >= 0.5 ? this.shown : Math.max(0, Math.min(1, this.shown * 1.8 - d * 0.9));
        if (BAYER[(y & 3) * 4 + (x & 3)] < local) img.data[(y * mw + x) * 4 + 3] = 255;
      }
    mc.putImageData(img, 0, 0);
    c.save();
    c.imageSmoothingEnabled = false;
    c.drawImage(this.mask, 0, 0, mw * B, mh * B);
    c.globalCompositeOperation = 'source-in';
    c.drawImage(this.room, 0, 0);
    c.restore();
  }

  /** the room, isometric: floor, two back walls with windows and banners, the dais and throne, the carpet to the door, the petitioners */
  private drawRoom(c: CanvasRenderingContext2D, w: number, h: number): void {
    const t = this.t;
    const [stoneA, stoneB] = PURPOSE_STONE[this.s.purpose?.kind ?? 'hold'] ?? PURPOSE_STONE.hold;
    const dim = this.s.condition === 'thriving' ? 1 : this.s.condition === 'struggling' ? 0.85 : 0.7;
    c.fillStyle = '#16120e';
    c.fillRect(0, 0, w, h);
    const N = 9;
    const tw = Math.min(w / (N + 1), (h * 0.9) / (N * 0.75)) * 1.0;
    const th = tw / 2;
    const ox = w / 2;
    const oy = h * 0.3;
    const iso = (i: number, j: number, z = 0): [number, number] => [ox + (i - j) * (tw / 2), oy + (i + j) * (th / 2) - z];
    const wallH = th * 7;
    // back walls (along i = 0 and j = 0)
    const wall = (a: [number, number], b: [number, number], shade: string) => {
      c.fillStyle = shade;
      c.beginPath();
      c.moveTo(a[0], a[1]);
      c.lineTo(b[0], b[1]);
      c.lineTo(b[0], b[1] - wallH);
      c.lineTo(a[0], a[1] - wallH);
      c.closePath();
      c.fill();
    };
    wall(iso(0, 0), iso(N, 0), '#4a3f36');
    wall(iso(0, 0), iso(0, N), '#3a312a');
    // windows on the right wall with light shafts falling across the floor, swaying a little
    for (let k = 1; k < N; k += 3) {
      const [x, y] = iso(k + 0.5, 0);
      c.fillStyle = '#e8d9a8';
      c.fillRect(x - tw * 0.12, y - wallH * 0.8, tw * 0.24, wallH * 0.38);
      const sway = Math.sin(t * 0.6 + k) * tw * 0.05;
      c.fillStyle = `rgba(255, 236, 180, ${0.1 * dim})`;
      c.beginPath();
      c.moveTo(x - tw * 0.12, y - wallH * 0.8);
      c.lineTo(x + tw * 0.12, y - wallH * 0.8);
      const [fx, fy] = iso(k + 0.5, 3.2);
      c.lineTo(fx + tw * 0.5 + sway, fy);
      c.lineTo(fx - tw * 0.1 + sway, fy + th * 0.3);
      c.closePath();
      c.fill();
    }
    // banners on the left wall: the realm's colour
    const banner = this.s.faction ? '#8a2b2b' : '#2b4f8a';
    for (let k = 1; k < N; k += 3) {
      const [x, y] = iso(0, k + 0.5);
      c.fillStyle = banner;
      c.fillRect(x - tw * 0.14, y - wallH * 0.85, tw * 0.28, wallH * 0.5);
      c.fillStyle = '#d9b44a';
      c.fillRect(x - tw * 0.14, y - wallH * 0.85, tw * 0.28, th * 0.15);
    }
    // the floor: checker stone
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const p = [iso(i, j), iso(i + 1, j), iso(i + 1, j + 1), iso(i, j + 1)];
        c.fillStyle = (i + j) % 2 ? stoneA : stoneB;
        c.beginPath();
        p.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.closePath();
        c.fill();
      }
    // the carpet from the door (the front corner) to the dais
    c.fillStyle = '#7a1f22';
    c.beginPath();
    [iso(3.6, 3.6), iso(N, N - 0.6), iso(N - 0.6, N), iso(3.0, 4.2)].forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    c.fill();
    // the dais and the throne at the back corner
    const box = (i0: number, j0: number, i1: number, j1: number, z: number, top: string, l: string, r: string) => {
      const a = iso(i0, j1, z), b = iso(i1, j1, z), d = iso(i1, j0, z), e = iso(i0, j0, z);
      const a0 = iso(i0, j1), b0 = iso(i1, j1), d0 = iso(i1, j0);
      c.fillStyle = l;
      c.beginPath();
      [a0, b0, b, a].forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.fill();
      c.fillStyle = r;
      c.beginPath();
      [b0, d0, d, b].forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.fill();
      c.fillStyle = top;
      c.beginPath();
      [a, b, d, e].forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.fill();
    };
    box(0.6, 0.6, 3.4, 3.4, th * 0.6, '#8d7f6c', '#6a5e50', '#5a4f43');
    box(1.4, 1.4, 2.4, 2.4, th * 3.2, '#c9a23a', '#a07e22', '#8a6c1c');
    // the ruler on the throne
    this.figure(c, iso(2.3, 2.3, th * 0.6), tw, '#4a2d6a', '#e0c08a', true);
    // pillars
    for (const [i, j] of [[4.5, 1], [1, 4.5], [7.5, 1], [1, 7.5]]) box(i - 0.3, j - 0.3, i + 0.3, j + 0.3, wallH * 0.95, '#a69a88', '#857a6a', '#6f6658');
    // braziers, flickering
    for (const [i, j] of [[3.6, 2.6], [2.6, 3.6]]) {
      const [x, y] = iso(i, j, th * 0.6);
      c.fillStyle = '#3a3029';
      c.fillRect(x - tw * 0.08, y - th * 1.2, tw * 0.16, th * 1.2);
      const f = 0.75 + 0.25 * Math.sin(t * 13 + i * 7) * Math.sin(t * 7.3 + j);
      const g = c.createRadialGradient(x, y - th * 1.4, 1, x, y - th * 1.4, tw * 1.6 * f);
      g.addColorStop(0, 'rgba(255, 190, 90, 0.55)');
      g.addColorStop(1, 'rgba(255, 140, 40, 0)');
      c.fillStyle = g;
      c.fillRect(x - tw * 2, y - th * 4, tw * 4, th * 6);
      c.fillStyle = '#ffb347';
      c.fillRect(x - tw * 0.06, y - th * 1.6 * f, tw * 0.12, th * 0.5);
    }
    // the petitioners along the carpet, the nearest to the door last
    this.spots = [];
    this.petitions.forEach((p, k) => {
      const at = iso(4.4 + k * 1.15, 4.4 + k * 1.15);
      const bob = Math.sin(t * 2 + k) * 1.5;
      this.figure(c, [at[0], at[1] + bob], tw, ROLE_COL[k % ROLE_COL.length], '#e8c09a', false);
      this.spots.push({ p, x: at[0], y: at[1] - th * 1.6 });
      c.fillStyle = 'rgba(16, 14, 12, 0.6)';
      c.font = `600 ${Math.max(10, tw * 0.22)}px system-ui, sans-serif`;
      const label = `${p.who} · ${p.role}`;
      const lw = c.measureText(label).width + 8;
      c.fillRect(at[0] + tw * 0.35, at[1] - th * 3.4, lw, tw * 0.3);
      c.fillStyle = '#f4efe2';
      c.fillText(label, at[0] + tw * 0.35 + 4, at[1] - th * 3.4 + tw * 0.23);
    });
    // the doorway (the anchor): an arch at the front corner, the street's daylight in it, the settlement's name over it
    const [dx, dy] = iso(N, N);
    c.fillStyle = '#2a221c';
    c.fillRect(dx - tw * 0.7, dy - th * 0.2, tw * 1.4, h);
    const day = c.createLinearGradient(dx, dy, dx, h);
    day.addColorStop(0, 'rgba(250, 236, 190, 0.85)');
    day.addColorStop(1, 'rgba(160, 200, 120, 0.6)');
    c.fillStyle = day;
    c.beginPath();
    c.ellipse(dx, dy + th * 1.4, tw * 0.55, th * 1.6, 0, Math.PI, 0);
    c.lineTo(dx + tw * 0.55, h);
    c.lineTo(dx - tw * 0.55, h);
    c.closePath();
    c.fill();
    c.fillStyle = '#f4efe2';
    c.font = `700 ${Math.max(12, tw * 0.28)}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.fillText(`${this.s.name} — the hall`, w / 2, h * 0.08);
    c.font = `${Math.max(10, tw * 0.2)}px system-ui, sans-serif`;
    c.fillText('tap a petitioner · tap the door to leave', w / 2, h * 0.08 + tw * 0.32);
    c.textAlign = 'start';
    this.doorAt = [dx, dy + th * 2];
    // the room's overall light: dimmer when the settlement is struggling
    if (dim < 1) {
      c.fillStyle = `rgba(10, 8, 6, ${1 - dim})`;
      c.fillRect(0, 0, w, h);
    }
  }
  private doorAt: [number, number] = [0, 0];

  private figure(c: CanvasRenderingContext2D, at: [number, number], tw: number, body: string, skin: string, seated: boolean): void {
    const [x, y] = at;
    const s = tw * 0.34;
    c.fillStyle = 'rgba(0, 0, 0, 0.3)';
    c.beginPath();
    c.ellipse(x, y, s * 0.7, s * 0.3, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = body;
    c.fillRect(x - s * 0.45, y - s * (seated ? 1.9 : 2.6), s * 0.9, s * (seated ? 1.5 : 2.4));
    c.fillStyle = skin;
    c.fillRect(x - s * 0.3, y - s * (seated ? 2.5 : 3.2), s * 0.6, s * 0.6);
    if (seated) {
      c.fillStyle = '#d9b44a';
      c.fillRect(x - s * 0.35, y - s * 2.75, s * 0.7, s * 0.2);
    }
  }

  private tap(x: number, y: number): void {
    if (this.panel) return;
    if (Math.hypot(x - this.doorAt[0], y - this.doorAt[1]) < 60) {
      this.onExit?.();
      return;
    }
    let best: { p: Petition; d: number } | null = null;
    for (const sp of this.spots) {
      const d = Math.hypot(x - sp.x, y - sp.y);
      if (d < 60 && (!best || d < best.d)) best = { p: sp.p, d };
    }
    if (best) this.open(best.p);
  }

  /** a petition's opportunity: the STUB of the opportunity UI (the record shown, and where it came from) */
  open(p: Petition): void {
    const el = document.createElement('div');
    el.className = 'pre-opp';
    el.innerHTML = `<div class="pre-opp-stub">STUB — the opportunity UI lives on facts / merge124, not on this base; this only shows the settlement's record</div>
      <h3>${p.who}, ${p.role}</h3>
      <p><b>The matter:</b> ${p.issue}</p>
      <p><b>They ask:</b> ${p.ask}</p>
      <p><b>They offer:</b> ${p.offer}</p>
      <p class="pre-opp-from">from the record: ${p.from}</p>
      <div class="pre-opp-row"><button data-a="take">Take it</button><button data-a="leave">Not now</button></div>`;
    for (const ev of ['pointerdown', 'touchstart']) el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    el.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        el.remove();
        this.panel = null;
        this.taken.push({ who: p.who, took: b.dataset.a === 'take' });
      }),
    );
    this.parent.append(el);
    this.panel = el;
  }
  /** what was decided (the review's log; the stub keeps nothing in the world) */
  readonly taken: { who: string; took: boolean }[] = [];

  /** the spots on screen (scripts) */
  get petitionerSpots(): { who: string; x: number; y: number }[] {
    return this.spots.map((s) => ({ who: s.p.who, x: s.x, y: s.y }));
  }

  dispose(): void {
    this.panel?.remove();
    this.canvas.remove();
  }
}
