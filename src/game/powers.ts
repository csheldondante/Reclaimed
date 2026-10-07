// What the player's gestures do in the world (DECISIONS 2026-10-07).
//   Tap under a storm  → lightning (always takes precedence)
//   Tap elsewhere      → tactile response from whatever was touched
//   Drag under a storm → a big gust along the drag (also shoves the storm)
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
}

export class Powers {
  private lastStrike = -10;
  private lastSummon = -STORM_COOLDOWN;
  private breeze: Gust = { x: 0, y: 0, radius: 7, strength: 0, dx: 1, dy: 0 };
  private cursor?: { x: number; y: number };
  private gust?: Gust & { sx: number; sy: number; ttl: number; weak: boolean };
  private told = { lightning: false, gust: false };

  constructor(private d: PowersDeps) {}

  // ---- per frame ----
  update(dt: number): void {
    const g = this.d.globals;
    this.breeze.strength *= Math.exp(-dt * 3);
    const gusts: Gust[] = [this.breeze];
    if (this.gust) {
      if (this.gust.ttl < 99) this.gust.ttl -= dt;
      if (this.gust.ttl <= 0) this.gust = undefined;
      else gusts.push({ ...this.gust, strength: this.gust.strength * Math.min(1, this.gust.ttl / 1.5) });
    }
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
      setTimeout(() => hud.say('A storm gathers upwind. Tap beneath it for lightning; drag beneath it to make the wind gust.', 8), 3000);
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
    if (weather.coverAt(x, y) > 0.3 || weather.coverAt(wx, wy) > 0.3) {
      void this.lightning(hit.cell, sx, sy);
      return;
    }
    this.touch(hit, x, y);
  }

  /** Tactile, mostly cosmetic responses (chips are "decay", not demolition). */
  private touch(hit: PickHit, x: number, y: number): void {
    const { audio, particles } = this.d;
    // every tap startles animals nearby (they flee the breeze impulse)
    this.puff(x, y, 6);
    const z = hit.z + 0.6;
    const veg = (hit.flags & 2) !== 0;
    if (veg || hit.mat === MAT.Leaves || hit.mat === MAT.Wood) {
      particles.burst({ kind: PK.Leaf, x, y, z: z + 1, count: 14, speed: 3, spread: 1.2 });
      if (hit.mat === MAT.Leaves && hit.z > 4) {
        particles.burst({ kind: PK.Bird, x, y, z: z + 1, count: 3 + Math.floor(Math.random() * 4), speed: 7, spread: 0.8 });
        audio.flutter();
      } else audio.rustle();
      this.puff(x, y, 2.5);
      return;
    }
    switch (hit.mat) {
      case MAT.Rust:
        audio.clang();
        particles.burst({ kind: PK.Chip, x, y, z, count: 3, speed: 2.5, spread: 0.3 });
        break;
      case MAT.Concrete:
      case MAT.Brick:
      case MAT.Asphalt:
        audio.chip();
        particles.burst({ kind: PK.Chip, x, y, z, count: 7, speed: 3.5, spread: 0.4 });
        // real (small) decay: cracks show, and a dozen taps will bring a piece down
        if (hit.mat !== MAT.Asphalt) {
          this.d.globals.events.push({ kind: EventKind.Chip, x, y, z: hit.z, radius: 1.8, strength: 1 });
        }
        particles.burst({ kind: PK.Dust, x, y, z, count: 6, speed: 1.2, spread: 0.6 });
        break;
      case MAT.Water:
      case MAT.Oil:
        audio.splash();
        // the picked z is floored: start the spray clearly above the surface
        particles.burst({ kind: PK.Splash, x, y, z: hit.z + 1.4, count: 24, speed: 4.5, spread: 0.25 });
        break;
      default:
        particles.burst({ kind: PK.Dust, x, y, z, count: 8, speed: 1.6, spread: 0.6 });
        audio.rustle(0.4);
    }
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
    if (globals.time - this.lastStrike < 0.8) return;
    if (nature.value < COSTS.lightning) {
      // not recharged: the land strains instead of an error message
      audio.strain();
      this.puff(tx + 0.5, ty + 0.5, 9);
      return;
    }
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
    audio.thunder(1);
    this.d.particles.burst({ kind: PK.Chip, x: bx + 0.5, y: by + 0.5, z: bz + 0.5, count: 12, speed: 6, spread: 0.5 });
    void sx;
    void sy;
  }

  // ---- gust gesture ----
  /** Drag start: only beneath a storm. */
  gustStart(wx: number, wy: number): boolean {
    const { weather, nature, audio } = this.d;
    if (weather.coverAt(wx, wy) < 0.25) return false;
    const weak = !nature.trySpend(COSTS.gust);
    if (weak) audio.strain();
    this.gust = { x: wx, y: wy, sx: wx, sy: wy, radius: 26, strength: 0, dx: 1, dy: 0, ttl: 99, weak };
    return true;
  }

  gustMove(wx: number, wy: number): void {
    const g = this.gust;
    if (!g) return;
    const dx = wx - g.sx;
    const dy = wy - g.sy;
    const l = Math.hypot(dx, dy);
    if (l < 0.5) return;
    g.dx = dx / l;
    g.dy = dy / l;
    g.x = g.sx + dx * 0.5;
    g.y = g.sy + dy * 0.5;
    g.strength = Math.min(16, l * 0.5) * (g.weak ? 0.3 : 1);
  }

  gustEnd(): void {
    const g = this.gust;
    if (!g) return;
    this.d.weather.gust(g.x, g.y, g.dx, g.dy, g.strength);
    this.d.audio.rustle(1.5);
    g.ttl = 2.5;
    if (!this.told.gust) {
      this.told.gust = true;
      this.d.hud.say('The wind carries dust, litter and smoke — and pushes storms.', 6);
    }
  }

  /** Arrow for the HUD while dragging (world → screen done by the caller). */
  gustArrow(): { x0: number; y0: number; x1: number; y1: number } | undefined {
    const g = this.gust;
    if (!g || g.ttl < 99 || g.strength <= 0) return undefined;
    const len = g.strength * 1.5;
    return { x0: g.sx, y0: g.sy, x1: g.sx + g.dx * len, y1: g.sy + g.dy * len };
  }
}
