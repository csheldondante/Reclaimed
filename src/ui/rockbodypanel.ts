// (round 95) The rigid rock's knobs (game/rockbodies.ts RB) as sliders, for the user to tune in the rock lab
// (`level=rocklab&rockbody=1`): a small fold-out panel at the top left. Changes apply at once; the URL line under
// them is what to paste to keep them (rbgrav=…&rbrest=…).

import { RB } from '../game/rockbodies';

const KNOBS: { k: keyof typeof RB; url: string; label: string; min: number; max: number; step: number }[] = [
  { k: 'gravity', url: 'rbgrav', label: 'gravity ×', min: 0.2, max: 4, step: 0.1 },
  { k: 'restitution', url: 'rbrest', label: 'bounce', min: 0, max: 0.9, step: 0.05 },
  { k: 'friction', url: 'rbfric', label: 'friction', min: 0, max: 1.5, step: 0.05 },
  { k: 'breakSpeed', url: 'rbbreak', label: 'break speed', min: 1, max: 30, step: 0.5 },
  { k: 'angDamp', url: 'rbdamp', label: 'spin damping', min: 0, max: 3, step: 0.05 },
  { k: 'maxBodies', url: 'rbmax', label: 'max bodies', min: 1, max: 40, step: 1 },
  { k: 'tipSpin', url: 'rbspin', label: 'tip spin', min: 0, max: 3, step: 0.05 },
  { k: 'maxV', url: 'rbmaxv', label: 'top speed', min: 2, max: 40, step: 1 },
  { k: 'scatter', url: 'rbscatter', label: 'scatter', min: 0, max: 1, step: 0.05 },
  { k: 'contactDamp', url: 'rbcdamp', label: 'ground damping', min: 0, max: 6, step: 0.1 },
  { k: 'sizeK', url: 'rbsize', label: 'big is weak', min: 0, max: 0.6, step: 0.05 },
  { k: 'crumble', url: 'rbcrumble', label: 'crumble ×', min: 0.5, max: 3, step: 0.1 },
  { k: 'cubes', url: 'rbcubes', label: 'show cubes', min: 0, max: 1, step: 1 },
];

export function mountRockPanel(parent: HTMLElement, stats: () => string): void {
  const box = document.createElement('details');
  box.style.cssText =
    'position:absolute;left:8px;top:64px;z-index:20;background:rgba(20,18,16,0.82);color:#eee;font:12px system-ui,sans-serif;padding:6px 8px;border-radius:6px;max-width:220px;pointer-events:auto';
  const sum = document.createElement('summary');
  sum.textContent = 'rock bodies';
  sum.style.cursor = 'pointer';
  box.appendChild(sum);
  const url = document.createElement('div');
  url.style.cssText = 'font:10px monospace;word-break:break-all;opacity:0.8;margin-top:4px;user-select:all';
  const info = document.createElement('div');
  info.style.cssText = 'font:10px monospace;opacity:0.8;margin-top:2px';
  const showUrl = () => (url.textContent = KNOBS.map((o) => `${o.url}=${RB[o.k]}`).join('&'));
  for (const o of KNOBS) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;margin:3px 0';
    const name = document.createElement('span');
    name.style.cssText = 'flex:0 0 78px';
    name.textContent = o.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(o.min);
    input.max = String(o.max);
    input.step = String(o.step);
    input.value = String(RB[o.k]);
    input.style.cssText = 'flex:1;min-width:0';
    const val = document.createElement('span');
    val.style.cssText = 'flex:0 0 30px;text-align:right';
    val.textContent = String(RB[o.k]);
    input.addEventListener('input', () => {
      RB[o.k] = Number(input.value);
      val.textContent = input.value;
      showUrl();
    });
    // (the panel's own presses don't reach the world)
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) row.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    row.append(name, input, val);
    box.appendChild(row);
  }
  for (const ev of ['pointerdown', 'touchstart', 'wheel']) box.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  showUrl();
  box.append(url, info);
  setInterval(() => {
    if (box.open) info.textContent = stats();
  }, 500);
  parent.appendChild(box);
}
