// (board, docs/design/BOARD.md) The raid played on the board in real time, about 25 seconds: raiders in red march in by
// the east road; they are met where your soldiers stand (a soldier on the watchtower out on the road, the wall walk by
// the gate, the free ones at the gate) and fall there; spells cast into the fight land on them. How many fall is the
// model's: the board shows the fight converging on the outcome the Realm predicts from the casts made (table/game.ts
// liveEvents), and the end is the Realm's own resolution (Table.resolveNow). Nothing here decides who wins.
import { roadPath } from './layout';
import type { TownScene } from './scene';
import { FOE } from './sprites';
import { tileXY } from './view';

export const RAID_MS = 24000;

interface Raider {
  key: string;
  engaged: boolean;
}

export class RaidPlay {
  readonly t0: number;
  private spawned = 0;
  private killed = 0;
  private fallenSoldiers = 0;
  private raiders: Raider[] = [];
  private route: [number, number][];
  /** where the raiders are met: world points and how far they reach */
  private posts: { x: number; y: number; r: number; tower: boolean }[] = [];
  done = false;

  /**
   * `n` raiders; `alive` how many the model says are left standing at the end as it stands; `soldiers` the model's
   * soldiers in the fight and `soldiersAlive` how many it says stand at the end; `fights`: the model counts the
   * soldiers at all (a keep or walls to gather at); `towers`: the manned watchtower and wall walk sites.
   */
  constructor(
    private s: TownScene,
    now: number,
    readonly n: number,
    public alive: number,
    readonly soldiers: number,
    public soldiersAlive: number,
    fights: boolean,
    towers: ('watch' | 'wall')[],
  ) {
    this.t0 = now;
    s.paused = true;
    const l = s.l;
    this.route = roadPath(l, l.entries.east, l.sites.keep).map((c) => tileXY(c.x, c.y));
    if (fights)
      for (const f of s.figs) if (f.look === 'soldier') this.posts.push({ x: f.x, y: f.y, r: 34, tower: false });
    for (const t of towers) {
      const [x, y] = s.siteXY(t);
      this.posts.push({ x, y, r: 110, tower: true });
    }
    // (the townspeople get off the street)
    s.figs = s.figs.filter((f) => !f.key.startsWith('folk'));
  }

  private get kills(): number {
    return Math.max(0, this.n - this.alive);
  }

  /** a spell landed: the model's new count of raiders left; those it puts down fall now where the raiders are thickest */
  cast(alive: number, now: number, colour: string): void {
    this.alive = alive;
    const extra = this.kills - this.killed;
    const live = this.liveFigs();
    const centre = live[Math.floor(live.length / 2)];
    if (centre) this.s.bursts.push({ x: centre.x, y: centre.y, t0: now, color: colour });
    for (let i = 0; i < extra && i < live.length; i++) this.kill(live[(Math.floor(live.length / 2) + i) % live.length].key, now);
  }

  private liveFigs() {
    const keys = new Set(this.raiders.map((r) => r.key));
    return this.s.figs.filter((f) => keys.has(f.key));
  }
  private kill(key: string, now: number): void {
    const f = this.s.figs.find((x) => x.key === key);
    if (f) this.s.bursts.push({ x: f.x, y: f.y - 10, t0: now, color: 'rgba(255,255,255,0.8)' });
    this.s.figs = this.s.figs.filter((x) => x.key !== key);
    this.raiders = this.raiders.filter((r) => r.key !== key);
    this.killed++;
  }

  /** a frame of the fight; true while it goes on */
  step(now: number): boolean {
    const t = now - this.t0;
    // (they come in a file down the road)
    while (this.spawned < this.n && t > this.spawned * 380) {
      const key = `raider#${this.spawned++}`;
      const [x, y] = this.route[0];
      this.s.figs.push({ key, look: 'raider', x: x + 30, y: y + 10, path: this.route.map(([a, b]) => [a + (Math.random() - 0.5) * 18, b + (Math.random() - 0.5) * 9] as [number, number]), speed: 30, mode: 'walk', phase: Math.random() * 6 });
      this.raiders.push({ key, engaged: false });
    }
    const live = this.liveFigs();
    // (met at a post: they stop and fight there; late in the fight the ones the model leaves standing push through)
    const push = t > RAID_MS * 0.62;
    for (const f of live) {
      const r = this.raiders.find((q) => q.key === f.key)!;
      const at = this.posts.find((p) => !p.tower && Math.hypot(p.x - f.x, p.y - f.y) < p.r);
      if (at && !push && this.killed < this.kills) {
        if (!r.engaged) {
          r.engaged = true;
          (f as { saved?: [number, number][] }).saved = f.path;
          f.path = [];
          f.mode = 'work';
        }
      } else if (r.engaged && (push || this.killed >= this.kills)) {
        r.engaged = false;
        f.path = (f as { saved?: [number, number][] }).saved ?? [];
        f.mode = 'walk';
      }
    }
    // (they fall at the posts and under the towers, paced so the model's count is reached in time)
    const due = Math.min(this.kills, Math.floor(this.kills * Math.max(0, Math.min(1, (t - 3500) / (RAID_MS * 0.6 - 3500)))));
    while (this.killed < due) {
      const near = live.filter((f) => this.posts.some((p) => Math.hypot(p.x - f.x, p.y - f.y) < p.r));
      const pick = near[0] ?? (t > RAID_MS * 0.5 ? live[0] : undefined);
      if (!pick) break;
      live.splice(live.indexOf(pick), 1);
      this.kill(pick.key, now);
    }
    // (soldiers who fall: the model's count, as the fight goes)
    const sDue = Math.floor((this.soldiers - this.soldiersAlive) / 3);
    if (this.fallenSoldiers < sDue && t > RAID_MS * 0.3 + this.fallenSoldiers * 2500) {
      const s = this.s.figs.find((f) => f.look === 'soldier');
      if (s) {
        this.s.bursts.push({ x: s.x, y: s.y - 10, t0: now, color: FOE });
        this.s.figs = this.s.figs.filter((f) => f !== s);
      }
      this.fallenSoldiers++;
    }
    // (those who reach the keep set it alight)
    const keep = this.s.siteXY('keep');
    for (const f of live) if (Math.hypot(f.x - keep[0], f.y - keep[1]) < 30 && Math.random() < 0.02) this.s.bursts.push({ x: f.x, y: f.y - 8, t0: now, color: 'rgba(255,140,40,0.8)' });
    const settled = this.spawned === this.n && this.killed >= this.kills && live.every((f) => !f.path.length);
    if (t > RAID_MS || (settled && t > 9000)) {
      this.done = true;
      return false;
    }
    return true;
  }

  /** the fight is over: raiders and the fallen leave the board, the town's figures come back */
  end(): void {
    const keys = new Set(this.raiders.map((r) => r.key));
    this.s.figs = this.s.figs.filter((f) => !keys.has(f.key) && f.look !== 'soldier');
    this.s.paused = false;
  }

  /** seconds left */
  left(now: number): number {
    return Math.max(0, Math.ceil((RAID_MS - (now - this.t0)) / 1000));
  }
  standing(): number {
    return this.n - this.killed;
  }
}
