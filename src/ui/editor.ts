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
import type { MapData } from '../world/mapgen';
import { decodeMap, encodeMap, savedMaps } from '../world/mapfile';
import { LEVELS } from '../game/levels';
import { MODELS } from '../world/models';
import { thumbnail } from './thumbs';
import { bodyCatalogue } from '../physics/shapes';

/** the drop tool's bodies */
export const BODIES = bodyCatalogue(MODELS, MAT);

/** What the panel's map buttons do (the level implements them). */
export interface EditorMaps {
  undo: () => void;
  capture: () => Promise<MapData>;
  load: (map: MapData) => void;
  fresh: () => void;
  say: (text: string) => void;
}

export type EditTool =
  | 'wind' // the normal hands: taps grow, drags paint wind
  | 'pour'
  | 'build'
  | 'bedrock'
  | 'dig'
  | 'place'
  | 'smash'
  | 'drop'
  | 'beam'
  | 'volcano'
  | 'meteor'
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
  smash: 12,
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
  ['place', '🚗', 'Place a model: cars, ruins, a tanker… (E rotates)'],
  ['smash', '💥', 'Break: punch a hole where you click — what loses its support falls'],
  ['drop', '🧱', 'Drop a physics body: steel bends, stone cracks into pieces, a hard hit crumbles it'],
  ['beam', '🔥', 'Heat beam: hold on something — steel glows, softens and melts, so you can cut it; the ground melts into lava'],
  ['volcano', '🌋', 'Volcano: tap — a cone rises out of the ground, then lava pours down its sides and sets into basalt'],
  ['meteor', '☄️', 'Meteor: tap — it falls smoking from the sky and blows out a crater: what it hits turns to dust, the blast of air throws it out'],
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
  /** place tool: the model, its quarter turns, and how deep it sits in the ground */
  model = MODELS[0].id;
  rot = 0;
  bury = MODELS[0].sink;
  /** place tool: degrees of tilt; above 0 the model goes in as a structure grid of its own (docs/GRIDS.md) */
  tilt = 0;
  /** drop tool: which body (physics/shapes.ts bodyCatalogue) and how high above the ground */
  body = 'steel-beam';
  dropHeight = 8;
  private el: HTMLElement;
  private picked = { pour: MAT.Soil as number, build: MAT.Stone as number };

  constructor(root: HTMLElement, onSpeed: (s: number) => void, private maps: EditorMaps) {
    const el = document.createElement('div');
    el.className = 'editor';
    el.innerHTML = `
      <div class="tools">${TOOLS.map(([t, icon, tip]) => `<button data-t="${t}" title="${tip}">${icon}</button>`).join('')}</div>
      <label data-ml>material <select data-m></select></label>
      <label>size <input data-r type="range" min="1" max="16" value="${this.radius}"></label>
      <label data-ll>layers <input data-l type="range" min="1" max="4" value="${this.layers}"></label>
      <div class="models" data-models>${MODELS.map((m) => `<button data-mod="${m.id}" title="${m.name}"><img alt="${m.name}" src="${thumbnail(m)}"></button>`).join('')}</div>
      <label data-bl>bury <input data-b type="range" min="0" max="4" value="${this.bury}"></label>
      <label data-tl title="Above 0: placed as its own tilted grid (sand buries it, moss grows on it)">tilt <input data-ti type="range" min="0" max="90" step="5" value="0"></label>
      <label data-pbl>body <select data-pb>${BODIES.map((b) => `<option value="${b.id}">${b.name}</option>`).join('')}</select></label>
      <label data-dhl>height <input data-dh type="range" min="0" max="30" value="${this.dropHeight}"></label>
      <label data-sl>strength <input data-s type="range" min="5" max="100" value="${this.strength * 100}"></label>
      <div class="speed">${[0, 1, 2, 4, 8].map((s) => `<button data-sp="${s}">${s === 0 ? '❚❚' : s + '×'}</button>`).join('')}</div>
      <div class="maps">
        <button data-a="undo" title="Undo the last brush press (Ctrl+Z)">↶</button>
        <button data-a="save" title="Save this map in the browser">save</button>
        <select data-saved title="Load a saved map"><option value="">load…</option></select>
        <button data-a="down" title="Download this map as a file">⤓</button>
        <button data-a="up" title="Open a map file">⤒</button>
        <button data-a="new" title="Start again from the sandbox map">new</button>
        <input data-file type="file" accept=".reclaimed" hidden>
      </div>`;
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
      show('[data-sl]', !!EDIT_OP[t] && !LAYER_TOOLS.has(t) && t !== 'smash');
      show('[data-models]', t === 'place');
      show('[data-bl]', t === 'place');
      show('[data-tl]', t === 'place');
      show('[data-pbl]', t === 'drop');
      show('[data-dhl]', t === 'drop');
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
    el.querySelector<HTMLSelectElement>('[data-pb]')!.addEventListener('change', (e) => (this.body = (e.target as HTMLSelectElement).value));
    el.querySelector<HTMLInputElement>('[data-dh]')!.addEventListener('input', (e) => (this.dropHeight = Number((e.target as HTMLInputElement).value)));
    const bury = el.querySelector<HTMLInputElement>('[data-b]')!;
    bury.addEventListener('input', () => (this.bury = Number(bury.value)));
    const tilt = el.querySelector<HTMLInputElement>('[data-ti]')!;
    tilt.addEventListener('input', () => (this.tilt = Number(tilt.value)));
    const pickModel = (id: string) => {
      this.model = id;
      this.bury = MODELS.find((m) => m.id === id)!.sink;
      bury.value = String(this.bury);
      for (const b of el.querySelectorAll<HTMLButtonElement>('[data-mod]')) b.classList.toggle('on', b.dataset.mod === id);
    };
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-mod]')) b.addEventListener('click', () => pickModel(b.dataset.mod!));
    pickModel(this.model);
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
    this.wireMaps();
  }

  private wireMaps(): void {
    const { el, maps } = this;
    const saved = el.querySelector<HTMLSelectElement>('[data-saved]')!;
    // the built levels first (round 30: edit them in the sandbox), then saved maps
    const built = LEVELS.filter((l) => l.generate && !l.sandbox);
    const head = '<option value="">load…</option>' + built.map((l) => `<option value="level:${l.id}">level: ${l.name}</option>`).join('');
    saved.innerHTML = head;
    const refresh = () =>
      savedMaps.list().then((names) => {
        saved.innerHTML = head + names.map((n) => `<option>${n.replace(/</g, '&lt;')}</option>`).join('');
      });
    void refresh();
    const act = (a: string, f: () => unknown) => el.querySelector<HTMLButtonElement>(`[data-a="${a}"]`)!.addEventListener('click', f);
    act('undo', () => maps.undo());
    act('save', async () => {
      const name = prompt('Save map as:', `map ${new Date().toLocaleString()}`)?.trim();
      if (!name) return;
      await savedMaps.save(name, await encodeMap(await maps.capture()));
      await refresh();
      maps.say(`Saved "${name}".`);
    });
    saved.addEventListener('change', async () => {
      const name = saved.value;
      if (!name) return;
      const lv = name.startsWith('level:') ? built.find((l) => `level:${l.id}` === name) : undefined;
      if (lv) return maps.load(lv.generate!({ w: 256, h: 256, zMax: 64 }));
      maps.load(await decodeMap(await savedMaps.load(name)));
    });
    act('down', async () => {
      const blob = await encodeMap(await maps.capture());
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'sandbox.reclaimed';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    const file = el.querySelector<HTMLInputElement>('[data-file]')!;
    act('up', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        maps.load(await decodeMap(f));
      } catch (e) {
        maps.say(`Couldn't open ${f.name}: ${(e as Error).message}`);
      }
    });
    act('new', () => maps.fresh());
  }

  /** Turn the model to place a quarter turn. */
  rotate(): void {
    this.rot = (this.rot + 1) % 4;
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
