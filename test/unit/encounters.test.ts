// (round 126, `encounters`) Every played opportunity is a scene in the world: each player template of the horde run maps
// to a real encounter spec (enemies or a quarry in within a screen, a way to lose, no race without an arena), the spec
// the card shows is the spec that's played, and the rules judge each kind — won, lost and the tier between — the way
// the live play reports it back to the opportunity. The user (round 126): "the actual hero missions are still the race
// with a flag and not actually any of the in world things we discussed like chases or fights or scenes with
// conversations and combat."

import { describe, expect, it } from 'vitest';
import type { EncounterSpec } from '../../src/api/contracts/encounter';
import type { SituationArea } from '../../src/api/contracts/situation';
import { MemoryWorldState } from '../../src/api/contracts/world-state';
import { encounterSpec, specCtx, specProblems } from '../../src/encounters/spec';
import { EncounterRules, type EncounterObs } from '../../src/encounters/rules';
import { detourArea, DETOURS, encounterOf, HORDE_TEMPLATES } from '../../src/living/horde';
import { OppRun } from '../../src/opps/run';
import { OPP_TUNE } from '../../src/opps/tune';
import { checkLiving } from '../../src/gm/oppcheck';
import { fillSituation, situationMap } from '../../src/runsit/fill';
import { seed1, seed1Graph } from '../support/seed1';

const snap = () => seed1().wiki.snapshot;
const graph = seed1Graph();
const fill = () => fillSituation({ graph, world: snap(), seed: 1, from: seed1().wiki.spawn.region, at: seed1().wiki.spawn.at as [number, number] });
const make = () => {
  const sit = fill();
  return new OppRun(sit, situationMap(graph, snap()), { seed: 1, hero: 'hoverbike', world: MemoryWorldState.restore(structuredClone(snap())), check: (rep, e) => checkLiving(e, rep, { region: (id) => !!graph.node(id), situation: sit }) });
};
const BIKE = { id: 'hoverbike', cruise: 32 };
const LICH = { id: 'lich', cruise: 7 };
const PLAYER_TEMPLATES = HORDE_TEMPLATES.filter((t) => (t.requires.agents ?? []).some((a) => a.kind === 'player')).map((t) => t.id);

/** every area a run can play: the situation's, and each detour off the first edge */
function areas(): { r: OppRun; list: SituationArea[] } {
  const r = make();
  r.play(r.offered[0].id);
  r.areaDone({ seconds: 150, won: true, pursuers: 0 });
  // (a trader, if the situation has none: the template's stall, so a scene is checked too)
  const list = [...r.sit.areas, ...DETOURS.map((d) => detourArea(r.sr, OPP_TUNE.horde, d))];
  if (!list.some((a) => a.play.kind === 'trader')) list.push({ id: 't', name: 'the crossroads', region: list[0].region, at: list[0].at, brief: '', minutes: 2, play: { kind: 'trader', offers: [] }, threat: { foes: 4, pursuers: 0 } });
  return { r, list };
}

describe('every player template is a real encounter', () => {
  it('the player templates are the ones the run deals (outriders, the ways on, the detours)', () => {
    expect(PLAYER_TEMPLATES.sort()).toEqual(['chase', 'lead-out', 'muster', 'outriders', 'rescue', 'ride', 'scout', 'warn'].sort());
  });
  it('each area, for either hero, is a spec with enemies or a quarry in within a screen and a way to lose — and none a race', () => {
    const { r, list } = areas();
    const kinds = new Set<string>();
    for (const hero of [BIKE, LICH])
      for (const a of list) {
        const s = encounterSpec(a, specCtx(r.sr, hero));
        expect(specProblems(s), `${a.id} (${a.play.kind} as ${s.kind}, ${hero.id})`).toEqual([]);
        expect(s.kind).not.toBe('race');
        kinds.add(s.kind);
      }
    for (const k of ['flee', 'fight', 'chase', 'escort', 'scene', 'defend']) expect(kinds, k).toContain(k);
  });
  it('every player card dealt in a run names the game it plays, read off the same spec the live play plays', () => {
    const r = make();
    const seen = new Map<string, string>();
    const look = () => {
      for (const o of r.forPlayer) {
        const e = o.challenge!.encounter;
        expect(e.plays, o.template).toBeTruthy();
        expect(e.foes + e.pursuers + (e.horde ?? 0), o.template).toBeGreaterThan(0);
        const a = r.sit.areas.find((x) => x.id === o.challenge!.area) ?? r.stage.detours.get(o.challenge!.area)!;
        const s = encounterSpec(a, specCtx(r.sr, BIKE, e.kind === 'evacuate'));
        expect(s.kind, o.template).toBe(e.plays);
        expect(s.goal).toBe(e.text);
        seen.set(o.template, s.kind);
      }
    };
    look();
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 150, won: true, pursuers: 0 });
    look();
    const rideOn = r.forPlayer.find((o) => o.template === 'ride' || o.template === 'muster')!;
    r.play(rideOn.id);
    r.arrive();
    r.areaDone({ seconds: 120, won: true, pursuers: 0 });
    look();
    expect(seen.get('outriders')).toBe('flee');
    expect(seen.get('chase')).toBe('chase');
    expect(seen.get('rescue')).toBe('escort');
    expect(seen.get('scout')).toBe('fight');
    expect(['flee', 'fight', 'scene']).toContain(seen.get('ride') ?? seen.get('muster'));
  });
  it('the card says the encounter its area plays (encounterOf over the spec)', () => {
    const { r, list } = areas();
    for (const a of list) {
      const e = encounterOf(r.sr, a);
      expect(e.plays).toBe(encounterSpec(a, specCtx(r.sr, BIKE)).kind);
    }
  });
  it('the riders ride at the hero\'s pace (a share of its cruise), and come in on its tail', () => {
    const { r, list } = areas();
    const flee = encounterSpec(list.find((a) => a.play.kind === 'flee')!, specCtx(r.sr, BIKE));
    const p = flee.bands.find((b) => b.part === 'pursuers')!;
    expect(p.pace! * BIKE.cruise).toBeGreaterThan(20);
    expect(p.from).toBe('behind');
    expect(p.range[1]).toBeLessThanOrEqual(20);
  });
});

