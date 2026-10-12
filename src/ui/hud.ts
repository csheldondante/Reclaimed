// Minimal HUD (DECISIONS 2026-10-07): no tool buttons — interaction is by
// gesture on the world. Round 27: no Nature meter or summon button either
// (storms are raised by swirling over water); what's left is the living-land
// bar, the life lens and hints.

const NS = 'http://www.w3.org/2000/svg';

export class Hud {
  private hint: HTMLElement;
  private hintTimer = 0;
  private bolts: SVGSVGElement;
  private hudEl: HTMLElement;
  private reclaim: HTMLElement;

  /** @param onLens hold-to-see life lens (the touch stand-in for Space) */
  constructor(root: HTMLElement, onLens: (on: boolean) => void = () => undefined) {
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <button class="lens" title="Hold to see what keeps life out (Space)"><span>◎</span></button>`;
    root.appendChild(hud);
    this.hudEl = hud;
    // how much of the land is alive, with the level goal marked
    this.reclaim = document.createElement('div');
    this.reclaim.className = 'reclaim';
    this.reclaim.title = 'Living land — the valley is reclaimed when it reaches the mark';
    this.reclaim.innerHTML = '<span>❧</span><div class="track"><div class="fill"></div><div class="goal"></div></div><span class="pct"></span>';
    root.appendChild(this.reclaim);
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

  /**
   * A jagged arc between two screen points (lightning chaining from where it
   * struck to near the cursor; round 20), with a small fork.
   */
  arc(x0: number, y0: number, x1: number, y1: number): void {
    const pts: [number, number][] = [];
    const steps = 10;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const nx = -(y1 - y0) / Math.max(len, 1);
    const ny = (x1 - x0) / Math.max(len, 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const j = i === 0 || i === steps ? 0 : (Math.random() - 0.5) * Math.min(40, len * 0.25);
      pts.push([x0 + (x1 - x0) * t + nx * j, y0 + (y1 - y0) * t + ny * j]);
    }
    const d = pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'bolt');
    g.innerHTML = `<polyline points="${d}" class="bolt-glow"/><polyline points="${d}" class="bolt-core"/>`;
    const [fx, fy] = pts[3 + Math.floor(Math.random() * 4)];
    let fpts = `${fx},${fy}`;
    let px = fx;
    let py = fy;
    for (let i = 0; i < 3; i++) {
      px += (Math.random() - 0.5) * 30;
      py += 10 + Math.random() * 14;
      fpts += ` ${px.toFixed(1)},${py.toFixed(1)}`;
    }
    g.innerHTML += `<polyline points="${fpts}" class="bolt-core" style="stroke-width:1"/>`;
    this.bolts.appendChild(g);
    setTimeout(() => g.remove(), 700);
  }

  private windWord?: HTMLElement;
  private shownTier = 0;

  /** The player's painted wind: 0 none, 1 breeze, 2 gust, 3 gale (fades out). */
  setWind(tier: number): void {
    if (tier === this.shownTier) return;
    this.shownTier = tier;
    if (!this.windWord) {
      this.windWord = document.createElement('div');
      this.windWord.className = 'wind-word';
      this.hudEl.appendChild(this.windWord);
    }
    const el = this.windWord;
    if (tier > 0) el.textContent = ['', 'breeze', 'gust', 'gale'][Math.min(3, tier)];
    el.dataset.tier = String(tier);
    el.classList.toggle('on', tier > 0);
  }

  /** @param frac reclamation 0..1; @param goal level threshold (shown at 80 % of the track) */
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
