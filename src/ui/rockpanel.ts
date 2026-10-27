// The rock's knobs (round 96, the user: "it seems like small supports still support it in atlas is that a setting?"):
// fracture.ts ROCK's constants and a few materials' bear, live — a small panel, opened by its button, in the rock lab
// (?level=rocklab) or anywhere with ?rockpanel=1. What a value does: fracture.ts ROCK's comment. The page's address
// sets them too (?crush=, ?buckle=, ?bear=sand:0.1 …); what's in use is logged ([rock]) as it changes.

import { ROCK } from '../game/fracture';
import { MATERIALS } from '../world/materials';

const KNOBS: { key: keyof typeof ROCK; label: string; step: number }[] = [
  { key: 'BUCKLE', label: 'buckle (a leg: × I / L²)', step: 500 },
  { key: 'TENSILE', label: 'tensile (a leg: its pull)', step: 5 },
  { key: 'CRUSH', label: 'crush (a column bears, cells)', step: 25 },
  { key: 'SHEAR', label: 'shear (a joint: × overlap)', step: 1 },
  { key: 'BEND', label: 'bend (a joint: × overlap²)', step: 0.5 },
  { key: 'TIP_GIVE', label: 'tip give (cells)', step: 0.05 },
  { key: 'NECK_R', label: 'neck reach (columns)', step: 1 },
];
const BEAR_MATS = ['sand', 'soil', 'rubble', 'snow'];

export class RockPanel {
  constructor(root: HTMLElement) {
    const btn = document.createElement('button');
    btn.textContent = 'rock';
    btn.style.cssText = 'position:fixed;left:8px;bottom:88px;z-index:30;pointer-events:auto;font:12px sans-serif;padding:6px 10px;border-radius:8px;border:0;background:#2b2f33cc;color:#eee';
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:8px;bottom:124px;z-index:30;pointer-events:auto;display:none;font:12px sans-serif;color:#eee;background:#22262acc;padding:8px;border-radius:8px;max-width:240px';
    const row = (label: string, value: number, step: number, set: (v: number) => void) => {
      const l = document.createElement('label');
      l.style.cssText = 'display:flex;justify-content:space-between;gap:6px;margin:2px 0';
      l.textContent = label;
      const i = document.createElement('input');
      i.type = 'number';
      i.step = String(step);
      i.value = String(value);
      i.style.cssText = 'width:64px';
      i.addEventListener('change', () => {
        const v = Number(i.value);
        if (!Number.isFinite(v)) return;
        set(v);
        log();
      });
      l.appendChild(i);
      el.appendChild(l);
    };
    for (const k of KNOBS) row(k.label, ROCK[k.key], k.step, (v) => (ROCK[k.key] = v));
    for (const name of BEAR_MATS) {
      const m = MATERIALS.find((d) => d.name === name);
      if (m) row(`bear: ${name}`, m.bear ?? 0.2, 0.05, (v) => (m.bear = v));
    }
    const log = () => console.info(`[rock] ${JSON.stringify(ROCK)} bear ${JSON.stringify(Object.fromEntries(BEAR_MATS.map((n) => [n, MATERIALS.find((d) => d.name === n)?.bear])))}`);
    btn.addEventListener('click', () => (el.style.display = el.style.display === 'none' ? 'block' : 'none'));
    root.appendChild(btn);
    root.appendChild(el);
    log();
  }
}
