// (round 108, BACKLOG AR8) The playground's stations bar (levels/playground.ts): which station, its buttons, and a
// reset for it (and for all). It only calls what the scene gives it; nothing here knows the world.

import type { Station } from '../levels/playground';

export interface StationHandlers {
  go(s: Station): void;
  run(s: Station, action: number): void;
  reset(s: Station): void;
  resetAll(): void;
}

export class StationsBar {
  readonly el: HTMLDivElement;
  private at = 0;
  private label: HTMLDivElement;
  private acts: HTMLDivElement;

  constructor(
    parent: HTMLElement,
    private stations: Station[],
    private h: StationHandlers,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'stations';
    this.label = document.createElement('div');
    this.label.className = 'label';
    this.acts = document.createElement('div');
    this.acts.style.cssText = 'display:contents';
    const prev = this.btn('◀', () => this.pick(this.at - 1));
    const next = this.btn('▶', () => this.pick(this.at + 1));
    this.nameBtn = this.btn('', () => this.h.go(this.stations[this.at]));
    this.nameBtn.title = 'look at this station';
    const reset = this.btn('↺ reset', () => this.h.reset(this.stations[this.at]));
    reset.className = 'reset';
    reset.title = 'put this station back as it was when the level opened';
    const all = this.btn('↺ all', () => this.h.resetAll());
    all.className = 'reset';
    all.title = 'put every station back';
    this.el.append(this.label, prev, this.nameBtn, next, this.acts, reset, all);
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    parent.appendChild(this.el);
    this.pick(0, false);
  }

  private nameBtn: HTMLButtonElement;

  /** the station shown (and looked at) */
  pick(i: number, look = true): void {
    const n = this.stations.length;
    this.at = ((i % n) + n) % n;
    const s = this.stations[this.at];
    this.nameBtn.textContent = `${this.at + 1} ${s.name}`;
    this.label.textContent = s.hint;
    this.acts.replaceChildren(...s.actions.map((a, k) => this.btn(a.label, () => this.h.run(s, k))));
    if (look) this.h.go(s);
  }

  get current(): Station {
    return this.stations[this.at];
  }

  dispose(): void {
    this.el.remove();
  }

  private btn(t: string, f: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = t;
    b.addEventListener('click', f);
    return b;
  }
}
