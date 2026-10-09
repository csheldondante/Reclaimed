// Sandbox editor panel (BACKLOG B2, round 13 F2–F4): brushes, materials,
// spawns and time. It only records what the player picked; the level turns
// brush strokes into EV_EDIT events (edit.wgsl) and spawn clicks into
// Weather calls.
//
// Ground brushes work in layers: one press lays (or digs) `layers` cells
// under the brush, soft at the rim; painting over the same place adds
// nothing more until the next press. Pour drops loose material from above
// (it settles by angle of repose), build places hard material, bedrock
// raises stone from below.

import { MAT } from '../world/materials';

export type EditTool =
  | 'wind' // the normal hands: taps grow, drags paint wind
  | 'pour'
  | 'build'
  | 'bedrock'
  | 'dig'
  | 'water'
  | 'drain'
  | 'oil'
  | 'pollute'
  | 'clean'
  | 'plant'
  | 'storm'
  | 'duststorm'
  | 'cyclone';

/** edit.wgsl op codes per brush tool */
export const EDIT_OP: Partial<Record<EditTool, number>> = {
  build: 1,
  dig: 2,
  water: 3,
  oil: 4,
  pollute: 6,
  plant: 7,
  clean: 8,
  drain: 9,
  pour: 10,
  bedrock: 11,
};

/** Tools that work in whole layers (strength = cells per press). */
export const LAYER_TOOLS: ReadonlySet<EditTool> = new Set(['pour', 'build', 'bedrock', 'dig']);

/** Loose materials: poured from above, they slump to their angle of repose. */
const LOOSE: [string, number][] = [
  ['dirt', MAT.Soil],
  ['sand', MAT.Sand],
  ['gravel', MAT.Rubble],
  ['dust', MAT.Drift],
  ['ash', MAT.Ash],
  ['litter', MAT.Litter],
];

/** Hard materials: built in place. */
const HARD: [string, number][] = [
  ['stone', MAT.Stone],
  ['concrete', MAT.Concrete],
  ['brick', MAT.Brick],
  ['asphalt', MAT.Asphalt],
  ['rust', MAT.Rust],
  ['trash', MAT.Trash],
];

const TOOLS: [EditTool, string, string][] = [
  ['wind', '✋', 'Hands: tap to grow, drag to make wind'],
  ['pour', '⛆', 'Pour: drop loose material from above (a layer per press)'],
  ['build', '▲', 'Build: lay hard material (a layer per press)'],
  ['bedrock', '⛰', 'Bedrock: raise stone from below, lifting everything on it'],
  ['dig', '▼', 'Dig: take a layer off the top'],
  ['water', '💧', 'Pour water'],
  ['drain', '◌', 'Drain water and oil'],
  ['oil', '⬤', 'Spill oil'],
  ['pollute', '☣', 'Poison the ground'],
  ['clean', '✧', 'Clean: poison, oil, dust'],
  ['plant', '❦', 'Plant'],
  ['storm', '☁', 'Place a storm'],
  ['duststorm', '🌫', 'Place a dust storm'],
  ['cyclone', '🌀', 'Place a cyclone'],
];

export class Editor {
  tool: EditTool = 'wind';
  /** the material for the current tool (pour: loose, build: hard) */
  material: number = MAT.Soil;
  radius = 6;
  /** liquids/fields: strength 0..1 */
  strength = 0.5;
  /** ground tools: cells per press */
  layers = 1;
  /** simulation speed (0 = paused) */
  speed = 1;
  private el: HTMLElement;
  private picked = { pour: MAT.Soil as number, build: MAT.Stone as number };

  constructor(root: HTMLElement, onSpeed: (s: number) => void) {
    const el = document.createElement('div');
    el.className = 'editor';
    el.innerHTML = `
      <div class="tools">${TOOLS.map(([t, icon, tip]) => `<button data-t="${t}" title="${tip}">${icon}</button>`).join('')}</div>
      <label data-ml>material <select data-m></select></label>
      <label>size <input data-r type="range" min="1" max="16" value="${this.radius}"></label>
      <label data-ll>layers <input data-l type="range" min="1" max="4" value="${this.layers}"></label>
      <label data-sl>strength <input data-s type="range" min="5" max="100" value="${this.strength * 100}"></label>
      <div class="speed">${[0, 1, 2, 4, 8].map((s) => `<button data-sp="${s}">${s === 0 ? '❚❚' : s + '×'}</button>`).join('')}</div>`;
    root.appendChild(el);
    this.el = el;
    // the panel is UI: keep its pointer events away from the world
    for (const ev of ['pointerdown', 'pointerup', 'wheel']) el.addEventListener(ev, (e) => e.stopPropagation());
    const matSel = el.querySelector<HTMLSelectElement>('[data-m]')!;
    const show = (sel: string, on: boolean) => (el.querySelector<HTMLElement>(sel)!.style.display = on ? '' : 'none');
    const sel = (t: EditTool) => {
      this.tool = t;
      for (const b of el.querySelectorAll<HTMLButtonElement>('[data-t]')) b.classList.toggle('on', b.dataset.t === t);
      const list = t === 'pour' ? LOOSE : t === 'build' ? HARD : undefined;
      show('[data-ml]', !!list);
      show('[data-ll]', LAYER_TOOLS.has(t));
      show('[data-sl]', !!EDIT_OP[t] && !LAYER_TOOLS.has(t));
      if (list) {
        const cur = this.picked[t as 'pour' | 'build'];
        matSel.innerHTML = list.map(([n, m]) => `<option value="${m}"${m === cur ? ' selected' : ''}>${n}</option>`).join('');
        this.material = cur;
      } else if (t === 'bedrock') this.material = MAT.Stone;
    };
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-t]')) b.addEventListener('click', () => sel(b.dataset.t as EditTool));
    matSel.addEventListener('change', () => {
      this.material = Number(matSel.value);
      if (this.tool === 'pour' || this.tool === 'build') this.picked[this.tool] = this.material;
    });
    sel('wind');
    el.querySelector<HTMLInputElement>('[data-r]')!.addEventListener('input', (e) => (this.radius = Number((e.target as HTMLInputElement).value)));
    el.querySelector<HTMLInputElement>('[data-l]')!.addEventListener('input', (e) => (this.layers = Number((e.target as HTMLInputElement).value)));
    el.querySelector<HTMLInputElement>('[data-s]')!.addEventListener('input', (e) => (this.strength = Number((e.target as HTMLInputElement).value) / 100));
    const speed = (s: number) => {
      this.speed = s;
      onSpeed(s);
      for (const b of el.querySelectorAll<HTMLButtonElement>('[data-sp]')) b.classList.toggle('on', Number(b.dataset.sp) === s);
    };
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-sp]')) b.addEventListener('click', () => speed(Number(b.dataset.sp)));
    speed(1);
  }

  /** Select a tool (and optionally a material) from code: scripted tests. */
  select(tool: EditTool, material?: number): void {
    this.el.querySelector<HTMLButtonElement>(`[data-t="${tool}"]`)!.click();
    if (material !== undefined) {
      this.material = material;
      if (tool === 'pour' || tool === 'build') this.picked[tool] = material;
      this.el.querySelector<HTMLSelectElement>('[data-m]')!.value = String(material);
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
