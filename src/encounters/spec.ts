// ---- encounters/spec.ts ---------------------------------------------------------------------------------------------
// (round 126, `encounters`) What a situation's area plays as: its EncounterSpec (contracts/encounter.ts). The one place
// that decides it — the card that offers the area (living/horde.ts encounterOf reads its text from here) and the live
// play (live.ts) use the same spec, so a card can't promise a chase that plays as a ride to a flag.
// Why each area is what it is (the user, round 120 and round 126):
//   flee     the outriders on the hero's tail from the first second (a few cells back, riders as fast as most of the
//            hero's cruise): lose them (clear of every one for a few seconds) or cut them down. Caught, they swing.
//   ambush   a fight: foes across the road a screen ahead, at the hero at once; won when they're down or break.
//   deliver  "deliver a message before enemies arrive": a flee to the hall's gate with riders on the hero's tail and
//            more across the way; the gate is pointed at, the riders are the play.
//   trader   a scene: raiders round a trader, their chief talks as the hero comes up; what's said decides it — a fight,
//            they back down (before renown, or a hero they dread), or a toll paid.
//   chase    the quarry running a few cells ahead (PL23: "a chase starts close and already in pursuit"): cut it down
//            before it gets away.
//   rescue   an escort: break the guards on the captives, then lead them (follow me / hold here) to safety while riders
//            come for them.
//   scout    a fight: the patrol on the ridge must be broken before the host can be counted.
//   town     the finale: defend (or lead its people out); its own rules (runsit/finale.ts).
// A race needs an arena (jumps, crowds): none exists, so no area is one.

import type { Band, EncounterSpec } from '../api/contracts/encounter';
import type { SituationArea, SituationThreat } from '../api/contracts/situation';

/** what a spec needs to know of the run and the hero */
export interface SpecCtx {
  threat: Pick<SituationThreat, 'name' | 'role' | 'faction' | 'outriders' | 'count'>;
  /** the threat's riders hunting the hero (the run's pursuers: the outriders at the start, what's left of them after) */
  carried: number;
  /** the hero: its play id and cruise (cells/s) */
  hero: { id: string; cruise: number };
  /** the town's finale: its people to be led out */
  evacuate?: boolean;
  /** the dead thinned before the finale */
  thinned?: number;
}

/** what a spec needs of the run (runsit/state.ts SituationRun's part of it), the hero's part from the live play (or a
 *  card's stand-in: a card's counts don't depend on the hero) */
export function specCtx(sr: { sit: { threat: SpecCtx['threat'] }; pursuers: { count: number } | null; evacuate: boolean; thinned: number }, hero: SpecCtx['hero'], evacuate = sr.evacuate): SpecCtx {
  return { threat: sr.sit.threat, carried: sr.pursuers?.count ?? 0, hero, evacuate, thinned: sr.thinned };
}

/** riders' pace as a share of the hero's cruise: pursuers just under it (boost or a jump shakes them, a cruise doesn't),
 *  quarry a little slower (it can be caught by riding hard at it) */
export const PURSUIT_PACE = 0.85;
export const QUARRY_PACE = 0.75;
/** cells behind the hero the pursuers come in at; ahead the foes and the quarry do */
export const BEHIND: [number, number] = [8, 14];
export const AHEAD: [number, number] = [10, 16];
/** cells clear of every pursuer, held this long, that count as lost */
export const CLEAR = { cells: 45, seconds: 3 };
/** the hero's health share at which it's beaten */
export const BEATEN = 0.3;
/** a fight's foes break when this share is down */
export const MORALE = 0.6;
/** seconds a chase's quarry runs before it's away (its escape: that far at its pace), and cells off the hero that's lost */
export const ESCAPE_S = 14;
export const ESCAPE_FAR = 70;
/** a hall's gate: seconds of the hero's cruise ahead (kept within a few screens) */
export const HAVEN_S = 6;
export const HAVEN_CELLS: [number, number] = [45, 200];
/** cells/s the riders who come for an escort's people ride at: faster than the people walk (a worker's 2.4), slower
 *  than any hero — the hero has to turn and meet them */
