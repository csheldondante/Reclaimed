// (knight, round 128) The knight at its contract, on tiny synthetic worlds (play/testing.ts): its run against the
// other heroes, a swipe's slash and lunge with the aim lean, the bow drawn back and loosed the other way, the spin
// caroming off enemies, the dodge passing blows through.
import { describe, expect, it } from 'vitest';
import type { Pt } from '../core/gestures';
import { KNIGHT_DEFAULTS } from '../controllers/knight';
import type { Thumb } from '../input/types';
import { input, testWorld, type TestWorld } from '../testing';
import { BikeHero } from './bike';
import { KnightHero } from './knight';
import { LichHero } from './lich';

const DT = 1 / 60;
const flat = () => 2;
const run = (n: number, f: (i: number) => void) => {
  for (let i = 0; i < n; i++) f(i);
};

/** A scripted right thumb: a stroke through screen points, one a frame, let go at the last (Thumb ids from 1). */
class Finger {
  private n = 0;
  play(k: KnightHero, w: TestWorld, pts: Pt[], o: { dir?: Pt; hold?: number } = {}): void {
    const id = ++this.n + 1000;
    const samples: { at: Pt; t: number }[] = [];
    pts.forEach((p, i) => {
      samples.push({ at: p, t: k.t + DT });
      const last = i === pts.length - 1 && !o.hold;
      const th: Thumb = { id, samples: [...samples], ended: last, endedAt: last ? k.t + DT : undefined };
      k.update(DT, { move: o.dir ?? [0, 0], input: input({ dir: o.dir ?? [0, 0], thumbs: [th] }) });
      w.tick(DT);
    });
    if (o.hold) {
      run(o.hold, () => {
        k.update(DT, { move: o.dir ?? [0, 0], input: input({ dir: o.dir ?? [0, 0], thumbs: [{ id, samples: [...samples], ended: false }] }) });
        w.tick(DT);
      });
      k.update(DT, { move: o.dir ?? [0, 0], input: input({ dir: o.dir ?? [0, 0], thumbs: [{ id, samples: [...samples], ended: true, endedAt: k.t + DT }] }) });
    }
  }
}
const line = (from: Pt, to: Pt, n: number): Pt[] => Array.from({ length: n + 1 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n]);
const idle = (k: KnightHero, w: TestWorld, n: number, o: { dir?: Pt; buttons?: boolean[] } = {}) =>
  run(n, () => {
    k.update(DT, { move: o.dir ?? [0, 0], input: input({ dir: o.dir ?? [0, 0], buttons: o.buttons ?? [] }) });
    w.tick(DT);
  });
const struck = (w: TestWorld, id: number) => {
  const u = w.list.find((v) => v.id === id)!;
  return w.strikes.filter((h) => Math.hypot(h.at[0] - u.at[0], h.at[1] - u.at[1]) < 0.7 && h.damage > 0);
};

