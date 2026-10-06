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
