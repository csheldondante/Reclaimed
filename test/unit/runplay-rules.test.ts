// (round 119, `runplay`) A run's stages as play at their rules: what each encounter becomes for the bike and the lich,
// when a stage is won or lost, which planned outcome that picks and how the run goes on, the run's clock; the race
// course on made-up hills and riders on it, the bike drive in Node.
import { describe, expect, test } from 'vitest';
import { library } from '../../src/play/library';
import { WALKER_PROFILE } from '../../src/api/contracts/play';
import type { RunStage, StageOutcome } from '../../src/api/contracts/run';
import { judge, outcomeFor, stageKind, stageSpec, type Observation } from '../../src/runplay/rules';
import { RunClock } from '../../src/runplan/clock';
import { layCourse, progress, prominence } from '../../src/runplay/course';
import { GATE_R, Quarry, Racer } from '../../src/runplay/riders';
import { BIKE_DEFAULTS } from '../../src/play/controllers/hoverbike';
import type { BikeTuning } from '../../src/play/core/bike';
import { planRun } from '../../src/runplan/plan';
import { heroCaps } from '../../src/runplan/heroes';
import { seed1, seed1Graph } from '../support/seed1';

const bike = library.get('hoverbike')!.profile();
const lich = library.get('lich')!.profile();

const out = (id: string, ends: StageOutcome['ends']): StageOutcome => ({ id, text: id, ends, effects: {} });
const stage = (encounter: RunStage['encounter'], outcomes: StageOutcome[], finale = false): Pick<RunStage, 'id' | 'encounter' | 'next' | 'outcomes'> => ({ id: 's', encounter, next: finale ? [] : ['l1'], outcomes });
const obs = (o: Partial<Observation>): Observation => ({ t: 1, heroAlive: true, ...o });

describe('what each encounter becomes', () => {
  test('the bike races and chases; the lich smashes, and fights what it can’t catch', () => {
    expect(stageKind('race', bike).kind).toBe('race');
    expect(stageKind('chase', bike).kind).toBe('chase');
    expect(stageKind('spectacle', lich).kind).toBe('smash');
    expect(stageKind('destruction', lich).kind).toBe('smash');
    expect(stageKind('chase', lich)).toMatchObject({ kind: 'fight', standIn: expect.stringMatching(/slow/) });
    expect(stageKind('race', lich).kind).toBe('trial');
    // (the bike breaks fences, not forts: a spectacle is a fight for it)
    expect(stageKind('destruction', bike).kind).toBe('fight');
  });
  test('the knight’s delve is a stand-in fight (said so on the banner)', () => {
    expect(stageKind('delve', WALKER_PROFILE)).toMatchObject({ kind: 'fight', standIn: expect.stringMatching(/knight/) });
  });
  test('numbers: a finale is bigger; the lich faces a bigger pack than the bike', () => {
    const r = stageSpec(stage('race', []), bike);
    const rf = stageSpec(stage('race', [], true), bike);
    expect(rf.gates!).toBeGreaterThan(r.gates!);
    expect(rf.rivals!).toBeGreaterThan(r.rivals!);
    expect(stageSpec(stage('fight', []), lich).foes!).toBeGreaterThan(stageSpec(stage('fight', []), bike).foes!);
    const s = stageSpec(stage('spectacle', []), lich);
    expect(s).toMatchObject({ kind: 'smash', towers: 4, need: 4 });
    expect(s.limit).toBeGreaterThan(s.par);
  });
});

