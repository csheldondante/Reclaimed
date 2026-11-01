// ---- play/lab/handling.ts ---------------------------------------------------------------------------------------
// (round 120, the user on the hero lab; BACKLOG PL30) The bike's handling as variants: turn acceleration (grip) and
// turn rate, and the steering assist's three helpers (core/steer.ts: the corridor, small-obstacle avoidance, target
// magnetism), each a chip that turns it on at a starting strength and a slider to tune it. The player's intent wins:
// the assist only fills in a light stick.

import type { Params } from '../../api/contracts/play';
import { Registry } from '../../tune/registry';
import { STEER_OFF, type SteerParams } from '../core/steer';

export const HANDLING_SPEC = {
  turn: {
    title: 'Bike turning',
    owner: 'play/core/bike.ts stepBike (grip, turnRate: the bike\'s own parameters)',
    params: {
      grip: { label: 'grip', units: 'cells/s²', min: 0, max: 200, step: 1, def: 0, help: 'sideways acceleration swinging its way toward the stick (0: the bike as it was)' },
      turnRate: { label: 'turn rate', units: 'rad/s', min: 0.5, max: 12, step: 0.1, def: 6, help: 'the most the grip swings its way a second' },
    },
  },
  assist: {
    title: 'Steering assist (the player first)',
    owner: 'play/core/steer.ts steerAssist (PlaySession, the bike only)',
    params: {
      corridor: { label: 'corridor', units: '0..1', min: 0, max: 1, step: 0.05, def: 0, help: 'bend a light stick toward the open way in narrow places' },
      look: { label: 'corridor ahead', units: 's', min: 0.2, max: 2, step: 0.05, def: 0.6 },
      fan: { label: 'corridor fan', units: '°', min: 10, max: 90, step: 5, def: 50 },
      avoid: { label: 'avoid small', units: '0..1', min: 0, max: 1, step: 0.05, def: 0, help: 'nudge round rocks and posts that would stop it dead' },
      avoidLook: { label: 'avoid ahead', units: 's', min: 0.1, max: 1, step: 0.05, def: 0.35 },
      small: { label: 'small is', units: 'cells', min: 0.5, max: 6, step: 0.25, def: 2.5, help: 'an obstacle no wider than this either side is gone round' },
      magnet: { label: 'target magnet', units: '0..1', min: 0, max: 1, step: 0.05, def: 0, help: 'lean toward a foe in the cone ahead (core/aim.ts, the weapons\' aim)' },
      magnetCone: { label: 'magnet cone', units: '°', min: 5, max: 60, step: 1, def: 25 },
      magnetRange: { label: 'magnet range', units: 'cells', min: 3, max: 40, step: 1, def: 14 },
      strong: { label: 'strong steer', units: '°', min: 5, max: 90, step: 1, def: 35, help: 'a stick this far off the way it goes overrides the assist at once' },
      maxBend: { label: 'bend at most', units: '°', min: 5, max: 90, step: 1, def: 40 },
    },
  },
};

export const HANDLING = new Registry(HANDLING_SPEC);

export type HandlingId = 'stock' | 'grip' | 'corridor' | 'avoid' | 'magnet';

/** the variants as chips: each turns its helper on at a starting strength (stock: all off) */
export const HANDLING_VARIANTS: { id: HandlingId; icon: string; label: string; hint: string; set: Record<string, number> }[] = [
  { id: 'stock', icon: '🏍', label: 'stock', hint: 'the bike as it is: no grip, no assist', set: { 'turn.grip': 0, 'assist.corridor': 0, 'assist.avoid': 0, 'assist.magnet': 0 } },
  { id: 'grip', icon: '↪', label: 'grip', hint: 'turn acceleration: the velocity swung toward the stick (grip 70, 6 rad/s)', set: { 'turn.grip': 70 } },
  { id: 'corridor', icon: '〰', label: 'flow', hint: 'the corridor: a light stick bent toward the open way in narrow places', set: { 'assist.corridor': 0.8 } },
  { id: 'avoid', icon: '🪨', label: 'avoid', hint: 'nudged round small things that would stop it dead', set: { 'assist.avoid': 1 } },
  { id: 'magnet', icon: '🧲', label: 'magnet', hint: 'leaned toward a foe ahead when attacking', set: { 'assist.magnet': 0.7 } },
];

/** the registry set to these variants (the others off) */
export function useHandling(reg: Registry<typeof HANDLING_SPEC>, ids: readonly HandlingId[]): void {
  reg.reset();
  for (const v of HANDLING_VARIANTS) if (ids.includes(v.id) && v.id !== 'stock') for (const [k, x] of Object.entries(v.set)) reg.set(k, x);
}

/** `?handling=grip+corridor` → the variants; absent: stock */
export function parseHandling(s: string | null | undefined): HandlingId[] {
  if (!s) return ['stock'];
  const out: HandlingId[] = [];
  for (const raw of s.split(/[+, ]+/).filter(Boolean)) {
    const v = HANDLING_VARIANTS.find((x) => x.id === raw || x.label === raw);
    if (!v) throw new Error(`?handling=${s}: no variant "${raw}" (${HANDLING_VARIANTS.map((x) => x.id).join(', ')})`);
    if (!out.includes(v.id)) out.push(v.id);
  }
  return out.length ? out : ['stock'];
}

/** the assist's numbers from the registry */
export function steerParams(v: typeof HANDLING.values): SteerParams {
  return { ...STEER_OFF, ...v.assist };
}

/** the bike's own turning numbers, onto its params */
export function applyTurn(v: typeof HANDLING.values, params: Params): void {
  params.grip = v.turn.grip;
  params.turnRate = v.turn.turnRate;
}
