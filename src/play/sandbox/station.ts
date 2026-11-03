// ---- play/sandbox/station.ts ------------------------------------------------------------------------------------
// (knight, round 128) The knight's test station: the start of the user's gauntlet ("I still want to make a gauntlet
// for the characters"), kept a test station — the gauntlet's design comes later with the user. On the atlas level with
// every system in play, at a spot with flat ground and a slope (the sandbox's hill finder): a WAVE button (raiders in a
// ring round the hero, one more each wave), DUMMIES (three that stand and take blows, for the reach and the lunge), and
// a readout: speed now and best, blows landed, kills, arrows, spins and bounces, what it's taken.
//   ?skipmenu=1&level=atlas&play=knight&station=1

import type { UnitId } from '../../api/contracts/units';
import type { Pt } from '../core/gestures';
import { findHills } from './hills';
import { KnightHero } from '../heroes/knight';
import { el } from '../session';
import type { PlaySandbox } from './sandbox';

/** a wave: raiders in a ring this far round the hero, the first wave's count; dummies: how many, how far ahead, apart */
const WAVE = { ring: 13, first: 3, sight: 30, speed: 3.5, health: 3 };
const DUMMY = { count: 3, ahead: 5, apart: 3, health: 400 };

export class Station {
  private box: HTMLElement;
  private read: HTMLElement;
  private wave = 0;
  private raiders: UnitId[] = [];
  private dummies: UnitId[] = [];
  /** blows that killed (the units' `died` naming the hero), what the hero took */
  readonly tally = { kills: 0, taken: 0, waves: 0 };
  private offDied: () => void;
  private lastText = '';

  constructor(private s: PlaySandbox) {
    const units = s.d.units;
    const died = (_u: unknown, by: UnitId | string | null) => {
      if (by === 'hero') this.tally.kills++;
    };
    units.died.push(died);
    this.offDied = () => {
      const i = units.died.indexOf(died);
      if (i >= 0) units.died.splice(i, 1);
    };
    this.box = el('div', 'play-station', s.d.ui);
    for (const ev of ['pointerdown', 'pointerup', 'touchstart']) this.box.addEventListener(ev, (e) => e.stopPropagation());
    const row = el('div', 'play-station-row', this.box);
    const btn = (label: string, f: () => void) => {
      const b = el('button', 'play-small', row) as HTMLButtonElement;
      b.textContent = label;
      b.addEventListener('click', f);
    };
    btn('Wave', () => this.nextWave());
    btn('Dummies', () => this.placeDummies());
    btn('Clear', () => this.clear());
    this.read = el('div', 'play-station-read', this.box);
    this.read.style.pointerEvents = 'none';
    this.relocate();
  }

  /**
   * To a station spot near the camera: a hilly spot (the sandbox's hill finder, at the knight's own climb) with no water
   * within 16 cells (a fight on the shore ends up wading), then the flattest ground within 8 cells of it — flat ground
   * to fight on with a slope beside it.
   */
  relocate(): void {
    const t = this.s.d.api.terrain;
    if (!t) return;
    const w = this.s.world;
    const b = this.s.d.bounds;
    const h = (x: number, y: number) => t.heightAt(x, y);
    const dry = (x: number, y: number) => {
      for (const r of [0, 4, 8, 12, 16])
        for (let k = 0; k < (r ? 12 : 1); k++) {
          const a = (k / 12) * Math.PI * 2;
          if (w.depth(x + Math.cos(a) * r, y + Math.sin(a) * r) > 0.02) return false;
        }
      return true;
    };
    const c = this.s.d.camera.target;
    const spot = findHills(h, [c[0], c[1]], { radius: Math.min(b[0], b[1]) * 0.45, step: 8, climb: this.s.hero.profileClimb(), least: 0.25, bounds: b, margin: 24, dry });
    if (!spot) return;
    let best: Pt = spot.at;
    let flat = Infinity;
    for (let dy = -8; dy <= 8; dy += 2)
      for (let dx = -8; dx <= 8; dx += 2) {
        const x = spot.at[0] + dx;
        const y = spot.at[1] + dy;
        const z = h(x, y);
        if (z === null || w.depth(x, y) > 0.02) continue;
        let g = 0;
        for (const [ox, oy] of [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]]) g = Math.max(g, Math.abs((h(x + ox, y + oy) ?? z) - z));
        if (g < flat) [flat, best] = [g, [x, y]];
      }
    this.s.hero.place(best);
    this.s.d.camera.target[0] = best[0];
    this.s.d.camera.target[1] = best[1];
  }

  /** the next wave: raiders in a ring round the hero, one more than the last */
  nextWave(): void {
    const [x, y] = this.s.hero.position();
    const n = WAVE.first + this.wave;
    this.wave++;
    this.tally.waves = this.wave;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const at: [number, number] = [x + Math.cos(a) * WAVE.ring, y + Math.sin(a) * WAVE.ring];
      this.raiders.push(this.s.d.units.spawn('raider', at, 'f-raiders', { hostile: true, health: WAVE.health, sight: WAVE.sight, speed: WAVE.speed, role: 'raider' }));
    }
  }

  /** three dummies in a row ahead of the hero: they stand, take blows and don't hit back */
  placeDummies(): void {
    for (const id of this.dummies) this.s.d.units.remove(id);
    this.dummies = [];
    const h = this.s.hero;
    const [x, y] = h.position();
    const a = h.heading();
    const f = [Math.cos(a), Math.sin(a)];
    const l = [-f[1], f[0]];
    for (let i = 0; i < DUMMY.count; i++) {
      const k = (i - (DUMMY.count - 1) / 2) * DUMMY.apart;
      const at: [number, number] = [x + f[0] * DUMMY.ahead + l[0] * k, y + f[1] * DUMMY.ahead + l[1] * k];
      this.dummies.push(this.s.d.units.spawn('dummy', at, null, { hostile: false, health: DUMMY.health, speed: 0.01, role: 'dummy', colour: '#c8a060' }));
    }
  }

  clear(): void {
    for (const id of [...this.raiders, ...this.dummies]) this.s.d.units.remove(id);
    this.raiders = [];
    this.dummies = [];
    this.wave = 0;
  }

  update(_dt: number): void {
    const h = this.s.hero;
    const st = h instanceof KnightHero ? h.stats : null;
    const alive = this.raiders.filter((id) => this.s.d.units.get(id)?.alive).length;
    this.tally.taken = h.maxHealth - h.health;
    const lines = [
      `speed ${h.speed().toFixed(1)} c/s${st ? ` · best ${st.best.toFixed(1)}` : ''}`,
      st ? `hits ${st.hits} · kills ${this.tally.kills} · swings ${st.swings} (lunges ${st.lunges})` : `kills ${this.tally.kills}`,
      st ? `arrows ${st.arrowHits}/${st.arrows} · spins ${st.spins} (bounces ${st.bounces}) · dodges ${st.dodges}` : '',
      `wave ${this.wave} · raiders left ${alive} · hurt ${this.tally.taken.toFixed(0)}`,
    ].filter(Boolean);
    const text = lines.join('\n');
    if (text !== this.lastText) {
      this.lastText = text;
      this.read.textContent = text;
    }
  }

  dispose(): void {
    this.offDied();
    this.clear();
    this.box.remove();
  }
}
