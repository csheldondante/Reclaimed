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

  it('(pass 2) every slash lunges: a slash from standing carries ~1.6 cells, the double swipe several times that', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    new Finger().play(k, w, line([600, 600], [660, 600], 3));
    idle(k, w, 50);
    expect(k.position()[0] - 50).toBeGreaterThan(KNIGHT_DEFAULTS.slashLunge * 0.85);
    expect(k.position()[0] - 50).toBeLessThan(KNIGHT_DEFAULTS.slashLunge * 1.3);
  });

  it('(pass 2) slashes alone carry it through a pack of eight to the far side, ending clear of every body', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [51, 50]);
    // (a pack 4 cells across at x 54..58, two staggered columns of four; they stand and take the blows)
    const pack: Pt[] = [];
    for (let i = 0; i < 4; i++) pack.push([54.5, 48.5 + i], [56.5, 49 + i]);
    for (const p of pack) w.add(p, 1000);
    const f = new Finger();
    let slashes = 0;
    let t = 0;
    while (k.position()[0] < 60 && slashes < 20) {
      f.play(k, w, line([600, 600], [660, 600], 3));
      slashes++;
      idle(k, w, 12);
      t += 16 * DT;
    }
    idle(k, w, 30);
    expect(k.position()[0]).toBeGreaterThan(59);
    expect(slashes).toBeLessThanOrEqual(6);
    const [x, y] = k.position();
    for (const p of pack) expect(Math.hypot(p[0] - x, p[1] - y)).toBeGreaterThan(0.5);
    expect(t).toBeLessThan(2);
  });

  it('(pass 2) a blow a guard blocks stops the dash and knocks the knight back; a dodge only counts', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    const g = w.add([51.5, 50], 1000);
    new Finger().play(k, w, line([600, 600], [660, 600], 3));
    // (the blow's out: the units report it blocked a frame later)
    idle(k, w, 6);
    expect(struck(w, g).length).toBeGreaterThan(0);
    w.turn(g, false);
    idle(k, w, 1);
    expect(k.stats.blocked).toBe(1);
    expect(k.status()).toBe('BLOCKED');
    const a = k.act;
    expect(a.kind === 'swing' ? a.dash?.left : 0).toBe(0);
    expect(k.f.vx).toBeLessThan(0);
    w.turn(g, true);
    idle(k, w, 1);
    expect(k.stats.dodgedBy).toBe(1);
    expect(k.status()).toBe('DODGED');
  });

  it('(pass 2) JUMP lifts it onto a ledge 2.5 cells up that it cannot walk up; walking, it stops at the face', () => {
    // (a ledge from x 53 on, 2.5 cells over the ground at 2)
    const ledge = (x: number) => (x >= 53 ? 4.5 : 2);
    const walk = testWorld(ledge);
    const k0 = new KnightHero(walk, [50, 50]);
    idle(k0, walk, 90, { dir: [1, 0] });
    expect(k0.position()[0]).toBeLessThan(53);
    const w = testWorld(ledge);
    const k = new KnightHero(w, [50, 50]);
    idle(k, w, 10, { dir: [1, 0] });
    idle(k, w, 1, { dir: [1, 0], buttons: [true] });
    expect(k.act.kind).toBe('jump');
    let top = 0;
    run(80, () => {
      idle(k, w, 1, { dir: [1, 0] });
      top = Math.max(top, k.position()[2]);
    });
    expect(top - 2).toBeGreaterThan(1.9);
    expect(k.position()[0]).toBeGreaterThan(53.5);
    expect(k.position()[2]).toBeCloseTo(4.5, 1);
    expect(k.act.kind).toBe('idle');
  });

  it('(pass 2) a swipe in the air is the jump attack: down on the raider, a stomp and a shockwave from above', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    const r = w.add([52.2, 50], 1000);
    const other = w.add([51.5, 51.6], 1000);
    idle(k, w, 1, { buttons: [true] });
    idle(k, w, 18);
    new Finger().play(k, w, line([600, 600], [660, 600], 3));
    expect(['plunge', 'land']).toContain(k.act.kind);
    idle(k, w, 30);
    expect(k.stats.slams).toBe(1);
    const st = struck(w, r);
    expect(st.length).toBeGreaterThan(0);
    expect(st.every((h) => h.overhead)).toBe(true);
    // (the shockwave reaches the one beside it too)
    expect(w.strikes.some((h) => h.radius >= KNIGHT_DEFAULTS.slamRadius && Math.hypot(h.at[0] - 51.5, h.at[1] - 51.6) < h.radius)).toBe(true);
    void other;
    // (landed on it, near enough: the plunge carried it there)
    expect(Math.hypot(k.position()[0] - 52.2, k.position()[1] - 50)).toBeLessThan(1);
  });

  it('(pass 2) a tap on an enemy locks it; a swipe the rough way then goes straight at it; a tap on the ground lets go', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    const a = w.add([53, 52], 1000);
    w.add([53, 48], 1000);
    // (a tap: down and up within a few px, quickly, on its middle as the test camera draws it)
    const mid = w.project(53, 52, 2 + 0.8);
    new Finger().play(k, w, [mid, [mid[0] + 3, mid[1] + 2]]);
    expect(k.lock).toBe(a);
    expect(k.stats.swings).toBe(0);
    // (a swipe straight right: 34° off the locked one — it goes at it)
    new Finger().play(k, w, line([600, 600], [660, 600], 3));
    const aimed = k.lastAim!.aimed;
    expect(Math.atan2(aimed[1], aimed[0])).toBeCloseTo(Math.atan2(2, 3), 2);
    expect(k.framing()).not.toBeNull();
    idle(k, w, 30);
    new Finger().play(k, w, [[100, 100], [102, 101]]);
    expect(k.lock).toBeNull();
  });

  it('(pass 2) the hook gun: a tap on a ledge top zips the knight up onto it; a tap on a foe yanks it in', () => {
    const ledge = (x: number) => (x >= 56 ? 6 : 2);
    const w = testWorld(ledge);
    const k = new KnightHero(w, [50, 50]);
    idle(k, w, 1, { buttons: [false, false, true] });
    idle(k, w, 1);
    idle(k, w, 1, { buttons: [false, false, true] });
    idle(k, w, 1);
    expect(k.arm).toBe('hook');
    // (a tap on the ledge top, 4 cells up and 8 along)
    const top = w.project(58, 50, 6);
    new Finger().play(k, w, [top, [top[0] + 2, top[1]]]);
    expect(k.stats.zips).toBe(1);
    idle(k, w, 90);
    expect(k.position()[0]).toBeGreaterThan(56.5);
    expect(k.position()[2]).toBeCloseTo(6, 1);
    // (a foe on the ground below: tapped, it's held and lobbed in)
    const foe = w.add([50, 50], 1000);
    const at = w.project(50, 50, 2 + 0.8);
    new Finger().play(k, w, [at, [at[0] + 1, at[1]]]);
    expect(k.stats.hooks).toBe(1);
    expect(k.lock).toBe(foe);
    expect(w.releases.some((r) => r.id === foe && r.vel !== undefined)).toBe(true);
  });

  it('(pass 2) parry variants: PARRY just before a blow, a swipe at one winding up, BLOCK held in time — each throws the attacker open', () => {
    const setup = (mode: number) => {
      const w = testWorld(flat);
      const k = new KnightHero(w, [50, 50], { ...KNIGHT_DEFAULTS, parryMode: mode });
      const r = w.add([51.2, 50], 1000);
      k.f.heading = 0;
      return { w, k, r };
    };
    // 1: PARRY pressed, the blow 0.1 s later: parried; pressed and the blow 0.3 s later: hurt
    let { w, k, r } = setup(1);
    idle(k, w, 1, { buttons: [false, false, false, false, true] });
    idle(k, w, 6);
    k.take(1, [51.2, 50], r);
    expect(k.health).toBe(k.maxHealth);
    expect(k.stats.parries).toBe(1);
    expect(w.releases.find((x) => x.id === r)?.stun).toBeCloseTo(KNIGHT_DEFAULTS.parryStagger, 6);
    idle(k, w, 40);
    idle(k, w, 1, { buttons: [false, false, false, false, true] });
    idle(k, w, 18);
    k.take(1, [51.2, 50], r);
    expect(k.health).toBe(k.maxHealth - 1);
    // 2: a swipe at it while it winds up
    ({ w, k, r } = setup(2));
    w.state.set(r, 'swing');
    new Finger().play(k, w, line([600, 600], [660, 600], 3));
    expect(k.stats.parries).toBe(1);
    // 3: BLOCK held: begun just before the blow, a parry; held long, a block (no harm, no parry); from behind, hurt
    ({ w, k, r } = setup(3));
    const hold = { buttons: [false, false, false, false, true] };
    idle(k, w, 3, hold);
    k.take(1, [51.2, 50], r);
    expect(k.stats.parries).toBe(1);
    idle(k, w, 30, hold);
    k.take(1, [51.2, 50], r);
    expect(k.stats.shielded).toBe(1);
    expect(k.health).toBe(k.maxHealth);
    k.take(1, [48.8, 50], r);
    expect(k.health).toBe(k.maxHealth - 1);
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
    idle(k, w, 1, { buttons: [false, false, true] });
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
    idle(k, w, 1, { buttons: [false, false, true] });
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
    // (the circle's first 30 px slashed, and pass 2's slash dashes: the crowd is set round where the spin began)
    const [cx, cy] = k.position();
    const crowd = [w.add([cx + 4, cy + 0.2], 50), w.add([cx + 5, cy - 0.5], 50), w.add([cx + 4.5, cy + 1], 50)];
    // (a full fling right, into them)
    new Finger().play(k, w, line([600, 600], [780, 600], 4));
    idle(k, w, 60);
    expect(k.stats.bounces).toBeGreaterThan(0);
    expect(struck(w, crowd[0]).length).toBeGreaterThan(0);
    // (it came back off them: a top bounced, not one that ploughed through)
    expect(k.position()[0]).toBeLessThan(cx + 4);
  });

  it('✦ spins with the sword; DODGE dashes the stick\'s way and blows pass through while it does', () => {
    const w = testWorld(flat);
    const k = new KnightHero(w, [50, 50]);
    idle(k, w, 1, { buttons: [false, false, false, true] });
    expect(k.act.kind).toBe('spin');
    const w2 = testWorld(flat);
    const d = new KnightHero(w2, [50, 50]);
    idle(d, w2, 1, { buttons: [false, true], dir: [0, 1] });
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