export const ESCORT_RIDERS = 6;
/** an escort's safety: seconds of the hero's cruise from the camp (the people walk: kept short) */
export const SAFETY_CELLS: [number, number] = [45, 80];

const band = (b: Band): Band => b;

/** the riders a spec takes: a role read as mounted (the threat's outriders ride; the horde walks) */
const ridersOf = (c: SpecCtx) => c.threat.outriders?.role ?? c.threat.role;

export function encounterSpec(a: SituationArea, c: SpecCtx): EncounterSpec {
  const p = a.play;
  const x = a.threat ?? { foes: 0, pursuers: 0 };
  const th = c.threat;
  const cruise = Math.max(1, c.hero.cruise);
  // (the riders in one encounter share a pace: the GPU's speed is a kind's — units/agent-units.ts RIDER_MIN)
  const tail = (n: number, pace = PURSUIT_PACE): Band[] => (n > 0 ? [band({ part: 'pursuers', role: ridersOf(c), faction: th.faction, count: n, from: 'behind', range: BEHIND, pace, health: 3, hostile: true })] : []);
  const foes = (n: number, role: string, faction: string | null, from: Band['from'] = 'ahead', range: [number, number] = AHEAD): Band[] => (n > 0 ? [band({ part: 'foes', role, faction, count: n, from, range, health: 3, hostile: true })] : []);
  switch (p.kind) {
    case 'flee': {
      const n = Math.max(1, (c.carried || (th.outriders?.count ?? 0)) + x.pursuers);
      return { kind: 'flee', title: 'Flee the outriders', goal: `${n} riders on your tail: lose them, or cut them down`, bands: tail(n), limit: 75, beaten: BEATEN, clear: CLEAR };
    }
    case 'ambush': {
      const n = p.foes + x.foes;
      return { kind: 'fight', title: 'Break the ambush', goal: `${n} ${p.role} across the road: cut them down or break them`, bands: [...foes(n, p.role, p.faction), ...tail(c.carried + x.pursuers)], limit: 100, beaten: BEATEN, morale: MORALE };
    }
    case 'deliver': {
      const n = Math.max(2, x.pursuers + c.carried);
      const haven = Math.max(HAVEN_CELLS[0], Math.min(HAVEN_CELLS[1], cruise * HAVEN_S));
      return { kind: 'flee', title: 'Carry the word', goal: `riders on your tail and ${x.foes} across the way: get to the hall's gate`, bands: [...tail(n), ...foes(x.foes, th.role, th.faction, 'ahead', [haven * 0.35, haven * 0.55])], limit: Math.min(p.limit, 60 + haven / cruise), beaten: BEATEN, haven };
    }
    case 'trader': {
      const n = Math.max(3, x.foes);
      return {
        kind: 'scene',
        title: 'Raiders at the trader',
        goal: `${n} raiders round the trader: talk, pay, or fight`,
        bands: [band({ part: 'foes', role: 'raider', faction: th.faction, count: n, from: 'camp', range: [3, 7], health: 3, hostile: false }), ...tail(c.carried + x.pursuers)],
        limit: 100,
        beaten: BEATEN,
        morale: MORALE,
        camp: 12,
        scene: {
          speaker: { name: 'Kesh Half-Ear', title: 'raider chief', colour: '#c0583a' },
          line: `This road is ours while ${th.name} marches. The trader pays us, or the trader feeds the dead. And you? You can pay too.`,
          answers: [
            { id: 'fight', text: 'Leave the trader alone. Now.', reply: 'Then bleed for it!' },
            { id: 'yield', text: `${th.name} will eat you too. Run while you can.`, reply: 'Fine. Fine! The road is yours.', refused: 'Big words. Get them!', needs: { renown: 1, dread: ['lich'] } },
            { id: 'bargain', text: 'Here. Two supplies for the trader and the road.', reply: 'A fair toll. Off you go.', cost: { goods: 'supplies', count: 2 } },
          ],
        },
      };
    }
    case 'chase': {
      const pace = QUARRY_PACE;
      return {
        kind: 'chase',
        title: 'Run them down',
        goal: `${p.quarry} ${p.role} running ahead: cut them down before they get away`,
        bands: [band({ part: 'quarry', role: ridersOf(c), faction: p.faction, count: p.quarry, from: 'ahead', range: [9, 13], pace, health: 2, hostile: false }), ...tail(c.carried + x.pursuers, pace)],
        limit: ESCAPE_S * 2 + 10,
        beaten: BEATEN,
        escape: { cells: pace * cruise * ESCAPE_S + 13, far: ESCAPE_FAR },
      };
    }
    case 'rescue': {
      const safety = Math.max(SAFETY_CELLS[0], Math.min(SAFETY_CELLS[1], cruise * 4));
      return {
        kind: 'escort',
        title: 'Free the captives',
        goal: `${p.guards} ${p.role} guard ${p.captives} captives: break them, then lead the people out`,
        bands: [
          band({ part: 'guards', role: p.role, faction: p.faction, count: p.guards, from: 'camp', range: [3, 8], health: 3, hostile: true }),
          band({ part: 'people', role: 'captive', faction: null, count: p.captives, from: 'camp', range: [1, 3], health: 4, hostile: false }),
          ...tail(c.carried + x.pursuers, ESCORT_RIDERS / cruise),
        ],
        limit: 150,
        beaten: BEATEN,
        morale: MORALE,
        camp: 16,
        escort: { safeShare: 0.5, safety, pursuers: band({ part: 'pursuers', role: ridersOf(c), faction: p.faction, count: Math.max(2, Math.ceil(p.guards / 2)), from: 'behind', range: [14, 20], pace: ESCORT_RIDERS / cruise, health: 3, hostile: true }) },
      };
    }
    case 'scout': {
      const n = Math.max(2, p.patrols * 2);
      return { kind: 'fight', title: 'Break the patrol', goal: `${n} ${p.role} hold the ridge: break them to count the host`, bands: [...foes(n, p.role, p.faction, 'around', [10, 15]), ...tail(c.carried + x.pursuers)], limit: 100, beaten: BEATEN, morale: 0.5 };
    }
    case 'town': {
      const n = Math.max(1, th.count - (c.thinned ?? 0));
      return { kind: 'defend', title: c.evacuate ? 'Lead them out' : 'Defend the town', goal: c.evacuate ? `${n} of ${th.name} come: lead the people out` : `${n} of ${th.name} assail the town: hold it, or it burns`, bands: [band({ part: 'foes', role: th.role, faction: th.faction, count: n, from: 'ahead', range: [20, 40], health: 3, hostile: true })], limit: Infinity, beaten: 0, finale: c.evacuate ? 'evacuate' : 'defend' };
    }
  }
}

