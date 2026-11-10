// (round 128r, Track A "Next season") The season's pure parts: the ledger resolves the same way every time; a landmark
// rises two storeys a season and is finished; a quarter is raided, ruined, overgrown by the one wear rule; a flood rises,
// holds, drains; the stage is derived; the words pass the writing lint; skipping the showcase gives the same writes in
// the same order; a second Next season mid-showcase finishes the first; wear is saved with the plan.
import { describe, expect, test } from 'vitest';
import { newLedger, nextSeason, play, short, type PlanView, type SeasonCard, type SeasonLedger } from './ledger';
import { prepare, FLOOD_STEPS, type SeasonBasin, type SeasonWorld } from './realise';
import { stageOf } from './stage';
import { SeasonPlay } from './play';
import { NEXT_SEASON, SEASON_PLAYING, SKIP_SEASON, wordsLine } from './words';
import { lint } from '../../test/support/writing';
import { Tiers } from '../sim/tiers';
import { TownPlan } from '../build/plan';
import type { V2, Wear } from '../api/contracts/structures';

/** a plan: a 3-cell tower (id 1) planned 6 high, nothing standing; houses (ids 2..7) round (50, 50), 2 storeys */
function fakePlan() {
  const standing = new Set<string>();
  const houses = new Map<number, { centre: V2; storeys: number }>();
  for (let i = 0; i < 6; i++) houses.set(2 + i, { centre: [50 + Math.cos(i) * 6, 50 + Math.sin(i) * 6], storeys: 2 });
  const view: PlanView = {
    blocks: (id) => {
      if (id !== 1) return [];
      const out = [];
      for (let l = 0; l < 6; l++) for (const c of [10, 11, 12]) out.push({ cell: c, level: l, standing: standing.has(`${c}:${l}`) });
      return out;
    },
    structure: (id) => (id === 1 ? { centre: [0, 0], base: 0, storeys: 6 } : houses.has(id) ? { centre: houses.get(id)!.centre, base: 0, storeys: houses.get(id)!.storeys } : null),
    structures: () => [...houses].map(([id, h]) => ({ id, centre: h.centre, base: 0, storeys: h.storeys })),
  };
  return { view, standing, houses };
}

const cards = (): SeasonCard[] => [
  { id: 'tower', name: 'the fortress tower', cost: { labor: 3 }, work: { kind: 'raise', structure: 1, storeys: 2 } },
  { id: 'quarter', name: 'the outer quarter', cost: { might: 1 }, work: { kind: 'decay', at: [50, 50], r: 14, marks: ['raided', 'ruined', 'overgrown'] } },
  { id: 'flood', name: 'the low ground', cost: { magic: 2 }, work: { kind: 'flood', at: [80, 80], hold: 1 } },
];

function start(): SeasonLedger {
  let l = newLedger({ labor: 4, might: 2, magic: 3 }, { labor: 2 });
  for (const c of cards()) l = play(l, c);
  return l;
}

/** a world that logs every write (the order, and the args) */
function logWorld(standing: Set<string>) {
  const log: string[] = [];
  const basin = (level: number): SeasonBasin => ({
    level,
    floor: level - 3,
    raise: (lv) => log.push(`raise ${lv.toFixed(3)}`),
    lower: (lv) => log.push(`lower ${lv}`),
    submerged: async () => new Set([4]),
    destroy: () => log.push('basin gone'),
  });
  const world: SeasonWorld = {
    scaffold: (c, l) => log.push(`scaffold ${c}:${l}`),
    stand: (c, l) => {
      standing.add(`${c}:${l}`);
      log.push(`stand ${c}:${l}`);
    },
    lowerTo: (id, n) => log.push(`lower ${id} to ${n}`),
    setWear: (id, w: Wear) => log.push(`wear ${id} ${w}`),
    grow: (x, y, r) => log.push(`grow ${x.toFixed(1)},${y.toFixed(1)} ${r}`),
    basin: async (_x, _y, level) => basin(level ?? 12),
    columns: () => [],
    where: () => [0, 0],
  };
  return { world, log };
}

