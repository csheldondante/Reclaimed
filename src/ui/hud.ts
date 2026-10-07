// Minimal HUD (DECISIONS 2026-10-07): no tool buttons — interaction is by
// gesture on the world. The UI only shows recharge: the Nature meter and a
// summon-storm control (clickable, key R) whose ring fills as it recharges.

const NS = 'http://www.w3.org/2000/svg';

export class Hud {
  private fill: HTMLElement;
  private val: HTMLElement;
  private stormBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private hintTimer = 0;
  private overlay: SVGSVGElement;
  private bolts: SVGSVGElement;

  constructor(root: HTMLElement, onSummon: () => void) {
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="nature" title="Nature — regenerates from living, healthy land">
        <span>❦</span><div class="bar"><div class="fill"></div></div><span class="val"></span>
      </div>
      <button class="summon" title="Summon a storm (R)"><span>☁</span></button>`;
    root.appendChild(hud);
    this.fill = hud.querySelector('.fill')!;
    this.val = hud.querySelector('.val')!;
    this.stormBtn = hud.querySelector('.summon')!;
    this.stormBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSummon();
    });
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

  /** Gust arrow while the player drags beneath a storm. */
  drawGust(arrow?: { x0: number; y0: number; x1: number; y1: number }): void {
    if (!arrow) {
      if (this.overlay.childElementCount) this.overlay.innerHTML = '';
      return;
    }
    const dx = arrow.x1 - arrow.x0;
    const dy = arrow.y1 - arrow.y0;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const hx = arrow.x1 - ux * 14;
    const hy = arrow.y1 - uy * 14;
    this.overlay.innerHTML =
      `<line x1="${arrow.x0}" y1="${arrow.y0}" x2="${hx}" y2="${hy}" class="nudge"/>` +
      `<polygon class="nudge-head" points="${arrow.x1},${arrow.y1} ${hx - uy * 8},${hy + ux * 8} ${hx + uy * 8},${hy - ux * 8}"/>`;
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

  /** @param stormReady 0..1 recharge of the summon control */
  update(nature: number, max: number, stormReady: number): void {
    this.fill.style.width = `${(nature / max) * 100}%`;
    this.val.textContent = String(Math.floor(nature));
    this.stormBtn.style.setProperty('--ready', String(Math.min(1, stormReady)));
    this.stormBtn.classList.toggle('ready', stormReady >= 1);
  }

  say(text: string, seconds = 5): void {
    this.hint.textContent = text;
    this.hint.style.opacity = '1';
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => (this.hint.style.opacity = '0'), seconds * 1000);
  }
}