// ---- the rules -----------------------------------------------------------------------------------------------------

const base = (t: number, o: Partial<EncounterObs> = {}): EncounterObs => ({ t, heroAlive: true, health: 1, ...o });
const spec = (kind: EncounterSpec['kind'], o: Partial<EncounterSpec> = {}): EncounterSpec => ({ kind, title: kind, goal: '', bands: [], limit: 60, beaten: 0.3, ...o });

describe('the rules judge each kind', () => {
  it('flee: lost by staying clear of them for a few seconds, beaten if they catch you, ragged past the limit', () => {
    const R = new EncounterRules(spec('flee', { clear: { cells: 45, seconds: 3 } }));
    expect(R.step(base(1, { pursuers: { alive: 3, nearest: 50 } })).state).toBe('playing');
    expect(R.step(base(2, { pursuers: { alive: 3, nearest: 20 } })).state).toBe('playing');
    R.step(base(3, { pursuers: { alive: 3, nearest: 50 } }));
    const st = R.step(base(6.5, { pursuers: { alive: 3, nearest: 60 } }));
    expect(st.state === 'ended' && st.result.tier).toBe('success');
    const B = new EncounterRules(spec('flee', { clear: { cells: 45, seconds: 3 } }));
    const b = B.step(base(5, { health: 0.2, pursuers: { alive: 2, nearest: 1 } }));
    expect(b.state === 'ended' && [b.result.tier, b.result.heroDied]).toEqual(['failure', false]);
    const L = new EncounterRules(spec('flee', { clear: { cells: 45, seconds: 3 } }));
    const l = L.step(base(61, { pursuers: { alive: 2, nearest: 10 } }));
    expect(l.state === 'ended' && l.result.tier).toBe('failure');
    const K = new EncounterRules(spec('flee', { clear: { cells: 45, seconds: 3 } }));
    const k = K.step(base(10, { pursuers: { alive: 0, nearest: Infinity } }));
    expect(k.state === 'ended' && k.result.tier).toBe('triumph');
  });
  it('flee to a haven: only the gate wins (the word carried), cut down or not', () => {
    const R = new EncounterRules(spec('flee', { haven: 100 }));
    expect(R.step(base(5, { pursuers: { alive: 0, nearest: Infinity }, atHaven: false })).state).toBe('playing');
    const st = R.step(base(9, { pursuers: { alive: 2, nearest: 8 }, atHaven: true, health: 0.9 }));
    expect(st.state === 'ended' && st.result.tier).toBe('success');
  });
  it('chase: run down is won, a quarry past its escape is lost', () => {
    const R = new EncounterRules(spec('chase', { escape: { cells: 200, far: 70 } }));
    expect(R.step(base(1, { quarry: { alive: 3, total: 3, escaped: false } })).state).toBe('playing');
    const w = R.step(base(9, { quarry: { alive: 0, total: 3, escaped: false }, health: 0.9 }));
    expect(w.state === 'ended' && w.result.tier).toBe('triumph');
    const L = new EncounterRules(spec('chase', { escape: { cells: 200, far: 70 } }));
    const l = L.step(base(9, { quarry: { alive: 1, total: 3, escaped: true } }));
    expect(l.state === 'ended' && [l.result.won, l.result.tier]).toEqual([false, 'failure']);
  });
  it('fight: won when they are down or their morale breaks; a dear win costs; dying is a disaster', () => {
    const R = new EncounterRules(spec('fight', { morale: 0.6 }));
    expect(R.step(base(1, { foes: { alive: 4, total: 5 } })).state).toBe('playing');
    const st = R.step(base(8, { foes: { alive: 2, total: 5 }, health: 0.35 }));
    expect(R.broke).toBe(true);
    expect(st.state === 'ended' && [st.result.won, st.result.tier]).toEqual([true, 'cost']);
    const D = new EncounterRules(spec('fight', { morale: 0.6 }));
    const d = D.step(base(4, { heroAlive: false, health: 0, foes: { alive: 5, total: 5 } }));
    expect(d.state === 'ended' && [d.result.tier, d.result.heroDied]).toEqual(['disaster', true]);
  });
  it('escort: the guards broken frees the people; half of them safe wins, more than half lost loses', () => {
    const s = spec('escort', { morale: 0.6, escort: { safeShare: 0.5, safety: 60, pursuers: { part: 'pursuers', role: 'r', faction: null, count: 2, from: 'behind', range: [16, 22], health: 3, hostile: true } } });
    const R = new EncounterRules(s);
    const o = (t: number, x: Partial<EncounterObs>) => base(t, { foes: { alive: 4, total: 4 }, people: { freed: false, alive: 4, safe: 0, total: 4 }, ...x });
    expect(R.guardsClear(o(1, {}))).toBe(false);
    R.step(o(5, { foes: { alive: 1, total: 4 } }));
    expect(R.guardsClear(o(5, { foes: { alive: 1, total: 4 } }))).toBe(true);
    expect(R.step(o(20, { foes: { alive: 1, total: 4 }, people: { freed: true, alive: 3, safe: 1, total: 4 } })).state).toBe('playing');
    const w = R.step(o(40, { foes: { alive: 1, total: 4 }, people: { freed: true, alive: 3, safe: 3, total: 4 } }));
    expect(w.state === 'ended' && [w.result.won, w.result.tier]).toEqual([true, 'cost']);
    const L = new EncounterRules(s);
    const l = L.step(o(30, { foes: { alive: 0, total: 4 }, people: { freed: true, alive: 1, safe: 0, total: 4 } }));
    expect(l.state === 'ended' && l.result.tier).toBe('failure');
  });
  it('scene: what is said decides it — a fight, they back down (renown, or a hero they dread), or a toll paid', () => {
    const { r, list } = areas();
    const s = encounterSpec(list.find((a) => a.play.kind === 'trader')!, specCtx(r.sr, BIKE));
    const nobody = { goods: { supplies: 0 }, renown: 0, hero: 'hoverbike' };
    // (no supplies: no bargain shown)
    expect(new EncounterRules(s).answers(nobody).map((a) => a.id)).toEqual(['fight', 'yield']);
    const Y = new EncounterRules(s);
    expect(Y.choose('yield', { ...nobody, hero: 'lich' }).then).toBe('yield');
    expect(Y.status.state === 'ended' && Y.status.result.tier).toBe('triumph');
    const N = new EncounterRules(s);
    expect(N.choose('yield', nobody).then).toBe('fight');
    expect(N.status.state).toBe('playing');
    const st = N.step(base(10, { foes: { alive: 0, total: 5 }, health: 0.6 }));
    expect(st.state === 'ended' && [st.result.won, st.result.answer]).toEqual([true, 'yield']);
    const B = new EncounterRules(s);
    expect(B.choose('bargain', { goods: { supplies: 3 }, renown: 0, hero: 'hoverbike' }).then).toBe('bargain');
    expect(B.status.state === 'ended' && B.status.result.tier).toBe('cost');
    expect(() => new EncounterRules(s).choose('bargain', nobody)).toThrow(/can't pay/);
  });
  it('a race without an arena is refused', () => {
    expect(() => new EncounterRules(spec('race'))).toThrow(/arena/);
    expect(specProblems(spec('race', { bands: [{ part: 'foes', role: 'r', faction: null, count: 1, from: 'ahead', range: [5, 9], health: 1, hostile: true }] }))).toContain('a race without an arena');
  });
  it("the encounter's tier is the opportunity's: a played card resolves at what the encounter judged", () => {
    const r = make();
    r.play(r.offered[0].id);
    r.areaDone({ seconds: 40, won: true, pursuers: 1, tier: 'cost' });
    expect(r.resolutions.at(-1)!.tier).toBe('cost');
  });
});
