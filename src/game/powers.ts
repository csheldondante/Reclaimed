// What the player's gestures do in the world (DECISIONS 2026-10-07, round 6).
//   Tap ground/plants  → small growth boost (or a visible wilt on bad ground)
//   Tap under a storm  → lightning (always takes precedence)
//   Tap elsewhere      → tactile response from whatever was touched
//   Drag anywhere      → wind along the drag; near a storm it also steers it
//   Hover              → a light breeze following the cursor
//   Summon (R/button)  → a storm forms upwind and rolls over the view
// Every power reads/writes only Weather, Nature, Globals (gusts/events) and
// particle bursts — never simulation internals.

import type { Ambience } from '../audio/ambience';
import type { Camera } from '../render/camera';
import type { PickHit } from '../render/renderer';
import { EventKind, type Gust, type GlobalsState } from '../sim/globals';
import { PK, type ParticleSystem } from '../sim/particles';
import type { Hud } from '../ui/hud';
import { MAT } from '../world/materials';
import type { Weather } from '../weather/weather';
import { COSTS, type Nature } from './nature';

const STORM_COOLDOWN = 25; // s between summons, on top of the Nature cost

export interface PowersDeps {
  weather: Weather;
  nature: Nature;
  audio: Ambience;
  hud: Hud;
  particles: ParticleSystem;
  globals: GlobalsState;
  camera: Camera;
  dims: { w: number; h: number };
  /** current surface heights (async readback, may be a frame or two old) */
  readSurface: () => Promise<Uint32Array>;
  /** total birds ever flushed from a perch (GPU counter, async readback) */
  birdsFlushed: () => Promise<number>;
}

export class Powers {
  private lastStrike = -10;
  private lastSummon = -STORM_COOLDOWN;
  private breeze: Gust = { x: 0, y: 0, radius: 7, strength: 0, dx: 1, dy: 0 };
  private cursor?: { x: number; y: number };
  /** the drag in progress: the segment drawn since the last frame is stamped into the wind field */
  private gust?: Gust & { lx: number; ly: number; vx: number; vy: number; t: number; moved: boolean };
  /** how hard the player's wind is blowing, for audio (fades after a drag) */
  private windLevel = { strength: 0, x: 0, y: 0 };
  private told = { lightning: false };

  constructor(private d: PowersDeps) {}

  // ---- per frame ----
  update(dt: number): void {
    const g = this.d.globals;
    this.breeze.strength *= Math.exp(-dt * 3);
    const gusts: Gust[] = [this.breeze];
    const gu = this.gust;
    if (gu) {
      // a held drag that stops moving keeps blowing where it is, dying down
      if (!gu.moved) {
        gu.strength *= Math.exp(-dt * 2);
        gu.len = 0;
      }
      gu.moved = false;
      gusts.push({ ...gu });
      // leaning on nearby storms while the drag lasts
      this.d.weather.gust(gu.x, gu.y, gu.dx, gu.dy, gu.strength * dt * 2.2);
      this.windLevel = { strength: Math.max(gu.strength, this.windLevel.strength), x: gu.x, y: gu.y };
    }
    // the stroke itself lives on in the wind field (~3 s); the audio follows it
    this.windLevel.strength *= Math.exp(-dt / 1.5);
    g.gusts = gusts;
  }

  stormReady(): number {
    const t = this.d.globals.time;
    return Math.min((t - this.lastSummon) / STORM_COOLDOWN, this.d.nature.value / COSTS.storm);
  }

  summonStorm(): void {
    const { weather, nature, hud, audio, globals } = this.d;
    if (this.stormReady() < 1 || !weather.canSpawn()) {
      audio.strain();
      return;
    }
    nature.trySpend(COSTS.storm);
    this.lastSummon = globals.time;
    const [tx, ty] = this.cursor ? [this.cursor.x, this.cursor.y] : [this.d.camera.target[0], this.d.camera.target[1]];
    weather.spawnToward(tx, ty);
    if (!this.told.lightning) {
      this.told.lightning = true;
      setTimeout(() => hud.say('A storm gathers upwind. Tap beneath it for lightning.', 8), 3000);
    }
  }

