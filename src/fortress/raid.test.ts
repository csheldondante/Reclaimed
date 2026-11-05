// (round 128l, m4: the attack wave) The raid's rules (raid.ts): the waves' clock and growth, where the raiders go (the
// stores; else the weakest wall between them and the stores), the loot, a broken block planned again (the repairs), and
// what the bar says (docs/WRITING.md).
import { describe, expect, it } from 'vitest';
import { lint } from '../../test/support/writing';
import { Fortress } from './fortress';
import { CpuReach, type ReachColumns } from './reach';
import { ECON } from './defs';
import { blockHp, lootOf, RAID, RaidClock, raidGoal, raidSides, sideOf, waveBreaks, waveSize, type RaidLayout } from './raid';
import { raidArrivedLine, raidNowLine, raidOverLines, raidWarnLine } from './words';

type V2 = [number, number];

/** an n × n grid of square cells 5 m across, a ring of wall at `r` cells round the middle, a gate on its east side */
function square(n: number, r: number, opts: { gate?: boolean; noRing?: boolean; hp?: Map<number, number> } = {}) {
  const nbr = new Int32Array(n * n * 4);
  const id = (x: number, y: number) => (x < 0 || y < 0 || x >= n || y >= n ? -1 : y * n + x);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const c = id(x, y);
      nbr[c * 4] = id(x + 1, y);
      nbr[c * 4 + 1] = id(x, y + 1);
      nbr[c * 4 + 2] = id(x - 1, y);
      nbr[c * 4 + 3] = id(x, y - 1);
    }
  const m = Math.floor(n / 2);
  const wall = new Set<number>();
  if (!opts.noRing) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (Math.max(Math.abs(x - m), Math.abs(y - m)) === r) wall.add(id(x, y));
  const gate = id(m + r, m);
  const centre = (c: number): V2 => [(c % n) * 5 + 2.5, Math.floor(c / n) * 5 + 2.5];
  const L: RaidLayout = {
    grid: { count: n * n, nbr, centre },
    solid: (c) => wall.has(c),
    wall: (c) => wall.has(c),
    hp: (c) => opts.hp?.get(c) ?? blockHp(!!opts.gate && c === gate, 1),
    stores: id(m, m),
  };
  return { L, id, m, gate, wall };
}

describe('the waves\' clock', () => {
  it('warns RAID.warnLead days before dusk, comes at dusk, and every wave is bigger', () => {
    const day = ECON.daySec;
    const c = new RaidClock(day);
    const dusk = (RAID.firstDay + RAID.dusk) * day;
    const lead = RAID.warnLead * day;
    expect(c.update(dusk - lead - 1)).toEqual([]);
    expect(c.update(dusk - lead)).toEqual([{ kind: 'warn', wave: 0, size: RAID.size0 }]);
    expect(c.update(dusk - 1)).toEqual([]);
    expect(c.update(dusk)).toEqual([{ kind: 'arrive', wave: 0, size: RAID.size0 }]);
    // (the next: everyDays on, a bigger wave, warned again a day before)
    const next = (RAID.firstDay + RAID.everyDays + RAID.dusk) * day;
    expect(c.next).toBeCloseTo(next);
    expect(c.update(next - lead)).toEqual([{ kind: 'warn', wave: 1, size: RAID.size0 + RAID.grow }]);
    expect(c.update(next)[0]).toEqual({ kind: 'arrive', wave: 1, size: RAID.size0 + RAID.grow });
    expect(waveSize(0)).toBeLessThan(waveSize(1));
    expect(waveSize(100)).toBe(RAID.most);
  });

  it('"Call raiders now" brings the next wave at once, and the clock goes on from it', () => {
    const day = ECON.daySec;
    const c = new RaidClock(day);
    expect(c.call(10)).toEqual({ kind: 'arrive', wave: 0, size: RAID.size0 });
    expect(c.wave).toBe(1);
    expect(c.next).toBeCloseTo((RAID.everyDays + RAID.dusk) * day);
  });

  it('the side a wave comes from is the window edge nearest where it starts', () => {
    expect(sideOf([3, 100], { w: 256, h: 220 })).toBe('west');
    expect(sideOf([253, 100], { w: 256, h: 220 })).toBe('east');
    expect(sideOf([100, 2], { w: 256, h: 220 })).toBe('north');
    expect(sideOf([100, 218], { w: 256, h: 220 })).toBe('south');
  });
});

describe('where the raiders go', () => {
  it('an open town: straight to the stores', () => {
    const { L } = square(15, 4, { noRing: true });
    expect(raidSides(L).open).toBe(true);
    expect(raidGoal(L, [0, 0])).toEqual({ kind: 'stores' });
  });

  it('a walled town with a gate: the gate (it is weaker than a wall)', () => {
    const { L, gate } = square(15, 4, { gate: true });
    const s = raidSides(L);
    expect(s.open).toBe(false);
    // (from the west the gate is far, but it is the weakest)
    expect(raidGoal(L, [0, 37.5], s)).toEqual({ kind: 'breach', cell: gate });
  });

  it('a wall already battered is weaker than the gate: they go there', () => {
    const hp = new Map<number, number>();
    const t = square(15, 4, { gate: true, hp });
    const weak = t.id(t.m - 4, t.m + 2);
    hp.set(weak, 5);
    expect(raidGoal(t.L, [70, 37.5])).toEqual({ kind: 'breach', cell: weak });
  });

  it('walls all alike: the one nearest the raiders', () => {
    const t = square(15, 4);
    const g = raidGoal(t.L, [37.5, 0]);
    expect(g?.kind).toBe('breach');
    const [x, y] = t.L.grid.centre((g as { cell: number }).cell);
    expect(x).toBeCloseTo(37.5);
    expect(y).toBeLessThan(25);
  });

  it('a wall broken: the stores are open again', () => {
    const t = square(15, 4, { gate: true });
    t.wall.delete(t.gate);
    expect(raidGoal(t.L, [70, 37.5])).toEqual({ kind: 'stores' });
  });

  it('walls two deep: the outer wall nearest the stores', () => {
    const t = square(17, 5);
    const inner = square(17, 4);
    for (const c of inner.wall) t.wall.add(c);
    const g = raidGoal(t.L, [0, 0]);
    expect(g?.kind).toBe('breach');
    const c = (g as { cell: number }).cell;
    expect(inner.wall.has(c)).toBe(false);
    expect(t.wall.has(c)).toBe(true);
  });
});

