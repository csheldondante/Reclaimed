// (living town, docs/design/LIVING_TOWN.md) The living town's parameters: one registry (the tuning editor's shell, as
// the street lab's), set from the address (?lt.<key>=… or ?<key>=… for the quarry's and the clearing's) and the panel.
// Everything here is an input the CPU passes in the parameters' uniform; nothing is decided on the CPU.
import { Registry, type ParamSpec } from '../tune/registry';

const people: Record<string, ParamSpec> = {
  commuters: { label: 'commuters', units: '', min: 0, max: 3000, step: 10, def: 600, help: 'home → market or workshops (a few to the gates) → home' },
  farmers: { label: 'farmers', units: '', min: 0, max: 1000, step: 10, def: 150, help: 'home → a farm → the granary with a sack → home' },
  quarrymen: { label: 'quarrymen', units: '', min: 0, max: 400, step: 5, def: 60, help: 'home → the quarry → down the ramp → dig at the face' },
  stoneCarts: { label: 'stone carts', units: '', min: 0, max: 400, step: 5, def: 40, help: 'the stores → the face → a load of stone → the stores’ stockpile' },
  woodcutters: { label: 'woodcutters', units: '', min: 0, max: 400, step: 5, def: 40, help: 'home → the camp → fell a tree → logs to the camp' },
  logCarts: { label: 'log carts', units: '', min: 0, max: 400, step: 5, def: 20, help: 'the camp’s logs → the stores' },
  wagons: { label: 'wagons', units: '', min: 0, max: 200, step: 1, def: 0, help: '(season life) a trade route: in through a gate, unload at a shop, out again, away a while' },
  ships: { label: 'ships', units: '', min: 0, max: 40, step: 1, def: 0, help: '(season life) a trade route by water: in from the box’s edge to the harbour’s quays, moored, out again' },
  builders: { label: 'builders', units: '', min: 0, max: 400, step: 5, def: 40, help: 'the stores → a building site (a lot rising: progress between 0 and 1) → work → back' },
  walk: { label: 'walking speed', units: 'm/s', min: 0.5, max: 6, step: 0.1, def: 1.4 },
  cart: { label: 'cart speed', units: 'm/s', min: 0.5, max: 8, step: 0.1, def: 2.2 },
  work: { label: 'work time', units: 's', min: 1, max: 120, step: 1, def: 14, help: 'a stop at work, at home, at a face' },
  spread: { label: 'spread across a road', units: 'm', min: 0, max: 2, step: 0.05, def: 0.7, help: 'each rider’s own offset off the route’s line (no lanes yet)' },
  speed: { label: 'time', units: '×', min: 0, max: 20, step: 0.5, def: 1, help: 'the living town’s clock (1: the world’s)' },
};
const quarry: Record<string, ParamSpec> = {
  on: { label: 'quarry', units: '', min: 0, max: 1, step: 1, def: 1, choices: ['off', 'on'] },
  side: { label: 'footprint', units: 'm', min: 12, max: 80, step: 2, def: 36, help: 'the pit’s side (a square; set at the site’s pick)' },
  bench: { label: 'bench height', units: 'm', min: 1, max: 8, step: 0.5, def: 3 },
  depth: { label: 'depth', units: 'm', min: 3, max: 60, step: 1, def: 18 },
  slope: { label: 'wall slope', units: '°', min: 30, max: 80, step: 1, def: 62, help: 'each bench’s face' },
  ledge: { label: 'ledge', units: 'm', min: 1, max: 8, step: 0.5, def: 3, help: 'each bench’s flat (the ramp runs on it)' },
  digRate: { label: 'dig rate', units: 'm³/s', min: 0.02, max: 5, step: 0.02, def: 0.5, help: 'a quarryman at the face' },
  load: { label: 'cart load', units: 'm³', min: 0.1, max: 4, step: 0.1, def: 1 },
};
const forest: Record<string, ParamSpec> = {
  on: { label: 'clearing', units: '', min: 0, max: 1, step: 1, def: 1, choices: ['off', 'on'] },
  radius: { label: 'clearing radius', units: 'm', min: 4, max: 60, step: 1, def: 24 },
  cut: { label: 'cut time', units: 's', min: 1, max: 60, step: 0.5, def: 6, help: 'a woodcutter at a tree' },
  replant: { label: 'replant', units: '', min: 0, max: 1, step: 1, def: 0, choices: ['off', 'on'], help: 'on: a stump is young woods again after the regrow time' },
  regrow: { label: 'regrow time', units: 's', min: 10, max: 900, step: 10, def: 120 },
};
/** (the street skeleton: citygen's own parameters, citygen/params.ts — set on every field town from here) */
const roads: Record<string, ParamSpec> = {
  skelReach: { label: 'main roads shown', units: '', min: 0, max: 2, step: 1, def: 1, choices: ['with their districts', 'districts begun + a margin', 'everywhere'] },
  skelMargin: { label: 'main roads’ margin', units: 'supercells', min: 0, max: 4, step: 0.25, def: 1 },
  minorAhead: { label: 'minor streets ahead', units: '', min: 0, max: 1, step: 1, def: 0, choices: ['with their buildings', 'with the main roads'] },
};
const graph: Record<string, ParamSpec> = {
  sweeps: { label: 'relax sweeps a frame', units: '', min: 2, max: 128, step: 2, def: 32, help: 'while the hubs’ fields settle (none once settled)' },
};

export const LIVING_TUNING = new Registry({
  people: { title: 'People', owner: 'citylife/routes.wgsl', params: people },
  quarry: { title: 'Quarry', owner: 'citylife/works.wgsl', params: quarry },
  forest: { title: 'Clearing', owner: 'citylife/works.wgsl', params: forest },
  roads: { title: 'Shown roads', owner: 'citygen/streets.wgsl', params: roads },
  graph: { title: 'Routes', owner: 'citylife/routes.wgsl', params: graph },
});
export type LivingValues = typeof LIVING_TUNING.values;

/** ?lt.<group>.<key>= or the short forms (?qside=, ?qbench=, ?qdepth=, ?qslope=, ?qrate=, ?fradius=, ?fcut=,
 *  ?freplant=, ?riders=N — scales every count) */
export function livingFromUrl(q: URLSearchParams): void {
  for (const [k, v] of q) {
    if (k.startsWith('lt.')) LIVING_TUNING.set(k.slice(3), Number(v));
  }
  const short: Record<string, string> = { skel: 'roads.skelReach', skelmargin: 'roads.skelMargin', minorahead: 'roads.minorAhead', qside: 'quarry.side', qbench: 'quarry.bench', qdepth: 'quarry.depth', qslope: 'quarry.slope', qrate: 'quarry.digRate', qledge: 'quarry.ledge', fradius: 'forest.radius', fcut: 'forest.cut', freplant: 'forest.replant', ltspeed: 'people.speed' };
  for (const [k, id] of Object.entries(short)) {
    const v = q.get(k);
    if (v !== null) LIVING_TUNING.set(id, Number(v));
  }
  const n = q.get('riders');
  if (n !== null) {
    const p = LIVING_TUNING.values.people;
    const keys = ['commuters', 'farmers', 'quarrymen', 'stoneCarts', 'woodcutters', 'logCarts', 'builders'] as const;
    const tot = keys.reduce((s, k) => s + p[k], 0);
    for (const k of keys) LIVING_TUNING.set(`people.${k}`, Math.round((p[k] * Number(n)) / tot));
  }
}
