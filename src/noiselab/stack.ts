// (round 112, BACKLOG TG9; the user: "I find the noise lab a little unintuitive in terms of how I navigate the layers
// and how they combine") The noise lab's layer stack as a list: a row a layer — its thumbnail (what it puts out), what
// it is (generator, op, target), the masks it gates and is gated by, enable, solo and "the result up to here". A row
// selected shows that layer's parameters alone in the panel below (control.ts's visibility rule asks `selected`).
// Rows reorder by dragging their handle or by the arrows; add, duplicate, remove.
//
// It edits the recipe only through the lab's registry (a stack operation is one `apply` of the rewritten recipe), so
// presets, links and the panel stay the one source of truth. Solo and "up to here" are views, not recipe: the
// control applies them to a copy of the values it runs (`effective`).

import type { LabResult } from './lab';
import { GEN, GENS, LAB_TUNING, LAYERS, LAYER_KEYS, OPS, OP, TARGET, TARGETS, labValues, type LabValues } from './params';

type Layer = Record<string, number>;

/** what a layer reads: mask slots (1..4) and whether it reads the height so far */
function reads(L: Layer): { masks: Set<number>; height: boolean } {
  const masks = new Set<number>();
  if (L.mask > 0) masks.add(L.mask);
  if (L.gen === GEN.mask && L.src > 0) masks.add(L.src);
  if ((L.gen === GEN.jfa || L.gen === GEN.jfaRidge) && L.src > 0) masks.add(L.src);
  if (L.target === TARGET.carve && L.coast > 0) masks.add(L.coast);
  const height = L.gen === GEN.height || L.gen === GEN.slope || ((L.gen === GEN.jfa || L.gen === GEN.jfaRidge || L.gen === GEN.mask) && L.src === 0) || (L.target === TARGET.carve && L.zRef === 0);
  return { masks, height };
}

/** the slot a layer writes (0 height, 1..4 a mask, 5/6 the old cave, 7 a carve) */
const writes = (L: Layer) => Math.round(L.target);

/**
 * (round 112; the user: "you can use JFA to find the narrow points if you want to measure in tuning") a carve's
 * passages measured off its thumbnail — its value is the JFA distance in from the passage's edge, so a ridge of it (a
 * sample no lower than its eight neighbours) is on the passage's mid line and twice its value is the width there. The
 * thumbnail samples every 4th column, so passages narrower than about 4 cells can be missed.
 */
function passageWidths(t: Float32Array, o: number, tw: number, th: number): string {
  const w: number[] = [];
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= tw || y >= th ? 0 : t[(o + y * tw + x) * 2]);
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const d = at(x, y);
      if (d <= 0) continue;
      let ridge = true;
      for (let dy = -1; dy <= 1 && ridge; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && at(x + dx, y + dy) > d) ridge = false;
      if (ridge) w.push(2 * d);
    }
  if (!w.length) return 'no passage';
  w.sort((a, b) => a - b);
  const q = (f: number) => w[Math.min(w.length - 1, Math.floor(f * w.length))].toFixed(1);
  return `passages (JFA): narrowest ${q(0)}, 10% ${q(0.1)}, median ${q(0.5)}, widest ${q(1)} cells`;
}

const short = (g: number) => (GENS[g] ?? '?').replace(/ \(.*\)$/, '');

export class LayerStack {
  readonly el = document.createElement('div');
  /** the slot whose parameters show */
  selected = 0;
  /** views (slots; -1 none) */
  solo = -1;
  upTo = -1;
  /** a view or the selection changed (the control reruns, the panel re-filters) */
  onView: () => void = () => {};
  private list = document.createElement('div');
  private rows: { row: HTMLElement; thumb: HTMLCanvasElement; name: HTMLElement; links: HTMLElement; stat: HTMLElement; on: HTMLInputElement; solo: HTMLButtonElement; upTo: HTMLButtonElement }[] = [];
  private bar = document.createElement('div');
  private btns: Record<string, HTMLButtonElement> = {};
  private drag?: { from: number; to: number; id: number };

