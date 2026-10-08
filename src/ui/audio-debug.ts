// Audio debug panel (round 11, `?audio=1`): every continuous voice with its
// live level and a mute box, and a log of recent one-shots (also mutable by
// name). For finding sounds the user dislikes — an agent can't hear them.

import type { Ambience } from '../audio/ambience';

export class AudioDebug {
  private el: HTMLElement;

  constructor(root: HTMLElement, private audio: Ambience) {
    this.el = document.createElement('div');
    this.el.className = 'audio-debug';
    root.appendChild(this.el);
    this.el.addEventListener('change', (e) => {
      const box = e.target as HTMLInputElement;
      if (box.dataset.name) audio.setMuted(box.dataset.name, !box.checked);
    });
    setInterval(() => this.render(), 250);
  }

  private render(): void {
    const d = this.audio.debug;
    const row = (name: string, extra: string) =>
      `<label><input type="checkbox" data-name="${name}" ${d.muted.has(name) ? '' : 'checked'}> ${name}${extra}</label>`;
    const voices = [...d.voices.entries()]
      .map(([name, v]) => {
        const g = v.level.gain.value;
        const db = g > 1e-5 ? Math.round(20 * Math.log10(g)) : -99;
        const bar = '▮'.repeat(Math.max(0, Math.min(12, Math.round((db + 60) / 5))));
        return row(name, ` <span class="lvl">${db > -99 ? db + ' dB' : '—'} ${bar}</span>`);
      })
      .join('');
    const now = performance.now() / 1000;
    const seen = new Set<string>();
    const shots = [...d.log]
      .reverse()
      .filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)))
      .map((e) => row(e.name, ` <span class="lvl">${(now - e.t).toFixed(1)} s ago${e.n > 1 ? ' ×' + e.n : ''}</span>`))
      .join('');
    if (this.el.contains(document.activeElement)) return; // don't rebuild under the cursor
    this.el.innerHTML = `<b>continuous</b>${voices}<b>one-shots</b>${shots || '<i>none yet</i>'}`;
  }
}
