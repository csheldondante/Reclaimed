// The forest station (round 125, `forest`; BACKLOG FLO32): a direct link into the composed scene the user asked for —
// the densest elder wood near the window's middle, a hero (play's lich) ridden round a loop that runs in under the
// canopy and out into the open, the understory's treatments each switchable, and a readout (frame time, the weight).
//
//   ?level=atlas&play=lich&forest=lab[&at=x,y]
//     &fvis=all|none|canopy+dither+dapple+rays+mist+leaves   the treatments (default all)
//     &fhold=auto|in|out                              the weight: by the canopy (default), held in, held out
//     &fride=0                                        the hero yours (the ride off)
//     &fseason=0.5                                    the season (the reference's autumn: 0.5)
// Every pick is in the address, so a view is a link; the panel's chips change them live.
import type { Plants, Tree } from '../api/plants';
import type { UnderstoryTreatments } from '../api/contracts/understory';
import type { PlaySession } from '../play/session';
import type { UnderstoryDriver } from './driver';
import { LoopRider, openWay, parkSpot, standLoop, type Stand, type V2 } from './ride';

export interface ForestLabDeps {
  ui: HTMLElement;
  session: PlaySession;
  plants: Plants;
  driver: UnderstoryDriver;
  params: URLSearchParams;
  /** where to look from (the window's middle) */
  near: V2;
  /** the season (Globals.season) */
  setSeason?: (s: number) => void;
  /** the ground way toward the eye (unit; the camera's) */
  eye?: V2;
  /**
   * (the foliage matrix's test winds: docs/design/FOLIAGE_WIND.md "a deterministic traveling gust, a strong steady wind,
   * and a direction reversal") the weather's prevailing wind (cells/s), and a gust pushed as the player's drag makes one
   */
  wind?: { base(): V2; setBase(w: V2): void; gust(g: { x: number; y: number; radius: number; strength: number; dx: number; dy: number; len: number }): void };
}

const KEYS: (keyof UnderstoryTreatments)[] = ['canopy', 'dither', 'dapple', 'rays', 'mist', 'leaves'];

/** the densest stand round `near`: elders count three times */
export function findStand(plants: Plants, near: V2, reach = 120, step = 12): Stand | null {
  let best: Stand | null = null;
  let bs = 0;
  for (let dy = -reach; dy <= reach; dy += step)
    for (let dx = -reach; dx <= reach; dx += step) {
      const at: V2 = [near[0] + dx, near[1] + dy];
      const ts = plants.treesNear(at[0], at[1], 16);
      const elders = ts.filter((t) => t.species === 'giant').length;
      const score = elders * 3 + ts.length - Math.hypot(dx, dy) * 0.02;
      if (score > bs) {
        bs = score;
        best = { at, out: [1, 0], trees: ts.length, elders };
      }
    }
  if (!best) return null;
  best.out = openWay(best.at[0], best.at[1], (x, y, r) => plants.treesNear(x, y, r).length);
  return best;
}

export class ForestLab {
  stand: Stand | null = null;
  rider: LoopRider | null = null;
  private panel: HTMLElement;
  private read: HTMLElement;
  private dts: number[] = [];
  private last = 0;
  private raf = 0;
  ride: boolean;

