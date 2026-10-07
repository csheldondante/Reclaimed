// Day/night cycle. Produces the light the renderer uses (sun direction,
// sun colour × intensity, ambient sky colour, night factor). The sun sweeps
// across the fixed view from front-left in the morning to back-right in the
// evening; at night a dim cool moon takes over (shadows still work).

export interface Daylight {
  /** direction toward the light (sun or moon) */
  dir: [number, number, number];
  /** light colour × intensity */
  col: [number, number, number];
  /** ambient sky colour */
  sky: [number, number, number];
  /** 0 = full day, 1 = deep night */
  night: number;
  /** 0..1, 0.25 sunrise, 0.5 noon, 0.75 sunset */
  timeOfDay: number;
  /** background/clear colour (sRGB) */
  clear: [number, number, number];
}

const NOON_AZ = Math.atan2(-0.3, 0.75); // the hand-tuned daytime sun from M0

function mix(a: number[], b: number[], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export class DayNight {
  /** seconds per full day */
  dayLength = 480;
  timeOfDay = 0.32;

  update(dt: number): void {
    this.timeOfDay = (this.timeOfDay + dt / this.dayLength) % 1;
  }

  /** @param pollution 0..1 — dirty air warms and dims the light */
  light(pollution: number): Daylight {
    const t = this.timeOfDay;
    // sun elevation: sin over the day half (0.25..0.75), negative at night
    const dayPhase = (t - 0.25) / 0.5; // 0 sunrise .. 1 sunset
    const elev = Math.sin(Math.PI * dayPhase) * (62 * Math.PI) / 180;
    const az = NOON_AZ + (dayPhase - 0.5) * 2.4;
    const sunUp = smooth(-0.05, 0.12, elev);
    const night = 1 - smooth(-0.18, 0.05, elev);
    const low = 1 - smooth(0.05, 0.5, elev); // golden hour
    let dir: [number, number, number];
    let col: [number, number, number];
    if (sunUp > 0.01) {
      const e = Math.max(elev, 0.08);
      dir = [Math.cos(az) * Math.cos(e), Math.sin(az) * Math.cos(e), Math.sin(e)];
      const noonCol = mix([1.0, 0.84, 0.64], [1.0, 0.95, 0.86], 1 - pollution);
      const c = mix(noonCol, [1.0, 0.55, 0.3], low * 0.85);
      const k = 2.4 * sunUp;
      col = [c[0] * k, c[1] * k, c[2] * k];
    } else {
      // moonlight from a fixed high angle
      dir = [0.35, -0.55, 0.76];
      col = [0.16, 0.2, 0.32];
    }
    const daySky = mix([0.34, 0.33, 0.31], [0.3, 0.38, 0.5], 1 - pollution);
    const duskSky: [number, number, number] = [0.36, 0.26, 0.24];
    const nightSky: [number, number, number] = [0.05, 0.07, 0.13];
    let sky = mix(daySky, duskSky, low * (1 - night));
    sky = mix(sky, nightSky, night);
    const clearDay = mix([0.36, 0.34, 0.31], [0.4, 0.44, 0.48], 1 - pollution);
    let clear = mix(clearDay, [0.42, 0.3, 0.26], low * (1 - night));
    clear = mix(clear, [0.04, 0.05, 0.09], night);
    return { dir, col, sky, night, timeOfDay: t, clear };
  }
}
