// Weather (design doc §20, DECISIONS 2026-10-07): storms are large CPU-side
// entities that roll across the map with a slowly wandering prevailing wind.
// They produce analytic fields on the GPU (rain, cloud shade, wind swirl) via
// the Globals uniform. Storms arrive on their own from time to time; the
// player can also summon one (it forms at the upwind edge, aimed to pass over
// a chosen point) and lean on it with drag-wind — steering is discovered, not
// shown (DECISIONS round 4).

import { MAX_DUSTS, MAX_STORMS, type DustUniform, type StormUniform } from '../sim/globals';

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
  /** outline phases (3) and elongation along travel (see stormDist) */
  shape: [number, number, number, number];
}

/**
 * A dust storm (DECISIONS round 4): a roaming patch of strong, gusty wind that
 * rolls downwind across the map, lifting the dust, litter and leaves lying on
 * the ground. No rain or cloud; what you see is the debris it raises.
 */
export interface DustStorm {
  x: number;
  y: number;
  radius: number;
  /** peak extra wind (cells/s) */
  strength: number;
  age: number;
  intensity: number;
}

/**
 * A cyclone (round 12): spun up by the player's tight circular drag. It
 * travels with the wind field for ~20 s, a fierce vortex that strips drifts
 * and litter, lifts dust into a spinning column, cracks ruins and breaks
 * junk, spares grown plants, and drops the dust it carried where it dies.
 */
export interface Cyclone {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** +1 counter-clockwise, -1 clockwise (from the player's spin) */
  spin: number;
  age: number;
  life: number;
  strength: number;
  /**
   * The funnel's spine (round 12): SPINE_N nodes from the ground up. Node 0 is
   * the cyclone; each node above is pushed by the wind field at its height
   * (more, higher up) and springs back over the node below, so the column
   * bends, lags and meanders with the wind — and with the player's strokes.
   */
  spine: { x: number; y: number; z: number; vx: number; vy: number }[];
}

export const SPINE_N = 6;
/** height between spine nodes (cells) */
const SPINE_SEG = 4.4;

/** cap on the drift a player can add to a storm (cells/s) */
const MAX_PUSH = 7;

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
  /**
   * How strongly the map's own wind blows, 0.3..1 (round 11): calm when no
   * storm or dust storm is about, rising as one arrives. Direction is kept —
   * only the magnitude is raised and lowered.
   */
  windScale = 0.3;
  private t = 0;
  /** render clock (Globals.time), so CPU storm shapes match the shader */
  time = 0;
  private nextNatural = 70;
  dusts: DustStorm[] = [];
  cyclone?: Cyclone;
  /** latest CPU copy of the wind field (texel = 2×2 columns; rgba: painted xy, whole wind zw) */
  windField?: { data: Float32Array; w: number; h: number };
  /** 0..1, set by the level from how dusty/polluted the land is: scales natural dust storms */
  dustiness = 0;
  private nextDust = 140;

  constructor(
    private heights: Float32Array,
    private w: number,
    private h: number,
  ) {}

  canSpawn(): boolean {
    return this.storms.length < MAX_STORMS;
  }

  /** Keep natural weather (storms, dust storms) away for `seconds` (the intro). */
  holdNatural(seconds: number): void {
    this.nextNatural = Math.max(this.nextNatural, this.t + seconds);
    this.nextDust = Math.max(this.nextDust, this.t + seconds);
  }

  /**
   * A storm forming at the upwind edge of the map, aimed so the wind carries
   * it over (tx, ty) — every storm drifts across the map (DECISIONS round 8);
   * the player can lean on it with painted wind on the way.
   */
  spawnToward(tx: number, ty: number): Storm | null {
    if (!this.canSpawn()) return null;
    const sp = Math.hypot(this.windX, this.windY) || 1;
    const ux = this.windX / sp;
    const uy = this.windY / sp;
    let x = tx;
    let y = ty;
    for (let i = 0; i < 400; i++) {
      // form right at the upwind edge, where it can be seen gathering
      if (x < 4 || y < 4 || x > this.w - 4 || y > this.h - 4) break;
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
      radius: 60 + Math.random() * 25,
      intensity: 0,
      age: 0,
      pushX: 0,
      pushY: 0,
      downpour: 0,
      flash: 0,
      shape: [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28, 1.2 + Math.random() * 0.45],
    };
    this.storms.push(s);
    return s;
  }