  constructor() {
    this.el.className = 'lab-stack';
    this.list.className = 'lab-rows';
    this.bar.className = 'lab-bar';
    const b = (key: string, label: string, title: string, f: () => void) => {
      const e = document.createElement('button');
      e.textContent = label;
      e.title = title;
      e.addEventListener('click', f);
      this.btns[key] = e;
      this.bar.appendChild(e);
    };
    b('add', '+ layer', 'add a layer under the selected one', () => this.add());
    b('dup', 'duplicate', 'a copy of the selected layer under it', () => this.dup());
    b('up', '↑', 'move the selected layer up (it runs earlier)', () => this.move(this.selected, this.selected - 1));
    b('down', '↓', 'move the selected layer down (it runs later)', () => this.move(this.selected, this.selected + 1));
    b('del', 'remove', 'remove the selected layer', () => this.remove());
    for (let i = 0; i < LAYERS; i++) this.rows.push(this.makeRow(i));
    this.el.append(this.list, this.bar);
    this.render();
  }

  /** the stack's slots (the layers that are on, in order) */
  stacked(v: LabValues = labValues()): number[] {
    const out: number[] = [];
    for (let i = 0; i < LAYERS; i++) if (v[`L${i + 1}`].on) out.push(i);
    return out;
  }

  /** the values to run: the views applied (solo: the layer and what it reads; up to here: the layers to it) */
  effective(v: LabValues): LabValues {
    if (this.solo >= 0 && !v[`L${this.solo + 1}`].on) this.solo = -1;
    if (this.upTo >= 0 && !v[`L${this.upTo + 1}`].on) this.upTo = -1;
    if (this.solo < 0 && this.upTo < 0) return v;
    const o = JSON.parse(JSON.stringify(v)) as LabValues;
    const keep = this.solo >= 0 ? this.closure(o, this.solo) : null;
    for (let i = 0; i < LAYERS; i++) {
      const L = o[`L${i + 1}`];
      if (this.upTo >= 0 && i > this.upTo) L.on = 0;
      if (keep && !keep.has(i)) L.on = 0;
    }
    return o;
  }

  /** a layer and the earlier layers it reads from, transitively (not its own target's: solo shows it alone) */
  private closure(v: LabValues, j: number): Set<number> {
    const keep = new Set([j]);
    const want = (i: number) => {
      const L = v[`L${i + 1}`];
      const r = reads(L);
      for (let k = i - 1; k >= 0; k--) {
        const K = v[`L${k + 1}`];
        if (!K.on || K.mute || keep.has(k)) continue;
        const w = writes(K);
        if ((w === 0 && r.height) || (w >= 1 && w <= 4 && r.masks.has(w))) {
          keep.add(k);
          want(k);
        }
      }
    };
    want(j);
    return keep;
  }

  /** rows' names, links and buttons from the values */
  render(): void {
    const v = labValues();
    const st = this.stacked(v);
    if (st.length && !st.includes(this.selected)) this.selected = st[st.length - 1];
    // the masks: who writes each (in order) — a reader's link is to the last writer before it
    const lastWriter = (slot: number, before: number) => {
      for (let k = before - 1; k >= 0; k--) {
        const K = v[`L${k + 1}`];
        if (K.on && !K.mute && writes(K) === slot) return k;
      }
      return -1;
    };
    const gates = new Map<number, number[]>();
    for (const j of st) {
      const L = v[`L${j + 1}`];
      for (const m of reads(L).masks) {
        const w = lastWriter(m, j);
        if (w >= 0) gates.set(w, [...(gates.get(w) ?? []), j]);
      }
    }
    const pos = (slot: number) => st.indexOf(slot) + 1;
    for (let i = 0; i < LAYERS; i++) {
      const r = this.rows[i];
      const L = v[`L${i + 1}`];
      r.row.hidden = !L.on;
      if (!L.on) continue;
      const t = writes(L);
      const carve = t === TARGET.carve;
      const tname = carve ? 'carve' : t >= 1 && t <= 4 ? `M${t}` : TARGETS[t] ?? '?';
      const op = carve ? '' : ` (${t !== 0 && L.op === OP.set ? 'set' : (OPS[L.op] ?? '?').replace(/ \(.*\)$/, '')})`;
      r.name.textContent = `${pos(i)}. ${short(L.gen)} → ${tname}${op}`;
      const bits: string[] = [];
      const rd = reads(L);
      for (const m of rd.masks) {
        const w = lastWriter(m, i);
        bits.push(w >= 0 ? `${m === L.mask ? 'gated by' : 'reads'} M${m} ← ${pos(w)}` : `M${m} is empty here`);
      }
      const g = gates.get(i);
      if (g && t >= 1 && t <= 4) bits.push(`M${t} → ${g.map(pos).join(', ')}`);
      r.links.textContent = bits.join(' · ');
      r.links.classList.toggle('warn', bits.some((b) => b.includes('empty')));
      r.on.checked = !L.mute;
      r.row.classList.toggle('sel', i === this.selected);
      r.row.classList.toggle('muted', !!L.mute);
      r.row.classList.toggle('gated', L.mask > 0);
      r.solo.classList.toggle('on', this.solo === i);
      r.upTo.classList.toggle('on', this.upTo === i);
      r.row.classList.toggle('after', this.upTo >= 0 && i > this.upTo);
    }
    const k = st.indexOf(this.selected);
    this.btns.add.disabled = this.btns.dup.disabled = st.length >= LAYERS;
    this.btns.del.disabled = !st.length;
    this.btns.dup.disabled ||= !st.length;
    this.btns.up.disabled = k <= 0;
    this.btns.down.disabled = k < 0 || k >= st.length - 1;
  }

