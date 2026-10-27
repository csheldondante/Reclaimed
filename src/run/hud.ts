// ---- run/hud.ts ----------------------------------------------------------------
// What to do now (round 83): the run's shown objectives, top left, small enough for a phone. A new one slides
// in; a done one is ticked and struck through, then leaves; a failed one is crossed out, then leaves. It reads
// the run through its API only (objectives(), onObjective).

import type { StoryRun } from './run';
import './hud.css';

export class ObjectiveHud {
  private el: HTMLDivElement;
  private rows = new Map<string, HTMLDivElement>();
  /** seconds a done or failed objective stays */
  linger = 4;

  constructor(
    root: HTMLElement,
    private run: StoryRun,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'objectives';
    this.el.setAttribute('aria-live', 'polite');
    root.append(this.el);
    for (const o of run.objectives()) if (o.state === 'shown') this.show(o.id);
    run.onObjective.push((id, state) => (state === 'shown' ? this.show(id) : this.finish(id, state)));
  }

  dispose(): void {
    this.el.remove();
  }

  /** (round 94) a line under a shown objective: where to go (null: none). Writes the DOM only when it changes. */
  hint(id: string, text: string | null): void {
    const row = this.rows.get(id);
    if (!row) return;
    let h = row.querySelector('.hint') as HTMLSpanElement | null;
    if (text === null) return void h?.remove();
    if (!h) {
      h = document.createElement('span');
      h.className = 'hint';
      row.querySelector('.text')!.append(h);
    }
    if (h.textContent !== text) h.textContent = text;
  }

  private show(id: string): void {
    if (this.rows.has(id)) return;
    const o = this.run.objective(id);
    const row = document.createElement('div');
    row.className = 'objective';
    row.innerHTML = '<span class="mark"></span><span class="text"></span>';
    row.querySelector('.text')!.textContent = o.text;
    this.el.append(row);
    this.rows.set(id, row);
    requestAnimationFrame(() => row.classList.add('in'));
  }

  private finish(id: string, state: 'done' | 'failed'): void {
    // (done before it was ever shown: shown as done, then gone)
    if (!this.rows.has(id)) this.show(id);
    const row = this.rows.get(id)!;
    row.classList.add(state);
    setTimeout(() => {
      row.classList.remove('in');
      setTimeout(() => row.remove(), 400);
      this.rows.delete(id);
    }, this.linger * 1000);
  }
}
