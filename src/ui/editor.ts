// Sandbox editor panel (BACKLOG B2): brushes, materials, spawns and time.
// It only records what the player picked; the level turns brush strokes into
// EV_EDIT events (edit.wgsl) and spawn clicks into Weather calls.

import { MAT } from '../world/materials';

export type EditTool =
  | 'wind' // the normal hands: taps grow, drags paint wind
  | 'raise'
  | 'dig'
  | 'water'
  | 'drain'
  | 'oil'
  | 'dust'
  | 'pollute'
  | 'clean'
  | 'plant'
  | 'storm'
  | 'duststorm'
  | 'cyclone';

/** edit.wgsl op codes per brush tool */
export const EDIT_OP: Partial<Record<EditTool, number>> = {
  raise: 1,
  dig: 2,
  water: 3,
  oil: 4,
  dust: 5,
  pollute: 6,
  plant: 7,
  clean: 8,
  drain: 9,
};

const MATERIALS: [string, number][] = [
  ['soil', MAT.Soil],
  ['sand', MAT.Sand],
  ['stone', MAT.Stone],
  ['concrete', MAT.Concrete],
  ['brick', MAT.Brick],
  ['rubble', MAT.Rubble],
  ['trash', MAT.Trash],
  ['litter', MAT.Litter],
  ['ash', MAT.Ash],
  ['rust', MAT.Rust],
];

const TOOLS: [EditTool, string, string][] = [
  ['wind', '✋', 'Hands: tap to grow, drag to make wind'],
  ['raise', '▲', 'Raise: build up the chosen material'],
  ['dig', '▼', 'Dig: remove the top'],
  ['water', '💧', 'Pour water'],
  ['drain', '◌', 'Drain water and oil'],
  ['oil', '⬤', 'Spill oil'],
  ['dust', '≋', 'Drift dust'],
  ['pollute', '☣', 'Poison the ground'],
  ['clean', '✧', 'Clean: poison, oil, dust'],
  ['plant', '❦', 'Plant'],
  ['storm', '☁', 'Place a storm'],
  ['duststorm', '🌫', 'Place a dust storm'],
  ['cyclone', '🌀', 'Place a cyclone'],
];

export class Editor {
  tool: EditTool = 'wind';
  material: number = MAT.Soil;
  radius = 4;
  strength = 0.5;
  /** simulation speed (0 = paused) */
  speed = 1;
  private el: HTMLElement;

  constructor(root: HTMLElement, onSpeed: (s: number) => void) {
    const el = document.createElement('div');
    el.className = 'editor';
    el.innerHTML = `
      <div class="tools">${TOOLS.map(([t, icon, tip]) => `<button data-t="${t}" title="${tip}">${icon}</button>`).join('')}</div>
      <label>material <select data-m>${MATERIALS.map(([n, m]) => `<option value="${m}">${n}</option>`).join('')}</select></label>
      <label>size <input data-r type="range" min="1" max="16" value="${this.radius}"></label>
      <label>strength <input data-s type="range" min="5" max="100" value="${this.strength * 100}"></label>
      <div class="speed">${[0, 1, 2, 4, 8].map((s) => `<button data-sp="${s}">${s === 0 ? '❚❚' : s + '×'}</button>`).join('')}</div>`;
    root.appendChild(el);
    this.el = el;
    // the panel is UI: keep its pointer events away from the world
    for (const ev of ['pointerdown', 'pointerup', 'wheel']) el.addEventListener(ev, (e) => e.stopPropagation());
    const sel = (t: EditTool) => {
      this.tool = t;
      for (const b of el.querySelectorAll<HTMLButtonElement>('[data-t]')) b.classList.toggle('on', b.dataset.t === t);
    };
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-t]')) b.addEventListener('click', () => sel(b.dataset.t as EditTool));
    sel('wind');
    el.querySelector<HTMLSelectElement>('[data-m]')!.addEventListener('change', (e) => (this.material = Number((e.target as HTMLSelectElement).value)));
    el.querySelector<HTMLInputElement>('[data-r]')!.addEventListener('input', (e) => (this.radius = Number((e.target as HTMLInputElement).value)));
    el.querySelector<HTMLInputElement>('[data-s]')!.addEventListener('input', (e) => (this.strength = Number((e.target as HTMLInputElement).value) / 100));
    const speed = (s: number) => {
      this.speed = s;
      onSpeed(s);
      for (const b of el.querySelectorAll<HTMLButtonElement>('[data-sp]')) b.classList.toggle('on', Number(b.dataset.sp) === s);
    };
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-sp]')) b.addEventListener('click', () => speed(Number(b.dataset.sp)));
    speed(1);
  }

  dispose(): void {
    this.el.remove();
  }
}
