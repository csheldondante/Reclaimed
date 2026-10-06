// Minimal HUD: Nature meter, one tool, a quiet contextual hint (design doc §3:
// avoid filling the experience with UI).

import { COSTS } from '../game/nature';

export type Tool = 'none' | 'storm';

export class Hud {
  tool: Tool = 'none';
  private fill: HTMLElement;
  private val: HTMLElement;
  private stormBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private hintTimer = 0;

  constructor(root: HTMLElement, onTool: (t: Tool) => void) {
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="nature" title="Nature — regenerates from living, healthy land">
        <span>❦</span><div class="bar"><div class="fill"></div></div><span class="val"></span>
      </div>
      <button class="tool" data-tool="storm">Storm <span class="cost">${COSTS.storm}</span></button>`;
    root.appendChild(hud);
    this.fill = hud.querySelector('.fill')!;
    this.val = hud.querySelector('.val')!;
    this.stormBtn = hud.querySelector('[data-tool="storm"]')!;
    this.stormBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setTool(this.tool === 'storm' ? 'none' : 'storm');
      onTool(this.tool);
    });
    this.hint = document.createElement('div');
    this.hint.className = 'hint';
    this.hint.style.opacity = '0';
    root.appendChild(this.hint);
  }

  private svg?: SVGSVGElement;

  /**
   * Storm handles + nudge arrow. `storms` are screen positions with a strength
   * 0..1; `drag` is the current nudge arrow (screen from → to) if any.
   */
  drawStorms(storms: { x: number; y: number; a: number }[], drag?: { x0: number; y0: number; x1: number; y1: number }): void {
    if (!this.svg) {
      const ns = 'http://www.w3.org/2000/svg';
      this.svg = document.createElementNS(ns, 'svg');
      this.svg.setAttribute('class', 'overlay');
      this.hint.parentElement!.appendChild(this.svg);
    }
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
    this.svg.innerHTML = html;
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.stormBtn.classList.toggle('active', t === 'storm');
  }

  update(nature: number, max: number): void {
    this.fill.style.width = `${(nature / max) * 100}%`;
    this.val.textContent = String(Math.floor(nature));
    this.stormBtn.disabled = nature < COSTS.storm && this.tool !== 'storm';
  }

  say(text: string, seconds = 5): void {
    this.hint.textContent = text;
    this.hint.style.opacity = '1';
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => (this.hint.style.opacity = '0'), seconds * 1000);
  }
}
