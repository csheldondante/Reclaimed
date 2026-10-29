// ---- hero/tunables.ts -----------------------------------------------------------
// (round 112, herosandbox) A hero's numbers as a tuning registry (src/tune/registry.ts), so the tuning panel shows
// them as sliders with presets, export and copyable strings: its chase camera (HeroCamera: zoom, behind, firm —
// the angles in degrees here, radians in the contract) and whatever it offers as Hero.tunables. The registry is a
// per-use copy made at the boundary: a slider moved sets the hero's own value through its tunable's `set`; the
// hero's value stays the truth.

import type { Hero } from '../api/contracts/hero';
import { Registry, type GroupSpec, type ParamSpec } from '../tune/registry';

const DEG = 180 / Math.PI;

export interface HeroTuning {
  registry: Registry<Record<string, GroupSpec>>;
  /** stop pushing slider moves to the hero */
  dispose(): void;
}

/** the sandbox's own follow (not the hero's): how fast the camera catches the hero up */
export const FOLLOW = { rate: 6 };

export function heroTuning(hero: Hero): HeroTuning {
  const cam = hero.camera;
  const spec: Record<string, GroupSpec> = {
    camera: {
      title: `Camera (${hero.role})`,
      owner: 'Hero.camera (contracts/hero.ts HeroCamera) — the sandbox frames the hero by it',
      params: {
        zoom: { label: 'zoom', units: 'px/cell', min: 2, max: 60, step: 0.5, def: clampDef(cam.zoom, 2, 60), help: 'screen px a world unit (the level\'s zoom)' },
        behind: { label: 'behind', units: '°', min: 0, max: 180, step: 1, def: clampDef(cam.behind * DEG, 0, 180), help: 'either side of straight behind its heading the view may drift before it is drawn back (Orbit.prefer.dead)' },
        firm: { label: 'firm', units: '°', min: 0, max: 180, step: 1, def: clampDef((cam.firm ?? cam.behind * 2) * DEG, 0, 180), help: 'past this the pull is twice as firm (Orbit.prefer.firm)' },
        follow: { label: 'follow rate', units: '1/s', min: 0.5, max: 30, step: 0.5, def: FOLLOW.rate, help: 'the sandbox\'s: how fast the camera catches the hero up' },
      },
    },
  };
  const own = hero.tunables ?? {};
  if (Object.keys(own).length) {
    const params: Record<string, ParamSpec> = {};
    for (const [k, t] of Object.entries(own)) params[k] = { label: t.label, units: t.units ?? '', min: t.min, max: t.max, step: t.step, def: clampDef(t.get(), t.min, t.max), help: t.help };
    spec.hero = { title: `Hero: ${hero.role}`, owner: `Hero.tunables (${hero.role})`, params };
  }
  const registry = new Registry(spec);
  const push = (id: string) => {
    const v = registry.get(id);
    const [g, k] = id.split('.');
    if (g === 'camera') {
      if (k === 'zoom') cam.zoom = v;
      else if (k === 'behind') cam.behind = v / DEG;
      else if (k === 'firm') cam.firm = v / DEG;
      else if (k === 'follow') FOLLOW.rate = v;
    } else own[k].set(v);
  };
  const off = registry.onChange((id) => {
    if (id) push(id);
    else for (const d of registry.defs) push(d.id);
  });
  return { registry, dispose: off };
}

/** a hero's value as a registry's default: inside its range (a hero whose value is out of its own range is told so) */
function clampDef(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) throw new Error(`hero tunable: ${v} is not a number`);
  if (v < min || v > max) console.warn(`[hero] a tunable's value ${v} is outside its range [${min}, ${max}]: shown clamped`);
  return Math.min(max, Math.max(min, v));
}