describe('won or lost', () => {
  const race = stageSpec(stage('race', []), bike);
  test('a race: through the last gate first wins; a rival over the line first loses; the clock loses', () => {
    expect(judge(race, obs({ gate: 3, rivalGate: 2.5 }))).toEqual({ state: 'playing' });
    expect(judge(race, obs({ gate: race.gates, rivalDone: false }))).toEqual({ state: 'won', how: 'finished' });
    expect(judge(race, obs({ gate: 4, rivalDone: true }))).toEqual({ state: 'lost', how: 'beaten' });
    expect(judge(race, obs({ t: race.limit + 1, gate: 2 }))).toEqual({ state: 'lost', how: 'clock' });
  });
  test('death comes first, whatever else', () => {
    expect(judge(race, obs({ heroAlive: false, gate: race.gates }))).toEqual({ state: 'lost', how: 'died' });
  });
  test('a chase: close enough catches; too far loses', () => {
    const c = stageSpec(stage('chase', []), bike);
    expect(judge(c, obs({ quarry: 30 })).state).toBe('playing');
    expect(judge(c, obs({ quarry: c.quarry!.catch - 0.1 }))).toEqual({ state: 'won', how: 'caught' });
    expect(judge(c, obs({ quarry: c.quarry!.lose + 1 }))).toEqual({ state: 'lost', how: 'escaped' });
  });
  test('a fight is won when the last raider is down; a fort when its towers are', () => {
    const f = stageSpec(stage('fight', []), bike);
    expect(judge(f, obs({ foesLeft: 1 })).state).toBe('playing');
    expect(judge(f, obs({ foesLeft: 0 }))).toEqual({ state: 'won', how: 'cleared' });
    const s = stageSpec(stage('spectacle', []), lich);
    expect(judge(s, obs({ down: s.need! - 1, foesLeft: 0 })).state).toBe('playing');
    expect(judge(s, obs({ down: s.need! }))).toEqual({ state: 'won', how: 'smashed' });
    expect(judge(s, obs({ t: s.limit + 0.1, down: 1 }))).toEqual({ state: 'lost', how: 'clock' });
  });
});

describe('the planned outcome it picks', () => {
  const mid = stage('fight', [out('held', 'continue'), out('sacked', 'continue'), out('taken', 'captured'), out('fell', 'continue')]);
  const fin = stage('race', [out('won-race', 'won'), out('dirty-race', 'won'), out('crashed', 'lost')], true);
  test('won: the hoped-for one; the run goes on (or is won at the finale)', () => {
    expect(outcomeFor(mid, { state: 'won', how: 'cleared' })).toEqual({ outcome: mid.outcomes[0], runEnd: null });
    expect(outcomeFor(fin, { state: 'won', how: 'finished' })).toEqual({ outcome: fin.outcomes[0], runEnd: 'won' });
  });
  test('lost on the clock: how it goes wrong (not the capture); the run goes on, or at the finale ends fled (alive)', () => {
    expect(outcomeFor(mid, { state: 'lost', how: 'clock' })).toEqual({ outcome: mid.outcomes[3], runEnd: null });
    expect(outcomeFor(fin, { state: 'lost', how: 'beaten' })).toEqual({ outcome: fin.outcomes[2], runEnd: 'fled' });
  });
  test('the hero fell: dragged off where there’s a capture, else the run is lost (the GM’s failure rule)', () => {
    expect(outcomeFor(mid, { state: 'lost', how: 'died' })).toEqual({ outcome: mid.outcomes[2], runEnd: 'captured' });
    const race = stage('race', [out('won-race', 'continue'), out('crashed', 'continue')]);
    expect(outcomeFor(race, { state: 'lost', how: 'died' })).toEqual({ outcome: race.outcomes[1], runEnd: 'lost' });
  });
  test('every stage of real plans maps both ways (seed 1, the bike and the lich)', () => {
    const { wiki } = seed1();
    for (const role of ['hoverbike', 'lich']) {
      const p = planRun({ graph: seed1Graph(), world: wiki.snapshot, hero: heroCaps(role), seed: 1, from: wiki.spawn.region });
      expect(p.hero).toBe(role);
      for (const s of p.stages) {
        const spec = stageSpec(s, library.get(role)!.profile());
        expect(spec.limit).toBeGreaterThan(0);
        const w = outcomeFor(s, { state: 'won', how: 'finished' });
        expect(w.outcome).toBe(s.outcomes[0]);
        const l = outcomeFor(s, { state: 'lost', how: 'clock' });
        expect(l.outcome).not.toBe(s.outcomes[0]);
        const d = outcomeFor(s, { state: 'lost', how: 'died' });
        expect(['lost', 'captured']).toContain(d.runEnd);
      }
    }
  });
});