  /**
   * A dust storm forming at the upwind edge, aimed to cross (tx, ty).
   * @param lead cells upwind of the edge (stagger several storms)
   */
  spawnDust(tx: number, ty: number, lead = 0): DustStorm | null {
    if (this.dusts.length >= MAX_DUSTS) return null;
    const sp = Math.hypot(this.windX, this.windY) || 1;
    let x = tx;
    let y = ty;
    for (let i = 0; i < 400; i++) {
      if (x < -10 || y < -10 || x > this.w + 10 || y > this.h + 10) break;
      x -= this.windX / sp;
      y -= this.windY / sp;
    }
    x -= (this.windX / sp) * lead;
    y -= (this.windY / sp) * lead;
    const d: DustStorm = { x, y, radius: 26 + Math.random() * 14, strength: 6.5 + Math.random() * 2.5, age: 0, intensity: 0 };
    this.dusts.push(d);
    return d;
  }

  spawnCyclone(x: number, y: number, spin: number): Cyclone | null {
    if (this.cyclone) return null;
    const g = this.heightAt(x, y);
    const spine = Array.from({ length: SPINE_N }, (_, i) => ({ x, y, z: g + i * SPINE_SEG, vx: 0, vy: 0 }));
    this.cyclone = { x, y, vx: 0, vy: 0, radius: 6, spin: Math.sign(spin) || 1, age: 0, life: 20, strength: 0, spine };
    return this.cyclone;
  }

  cycloneUniform(): { a: [number, number, number, number]; b: [number, number, number, number] } {
    const c = this.cyclone;
    if (!c) return { a: [0, 0, 1, 0], b: [0, 0, 0, 0] };
    const dropping = c.age > c.life - 3 ? 1 : 0;
    return { a: [c.x, c.y, c.radius, c.strength * c.spin], b: [c.vx, c.vy, dropping, 0] };
  }

  /** Spine nodes for the GPU: x, y, z, funnel radius at that node. */
  spineUniform(): [number, number, number, number][] {
    const c = this.cyclone;
    if (!c) return Array.from({ length: SPINE_N }, () => [0, 0, 0, 0] as [number, number, number, number]);
    // narrow at the ground, flaring toward the top; it thins as it dies
    return c.spine.map((n, i) => [n.x, n.y, n.z, (0.45 + 0.6 * i) * (0.4 + 0.6 * c.strength)] as [number, number, number, number]);
  }

  dustUniforms(): DustUniform[] {
    return this.dusts.map((d) => ({ x: d.x, y: d.y, radius: d.radius, strength: d.strength * d.intensity }));
  }

  /**
   * Player wind: shoves storms near (x, y) along (dx, dy), proportional to
   * strength (called every frame while dragging, with strength × dt).
   */
  gust(x: number, y: number, dx: number, dy: number, strength: number): void {
    for (const s of this.storms) {
      const d = Math.hypot(s.x - x, s.y - y) / s.radius;
      if (d > 1.2) continue;
      const k = strength * 0.12 * (1.2 - d);
      s.pushX += dx * k;
      s.pushY += dy * k;
      const p = Math.hypot(s.pushX, s.pushY);
      if (p > MAX_PUSH) {
        s.pushX *= MAX_PUSH / p;
        s.pushY *= MAX_PUSH / p;
      }
    }
  }

