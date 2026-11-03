import { describe, expect, it } from 'vitest';
import { wayAhead } from '../camera/ahead';
import { Autopilot } from './autopilot';
import { Stations, type LabResult, type LabStation } from './lab';
import { ride, sight } from './ride';
import { G, LAB_TERRAINS } from './terrains';

describe('the lab terrains', () => {
  it('six stations, each path inside its rect, on ground a bike rides', () => {
    expect(LAB_TERRAINS.map((t) => t.id)).toEqual(['cliff', 'canyon', 'forest', 'city', 'cave', 'hills']);
    const s = sight();
    for (const t of LAB_TERRAINS) {
      const [x0, y0, x1, y1] = t.rect;
      for (const p of t.path) {
        expect(p.at[0] >= x0 && p.at[0] < x1 && p.at[1] >= y0 && p.at[1] < y1, `${t.id} ${p.at}`).toBe(true);
        // (no path point on a cliff top or a roof: the ride is on the floor)
        expect(s.top(p.at[0], p.at[1]), `${t.id} at ${p.at.map((v) => v.toFixed(1))}`).toBeLessThan(G + (t.id === 'hills' ? 11 : 4));
      }
    }
  });

  it('the cliff: a tall face, a notch that is a dead end, a corner that leads on', () => {
    const s = sight();
    expect(s.top(40, 60)).toBeGreaterThan(G + 30);
    // (riding north into the notch from its mouth: a dead end)
    const into = wayAhead(s.top, [49, 30], Math.PI / 2, { dist: 30, step: 1, climb: 1.2, fan: (10 * Math.PI) / 180, maxTurn: (125 * Math.PI) / 180, bounds: s.bounds, margin: 2 });
    expect(into.open).toBe(false);
    // (riding east along the south face toward the corner: it goes on round it)
    const on = wayAhead(s.top, [58, 27], 0, { dist: 30, step: 1, climb: 1.2, fan: (10 * Math.PI) / 180, maxTurn: (125 * Math.PI) / 180, bounds: s.bounds, margin: 2 });
    expect(on.open).toBe(true);
  });

  it('the cave has a roof over air at its mouth, the sky floor over it', () => {
    const s = sight();
    const t = LAB_TERRAINS.find((x) => x.id === 'cave')!;
    const [mx, my] = t.pois[0];
    const col = s.solid(mx, my + 4)!;
    expect(col.length).toBeGreaterThan(2);
    expect(col[1].z1).toBeLessThan(col[2].z0);
  });

  it('the forest is woods (trees in the camera\'s sight)', () => {
    const s = sight();
    const t = LAB_TERRAINS.find((x) => x.id === 'forest')!;
    const c = [(t.rect[0] + t.rect[2]) / 2, (t.rect[1] + t.rect[3]) / 2];
    expect(s.props!(c[0], c[1], 20).length).toBeGreaterThan(20);
  });
});

describe('the autopilot', () => {
  it('steers along a square and keeps its progress', () => {
    const pilot = new Autopilot([
      { at: [0, 0], speed: 1 },
      { at: [10, 0], speed: 0.5 },
      { at: [10, 10], speed: 1 },
      { at: [0, 10], speed: 1 },
    ], 3);
    expect(pilot.length).toBeCloseTo(40, 6);
    const d = pilot.steer([2, 0]);
    expect(d[0]).toBeGreaterThan(0.5);
    expect(Math.abs(d[1])).toBeLessThan(1e-6);
    expect(pilot.progress).toBeCloseTo(0.05, 6);
  });

  it('rides the bike round each station', () => {
    for (const t of LAB_TERRAINS) {
      const r = ride(t.id, ['chase'], { secs: 25 });
      expect(r.laps, t.id).toBeGreaterThan(0.6);
      expect(r.speed, t.id).toBeGreaterThan(6);
    }
  }, 60_000);
});

describe('encounters (HL11)', () => {
  const ctx = { x: 0, dead: false };
  const station = (id: string, time?: number): LabStation<typeof ctx> => ({
    id,
    kind: 'enemy',
    name: id,
    hint: '',
    enter: (c) => {
      c.x = 0;
      c.dead = false;
    },
    update: (c, dt) => {
      c.x += dt;
    },
    goal: { text: 'Get to 2.', time, check: (c) => (c.dead ? { state: 'lost', note: 'Knocked out' } : c.x >= 2 ? { state: 'won' } : { state: 'on', done: c.x / 2, note: `${(2 - c.x).toFixed(0)} to go` }) },
  });
  it('a goal is checked each frame; won, lost or out of time ends it once, with the time', () => {
    const results: LabResult[] = [];
    const st = new Stations([station('win'), station('slow', 1), station('die')], ctx);
    st.ended.push((r) => results.push(r));
    st.go('win');
    for (let k = 0; k < 300; k++) st.update(1 / 60);
    expect(results).toHaveLength(1);
    expect(results[0].state).toBe('won');
    expect(results[0].time).toBeCloseTo(2, 1);
    st.go('slow');
    for (let k = 0; k < 120; k++) st.update(1 / 60);
    expect(results[1]).toMatchObject({ station: 'slow', state: 'lost', note: 'Out of time' });
    st.go('die');
    st.update(1 / 60);
    ctx.dead = true;
    st.update(1 / 60);
    expect(results[2]).toMatchObject({ station: 'die', state: 'lost', note: 'Knocked out' });
    expect(results).toHaveLength(3);
  });
});