  /** the rows' thumbnails from a run (each normalized to its own range; darker where its mask holds it back) */
  drawThumbs(r: LabResult): void {
    const { tw, th, thumbs } = r;
    const v = labValues();
    for (let l = 0; l < LAYERS; l++) {
      const L = v[`L${l + 1}`];
      if (!L.on) continue;
      const cv = this.rows[l].thumb;
      if (cv.width !== tw || cv.height !== th) {
        cv.width = tw;
        cv.height = th;
      }
      const ctx = cv.getContext('2d');
      if (!ctx) continue;
      const img = ctx.createImageData(tw, th);
      const o = l * tw * th;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < tw * th; i++) {
        const x = thumbs[(o + i) * 2];
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      const carve = L.target === TARGET.carve;
      if (carve) lo = 0;
      const span = hi - lo > 1e-6 ? hi - lo : 1;
      for (let i = 0; i < tw * th; i++) {
        const t = hi - lo > 1e-6 ? (thumbs[(o + i) * 2] - lo) / span : 0.5;
        const m = thumbs[(o + i) * 2 + 1];
        const k = 0.25 + 0.75 * Math.max(0, Math.min(1, m));
        const c = carve ? (t > 0 ? [255, 120 + 100 * t, 40] : [20, 20, 24]) : [40 + 215 * t, 40 + 215 * t, 46 + 209 * t];
        img.data[i * 4] = c[0] * (carve ? 1 : k);
        img.data[i * 4 + 1] = c[1] * (carve ? 1 : k);
        img.data[i * 4 + 2] = c[2] * (carve ? 1 : k) + (carve ? 0 : (1 - k) * 60);
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      this.rows[l].stat.textContent = carve ? passageWidths(thumbs, o, tw, th) : '';
    }
  }

  /** a soloed layer's thumbnail (the preview shows it when the layer isn't the height's) */
  thumbOf(slot: number): HTMLCanvasElement {
    return this.rows[slot].thumb;
  }

  private makeRow(i: number): (typeof this.rows)[number] {
    const row = document.createElement('div');
    row.className = 'lab-row';
    const handle = document.createElement('span');
    handle.className = 'lab-handle';
    handle.textContent = '⋮⋮';
    handle.title = 'drag to reorder';
    const thumb = document.createElement('canvas');
    thumb.className = 'lab-thumb';
    thumb.width = thumb.height = 1;
    const text = document.createElement('div');
    text.className = 'lab-text';
    const name = document.createElement('div');
    name.className = 'lab-name';
    const links = document.createElement('div');
    links.className = 'lab-links';
    const stat = document.createElement('div');
    stat.className = 'lab-links lab-stat';
    text.append(name, links, stat);
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.title = 'enabled (off: the stack skips it)';
    on.addEventListener('change', () => LAB_TUNING.set(`L${i + 1}.mute`, on.checked ? 0 : 1));
    on.addEventListener('click', (e) => e.stopPropagation());
    const view = (label: string, title: string, f: () => void) => {
      const e = document.createElement('button');
      e.className = 'lab-view';
      e.textContent = label;
      e.title = title;
      e.addEventListener('click', (ev) => {
        ev.stopPropagation();
        f();
        this.render();
        this.onView();
      });
      return e;
    };
    const solo = view('S', 'solo: this layer alone on the base (with the layers it reads: its mask, its source)', () => {
      this.solo = this.solo === i ? -1 : i;
      if (this.solo >= 0) this.upTo = -1;
    });
    const upTo = view('▼', 'the result up to here: the layers after this one off', () => {
      this.upTo = this.upTo === i ? -1 : i;
      if (this.upTo >= 0) this.solo = -1;
    });
    row.append(handle, thumb, text, on, solo, upTo);
    row.addEventListener('click', () => this.select(i));
    // (drag the handle: pointer events, so a phone's finger works too)
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      this.drag = { from: i, to: i, id: e.pointerId };
      row.classList.add('dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      const st = this.stacked();
      let to = st[st.length - 1];
      for (const s of st) {
        const rc = this.rows[s].row.getBoundingClientRect();
        if (e.clientY < rc.top + rc.height / 2) {
          to = s;
          break;
        }
      }
      this.drag.to = to;
      for (const s of st) this.rows[s].row.classList.toggle('drop', s === to && to !== this.drag.from);
    });
    const end = (e: PointerEvent) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      const { from, to } = this.drag;
      this.drag = undefined;
      for (const r of this.rows) r.row.classList.remove('drop', 'dragging');
      if (to !== from) this.move(from, to);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    this.list.appendChild(row);
    return { row, thumb, name, links, stat, on, solo, upTo };
  }

