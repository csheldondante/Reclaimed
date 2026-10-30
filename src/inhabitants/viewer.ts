// The inhabitants viewer (round 117; DECISIONS r117 part 4: "Editor" means a VIEWER page per generator — seed, a
// few parameters, turn and zoom — "just having a way to view that sounds great"). `?skipmenu=1&level=bestiary&life=viewer`
// (or `&life=viewer` on any level, the atlas too): pick a body plan, tweak it, see it idle, walk, run or fly on the
// terrain round the camera; or a herd and a predator, or a flock. The camera pans and zooms as the level's always do.
// Inline styles on purpose: the panel is one file a phone can use (big touch targets, a bottom sheet that folds).

import type { BodyPlan, SpeciesSpec } from '../api/contracts/inhabitants';
import type { V2 } from '../api/contracts/units';
import type { WorldCore } from '../scenes/world-core';
import type { InhabitantsGpu } from './system';
import { PRESETS, SPECIES, type PresetName } from './species';

type Gait = 'idle' | 'walk' | 'run' | 'fly';

const SLIDERS: { key: keyof NonNullable<SpeciesSpec['proportions']> | 'fur' | 'seed'; label: string; min: number; max: number; step: number }[] = [
  { key: 'size', label: 'size', min: 0.2, max: 3, step: 0.05 },
  { key: 'legs', label: 'legs', min: 0.4, max: 2, step: 0.05 },
  { key: 'body', label: 'body', min: 0.4, max: 2, step: 0.05 },
  { key: 'girth', label: 'girth', min: 0.5, max: 2, step: 0.05 },
  { key: 'neck', label: 'neck', min: 0.2, max: 2, step: 0.05 },
  { key: 'head', label: 'head', min: 0.5, max: 2, step: 0.05 },
  { key: 'tail', label: 'tail', min: 0, max: 2.5, step: 0.05 },
  { key: 'wings', label: 'wings', min: 0.5, max: 2, step: 0.05 },
  { key: 'segments', label: 'segments', min: 1, max: 20, step: 1 },
  { key: 'fur', label: 'fur', min: 0, max: 1, step: 0.05 },
  { key: 'seed', label: 'seed', min: 1, max: 99, step: 1 },
];