  // ---- hover ----
  hover(x: number, y: number, dt: number): void {
    if (this.cursor && dt > 0) {
      const vx = (x - this.cursor.x) / dt;
      const vy = (y - this.cursor.y) / dt;
      const sp = Math.hypot(vx, vy);
      if (sp > 0.5) {
        const b = this.breeze;
        b.x = x;
        b.y = y;
        b.dx = vx / sp;
        b.dy = vy / sp;
        b.strength = Math.max(b.strength, Math.min(sp * 0.08, 4));
      }
    }
    this.cursor = { x, y };
  }

  // ---- tap ----
  tap(hit: PickHit | null, wx: number, wy: number, sx: number, sy: number): void {
    const { weather } = this.d;
    if (hit === null) return;
    const x = (hit.cell % this.d.dims.w) + 0.5;
    const y = Math.floor(hit.cell / this.d.dims.w) + 0.5;
    // under a storm a tap is lightning — when Nature can pay for it. Taps
    // never depend on Nature: otherwise it is an ordinary touch (clink, crack,
    // grow; DECISIONS round 7)
    const underStorm = weather.coverAt(x, y) > 0.3 || weather.coverAt(wx, wy) > 0.3;
    if (underStorm && this.d.nature.value >= COSTS.lightning && this.d.globals.time - this.lastStrike >= 0.8) {
      void this.lightning(hit.cell, sx, sy);
      return;
    }
    this.touch(hit, x, y, sx / Math.max(1, this.d.camera.viewportW));
  }

  /** Tactile, mostly cosmetic responses (chips are "decay", not demolition). */
  private touch(hit: PickHit, x: number, y: number, at: number): void {
    const { audio, particles } = this.d;
    // every tap startles animals nearby (they flee the breeze impulse)
    this.puff(x, y, 6);
    const z = hit.z + 0.6;
    const veg = (hit.flags & 2) !== 0;
    if (veg || hit.mat === MAT.Leaves || hit.mat === MAT.Wood) {
      particles.burst({ kind: PK.Leaf, x, y, z: z + 1, count: 14, speed: 3, spread: 1.2 });
      audio.rustle(1, at);
      // only a tree with birds in it gives up birds: startle any perched in
      // its crown, and flap if some actually went (GPU counter readback)
      this.d.globals.events.push({ kind: EventKind.Scare, x, y, radius: 3.2, strength: 1 });
      void this.listenForWings(at);
      // and the living ground around it gets a little boost (round 6)
      this.d.globals.events.push({ kind: EventKind.Grow, x, y, radius: 2.5, strength: 1 });
      audio.grow(at);
      this.puff(x, y, 2.5);
      return;
    }
    switch (hit.mat) {
      case MAT.Rust:
        audio.clang(at);
        particles.burst({ kind: PK.Chip, x, y, z, count: 3, speed: 2.5, spread: 0.3 });
        break;
      case MAT.Concrete:
      case MAT.Brick:
      case MAT.Asphalt:
        audio.chip(at);
        particles.burst({ kind: PK.Chip, x, y, z, count: 7, speed: 3.5, spread: 0.4 });
        // real (small) decay: cracks show, and a dozen taps will bring a piece down
        if (hit.mat !== MAT.Asphalt) {
          this.d.globals.events.push({ kind: EventKind.Chip, x, y, z: hit.z, radius: 1.8, strength: 1 });
        }
        particles.burst({ kind: PK.Dust, x, y, z, count: 6, speed: 1.2, spread: 0.6 });
        break;
      case MAT.Water:
      case MAT.Oil:
        audio.splash(at);
        // the picked z is floored: start the spray clearly above the surface
        particles.burst({ kind: PK.Splash, x, y, z: hit.z + 1.4, count: 24, speed: 4.5, spread: 0.25 });
        break;
      default:
        particles.burst({ kind: PK.Dust, x, y, z, count: 8, speed: 1.6, spread: 0.6 });
        audio.rustle(0.4, at);
        // a tap on open ground: growth where life can take, a wilt where it
        // can't (green sparkles vs brown flecks — round 6)
        this.d.globals.events.push({ kind: EventKind.Grow, x, y, radius: 2.5, strength: 1 });
        audio.grow(at);
    }
  }

