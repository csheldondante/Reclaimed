// (round 108, BACKLOG AR5) The tuning panel: every parameter of the tuning registry (src/tune/params.ts) as a live
// slider, grouped by the system that reads it, with presets — saved in this browser (localStorage), exported and
// imported as JSON, or copied as a string (`?tune=<string>` on the page's address loads one). It replaces round 95's
// rock-body panel and round 96's rock panel (the rock lab opens it on those groups). Phone-first: a button opens it,
// groups fold, the sliders are a thumb tall, and nothing it's pressed on reaches the world.

import type { ParamDef, Preset } from '../tune/registry';
import { TUNING } from '../tune/params';

const STORE = 'reclaimed.tune.presets';

export interface TunePanelOpts {
  /** groups open at the start (default: none) */
  open?: string[];
  /** open the panel itself at the start */
  shown?: boolean;
  /** a line of live numbers under the header (e.g. the rigid bodies'), refreshed twice a second while open */
  stats?: () => string;
}

function loadPresets(): Record<string, Preset> {
  try {
    const s = localStorage.getItem(STORE);
    const o = s ? (JSON.parse(s) as unknown) : {};
    return o && typeof o === 'object' ? (o as Record<string, Preset>) : {};
  } catch {
    return {};
  }
}

function savePresets(p: Record<string, Preset>): boolean {
  try {
    localStorage.setItem(STORE, JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}

/** files the browser saves (or the phone's share sheet sends, all in one) */
export async function offerFiles(files: { name: string; data: Blob }[]): Promise<void> {
  const fs = files.map((f) => new File([f.data], f.name, { type: f.data.type }));
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  // (a phone: its share sheet — mail, chat, files — when it takes files)
  if (matchMedia('(pointer: coarse)').matches && nav.canShare?.({ files: fs })) {
    try {
      await navigator.share({ files: fs, title: files[0].name });
      return;
    } catch (e) {
      // (the sheet dismissed: download instead)
      if ((e as Error).name !== 'AbortError') console.warn('[share]', e);
    }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f.data);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }
}

const fmt = (d: ParamDef, v: number) => {
  const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(d.step) + 1e-9)));
  return v.toFixed(dec);
};

export class TunePanel {
  readonly el: HTMLDivElement;
  readonly button: HTMLButtonElement;
  private rows = new Map<string, { input: HTMLInputElement; num: HTMLInputElement; row: HTMLElement; reset: HTMLButtonElement }>();
  private groups = new Map<string, { el: HTMLDetailsElement; sum: HTMLElement }>();
  private presetSel!: HTMLSelectElement;
  private note!: HTMLDivElement;
  private filter = '';
  private changedOnly = false;
  private off: () => void;
  private timer: number;

