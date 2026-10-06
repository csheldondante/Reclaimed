// Weather system (design doc §20): storms are small CPU-side entities that
// produce analytic fields on the GPU (rain, cloud shade) via the Globals
// uniform. They drift with the prevailing wind, are slowed/deflected by high
// terrain, and the player can only *nudge* them.

import { MAX_STORMS, type StormUniform } from '../sim/globals';

export interface Storm {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** 0..1, ramps up then decays over the storm's life */
  intensity: number;
  age: number;
  life: number;
  /** Player steering offset added to the prevailing wind (bounded). */
  nudgeX: number;
  nudgeY: number;
  downpour: number;
  flash: number;
}

export interface WeatherParams {
  windX: number;
  windY: number;
  /** Max nudge speed (cells/s) the player can add to the wind. */
  maxNudge: number;
}

export class Weather {
  storms: Storm[] = [];
  params: WeatherParams = { windX: 2.2, windY: 1.4, maxNudge: 6 };

  constructor(
    private heights: Float32Array,
    private w: number,
    private h: number,
  ) {}

  canSpawn(): boolean {
    return this.storms.length < MAX_STORMS;
  }

  spawn(x: number, y: number): Storm | null {
    if (!this.canSpawn()) return null;
    const s: Storm = {
      x,
      y,
      vx: this.params.windX,
      vy: this.params.windY,
      radius: 26,
      intensity: 0,
      age: 0,
      life: 55,
      nudgeX: 0,
      nudgeY: 0,
      downpour: 0,
      flash: 0,
    };
    this.storms.push(s);
    return s;
  }

  /** Steer a storm toward a world point; the effect is bounded and decays. */
  nudge(s: Storm, tx: number, ty: number): void {
    let dx = tx - s.x;
    let dy = ty - s.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-3) return;
    const mag = Math.min(this.params.maxNudge, l * 0.25);
    dx = (dx / l) * mag;
    dy = (dy / l) * mag;
    s.nudgeX = dx;
    s.nudgeY = dy;
  }

  private heightAt(x: number, y: number): number {
    const ix = Math.max(0, Math.min(this.w - 1, Math.floor(x)));
    const iy = Math.max(0, Math.min(this.h - 1, Math.floor(y)));
    return this.heights[iy * this.w + ix];
  }

  update(dt: number): void {
    for (const s of this.storms) {
      s.age += dt;
      // envelope: build over 4s, hold, fade over last 10s
      const up = Math.min(1, s.age / 4);
      const down = Math.min(1, Math.max(0, (s.life - s.age) / 10));
      s.intensity = up * down;
      // target velocity = prevailing wind + player nudge
      let tvx = this.params.windX + s.nudgeX;
      let tvy = this.params.windY + s.nudgeY;
      // terrain: storms slow climbing high ground and slide along contours
      const ahead = 10;
      const sp = Math.hypot(tvx, tvy) || 1;
      const h0 = this.heightAt(s.x, s.y);
      const h1 = this.heightAt(s.x + (tvx / sp) * ahead, s.y + (tvy / sp) * ahead);
      const climb = Math.max(0, h1 - h0) / ahead;
      if (climb > 0) {
        const gx = this.heightAt(s.x + 3, s.y) - this.heightAt(s.x - 3, s.y);
        const gy = this.heightAt(s.x, s.y + 3) - this.heightAt(s.x, s.y - 3);
        const gl = Math.hypot(gx, gy) || 1;
        // remove part of the uphill component
        const up2 = (tvx * gx + tvy * gy) / gl;
        if (up2 > 0) {
          const k = Math.min(1, climb * 3);
          tvx -= (gx / gl) * up2 * k;
          tvy -= (gy / gl) * up2 * k;
        }
      }
      const blend = 1 - Math.exp(-dt * 0.8);
      s.vx += (tvx - s.vx) * blend;
      s.vy += (tvy - s.vy) * blend;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      // nudges fade so the storm returns to the prevailing wind
      const fade = Math.exp(-dt * 0.25);
      s.nudgeX *= fade;
      s.nudgeY *= fade;
      s.downpour = Math.max(0, s.downpour - dt * 0.5);
      s.flash = Math.max(0, s.flash - dt * 4);
    }
    const m = 40;
    this.storms = this.storms.filter(
      (s) => s.age < s.life && s.x > -m && s.y > -m && s.x < this.w + m && s.y < this.h + m,
    );
  }

  uniforms(): StormUniform[] {
    return this.storms.map((s) => ({
      x: s.x,
      y: s.y,
      radius: s.radius,
      intensity: s.intensity,
      vx: s.vx,
      vy: s.vy,
      downpour: s.downpour,
      flash: s.flash,
    }));
  }

  /** Rain intensity felt at a point (for audio), roughly matching the shader. */
  rainAt(x: number, y: number): number {
    let r = 0;
    for (const s of this.storms) {
      const d = Math.hypot(x - s.x, y - s.y) / s.radius;
      const t = Math.min(1, Math.max(0, (1.6 - d) / 1.2));
      r += s.intensity * (1 + s.downpour) * t * t * (3 - 2 * t);
    }
    return r;
  }

  nearest(x: number, y: number, maxDist: number): Storm | null {
    let best: Storm | null = null;
    let bd = maxDist;
    for (const s of this.storms) {
      const d = Math.hypot(x - s.x, y - s.y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }
}
