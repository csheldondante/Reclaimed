// Minimal HUD: Nature meter, a couple of tools, a quiet contextual hint
// (design doc §3: avoid filling the experience with UI).

import { COSTS } from '../game/nature';

export type Tool = 'none' | 'storm' | 'lightning';

const TOOLS: { id: Exclude<Tool, 'none'>; label: string; cost: number; key: string }[] = [
  { id: 'storm', label: 'Storm', cost: COSTS.storm, key: '1' },
  { id: 'lightning', label: 'Lightning', cost: COSTS.lightning, key: '2' },
];

const NS = 'http://www.w3.org/2000/svg';

export class Hud {
  tool: Tool = 'none';
  private fill: HTMLElement;
  private val: HTMLElement;
  private buttons = new Map<Tool, HTMLButtonElement>();
  private hint: HTMLElement;
  private hintTimer = 0;
  private overlay: SVGSVGElement;
  private bolts: SVGSVGElement;

  constructor(root: HTMLElement, onTool: (t: Tool) => void) {
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="nature" title="Nature — regenerates from living, healthy land">
        <span>❦</span><div class="bar"><div class="fill"></div></div><span class="val"></span>
      </div>
      ${TOOLS.map((t) => `<button class="tool" data-tool="${t.id}" title="${t.label} (${t.key})">${t.label} <span class="cost">${t.cost}</span></button>`).join('')}`;
    root.appendChild(hud);
    this.fill = hud.querySelector('.fill')!;
    this.val = hud.querySelector('.val')!;
    for (const t of TOOLS) {
      const b = hud.querySelector<HTMLButtonElement>(`[data-tool="${t.id}"]`)!;
      this.buttons.set(t.id, b);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setTool(this.tool === t.id ? 'none' : t.id);
        onTool(this.tool);
      });
    }
    this.hint = document.createElement('div');
    this.hint.className = 'hint';
    this.hint.style.opacity = '0';
    root.appendChild(this.hint);
    this.overlay = document.createElementNS(NS, 'svg');
    this.overlay.setAttribute('class', 'overlay');
    root.appendChild(this.overlay);
    this.bolts = document.createElementNS(NS, 'svg');
    this.bolts.setAttribute('class', 'overlay');
    root.appendChild(this.bolts);
  }

  /**
   * Storm handles + nudge arrow. `storms` are screen positions with a strength
   * 0..1; `drag` is the current nudge arrow (screen from → to) if any.
   */
  drawStorms(storms: { x: number; y: number; a: number }[], drag?: { x0: number; y0: number; x1: number; y1: number }): void {
    let html = '';
    for (const s of storms) {
      html += `<circle cx="${s.x}" cy="${s.y}" r="26" class="storm-handle" style="opacity:${(0.25 + s.a * 0.45).toFixed(2)}"/>`;
    }
    if (drag) {
      const dx = drag.x1 - drag.x0;
      const dy = drag.y1 - drag.y0;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l;
      const uy = dy / l;
      const hx = drag.x1 - ux * 12;
      const hy = drag.y1 - uy * 12;
      html += `<line x1="${drag.x0}" y1="${drag.y0}" x2="${hx}" y2="${hy}" class="nudge"/>`;
      html += `<polygon class="nudge-head" points="${drag.x1},${drag.y1} ${hx - uy * 7},${hy + ux * 7} ${hx + uy * 7},${hy - ux * 7}"/>`;
    }
    this.overlay.innerHTML = html;
  }

  /** A jagged lightning bolt from the sky to a screen point; fades by itself. */
  bolt(x: number, y: number): void {
    const pts: [number, number][] = [];
    let cx = x + (Math.random() - 0.5) * 160;
    const top = -20;
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const yy = top + (y - top) * t;
      cx = cx + (x - cx) * (t * 0.5) + (Math.random() - 0.5) * 34 * (1 - t);
      pts.push([i === steps ? x : cx, yy]);
    }
    const d = pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'bolt');
    g.innerHTML = `<polyline points="${d}" class="bolt-glow"/><polyline points="${d}" class="bolt-core"/>`;
    // a short fork
    const fi = 4 + Math.floor(Math.random() * 6);
    const [fx, fy] = pts[fi];
    let fpts = `${fx},${fy}`;
    let px = fx;
    let py = fy;
    for (let i = 0; i < 4; i++) {
      px += (Math.random() - 0.3) * 30;
      py += 18 + Math.random() * 20;
      fpts += ` ${px.toFixed(1)},${py.toFixed(1)}`;
    }
    g.innerHTML += `<polyline points="${fpts}" class="bolt-core" style="stroke-width:1"/>`;
    this.bolts.appendChild(g);
    setTimeout(() => g.remove(), 700);
  }

  setTool(t: Tool): void {
    this.tool = t;
    for (const [id, b] of this.buttons) b.classList.toggle('active', id === t);
  }

  update(nature: number, max: number): void {
    this.fill.style.width = `${(nature / max) * 100}%`;
    this.val.textContent = String(Math.floor(nature));
    for (const t of TOOLS) {
      const b = this.buttons.get(t.id)!;
      b.disabled = nature < t.cost && this.tool !== t.id;
    }
  }

  say(text: string, seconds = 5): void {
    this.hint.textContent = text;
    this.hint.style.opacity = '1';
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => (this.hint.style.opacity = '0'), seconds * 1000);
  }
}