  constructor(parent: HTMLElement, opts: TunePanelOpts = {}) {
    this.button = document.createElement('button');
    this.button.className = 'tune-btn';
    this.button.textContent = 'tune';
    this.button.title = 'physics and flow parameters (live)';
    this.el = document.createElement('div');
    this.el.className = 'tune-panel';
    this.el.hidden = !opts.shown;
    this.button.classList.toggle('on', !!opts.shown);
    this.button.addEventListener('click', () => this.toggle());
    this.build(opts);
    // (the panel's own presses and keys don't reach the world)
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'wheel', 'keydown', 'keyup', 'click']) {
      this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) this.button.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    parent.append(this.button, this.el);
    this.off = TUNING.onChange((id) => (id ? this.sync(id) : this.syncAll()));
    this.timer = window.setInterval(() => {
      if (!this.el.hidden && opts.stats) this.statsEl.textContent = opts.stats();
    }, 500);
  }

  private statsEl = document.createElement('div');

  toggle(want?: boolean): void {
    const on = want ?? this.el.hidden === true;
    this.el.hidden = !on;
    this.button.classList.toggle('on', on);
  }

  dispose(): void {
    this.off();
    clearInterval(this.timer);
    this.el.remove();
    this.button.remove();
  }

  private build(opts: TunePanelOpts): void {
    const el = this.el;
    const head = document.createElement('div');
    head.className = 'tune-head';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'find…';
    search.addEventListener('input', () => {
      this.filter = search.value.trim().toLowerCase();
      this.applyFilter();
    });
    const only = document.createElement('label');
    only.className = 'tune-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => {
      this.changedOnly = cb.checked;
      this.applyFilter();
    });
    only.append(cb, document.createTextNode('changed'));
    const resetAll = this.btn('reset all', () => TUNING.reset());
    const close = this.btn('×', () => this.toggle(false));
    close.className = 'tune-close';
    head.append(search, only, resetAll, close);
    el.appendChild(head);

    // presets
    const pre = document.createElement('div');
    pre.className = 'tune-presets';
    this.presetSel = document.createElement('select');
    this.fillPresets();
    const load = this.btn('load', () => {
      const p = loadPresets()[this.presetSel.value];
      if (p) this.report(TUNING.apply(p), `loaded “${this.presetSel.value}”`);
    });
    const save = this.btn('save…', () => {
      const name = prompt('Save the changed values as a preset named:', this.presetSel.value || 'preset 1');
      if (!name) return;
      const all = loadPresets();
      all[name] = TUNING.changed();
      if (!savePresets(all)) return this.say('this browser keeps nothing (private window?) — export instead');
      this.fillPresets(name);
      this.say(`saved “${name}” (${Object.keys(all[name]).length} changed)`);
    });
    const del = this.btn('delete', () => {
      const all = loadPresets();
      if (!all[this.presetSel.value]) return;
      if (!confirm(`Delete the preset “${this.presetSel.value}”?`)) return;
      delete all[this.presetSel.value];
      savePresets(all);
      this.fillPresets();
    });
    pre.append(this.presetSel, load, save, del);
    el.appendChild(pre);
    const io = document.createElement('div');
    io.className = 'tune-presets';
    const exp = this.btn('export', () => {
      const json = JSON.stringify({ kind: 'reclaimed-tune', at: new Date().toISOString(), params: TUNING.changed() }, null, 1);
      void offerFiles([{ name: `tune-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, data: new Blob([json], { type: 'application/json' }) }]);
    });
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        this.report(TUNING.apply(TUNING.decode(await f.text())), `imported ${f.name}`);
      } catch (e) {
        this.say(`couldn't read ${f.name}: ${(e as Error).message}`);
      }
      file.value = '';
    });
    const imp = this.btn('import', () => file.click());
    const copy = this.btn('copy', () => {
      const s = TUNING.encode();
      const link = `${location.origin}${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), tune: s }).toString()}`;
      this.strBox.value = s;
      this.strBox.hidden = false;
      this.strBox.select();
      navigator.clipboard?.writeText(link).then(
        () => this.say('copied a link with these values (the string is below)'),
        () => this.say('select the string below to copy it'),
      );
    });
    copy.title = 'copy a link to this page with the changed values in it (?tune=)';
    const paste = this.btn('paste', () => {
      this.strBox.hidden = false;
      this.strBox.value = '';
      this.strBox.placeholder = 'paste a string, a ?tune= link or JSON, then press apply';
      this.strBox.focus();
      this.applyStr.hidden = false;
    });
    this.applyStr.textContent = 'apply';
    this.applyStr.hidden = true;
    this.applyStr.addEventListener('click', () => {
      try {
        this.report(TUNING.apply(TUNING.decode(this.strBox.value)), 'applied');
        this.applyStr.hidden = true;
      } catch (e) {
        this.say(`not a preset: ${(e as Error).message}`);
      }
    });
    io.append(exp, imp, file, copy, paste);
    el.appendChild(io);
    this.strBox.className = 'tune-str';
    this.strBox.hidden = true;
    this.strBox.rows = 2;
    el.append(this.strBox, this.applyStr);
    this.note = document.createElement('div');
    this.note.className = 'tune-note';
    el.appendChild(this.note);
    this.statsEl.className = 'tune-note';
    if (opts.stats) el.appendChild(this.statsEl);

    // the groups
    let cur = '';
    let body: HTMLDetailsElement | null = null;
    for (const d of TUNING.defs) {
      if (d.group !== cur) {
        cur = d.group;
        body = document.createElement('details');
        body.className = 'tune-group';
        body.open = !!opts.open?.includes(d.group);
        const sum = document.createElement('summary');
        body.appendChild(sum);
        const owner = document.createElement('div');
        owner.className = 'tune-owner';
        owner.textContent = d.owner;
        const reset = this.btn('reset group', () => TUNING.reset(d.group));
        reset.className = 'tune-mini';
        owner.appendChild(reset);
        body.appendChild(owner);
        el.appendChild(body);
        this.groups.set(d.group, { el: body, sum });
      }
      body!.appendChild(this.row(d));
    }
    this.syncAll();
  }

  private strBox = document.createElement('textarea');
  private applyStr = document.createElement('button');

  private row(d: ParamDef): HTMLElement {
    const row = document.createElement('div');
    row.className = 'tune-row';
    row.title = `${d.id} — ${d.help ?? d.label} (default ${d.def}, ${d.min}–${d.max} ${d.units})`;
    const top = document.createElement('div');
    top.className = 'tune-top';
    const name = document.createElement('span');
    name.className = 'tune-name';
    name.textContent = d.label;
    const units = document.createElement('span');
    units.className = 'tune-units';
    units.textContent = d.units;
    const num = document.createElement('input');
    num.type = 'number';
    num.step = String(d.step);
    num.min = String(d.min);
    num.max = String(d.max);
    num.inputMode = 'decimal';
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (Number.isFinite(v)) TUNING.set(d.id, v);
      else this.sync(d.id);
    });
    const reset = document.createElement('button');
    reset.className = 'tune-reset';
    reset.textContent = '↺';
    reset.title = `back to ${d.def}`;
    reset.addEventListener('click', () => TUNING.set(d.id, d.def));
    top.append(name, units, num, reset);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(d.min);
    input.max = String(d.max);
    input.step = String(d.step);
    input.addEventListener('input', () => TUNING.set(d.id, Number(input.value)));
    row.append(top, input);
    if (d.help) {
      const help = document.createElement('div');
      help.className = 'tune-help';
      help.textContent = d.help;
      row.appendChild(help);
    }
    this.rows.set(d.id, { input, num, row, reset });
    return row;
  }

  private sync(id: string): void {
    const r = this.rows.get(id);
    const d = TUNING.byId.get(id);
    if (!r || !d) return;
    const v = TUNING.get(id);
    if (document.activeElement !== r.input) r.input.value = String(v);
    if (document.activeElement !== r.num) r.num.value = fmt(d, v);
    r.row.classList.toggle('changed', v !== d.def);
    this.groupCounts();
    if (this.changedOnly) this.applyFilter();
  }

  private syncAll(): void {
    for (const id of this.rows.keys()) this.sync(id);
    this.groupCounts();
  }

  private groupCounts(): void {
    const ch = TUNING.changed();
    for (const [g, { sum }] of this.groups) {
      const d = TUNING.defs.find((x) => x.group === g)!;
      const n = Object.keys(ch).filter((id) => id.startsWith(g + '.')).length;
      sum.textContent = n ? `${d.title} · ${n} changed` : d.title;
    }
    this.button.textContent = Object.keys(ch).length ? `tune · ${Object.keys(ch).length}` : 'tune';
  }

  private applyFilter(): void {
    const ch = TUNING.changed();
    for (const [g, { el }] of this.groups) {
      let any = false;
      for (const d of TUNING.defs) {
        if (d.group !== g) continue;
        const hit = (!this.filter || `${d.id} ${d.label} ${d.title} ${d.help ?? ''}`.toLowerCase().includes(this.filter)) && (!this.changedOnly || d.id in ch);
        this.rows.get(d.id)!.row.hidden = !hit;
        any ||= hit;
      }
      el.hidden = !any;
      if ((this.filter || this.changedOnly) && any) el.open = true;
    }
  }

  private fillPresets(pick?: string): void {
    const names = Object.keys(loadPresets()).sort();
    this.presetSel.replaceChildren(...(names.length ? names : ['(no presets)']).map((n) => new Option(n, names.length ? n : '')));
    if (pick) this.presetSel.value = pick;
  }

  private report(unknown: string[], what: string): void {
    this.say(unknown.length ? `${what}; not in this build: ${unknown.join(', ')}` : `${what} (${Object.keys(TUNING.changed()).length} changed)`);
  }

  private say(t: string): void {
    this.note.textContent = t;
  }

  private btn(label: string, f: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', f);
    return b;
  }
}