/** a spec's problems (none: it's a real encounter) — the Node test's and oppcheck's */
export function specProblems(s: EncounterSpec): string[] {
  const out: string[] = [];
  const hostile = s.bands.filter((b) => b.part !== 'people');
  if (!hostile.length) out.push('no enemies and no quarry: a ride to a flag');
  // (the nearest band in within a screen of the hero: a camp's bands count from the camp)
  const near = Math.min(...hostile.map((b) => (b.from === 'camp' ? (s.camp ?? Infinity) : 0) + b.range[0]));
  if (hostile.length && !(near <= 20)) out.push(`the nearest enemies come in ${near} cells off: off the screen`);
  if (s.bands.some((b) => b.from === 'camp') && s.camp === undefined) out.push('bands at a camp, and no camp');
  if (s.kind === 'race' && !s.arena) out.push('a race without an arena');
  // (riders share one pace in the window: the GPU's speed is a kind's)
  const paces = new Set([...s.bands, ...(s.escort ? [s.escort.pursuers] : [])].filter((b) => b.pace !== undefined).map((b) => b.pace!.toFixed(4)));
  if (paces.size > 1) out.push(`riders at ${paces.size} paces (they share one)`);
  if (!s.finale && !(s.beaten > 0) && !Number.isFinite(s.limit)) out.push('no way to lose');
  if (s.kind === 'scene' && !s.scene?.answers.some((a) => a.id === 'fight')) out.push('a scene with no fight in it');
  return out;
}