  private async listenForWings(at: number): Promise<void> {
    const before = await this.d.birdsFlushed();
    // the scare event is consumed on the next tick; give it a few frames
    await new Promise((r) => setTimeout(r, 120));
    const after = await this.d.birdsFlushed();
    if (after > before) this.d.audio.flutter(at, Math.min(1.5, 0.6 + (after - before) * 0.15));
  }

  /** A short local breeze (makes nearby plants sway, lifts dust). */
  private puff(x: number, y: number, strength: number): void {
    const b = this.breeze;
    b.x = x;
    b.y = y;
    b.strength = Math.max(b.strength, strength);
  }

  // ---- lightning ----
  private async lightning(cell: number, sx: number, sy: number): Promise<void> {
    const { nature, globals, hud, audio, dims } = this.d;
    const tx = cell % dims.w;
    const ty = Math.floor(cell / dims.w);
    nature.trySpend(COSTS.lightning);
    this.lastStrike = globals.time;
    // lightning seeks the highest point near the tap
    const surf = await this.d.readSurface();
    let bx = tx;
    let by = ty;
    let best = -Infinity;
    const R = 7;
    for (let y = Math.max(0, ty - R); y <= Math.min(dims.h - 1, ty + R); y++)
      for (let x = Math.max(0, tx - R); x <= Math.min(dims.w - 1, tx + R); x++) {
        const d = Math.hypot(x - tx, y - ty);
        if (d > R) continue;
        const score = (surf[y * dims.w + x] & 0xff) - 0.4 * d;
        if (score > best) {
          best = score;
          bx = x;
          by = y;
        }
      }
    const bz = surf[by * dims.w + bx] & 0xff;
    globals.events.push({ kind: EventKind.Lightning, x: bx + 0.5, y: by + 0.5, radius: 5, strength: 20 });
    globals.flash = 1;
    const [px, py] = this.d.camera.project(bx + 0.5, by + 0.5, bz);
    hud.bolt(px, py);
    audio.thunder(1, 1, px / Math.max(1, this.d.camera.viewportW));
    this.d.particles.burst({ kind: PK.Chip, x: bx + 0.5, y: by + 0.5, z: bz + 0.5, count: 12, speed: 6, spread: 0.5 });
    void sx;
    void sy;
  }

  // ---- drag gesture: wind ----
  // Every LMB drag is wind (DECISIONS rounds 4–5): a gust that follows the
  // cursor, as strong as the drag is fast, lingering 1–2.5 s after it, rippling water, grass and leaves
  // and lifting loose debris. Dragging under or near a storm also leans on
  // it — there is no arrow or hint; players discover they can steer storms.

  /** Drag start: always a wind gesture. */
  gustStart(wx: number, wy: number): boolean {
    this.gust = { x: wx, y: wy, lx: wx, ly: wy, vx: 0, vy: 0, t: performance.now(), radius: 7, strength: 0, dx: 1, dy: 0, len: 0, moved: false };
    return true;
  }

  gustMove(wx: number, wy: number): void {
    const g = this.gust;
    if (!g) return;
    const now = performance.now();
    const dt = Math.max(1e-3, (now - g.t) / 1000);
    g.t = now;
    const mx = wx - g.lx;
    const my = wy - g.ly;
    const step = Math.hypot(mx, my);
    // smoothed cursor velocity (cells/s) sets the strength
    const k = Math.min(1, dt * 10);
    g.vx += (mx / dt - g.vx) * k;
    g.vy += (my / dt - g.vy) * k;
    const sp = Math.hypot(g.vx, g.vy);
    if (step > 0.05) {
      g.dx = mx / step;
      g.dy = my / step;
    }
    // this frame's piece of the stroke: from where the cursor was to where it is
    g.x = wx;
    g.y = wy;
    g.len = step;
    g.strength = Math.min(24, sp * 0.22);
    g.lx = wx;
    g.ly = wy;
    g.moved = true;
  }

  gustEnd(): void {
    const g = this.gust;
    if (!g) return;
    this.gust = undefined;
    if (g.strength > 4) this.d.audio.rustle(Math.min(1.5, g.strength / 8), this.d.camera.project(g.x, g.y, 0)[0] / this.d.camera.viewportW);
  }

  /** How hard the player's wind is blowing (for audio), if at all. */
  dragWind(): { strength: number; x: number; y: number } | undefined {
    return this.windLevel.strength > 0.2 ? this.windLevel : undefined;
  }
}