describe('the run’s clock', () => {
  test('stages count their planned minutes, more when slow; legs their travel; late past the deadline', () => {
    const c = new RunClock(20);
    c.stage(5, 30, 60);
    expect(c.minutes).toBe(5);
    c.stage(5, 120, 60);
    // (twice par counts half again, at most)
    expect(c.minutes).toBe(12.5);
    c.leg(2.5);
    c.leg(3);
    expect(c.late).toBe(false);
    c.leg(3);
    expect(c.late).toBe(true);
  });
});

// made-up hills: gentle swells with a few crests
const hills = (x: number, y: number) => 100 + 3 * Math.sin(x * 0.09) * Math.cos(y * 0.07) + (Math.hypot(x - 140, y - 90) < 8 ? 4 - Math.hypot(x - 140, y - 90) / 2 : 0);
const flat = () => 100;
const dry = () => 0;

describe('the course', () => {
  test('a loop of gates inside the window, back to the start, on crests where there are any', () => {
    const c = layCourse(hills, dry, [128, 60], 0, { gates: 6, spacing: 50, bounds: [256, 256], margin: 16 });
    expect(c.gates).toHaveLength(6);
    for (const [x, y] of c.gates) {
      expect(x).toBeGreaterThan(16);
      expect(y).toBeGreaterThan(16);
      expect(x).toBeLessThan(240);
      expect(y).toBeLessThan(240);
    }
    // the finish line back by the start
    expect(Math.hypot(c.gates[5][0] - 128, c.gates[5][1] - 60)).toBeLessThan(30);
    // gates moved onto crests: more prominent than the spots the circle put them on, on average
    const prom = c.gates.slice(0, 5).reduce((s, g) => s + prominence(hills, g[0], g[1]), 0) / 5;
    expect(prom).toBeGreaterThan(0);
  });
  test('flat land gets kickers between gates', () => {
    const c = layCourse(flat, dry, [128, 60], 0, { gates: 6, spacing: 50, bounds: [256, 256], margin: 16 });
    expect(c.kickers.length).toBeGreaterThanOrEqual(3);
  });
  test('progress counts gates and the way to the next', () => {
    const g: [number, number][] = [[10, 0], [20, 0]];
    expect(progress(g, 0, [5, 0], [0, 0])).toBeCloseTo(0.5);
    expect(progress(g, 1, [10, 0], [0, 0])).toBeCloseTo(1);
    expect(progress(g, 2, [20, 0], [0, 0])).toBe(2);
  });
});

describe('riders on the bike drive', () => {
  const t = { ...BIKE_DEFAULTS } as unknown as BikeTuning;
  test('a rival rides the whole course, gate by gate', () => {
    const c = layCourse(hills, dry, [128, 60], 0, { gates: 6, spacing: 50, bounds: [256, 256], margin: 16 });
    const r = new Racer('r', c.start, t, 0.92, hills, [256, 256], 0, c.gates);
    let time = 0;
    while (!r.done && time < 60) {
      r.step(1 / 60);
      time += 1 / 60;
    }
    expect(r.done).toBe(true);
    // (at its pace, about the course's length over its speed — not stuck circling a gate)
    expect(time).toBeLessThan((6 * 50) / (t.max * 0.92) * 2.5);
    expect(GATE_R).toBeGreaterThan(3);
  });
  test('the quarry runs from a hero standing still and stays in the window', () => {
    const q = new Quarry('q', [128, 128], t, 0.85, flat, [256, 256]);
    for (let i = 0; i < 600; i++) q.step(1 / 60, [120, 128]);
    const [x, y] = q.at;
    expect(Math.hypot(x - 120, y - 128)).toBeGreaterThan(40);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(256);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(256);
  });
});