  select(i: number): void {
    if (this.selected === i) return;
    this.selected = i;
    this.render();
    this.onView();
  }

  // ---- stack operations: the recipe rewritten (layers in their new order, compact) and applied once ----

  private layers(): Layer[] {
    const v = labValues();
    return this.stacked(v).map((i) => ({ ...v[`L${i + 1}`] }));
  }

  /** the layers into slots 1..n (the rest default) in one apply; `map` old slot → new (views follow) */
  private write(list: Layer[], map: (old: number) => number, sel: number): void {
    const p: Record<string, number> = {};
    const lab = labValues().lab;
    for (const [k, val] of Object.entries(lab)) {
      const d = LAB_TUNING.byId.get(`lab.${k}`)!;
      if (val !== d.def) p[`lab.${k}`] = val;
    }
    list.forEach((L, i) => {
      for (const k of LAYER_KEYS) {
        const id = `L${i + 1}.${k}`;
        if (L[k] !== LAB_TUNING.byId.get(id)!.def) p[id] = L[k];
      }
    });
    this.solo = this.solo >= 0 ? map(this.solo) : -1;
    this.upTo = this.upTo >= 0 ? map(this.upTo) : -1;
    this.selected = Math.max(0, sel);
    LAB_TUNING.apply(p);
    this.render();
    this.onView();
  }

  move(fromSlot: number, toSlot: number): void {
    const st = this.stacked();
    const a = st.indexOf(fromSlot);
    const b = Math.max(0, Math.min(st.length - 1, st.indexOf(toSlot) >= 0 ? st.indexOf(toSlot) : toSlot));
    if (a < 0 || a === b) return;
    const list = this.layers();
    const order = st.map((_, i) => i);
    const [L] = list.splice(a, 1);
    list.splice(b, 0, L);
    const [o] = order.splice(a, 1);
    order.splice(b, 0, o);
    // (old position → new; slots are positions once compact)
    this.write(list, (old) => order.indexOf(st.indexOf(old)), b);
  }

  private insert(at: number, L: Layer): void {
    const st = this.stacked();
    const list = this.layers();
    list.splice(at, 0, L);
    this.write(list, (old) => {
      const p = st.indexOf(old);
      return p < 0 ? -1 : p >= at ? p + 1 : p;
    }, at);
  }

  add(): void {
    const st = this.stacked();
    if (st.length >= LAYERS) return;
    const at = st.length ? st.indexOf(this.selected) + 1 : 0;
    const used = new Set(this.layers().map((L) => L.seed));
    let seed = 11;
    while (used.has(seed)) seed += 13;
    const def: Layer = {};
    for (const k of LAYER_KEYS) def[k] = LAB_TUNING.byId.get(`L1.${k}`)!.def;
    this.insert(at, { ...def, on: 1, gen: GEN.fbm, scale: 64, oct: 4, amp: 8, op: OP.add, target: TARGET.h, seed });
  }

  dup(): void {
    const st = this.stacked();
    const k = st.indexOf(this.selected);
    if (k < 0 || st.length >= LAYERS) return;
    this.insert(k + 1, { ...labValues()[`L${this.selected + 1}`] });
  }

  remove(): void {
    const st = this.stacked();
    const k = st.indexOf(this.selected);
    if (k < 0) return;
    const list = this.layers();
    list.splice(k, 1);
    this.write(list, (old) => {
      const p = st.indexOf(old);
      return p === k ? -1 : p > k ? p - 1 : p;
    }, Math.max(0, Math.min(k, list.length - 1)));
  }
}