describe('the knight', () => {
  it('runs faster than the lich by a bit and slower than the bike', () => {
    const top = (h: { update: (dt: number, i: { move: [number, number]; input: ReturnType<typeof input> }) => void; speed(): number }) => {
      let s = 0;
      run(300, () => {
        h.update(DT, { move: [1, 0], input: input({ dir: [1, 0] }) });
        s = Math.max(s, h.speed());
      });
      return s;
    };
    const w = testWorld(flat);
    const knight = top(new KnightHero(w, [50, 50]));
    const lich = top(new LichHero(w, [50, 100]));
    const bike = top(new BikeHero(w, [50, 150]));
    expect(knight).toBeCloseTo(KNIGHT_DEFAULTS.speed, 1);
    expect(knight).toBeGreaterThan(lich * 1.1);
    expect(knight).toBeLessThan(lich * 1.6);
    expect(knight).toBeLessThan(bike * 0.5);
  });

  it('a swipe toward an enemy slashes it, lunging the knight that way; one behind it is spared', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    const ahead = w.add([52, 50]);
    const behind = w.add([48, 50]);
    // (the test camera: screen = world × 20, so a swipe right is +x)
    new Finger().play(k, w, line([600, 600], [660, 600], 4));
    const x0 = k.position()[0];
    idle(k, w, 30);
    expect(struck(w, ahead).length).toBeGreaterThan(0);
    expect(struck(w, behind)).toHaveLength(0);
    expect(k.position()[0]).toBeGreaterThan(x0 + 0.1);
    expect(k.stats.hits).toBe(1);
  });

  it('leans the swipe slightly toward the enemy it means (a swipe 20° off still finds it)', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    const a = (20 * Math.PI) / 180;
    const id = w.add([50 + Math.cos(a) * 2.6, 50 + Math.sin(a) * 2.6]);
    new Finger().play(k, w, line([600, 600], [660, 600], 4));
    expect(k.lastAim?.target).toBe(id);
    const lean = Math.atan2(k.lastAim!.aimed[1], k.lastAim!.aimed[0]);
    expect(lean).toBeGreaterThan(0.05);
    expect(lean).toBeLessThan(a);
  });

  it('two quick swipes the same way: the second is the lunge, carrying it much further', () => {
    const lungeRun = (double: boolean) => {
      const w = testWorld(flat);
      const k = new KnightHero(w, [50, 50]);
      const f = new Finger();
      f.play(k, w, line([600, 600], [660, 600], 3));
      if (double) f.play(k, w, line([600, 600], [660, 600], 3));
      idle(k, w, double ? 40 : 46);
      return { x: k.position()[0], lunges: k.stats.lunges };
    };
    const one = lungeRun(false);
    const two = lungeRun(true);
    expect(two.lunges).toBe(1);
    expect(two.x).toBeGreaterThan(one.x + 1);
  });

  it('swipes chain the combo: three swings, the third a wide finisher', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    const f = new Finger();
    // (each swipe turned more than the lunge's 40° from the last, so they chain rather than lunge)
    f.play(k, w, line([600, 600], [660, 600], 3));
    f.play(k, w, line([600, 600], [600, 660], 3));
    idle(k, w, 6);
    f.play(k, w, line([600, 600], [540, 600], 3));
    idle(k, w, 40);
    expect(k.stats.swings).toBe(3);
    expect(k.stats.lunges).toBe(0);
  });

  it('the bow: drawn back and let go, the arrow flies the opposite way and hits what is there', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    idle(k, w, 1, { buttons: [false, true] });
    idle(k, w, 1);
    expect(k.arm).toBe('bow');
    const target = w.add([58, 50]);
    // (pulled left: it shoots right; held a full draw)
    new Finger().play(k, w, line([600, 600], [480, 600], 6), { hold: 50 });
    expect(k.stats.arrows).toBe(1);
    idle(k, w, 60);
    expect(k.stats.arrowHits).toBe(1);
    expect(struck(w, target)[0].damage).toBeGreaterThan(KNIGHT_DEFAULTS.arrowDamageHigh * 0.8);
  });

  it('a draw let go at once (under the least charge) fizzles; a quick flick on the bow rolls', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    idle(k, w, 1, { buttons: [false, true] });
    idle(k, w, 1);
    new Finger().play(k, w, line([600, 600], [580, 620], 2));
    expect(k.stats.arrows).toBe(0);
    new Finger().play(k, w, line([600, 600], [700, 600], 3));
    expect(k.stats.dodges).toBe(1);
    expect(k.act.kind).toBe('dodge');
  });

  it('the spin: a circle drawn spins it; flicked into a crowd it cuts the first and caroms back off it', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    const ring: Pt[] = Array.from({ length: 28 }, (_, i) => [600 + 60 * Math.cos((i * Math.PI * 2) / 24), 600 + 60 * Math.sin((i * Math.PI * 2) / 24)]);
    new Finger().play(k, w, ring);
    expect(k.act.kind).toBe('spin');
    const crowd = [w.add([54, 50.2], 50), w.add([55, 49.5], 50), w.add([54.5, 51], 50)];
    // (a full fling right, into them)
    new Finger().play(k, w, line([600, 600], [780, 600], 4));
    idle(k, w, 60);
    expect(k.stats.bounces).toBeGreaterThan(0);
    expect(struck(w, crowd[0]).length).toBeGreaterThan(0);
    // (it came back off them: a top bounced, not one that ploughed through)
    expect(k.position()[0]).toBeLessThan(54);
  });

  it('✦ spins with the sword; DODGE dashes the stick\'s way and blows pass through while it does', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    idle(k, w, 1, { buttons: [false, false, true] });
    expect(k.act.kind).toBe('spin');
    const w2 = testWorld(flat);
    const d = new KnightHero(w2, [50, 50]);
    idle(d, w2, 1, { buttons: [true], dir: [0, 1] });
    expect(d.act.kind).toBe('dodge');
    d.take(3, [50, 49]);
    expect(d.health).toBe(d.maxHealth);
    idle(d, w2, 30, { dir: [0, 1] });
    expect(d.position()[1]).toBeGreaterThan(53);
    d.take(3, [50, 49]);
    expect(d.health).toBe(d.maxHealth - 3);
  });

  it('draws as a posed generator body with its sword (a few hundred voxels at most)', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    idle(k, w, 20, { dir: [1, 0] });
    const parts = k.parts();
    const n = parts.reduce((a, p) => a + p.voxels.length, 0);
    expect(n).toBeGreaterThan(40);
    expect(n).toBeLessThan(900);
    // (its head is about a person's height over its feet)
    const top = Math.max(...parts.flatMap((p) => p.voxels.map((v) => p.at[2] + v.at[2])));
    expect(top - k.position()[2]).toBeGreaterThan(1.4);
    expect(top - k.position()[2]).toBeLessThan(2.4);
  });
});