export function mountViewer(ui: HTMLElement, life: InhabitantsGpu, core: WorldCore, ground: (x: number, y: number) => number): { spec: () => SpeciesSpec } {
  const cam = core.camera;
  const centre = (): V2 => [cam.target[0], cam.target[1]];
  let preset: PresetName = 'deer';
  let spec: SpeciesSpec = structuredClone(SPECIES[preset]);
  let gait: Gait = 'walk';
  let scene: 'one' | 'herd' | 'flock' = 'one';
  let groups: number[] = [];
  let at: V2 = centre();
  void ground;
  cam.zoom = Math.max(cam.zoom, 26);

  const panel = document.createElement('div');
  panel.className = 'life-viewer';
  Object.assign(panel.style, {
    position: 'absolute', left: '8px', bottom: '8px', zIndex: '30', width: 'min(330px, calc(100vw - 16px))', maxHeight: '46vh', overflowY: 'auto',
    background: 'rgba(20,22,28,0.86)', color: '#eee', font: '13px system-ui, sans-serif', borderRadius: '10px', padding: '8px 10px', boxSizing: 'border-box',
    touchAction: 'pan-y',
  } as CSSStyleDeclaration);
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:6px';
  head.innerHTML = '<span>Inhabitants</span>';
  const fold = button('–', () => {
    body.style.display = body.style.display === 'none' ? '' : 'none';
    fold.textContent = body.style.display === 'none' ? '+' : '–';
  });
  head.append(fold);
  const body = document.createElement('div');
  panel.append(head, body);
  ui.append(panel);

  const row = () => {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:4px 0';
    body.append(r);
    return r;
  };
  function button(label: string, on: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'min-width:44px;min-height:34px;padding:4px 8px;border-radius:6px;border:1px solid #556;background:#2c3140;color:#eee;font:inherit';
    b.onclick = (e) => {
      e.stopPropagation();
      on();
    };
    return b;
  }
  const mark = (bs: HTMLButtonElement[], on: HTMLButtonElement) => bs.forEach((b) => (b.style.background = b === on ? '#5a6a9a' : '#2c3140'));

  // species presets
  const pr = row();
  const presetBtns = PRESETS.map((p) => {
    const b = button(p, () => {
      preset = p;
      spec = structuredClone(SPECIES[p]);
      mark(presetBtns, b);
      syncSliders();
      respawn();
    });
    pr.append(b);
    return b;
  });
  mark(presetBtns, presetBtns[0]);
  // plan
  const planSel = document.createElement('select');
  planSel.style.cssText = 'min-height:34px;background:#2c3140;color:#eee;border:1px solid #556;border-radius:6px;font:inherit';
  for (const p of ['biped', 'quadruped', 'bird', 'serpent', 'insect', 'beast', 'winged'] as BodyPlan[]) planSel.append(new Option(p, p));
  planSel.onchange = () => {
    spec = { ...spec, plan: planSel.value as BodyPlan };
    respawn();
  };
  const colIn = document.createElement('input');
  colIn.type = 'color';
  colIn.style.cssText = 'width:44px;height:34px;border:none;background:none';
  colIn.oninput = () => {
    spec = { ...spec, palette: { ...spec.palette, body: colIn.value } };
    respawn();
  };
  const accIn = colIn.cloneNode() as HTMLInputElement;
  accIn.oninput = () => {
    spec = { ...spec, palette: { ...spec.palette, accent: accIn.value } };
    respawn();
  };
  const capeBtn = button('cape', () => {
    const has = spec.gear?.some((g) => g.slot === 'cape');
    spec = { ...spec, gear: has ? spec.gear!.filter((g) => g.slot !== 'cape') : [...(spec.gear ?? []), { slot: 'cape', colour: '#b03a2e' }] };
    respawn();
  });
  const r2 = row();
  r2.append(planSel, colIn, accIn, capeBtn);
  // gaits
  const r3 = row();
  const gaitBtns = (['idle', 'walk', 'run', 'fly'] as Gait[]).map((g) => {
    const b = button(g, () => {
      gait = g;
      mark(gaitBtns, b);
      if (scene !== 'one') scene = 'one';
      respawn();
    });
    r3.append(b);
    return b;
  });
  mark(gaitBtns, gaitBtns[1]);
  // scenes
  const r4 = row();
  r4.append(
    button('herd + predator', () => {
      scene = 'herd';
      respawn();
    }),
    button('flock', () => {
      scene = 'flock';
      respawn();
    }),
    button('here', () => {
      at = centre();
      respawn();
    }),
  );
  // sliders
  const inputs = new Map<string, HTMLInputElement>();
  for (const s of SLIDERS) {
    const r = document.createElement('label');
    r.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0';
    const t = document.createElement('span');
    t.textContent = s.label;
    t.style.width = '64px';
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = String(s.min);
    inp.max = String(s.max);
    inp.step = String(s.step);
    inp.style.flex = '1';
    const v = document.createElement('span');
    v.style.width = '34px';
    inp.oninput = () => {
      v.textContent = inp.value;
      const x = Number(inp.value);
      if (s.key === 'seed') spec = { ...spec, seed: x };
      else if (s.key === 'fur') spec = { ...spec, secondary: { ...spec.secondary, fur: x } };
      else spec = { ...spec, proportions: { ...spec.proportions, [s.key]: x } };
      respawn();
    };
    r.append(t, inp, v);
    body.append(r);
    inputs.set(s.key, inp);
  }
  const info = document.createElement('div');
  info.style.cssText = 'opacity:0.7;margin-top:4px';
  body.append(info);

  function syncSliders(): void {
    planSel.value = spec.plan;
    colIn.value = spec.palette.body;
    accIn.value = spec.palette.accent ?? '#333333';
    for (const s of SLIDERS) {
      const inp = inputs.get(s.key)!;
      const val = s.key === 'seed' ? (spec.seed ?? 1) : s.key === 'fur' ? (spec.secondary?.fur ?? 0) : (spec.proportions?.[s.key] ?? (s.key === 'segments' ? 12 : 1));
      inp.value = String(val);
      (inp.nextSibling as HTMLElement).textContent = String(val);
    }
  }

  let pending: ReturnType<typeof setTimeout> | null = null;
  function respawn(): void {
    // (sliders fire fast: the respawn waits for them to settle a little)
    if (pending) clearTimeout(pending);
    pending = setTimeout(doRespawn, 60);
  }
  function doRespawn(): void {
    pending = null;
    for (const g of groups) life.remove(g);
    groups = [];
    // (the one being tweaked is always the species 'viewer': the table has room for 16)
    const sp = life.define({ ...spec, id: 'viewer' });
    const rig = life.rig(sp);
    info.textContent = `${spec.plan}: ${rig.points.length} points, ${rig.segments.length} parts, ${rig.vertsPerAgent} vertices`;
    if (scene === 'one') {
      const g = life.spawnGroup(sp, [at[0] + 3, at[1]], 1, { spread: 0.1 });
      life.drive(g, { kind: 'pace', gait, around: at, radius: gait === 'fly' ? 6 : 4 });
      groups.push(g);
    } else if (scene === 'herd') {
      const prey = life.define(SPECIES.deer);
      const wolf = life.define(SPECIES.wolf);
      const h = life.spawnGroup(prey, [at[0] - 8, at[1] + 4], 10);
      life.drive(h, { kind: 'roam', around: [at[0] - 6, at[1] + 4], radius: 18 });
      const w = life.spawnGroup(wolf, [at[0] + 30, at[1] + 18], 3);
      life.drive(w, { kind: 'roam', around: [at[0] + 10, at[1] + 10], radius: 30 });
      groups.push(h, w);
    } else {
      const crow = life.define(SPECIES.crow);
      const g = life.spawnGroup(crow, at, 18);
      life.drive(g, { kind: 'roam', around: at, radius: 14 });
      groups.push(g);
    }
  }
  syncSliders();
  doRespawn();
  return { spec: () => spec };
}