describe('the ledger', () => {
  test('a card is paid when played; one the pools cannot pay is refused', () => {
    const l = start();
    expect(l.pools).toMatchObject({ labor: 1, might: 1, magic: 1 });
    expect(short(newLedger(), cards()[0])).toEqual({ labor: 3 });
    expect(() => play(newLedger(), cards()[0])).toThrow(/can't be paid/);
  });

  test('the same ledger and plan give the same season', () => {
    const { view } = fakePlan();
    const a = nextSeason(start(), view);
    const b = nextSeason(start(), view);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (let i = 1; i < a.changes.length; i++) expect(a.changes[i].at).toBeGreaterThanOrEqual(a.changes[i - 1].at);
  });

  test('three seasons: the tower rises two storeys a season, the quarter decays, the flood rises, holds and drains', () => {
    const { view, standing } = fakePlan();
    let l = start();
    const kinds: string[][] = [];
    const sums: string[] = [];
    for (let k = 0; k < 3; k++) {
      const r = nextSeason(l, view);
      for (const c of r.changes) if (c.kind === 'stand') standing.add(`${c.cell}:${c.level}`);
      kinds.push([...new Set(r.changes.map((c) => c.kind))].sort());
      sums.push(r.summary);
      l = r.ledger;
    }
    expect(standing.size).toBe(18);
    expect(sums[0]).toBe('Season 1. The fortress tower rose two storeys. Raiders broke into the outer quarter. Floodwater fills the low ground.');
    expect(sums[1]).toBe('Season 2. The fortress tower rose two storeys. The outer quarter lies in ruins. The water still stands in the low ground.');
    expect(sums[2]).toBe('Season 3. The fortress tower is finished. Green grows over the outer quarter. The flood in the low ground went down.');
    expect(kinds[0]).toEqual(['flood', 'scaffold', 'stand', 'wear']);
    expect(kinds[2]).toEqual(['drain', 'grow', 'scaffold', 'stand', 'wear']);
    expect(l.projects).toEqual([]);
    expect(l.story.map((e) => e.what)).toEqual(['raided', 'flooded', 'ruined', 'grew', 'overgrown']);
    expect(l.pools.labor).toBe(1 + 3 * 2);
  });

  test('a quarter is worn by the same rule as a generated town (markWear)', () => {
    const { view } = fakePlan();
    const r = nextSeason(start(), view);
    const wears = r.changes.filter((c) => c.kind === 'wear');
    expect(wears.length).toBe(6);
    for (const w of wears) expect(w).toMatchObject({ wear: 'damaged', storeys: 1 });
  });
});

describe('the stage', () => {
  test('derived from the blocks, then from the wear', () => {
    expect(stageOf({}, { planned: 6, standing: 0, begun: 0 }).stage).toBe('planned');
    expect(stageOf({}, { planned: 6, standing: 0, begun: 2 }).stage).toBe('building');
    expect(stageOf({}, { planned: 6, standing: 3, begun: 0 })).toEqual({ stage: 'building', progress: 0.5 });
    expect(stageOf({}, { planned: 6, standing: 6, begun: 0 }).stage).toBe('built');
    expect(stageOf({ wear: 'flooded' }, { planned: 6, standing: 6, begun: 0 }).stage).toBe('damaged');
    expect(stageOf({ wear: 'ruined' }, { planned: 1, standing: 1, begun: 0 }).stage).toBe('ruined');
    expect(stageOf({ wear: 'overgrown' }, { planned: 1, standing: 1, begun: 0 }).stage).toBe('overgrown');
  });
});

describe('the words', () => {
  test('every line passes the writing lint', () => {
    const lines = [NEXT_SEASON, SKIP_SEASON, SEASON_PLAYING];
    for (const kind of ['raided', 'ruined', 'overgrown', 'flood', 'flood-holds', 'drain'] as const) lines.push(wordsLine({ kind, name: 'the outer quarter' }));
    for (const n of [1, 2, 3]) lines.push(wordsLine({ kind: 'raise', name: 'the fortress tower', storeys: n, done: false }));
    lines.push(wordsLine({ kind: 'raise', name: 'the fortress tower', storeys: 2, done: true }));
    const { view } = fakePlan();
    let l = start();
    for (let k = 0; k < 3; k++) {
      const r = nextSeason(l, view);
      lines.push(r.summary, ...r.story.map((e) => e.note));
      l = r.ledger;
    }
    for (const s of lines) expect(lint(s), s).toEqual([]);
  });
});

describe('the showcase', () => {
  /** a season realised and its steps run: all at once (skip), or in order at their fractions (played) */
  async function realised(skip: boolean): Promise<string[]> {
    const { view, standing } = fakePlan();
    const { world, log } = logWorld(standing);
    const floods = new Map<string, SeasonBasin>();
    let l = start();
    for (let k = 0; k < 3; k++) {
      const r = nextSeason(l, view);
      const real = await prepare(r, world, floods);
      if (skip) real.steps.forEach((s) => s.apply());
      else for (let t = 0; t <= 1.0001; t += 0.01) for (const s of real.steps.filter((x) => x.at > t - 0.01 && x.at <= t)) s.apply();
      l = r.ledger;
    }
    return log;
  }

  test('skipped or played, the same writes in the same order', async () => {
    const a = await realised(true);
    const b = await realised(false);
    expect(b).toEqual(a);
    expect(a.filter((x) => x.startsWith('raise')).length).toBe(FLOOD_STEPS);
    expect(a.filter((x) => x === 'wear 4 flooded').length).toBe(1);
    expect(a[a.length - 1] === 'basin gone' || a.includes('basin gone')).toBe(true);
  });

  test('the flood level found by the fill is the outcome: the AtlasEvent and the history mark carry it', async () => {
    const { view, standing } = fakePlan();
    const { world } = logWorld(standing);
    const r = nextSeason(start(), view);
    await prepare(r, world, new Map());
    expect(r.atlas.find((e) => e.kind === 'flood')!.level).toBe(12);
    expect(r.ledger.story.find((e) => e.what === 'flooded')!.level).toBe(12);
  });

  test('a second Next season while the first plays finishes the first (skip) before it resolves', async () => {
    const { view, standing } = fakePlan();
    const { world, log } = logWorld(standing);
    const tiers = new Tiers({ origin: () => [0, 0], dims: { w: 64, h: 64 }, tickDt: 1 / 60, wake: () => undefined, awake: () => false, write: () => undefined });
    const p = new SeasonPlay({ world, plan: view, tiers, look: () => undefined, seconds: 60 }, start());
    await p.next();
    expect(p.playing).toBe(true);
    // (nothing of season 1 shown yet: its clock hasn't started)
    expect(log.filter((x) => x.startsWith('stand')).length).toBe(0);
    await p.next();
    // season 1 all in (6 blocks), season 2 started, not shown
    expect(log.filter((x) => x.startsWith('stand')).length).toBe(6);
    expect(p.ledger.season).toBe(2);
    await p.settle();
    expect(log.filter((x) => x.startsWith('stand')).length).toBe(12);
    expect(p.playing).toBe(false);
  });

  test('the showcase applies steps as its clock passes them; what they queue is ticked on the frames after', () => {
    let queue = 0;
    const tiers = new Tiers({ origin: () => [0, 0], dims: { w: 64, h: 64 }, tickDt: 1 / 60, wake: () => undefined, awake: () => false, write: () => undefined, queued: () => queue });
    const got: number[] = [];
    const s = tiers.showcase(
      [
        { at: 0, apply: () => (got.push(0), queue++) },
        { at: 1, apply: () => (got.push(1), (queue += 5)) },
      ],
      { seconds: 1000 },
    );
    let ticks = 0;
    // (a tick takes up to four events, as the sim's MAX_EVENTS)
    const tick = () => (ticks++, (queue = Math.max(0, queue - 4)));
    tiers.pump(tick, 0);
    expect(got).toEqual([0]);
    expect(ticks).toBe(0);
    tiers.pump(tick, 0);
    expect(ticks).toBe(1);
    tiers.pump(tick, 0);
    expect(ticks).toBe(1);
    expect(() => tiers.showcase([], { seconds: 1 })).toThrow(/one is playing/);
    s.skip();
    expect(got).toEqual([0, 1]);
    expect(s.playing).toBe(false);
    // (the skip's five events land on the frames after, even with time stopped: two ticks)
    for (let i = 0; i < 4; i++) tiers.pump(tick, 0);
    expect(ticks).toBe(3);
    expect(queue).toBe(0);
  });
});

describe('wear on the plan', () => {
  test('setWear is saved with the plan (toData round trip)', () => {
    const grid = { count: 4, nbr: new Int32Array(16).fill(-1), centre: (c: number): [number, number] => [c, 0] } as unknown as ConstructorParameters<typeof TownPlan>[0];
    const plan = new TownPlan(grid);
    expect(plan.paint(0, 0, 'house')).toBe(true);
    const id = plan.structureAt(0)!.id;
    plan.setWear(id, 'ruined');
    const back = new TownPlan(grid, undefined, undefined, plan.toData());
    expect(back.structure(id)!.wear).toBe('ruined');
    back.setWear(id, undefined);
    expect(back.structure(id)!.wear).toBeUndefined();
  });
});
