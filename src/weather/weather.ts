// Weather (design doc §20, DECISIONS 2026-10-07): storms are large CPU-side
// entities that roll across the map with a slowly wandering prevailing wind.
// They produce analytic fields on the GPU (rain, cloud shade, wind swirl) via
// the Globals uniform. Storms arrive on their own from time to time; the
// player can also summon one (it forms at the upwind edge, aimed to pass over
// a chosen point) and push it with gusts — never steer it directly.

import { MAX_STORMS, type StormUniform } from '../sim/globals';

export interface Storm {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** 0..1: ramps up as it forms, fades as it leaves the map */
  intensity: number;
  age: number;
  /** extra velocity from player gusts, decays back to the prevailing wind */
  pushX: number;
  pushY: number;
  downpour: number;
  flash: number;
}

export interface WeatherParams {
  /** base prevailing wind (direction it blows toward), cells/s */
  baseWindX: number;
  baseWindY: number;
  /** natural storm interval range (s) */
  naturalEvery: [number, number];
}

export class Weather {
  storms: Storm[] = [];
  params: WeatherParams = { baseWindX: 3.0, baseWindY: 1.9, naturalEvery: [150, 260] };
  /** current prevailing wind (wanders around the base direction) */
  windX = 2.4;
  windY = 1.5;
  private t = 0;
  private nextNatural = 70;

  constructor(
    private heights: Float32Array,
    private w: number,
    private h: number,
  ) {}

  canSpawn(): boolean {
    return this.storms.length < MAX_STORMS;
  }

  /**
   * A storm forming upwind so the wind carries it over (tx, ty).
   * @param fromEdge natural weather rolls in from the map edge; summoned storms
   *   gather just upwind of the target so they arrive in ~15 s.
   */
  spawnToward(tx: number, ty: number, fromEdge = false): Storm | null {
    if (!this.canSpawn()) return null;
    const sp = Math.hypot(this.windX, this.windY) || 1;
    const ux = this.windX / sp;
    const uy = this.windY / sp;
    let x = tx;
    let y = ty;
    const reach = fromEdge ? 1e9 : 48 * 1.15;
    for (let i = 0; i < 400 && i < reach; i++) {
      if (x < -20 || y < -20 || x > this.w + 20 || y > this.h + 20) break;
      x -= ux;
      y -= uy;
    }
    return this.spawn(x, y);
  }

  spawn(x: number, y: number): Storm | null {
    if (!this.canSpawn()) return null;
    const s: Storm = {
      x,
      y,
      vx: this.windX,
      vy: this.windY,
      radius: 48,
      intensity: 0,
      age: 0,
      pushX: 0,
      pushY: 0,
      downpour: 0,
      flash: 0,
    };
    this.storms.push(s);
    return s;
  }

  /** Player gust: shoves storms near (x, y) along (dx, dy), proportional to strength. */
  gust(x: number, y: number, dx: number, dy: number, strength: number): void {
    for (const s of this.storms) {
      const d = Math.hypot(s.x - x, s.y - y) / s.radius;
      if (d > 1.2) continue;
      const k = strength * 0.12 * (1.2 - d);
      s.pushX += dx * k;
      s.pushY += dy * k;
    }
  }

  private heightAt(x: number, y: number): number {
    const ix = Math.max(0, Math.min(this.w - 1, Math.floor(x)));
    const iy = Math.max(0, Math.min(this.h - 1, Math.floor(y)));
    return this.heights[iy * this.w + ix];
  }

  update(dt: number): void {
    this.t += dt;
    // prevailing wind wanders ±35° and 70–130 % strength over minutes
    const ang = Math.atan2(this.params.baseWindY, this.params.baseWindX) + Math.sin(this.t * 0.011) * 0.45 + Math.sin(this.t * 0.027 + 1.3) * 0.17;
    const mag = Math.hypot(this.params.baseWindX, this.params.baseWindY) * (1 + 0.3 * Math.sin(this.t * 0.019 + 0.7));
    this.windX = Math.cos(ang) * mag;
    this.windY = Math.sin(ang) * mag;

    // weather arrives on its own now and then
    if (this.t > this.nextNatural) {
      const [a, b] = this.params.naturalEvery;
      this.nextNatural = this.t + a + Math.random() * (b - a);
      this.spawnToward(this.w * (0.3 + Math.random() * 0.4), this.h * (0.3 + Math.random() * 0.4), true);
    }

    for (const s of this.storms) {
      s.age += dt;
      let tvx = this.windX + s.pushX;
      let tvy = this.windY + s.pushY;
      // high ground slows a storm and deflects it along the contours
      const ahead = 14;
      const sp = Math.hypot(tvx, tvy) || 1;
      const h0 = this.heightAt(s.x, s.y);
      const h1 = this.heightAt(s.x + (tvx / sp) * ahead, s.y + (tvy / sp) * ahead);
      const climb = Math.max(0, h1 - h0) / ahead;
      if (climb > 0) {
        const gx = this.heightAt(s.x + 3, s.y) - this.heightAt(s.x - 3, s.y);
        const gy = this.heightAt(s.x, s.y + 3) - this.heightAt(s.x, s.y - 3);
        const gl = Math.hypot(gx, gy) || 1;
        const up = (tvx * gx + tvy * gy) / gl;
        if (up > 0) {
          const k = Math.min(1, climb * 3);
          tvx -= (gx / gl) * up * k;
          tvy -= (gy / gl) * up * k;
        }
      }
      const blend = 1 - Math.exp(-dt * 0.6);
      s.vx += (tvx - s.vx) * blend;
      s.vy += (tvy - s.vy) * blend;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const fade = Math.exp(-dt * 0.3);
      s.pushX *= fade;
      s.pushY *= fade;
      // intensity: forms over ~6 s, fades while leaving the map
      const outside = Math.max(0, -s.x, -s.y, s.x - this.w, s.y - this.h);
      const form = Math.min(1, s.age / 6);
      s.intensity = form * Math.max(0, 1 - Math.max(0, outside - 4) / (s.radius * 0.6));
      s.downpour = Math.max(0, s.downpour - dt * 0.5);
      s.flash = Math.max(0, s.flash - dt * 4);
    }
    this.storms = this.storms.filter((s) => s.age < 6 || s.intensity > 0.01);
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
      const t = Math.min(1, Math.max(0, (1.0 - d) / 0.65));
      r += s.intensity * (1 + s.downpour) * t * t * (3 - 2 * t);
    }
    return r;
  }

  /** Cloud cover 0..1 at a point (CPU twin of the shader's cloud mask, without the ragged edge). */
  coverAt(x: number, y: number): number {
    let c = 0;
    for (const s of this.storms) {
      const d = Math.hypot(x - s.x, y - s.y) / s.radius;
      if (d < 1.05) c = Math.max(c, s.intensity);
    }
    return c;
  }
}
