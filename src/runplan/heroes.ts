// ---- runplan/heroes.ts ------------------------------------------------------------------------------------------
// (round 117, runplan; runplay round 119: the HEROES stand-in table is gone) A hero's capabilities as the run manager
// reasons about them: play's profile (contracts/play.ts — the library's controllers, or WALKER_PROFILE for the heroes
// on foot) through the adapter (play-adapter.ts). The user (round 117): "parameterize it so we can reason about it
// during generation and make not only obstacles but fun ones."

import type { HeroCapabilities } from '../api/contracts/run';
import type { BarrierKind } from '../api/contracts/terrain';
import { WALKER_PROFILE, type ControllerProfile } from '../api/contracts/play';
import { library } from '../play/library';
import { capsFromProfile } from './play-adapter';
import { BARRIER_RANK } from './graph';

/**
 * The roles a run can be planned for, and the play controller each is (role → controller id). 'bike' is runplan's
 * older name for the hoverbike. The knight (delving) and the wanderer walk: the walker's profile stands in until play
 * ports the knight (BACKLOG PL5).
 */
export const ROLES: Record<string, string> = { hoverbike: 'hoverbike', bike: 'hoverbike', lich: 'lich', knight: 'walker', wanderer: 'walker' };

/** a role's controller profile (an unknown role is the caller's bug: no silent fallback) */
export function heroProfile(role: string, params?: Record<string, number>): ControllerProfile {
  const id = ROLES[role];
  if (!id) throw new Error(`runplan: no capabilities for hero "${role}" (have ${Object.keys(ROLES).join(', ')})`);
  if (id === 'walker') return WALKER_PROFILE;
  const c = library.get(id);
  if (!c) throw new Error(`runplan: play's library has no controller "${id}" for hero "${role}"`);
  return c.profile(params);
}

/** a hero's capabilities by role */
export function heroCaps(role: string): HeroCapabilities {
  return capsFromProfile(role, heroProfile(role));
}

/**
 * How much a border costs this hero: a multiplier on the travel time (1 easy), or 0 when it can't pass. A road's
 * crossing makes any barrier but the open sea easy (a bridge, a pass). A barrier the capabilities don't name: soft
 * ones (ranked under a ravine) cost 2, hard ones stop it — the controller didn't say it can.
 */
export function borderCost(h: HeroCapabilities, barrier: BarrierKind | null, crossing: string | null): number {
  if (!barrier || barrier === 'open') return 1;
  if (crossing && barrier !== 'sea') return 1;
  if (crossing === 'bridge') return 1;
  const p = h.passes[barrier];
  if (p !== undefined) return p;
  return BARRIER_RANK[barrier] < BARRIER_RANK.ravine ? 2 : 0;
}
