// The fortress's planning bar (milestone 1): select what — one of the eight types — then tap to plan it. An erase
// toggle (no shift key on a phone) and, for walls, a gate toggle. A panel over the bar says what the type costs,
// what the structure just painted costs and gives, and the whole plan against the stores. Phone-sized: two rows of
// four big buttons.
import { STRUCTURE_TYPES, type StructureType } from '../api/contracts/fortress';
import { DEFS } from './defs';
import type { Fortress } from './fortress';
import { PAUSED_LINE, planLines, structureLines, typeLines } from './words';

const CSS = `
.fort-bar{position:absolute;left:0;right:0;bottom:0;padding:6px 8px calc(8px + env(safe-area-inset-bottom));
  background:rgba(20,22,26,.86);color:#eee;font:14px/1.3 system-ui,sans-serif;pointer-events:auto;z-index:30}
.fort-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}
.fort-bar button{min-height:42px;border:1px solid #555;border-radius:7px;background:#2c3036;color:#eee;font:inherit;padding:2px 4px}
.fort-bar button.on{background:#c8a24a;color:#111;border-color:#e6c46a;font-weight:600}
.fort-bar button:disabled{opacity:.35}
.fort-row{display:flex;gap:5px;margin-top:5px}
.fort-row button{flex:1}
.fort-info{margin:0 0 6px;font-size:13px;line-height:1.35}
.fort-info p{margin:0}
.fort-info .short{color:#ff9c7a}
.fort-top{position:absolute;left:50%;top:10px;transform:translateX(-50%);background:rgba(20,22,26,.8);color:#eee;
  padding:5px 12px;border-radius:14px;font:13px system-ui,sans-serif;z-index:30;pointer-events:none;white-space:nowrap}
`;

export class FortressBar {
  readonly root: HTMLDivElement;
  private info: HTMLDivElement;
  private buttons = new Map<StructureType, HTMLButtonElement>();
  private eraseBtn: HTMLButtonElement;
  private gateBtn: HTMLButtonElement;
  private top: HTMLDivElement;

  constructor(parent: HTMLElement, private fort: Fortress) {
    const style = document.createElement('style');
    style.textContent = CSS;
    parent.appendChild(style);
    this.top = document.createElement('div');
    this.top.className = 'fort-top';
    this.top.textContent = PAUSED_LINE;
    parent.appendChild(this.top);
    this.root = document.createElement('div');
    this.root.className = 'fort-bar';
    this.info = document.createElement('div');
    this.info.className = 'fort-info';
    this.root.appendChild(this.info);
    const grid = document.createElement('div');
    grid.className = 'fort-grid';
    for (const t of STRUCTURE_TYPES) {
      const b = document.createElement('button');
      b.textContent = DEFS[t].label;
      b.onclick = () => {
        fort.tool = { type: t, erase: false, gate: false };
        this.render();
      };
      this.buttons.set(t, b);
      grid.appendChild(b);
    }
    this.root.appendChild(grid);
    const row = document.createElement('div');
    row.className = 'fort-row';
    this.eraseBtn = document.createElement('button');
    this.eraseBtn.textContent = 'Erase';
    this.eraseBtn.onclick = () => {
      fort.tool = { ...fort.tool, erase: !fort.tool.erase, gate: false };
      this.render();
    };
    this.gateBtn = document.createElement('button');
    this.gateBtn.textContent = 'Gate';
    this.gateBtn.onclick = () => {
      fort.tool = { ...fort.tool, gate: !fort.tool.gate, erase: false };
      this.render();
    };
    row.append(this.eraseBtn, this.gateBtn);
    this.root.appendChild(row);
    // (the bar takes its own presses: none reach the map under it)
    for (const ev of ['pointerdown', 'pointerup', 'click', 'wheel', 'touchstart']) this.root.addEventListener(ev, (e) => e.stopPropagation());
    parent.appendChild(this.root);
    fort.onChange.push(() => this.render());
    this.render();
  }

  /** The lines the panel shows now (the writing lint reads them too). */
  lines(): { text: string; short?: boolean }[] {
    const f = this.fort;
    const out: { text: string; short?: boolean }[] = [];
    const t = f.tool;
    if (t.gate) out.push({ text: 'Tap a straight wall to put a gate in it. Tap a gate to close it.' });
    else if (t.erase) out.push({ text: 'Tap a block to take it away.' });
    else {
      const def = DEFS[t.type];
      out.push({ text: `${def.label}. ${typeLines(def).join(' ')}` });
    }
    const s = f.selected !== null ? f.plan.structure(f.selected) : null;
    if (s) out.push({ text: structureLines(DEFS[s.type], f.plan.blocks(s), f.plan.cost(s), f.plan.gives(s)).join(' ') });
    const stores = f.stores();
    const tot = f.plan.totals(stores);
    const pl = planLines(tot, stores);
    out.push({ text: pl.slice(0, -1).join(' ') || pl[0] });
    if (pl.length > 1) out.push({ text: pl[pl.length - 1], short: Object.keys(tot.short).length > 0 });
    return out;
  }

  render(): void {
    const t = this.fort.tool;
    for (const [k, b] of this.buttons) b.classList.toggle('on', !t.erase && !t.gate && k === t.type);
    this.eraseBtn.classList.toggle('on', t.erase);
    this.gateBtn.classList.toggle('on', t.gate);
    this.gateBtn.disabled = t.type !== 'wall' && !t.gate;
    this.info.replaceChildren(
      ...this.lines().map((l) => {
        const p = document.createElement('p');
        p.textContent = l.text;
        if (l.short) p.className = 'short';
        return p;
      }),
    );
  }

  dispose(): void {
    this.root.remove();
    this.top.remove();
  }
}