  /**
   * Mean wind over a disc (cells/s) from the wind field (whole wind), on a
   * coarse grid. Off the map, and before the first readback: the prevailing
   * wind.
   */
  private fieldOver(cx: number, cy: number, r: number): [number, number] {
    const f = this.windField;
    if (!f) return [this.windX, this.windY];
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let j = -3; j <= 3; j++)
      for (let i = -3; i <= 3; i++) {
        if (i * i + j * j > 9) continue;
        const tx = Math.floor((cx + (i / 3) * r) / 2);
        const ty = Math.floor((cy + (j / 3) * r) / 2);
        n++;
        if (tx < 0 || ty < 0 || tx >= f.w || ty >= f.h) {
          sx += this.windX;
          sy += this.windY;
          continue;
        }
        sx += f.data[(ty * f.w + tx) * 4 + 2];
        sy += f.data[(ty * f.w + tx) * 4 + 3];
      }
    return [sx / n, sy / n];
  }

  private heightAt(x: number, y: number): number {
    const ix = Math.max(0, Math.min(this.w - 1, Math.floor(x)));
    const iy = Math.max(0, Math.min(this.h - 1, Math.floor(y)));
    return this.heights[iy * this.w + ix];
  }

  update(dt: number): void {
    this.t += dt;
    // a steady prevailing flow across the map (round 10): it only wanders
    // ±10° and 88–112 % in strength over minutes
    const ang = Math.atan2(this.params.baseWindY, this.params.baseWindX) + Math.sin(this.t * 0.011) * 0.13 + Math.sin(this.t * 0.027 + 1.3) * 0.05;
    const mag = Math.hypot(this.params.baseWindX, this.params.baseWindY) * (1 + 0.12 * Math.sin(this.t * 0.019 + 0.7));
    const weather = this.storms.reduce((a, st) => a + st.intensity, 0) + this.dusts.reduce((a, d) => a + d.intensity * 0.7, 0);
    const target = 0.3 + 0.7 * Math.min(1, weather);
    this.windScale += (target - this.windScale) * (1 - Math.exp(-dt / 6));
    this.windX = Math.cos(ang) * mag * this.windScale;
    this.windY = Math.sin(ang) * mag * this.windScale;

    // weather arrives on its own now and then
    if (this.t > this.nextNatural) {
      const [a, b] = this.params.naturalEvery;
      this.nextNatural = this.t + a + Math.random() * (b - a);
      this.spawnToward(this.w * (0.3 + Math.random() * 0.4), this.h * (0.3 + Math.random() * 0.4));
    }

    for (const s of this.storms) {
      s.age += dt;
      // storms ride the wind field — the map's wind plus whatever the player
      // has painted (DECISIONS round 8), averaged over the storm's body so it
      // takes a broad or repeated push to turn one
      const [fx, fy] = this.fieldOver(s.x, s.y, s.radius * 0.6);
      let tvx = fx + s.pushX;
      let tvy = fy + s.pushY;
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

    // dust storms: natural ones only while the land is still dusty
    if (this.t > this.nextDust) {
      this.nextDust = this.t + 110 + Math.random() * 120;
      if (Math.random() < this.dustiness) this.spawnDust(this.w * (0.25 + Math.random() * 0.5), this.h * (0.25 + Math.random() * 0.5));
    }
    for (const d of this.dusts) {
      d.age += dt;
      // they run a little ahead of the prevailing wind
      d.x += this.windX * 1.4 * dt;
      d.y += this.windY * 1.4 * dt;
      const outside = Math.max(0, -d.x, -d.y, d.x - this.w, d.y - this.h);
      d.intensity = Math.min(1, d.age / 4) * Math.max(0, 1 - outside / d.radius);
    }
    this.dusts = this.dusts.filter((d) => d.age < 4 || d.intensity > 0.01);

    // the cyclone: spins up, wanders along with the wind field, dies down
    const cy = this.cyclone;
    if (cy) {
      cy.age += dt;
      const [fx, fy] = this.fieldOver(cy.x, cy.y, cy.radius * 2.5);
      const wob = Math.sin(this.t * 0.9 + cy.spin) * 1.5;
      const tvx = fx * 0.9 + wob * -fy * 0.15;
      const tvy = fy * 0.9 + wob * fx * 0.15;
      const k = 1 - Math.exp(-dt * 0.8);
      cy.vx += (tvx - cy.vx) * k;
      cy.vy += (tvy - cy.vy) * k;
      cy.x += cy.vx * dt;
      cy.y += cy.vy * dt;
      cy.strength = Math.min(1, cy.age / 1.5) * Math.min(1, Math.max(0, (cy.life - cy.age) / 3));
      cy.radius = 6 + 1.5 * Math.sin(this.t * 0.7);
      // the spine: wind at each height pushes its node; a spring holds it over
      // the node below (stiffer low down), damped
      const sp = cy.spine;
      sp[0].x = cy.x;
      sp[0].y = cy.y;
      sp[0].z = this.heightAt(cy.x, cy.y);
      for (let i = 1; i < sp.length; i++) {
        const n = sp[i];
        const below = sp[i - 1];
        const [wx, wy] = this.fieldOver(n.x, n.y, 3);
        const lift = 0.35 + 0.22 * i; // wind bites harder higher up
        const k = 2.6 - 0.3 * i;      // and the column is looser there
        n.vx += ((wx - cy.vx) * lift + (below.x - n.x) * k - n.vx * 1.6) * dt;
        n.vy += ((wy - cy.vy) * lift + (below.y - n.y) * k - n.vy * 1.6) * dt;
        n.x += (n.vx + cy.vx) * dt;
        n.y += (n.vy + cy.vy) * dt;
        // keep each segment from stretching sideways past ~60°
        const ox = n.x - below.x;
        const oy = n.y - below.y;
        const o = Math.hypot(ox, oy);
        const lim = SPINE_SEG * 1.7;
        if (o > lim) {
          n.x = below.x + (ox / o) * lim;
          n.y = below.y + (oy / o) * lim;
        }
        n.z = below.z + SPINE_SEG;
      }
      const off = cy.x < -10 || cy.y < -10 || cy.x > this.w + 10 || cy.y > this.h + 10;
      if (cy.age >= cy.life || off) this.cyclone = undefined;
    }
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
      shape: s.shape,
    }));
  }

  /** CPU twin of common.wgsl stormDist: normalised distance (1 = edge). */
  stormDist(s: Storm, x: number, y: number): number {
    const sp = Math.hypot(s.vx, s.vy);
    const fx = sp > 1e-3 ? s.vx / sp : 1;
    const fy = sp > 1e-3 ? s.vy / sp : 0;
    const ox = x - s.x;
    const oy = y - s.y;
    const along = (ox * fx + oy * fy) / s.shape[3];
    const across = ox * -fy + oy * fx;
    const th = Math.atan2(across, along);
    const t = this.time * 0.015;
    const lobe = 1 + 0.22 * Math.sin(2 * th + s.shape[0] + t) + 0.15 * Math.sin(3 * th + s.shape[1] - t * 1.3) + 0.08 * Math.sin(5 * th + s.shape[2] + t * 0.7);
    return Math.hypot(along, across) / (s.radius * lobe);
  }

  /** Rain intensity felt at a point (for audio), roughly matching the shader. */
  rainAt(x: number, y: number): number {
    let r = 0;
    for (const s of this.storms) {
      const d = this.stormDist(s, x, y);
      const t = Math.min(1, Math.max(0, (1.0 - d) / 0.65));
      r += s.intensity * (1 + s.downpour) * t * t * (3 - 2 * t);
    }
    return r;
  }

  /** Cloud cover 0..1 at a point (CPU twin of the shader's cloud mask, without the ragged edge). */
  coverAt(x: number, y: number): number {
    let c = 0;
    for (const s of this.storms) {
      const d = this.stormDist(s, x, y);
      if (d < 1.05) c = Math.max(c, s.intensity);
    }
    return c;
  }
}