describe('the loot and the wave\'s end', () => {
  it('the dearest goods first, RAID.loot a raider', () => {
    expect(lootOf({ stone: 50, grain: 2, weapons: 1 }, 2)).toEqual({ weapons: 1, grain: 2, stone: 2 * RAID.loot - 3 });
    expect(lootOf({}, 3)).toEqual({});
  });
  it('the wave runs when enough of it is down', () => {
    expect(waveBreaks(10, 10)).toBe(false);
    expect(waveBreaks(10, 5)).toBe(false);
    expect(waveBreaks(10, 4)).toBe(true);
  });
});

describe('repairs: a broken block is a planned block again', () => {
  it('breakBlock takes down the block and what stands on it; the plan keeps them, so the builders build them again', () => {
    const W = 160;
    const H = 184;
    const cols: ReachColumns = { w: W, h: H, runs: () => [[0, 5]], water: () => 0 };
    const f = new Fortress({ origin: [0, 0], w: W, h: H }, {
      windowOrigin: () => [0, 0],
      dims: { w: W, h: H, zMax: 999 },
      ground: () => 5,
      stores: () => ({}),
      changed: () => {},
      reach: new CpuReach(cols, W, H, () => [0, 0]),
      townHeap: () => [10, 10],
    });
    f.ready = true;
    const c = f.cellAt(80, 80);
    expect(f.paint(c, 0, 'house')).toBe(true);
    expect(f.paint(c, 1, 'house')).toBe(true);
    f.markBuilt(c, 0);
    f.markBuilt(c, 1);
    expect(f.todoCells()).toEqual([]);
    const told: number[][] = [];
    f.onBroken.push((_c, l) => told.push(l));
    expect(f.breakBlock(c, 0)).toEqual([1, 0]);
    expect(told).toEqual([[1, 0]]);
    expect(f.town.has(c, 0) || f.town.has(c, 1)).toBe(false);
    expect(f.town.planned(c, 0) && f.town.planned(c, 1)).toBe(true);
    expect(f.plan.has(c, 0) && f.plan.has(c, 1)).toBe(true);
    expect(f.todoCells()).toEqual([c]);
    // (nothing stands there now: nothing more comes down)
    expect(f.breakBlock(c, 0)).toEqual([]);
    // (rebuilt as any planned block is)
    f.markBuilt(c, 0);
    expect(f.town.has(c, 0)).toBe(true);
  });

  it('the gates shut and open', () => {
    const W = 160;
    const H = 184;
    const cols: ReachColumns = { w: W, h: H, runs: () => [[0, 5]], water: () => 0 };
    const f = new Fortress({ origin: [0, 0], w: W, h: H }, { windowOrigin: () => [0, 0], dims: { w: W, h: H, zMax: 999 }, ground: () => 5, stores: () => ({}), changed: () => {}, reach: new CpuReach(cols, W, H, () => [0, 0]), townHeap: () => [10, 10] });
    let n = 0;
    f.onChange.push(() => n++);
    f.setGatesShut(true);
    f.setGatesShut(true);
    expect(f.gatesShut).toBe(true);
    expect(n).toBe(1);
    f.setGatesShut(false);
    expect(f.gatesShut).toBe(false);
  });
});

describe('what the bar says of a raid (docs/WRITING.md)', () => {
  it('is plain', () => {
    const lines = [
      raidWarnLine('east', 4),
      raidArrivedLine('north', 6),
      ...['breach', 'stores', 'houses', 'out'].flatMap((st) => [raidNowLine(st, 1, null), raidNowLine(st, 5, 'gate')]),
      ...raidOverLines({ taken: { grain: 12, stone: 4 }, broken: { gate: 1, wall: 2 }, housesBurned: 2, fallen: ['Ann', null, 'Bo'], soldiersFallen: 1, raidersFallen: 5, raidersOut: 1 }),
      ...raidOverLines({ taken: {}, broken: {}, housesBurned: 0, fallen: [], soldiersFallen: 0, raidersFallen: 1, raidersOut: 0 }),
    ];
    expect(lines).toContain('A rider brings word. Raiders from the east, tomorrow at dusk. He counted 4 of them.');
    expect(lines.some((l) => /^The raiders got away with .*12 grain/.test(l) && l.includes('4 stone'))).toBe(true);
    expect(lines).toContain('They broke the gate and 2 wall blocks.');
    expect(lines).toContain('2 houses burned down.');
    expect(lines).toContain('1 raider died. 0 got away.');
    for (const l of lines) expect(lint(l), l).toEqual([]);
  });
});
