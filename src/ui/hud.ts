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
  private bolts: SVGSVGElement;
  private hudEl: HTMLElement;
  private reclaim: HTMLElement;

  /** @param onLens hold-to-see life lens (the touch stand-in for Space) */
  constructor(root: HTMLElement, onSummon: () => void, onLens: (on: boolean) => void = () => undefined) {
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="nature" title="Nature — regenerates from living, healthy land">
        <span>❦</span><div class="bar"><div class="fill"></div></div><span class="val"></span>
      </div>
      <button class="summon" title="Summon a storm (R)"><span>☁</span></button>
      <button class="lens" title="Hold to see what keeps life out (Space)"><span>◎</span></button>`;
    root.appendChild(hud);
    this.hudEl = hud;
    // how much of the land is alive, with the level goal marked
    this.reclaim = document.createElement('div');
    this.reclaim.className = 'reclaim';
    this.reclaim.title = 'Living land — the valley is reclaimed when it reaches the mark';
    this.reclaim.innerHTML = '<span>❧</span><div class="track"><div class="fill"></div><div class="goal"></div></div><span class="pct"></span>';
    root.appendChild(this.reclaim);
    this.fill = hud.querySelector('.fill')!;
    this.val = hud.querySelector('.val')!;
    this.stormBtn = hud.querySelector('.summon')!;
    this.stormBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSummon();
    });
    const lensBtn = hud.querySelector('.lens') as HTMLButtonElement;
    const lensOff = () => onLens(false);
    lensBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      onLens(true);
    });
    lensBtn.addEventListener('pointerup', lensOff);
    lensBtn.addEventListener('pointercancel', lensOff);
    lensBtn.addEventListener('pointerleave', lensOff);
    this.hint = document.createElement('div');
    this.hint.className = 'hint';
    this.hint.style.opacity = '0';
    root.appendChild(this.hint);
    this.bolts = document.createElementNS(NS, 'svg');
    this.bolts.setAttribute('class', 'overlay');
    root.appendChild(this.bolts);
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
  /** @param rate Nature's net change per second (negative = the land is suffering) */
  update(nature: number, max: number, stormReady: number, rate = 0): void {
    this.fill.style.width = `${(nature / max) * 100}%`;
    this.hudEl.querySelector('.nature')!.classList.toggle('draining', rate < 0);
    this.val.textContent = String(Math.floor(nature));
    this.stormBtn.style.setProperty('--ready', String(Math.min(1, stormReady)));
    this.stormBtn.classList.toggle('ready', stormReady >= 1);
  }

  /** @param frac living fraction of the land; @param goal level threshold (shown at 80 % of the track) */
  setReclaim(frac: number, goal: number): void {
    const shown = Math.min(1.25, frac / goal) * 0.8;
    (this.reclaim.querySelector('.fill') as HTMLElement).style.width = `${(shown * 100).toFixed(1)}%`;
    (this.reclaim.querySelector('.pct') as HTMLElement).textContent = `${Math.round((frac / goal) * 100)}%`;
    this.reclaim.classList.toggle('done', frac >= goal);
  }

  dispose(): void {
    for (const el of [this.hudEl, this.hint, this.bolts, this.reclaim]) el.remove();
    clearTimeout(this.hintTimer);
  }

  say(text: string, seconds = 5): void {
    this.hint.textContent = text;
    this.hint.style.opacity = '1';
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => (this.hint.style.opacity = '0'), seconds * 1000);
  }
}