  private constructor(private d: ForestLabDeps) {
    this.ride = d.params.get('fride') !== '0';
    const vis = d.params.get('fvis') ?? 'all';
    const on = vis === 'all' ? KEYS : vis === 'none' ? [] : vis.split('+');
    for (const k of on) if (!KEYS.includes(k as keyof UnderstoryTreatments)) throw new Error(`?fvis=${vis}: the treatments are ${KEYS.join(', ')}`);
    for (const k of KEYS) d.driver.treatments[k] = on.includes(k) ? 1 : 0;
    const hold = d.params.get('fhold') ?? 'auto';
    if (!['auto', 'in', 'out'].includes(hold)) throw new Error(`?fhold=${hold}: auto, in or out`);
    d.driver.force = hold === 'in' ? 1 : hold === 'out' ? 0 : null;
    const season = d.params.get('fseason');
    if (season !== null) d.setSeason?.(Number(season));
    this.panel = document.createElement('div');
    this.panel.className = 'forest-lab';
    this.panel.style.cssText =
      'position:absolute;left:6px;top:96px;z-index:8;background:rgba(18,12,10,.78);color:#f3e6d8;font:11px system-ui;padding:6px 7px;border-radius:8px;max-width:190px;pointer-events:auto;user-select:none';
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) this.panel.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    const head = document.createElement('div');
    head.textContent = '🌲 Forest station';
    head.style.cssText = 'font-weight:600;margin-bottom:4px;cursor:pointer';
    head.addEventListener('click', () => this.panel.classList.toggle('folded'));
    this.panel.append(head);
    const chips = document.createElement('div');
    chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px';
    const chip = (label: string, isOn: () => boolean, flip: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      const paint = () => (b.style.cssText = `font:11px system-ui;padding:2px 6px;border-radius:9px;border:1px solid #a87;background:${isOn() ? '#c8643c' : 'transparent'};color:#f3e6d8`);
      paint();
      b.addEventListener('click', () => {
        flip();
        paint();
      });
      chips.append(b);
    };
    for (const k of KEYS) chip(k, () => d.driver.treatments[k] > 0, () => (d.driver.treatments[k] = d.driver.treatments[k] > 0 ? 0 : 1));
    chip('ride', () => this.ride, () => (this.ride = !this.ride));
    // (the matrix's winds: a gust front run across the stand; a gale (the prevailing wind x3); the wind turned round)
    if (d.wind) {
      const w = d.wind;
      const calm = w.base();
      chip('gust', () => false, () => this.gust());
      chip('gale', () => Math.hypot(...w.base()) > Math.hypot(...calm) * 2, () => {
        const b = w.base();
        const strong = Math.hypot(...b) > Math.hypot(...calm) * 2;
        w.setBase(strong ? [Math.sign(b[0]) * Math.abs(calm[0]), Math.sign(b[1]) * Math.abs(calm[1])] : [b[0] * 3, b[1] * 3]);
      });
      chip('reverse', () => w.base()[0] * calm[0] < 0, () => {
        const b = w.base();
        w.setBase([-b[0], -b[1]]);
      });
    }
    chip('hold in', () => d.driver.force === 1, () => (d.driver.force = d.driver.force === 1 ? null : 1));
    chip('hold out', () => d.driver.force === 0, () => (d.driver.force = d.driver.force === 0 ? null : 0));
    this.panel.append(chips);
    this.read = document.createElement('div');
    this.read.style.cssText = 'white-space:pre;font:10px ui-monospace,monospace;opacity:.9';
    this.panel.append(this.read);
    d.ui.append(this.panel);
  }

  static async start(d: ForestLabDeps): Promise<ForestLab> {
    const lab = new ForestLab(d);
    // (the plan needs the succession field read back once)
    let stand: Stand | null = null;
    for (let k = 0; k < 60 && !stand; k++) {
      stand = findStand(d.plants, d.near);
      if (!stand) await new Promise((r) => setTimeout(r, 500));
    }
    if (!stand) throw new Error('?forest=lab: no wood within 120 cells of the window’s middle');
    lab.stand = stand;
    // (the composed shot's spot: in front of the trunk the most trunks stand round — elders first)
    const near = d.plants.treesNear(stand.at[0], stand.at[1], 20);
    const big = near.filter((t) => t.species === 'giant');
    stand.park = parkSpot((big.length >= 2 ? big : near).map((t): V2 => [t.x, t.y]), d.eye ?? [Math.SQRT1_2, Math.SQRT1_2]) ?? undefined;
    lab.rider = new LoopRider(standLoop(stand));
    // (start out in the open, the far side of the loop from the stand, so the first lap rides in)
    const at = lab.rider.start(0);
    d.session.hero.place(at);
    d.session.steer = (q: V2, stick: V2) => (lab.ride && lab.rider ? (lab.rider.stick(q) ?? stick) : stick);
    const R = window as unknown as { reclaimed?: Record<string, unknown> };
    if (R.reclaimed) R.reclaimed.forest = lab;
    lab.loop();
    return lab;
  }

  /** the hero's trees as the readout counts them */
  private counts(): { trees: number; elders: number } {
    const ts: readonly Tree[] = this.d.driver.near;
    return { trees: ts.length, elders: ts.filter((t) => t.species === 'giant').length };
  }

  private loop(): void {
    const tick = (t: number) => {
      if (this.last) this.dts.push(t - this.last);
      this.last = t;
      if (this.dts.length > 120) this.dts.shift();
      const s = [...this.dts].sort((a, b) => a - b);
      const p50 = s[Math.floor(s.length * 0.5)] ?? 0;
      const p95 = s[Math.floor(s.length * 0.95)] ?? 0;
      const m = this.d.driver.model;
      const c = this.counts();
      this.read.textContent = `${(1000 / Math.max(p50, 1)).toFixed(0)} fps  ${p50.toFixed(1)}/${p95.toFixed(1)} ms\nunder ${m.weight.toFixed(2)}  cover ${m.cover.toFixed(2)}\ntrees ${c.trees}  elders ${c.elders}\nstand ${this.stand ? `${this.stand.elders}e/${this.stand.trees}t` : '-'}`;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** a gust front across the stand, downwind, for 2.5 s (as florashot's: the wind field's impulse, the player's kind) */
  gust(): void {
    const w = this.d.wind;
    const s = this.stand;
    if (!w || !s) return;
    const b = w.base();
    const l = Math.hypot(b[0], b[1]) || 1;
    const dx = b[0] / l;
    const dy = b[1] / l;
    let n = 0;
    const t = setInterval(() => {
      const k = n / 40;
      w.gust({ x: s.at[0] - dx * 30 + dx * 60 * k, y: s.at[1] - dy * 30 + dy * 60 * k, radius: 22, strength: 14, dx, dy, len: 16 });
      if (++n > 40) clearInterval(t);
    }, 60);
  }

  /** the window slid (WorldCore.onShift's step, negated, as the play session's): what's kept in window coordinates moves */
  shift(dx: number, dy: number): void {
    if (this.stand) this.stand.at = [this.stand.at[0] + dx, this.stand.at[1] + dy];
    if (this.stand?.park) this.stand.park = [this.stand.park[0] + dx, this.stand.park[1] + dy];
    if (this.rider) for (const p of this.rider.path) (p[0] += dx), (p[1] += dy);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.d.session.steer = null;
    this.panel.remove();
  }
}
