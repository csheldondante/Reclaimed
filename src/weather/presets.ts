// (loop round 13, BACKLOG LS-126; docs/design/PACK_FORMAT.md "Weather") Weathers as data: a small table of named
// weathers, each a bundle of settings the engine already has — the prevailing wind (Weather.params), storms (a storm
// held over the town, natural storms and how often), the sky dimmed (WorldCore.skyDim), ash falling (WorldCore.ashFall)
// and fog (WorldCore.fog). Pure: no GPU, no DOM; the level applies what `weatherNow` gives (scenes/level/weather-set.ts).
//
// Where a weather comes from:
//   - a SIGN on the home town (a card's effect: `{ "sign": "storm", "seasons": 2 }`). The signs `ashfall` and
//     `darkness` were already weathers in all but name; `rain`, `storm` and `fog` are new. A sign's strength (0..1)
//     scales its weather.
//   - the SEASON: a pack's `weather` list names the weather of seasons of the run (`seasonWeather`); with none, `fair`
//     (the weather as it always was: a storm passing now and then).
// Signs are laid over the season's weather; where two set one number, the stronger wins.

export type WeatherId = 'fair' | 'clear' | 'rain' | 'storm' | 'ashfall' | 'fog' | 'dark';

export interface WeatherPreset {
  id: WeatherId;
  /** the player's word for it */
  name: string;
  /** the prevailing wind, times the map's own (Weather.params.baseWind) */
  wind: number;
  /** a storm held over the town: its strength, 0..1 (0: none) */
  storm: number;
  /** natural storms: seconds between them, or null for none */
  every: readonly [number, number] | null;
  /** the sky dimmed and browned, 0..1 (WorldCore.skyDim) */
  skyDim: number;
  /** ash falling, 0..1 (WorldCore.ashFall) */
  ashFall: number;
  /** fog over the land, 0..1 (WorldCore.fog) */
  fog: number;
}

/** the map's own natural storms (weather.ts's defaults): one every 150-260 s */
const NATURAL: readonly [number, number] = [150, 260];

export const WEATHERS: Readonly<Record<WeatherId, WeatherPreset>> = {
  fair: { id: 'fair', name: 'Fair', wind: 1, storm: 0, every: NATURAL, skyDim: 0, ashFall: 0, fog: 0 },
  clear: { id: 'clear', name: 'Clear', wind: 0.6, storm: 0, every: null, skyDim: 0, ashFall: 0, fog: 0 },
  rain: { id: 'rain', name: 'Rain', wind: 1.3, storm: 0.6, every: [90, 160], skyDim: 0.15, ashFall: 0, fog: 0.1 },
  storm: { id: 'storm', name: 'Storm', wind: 2.4, storm: 1, every: [40, 80], skyDim: 0.35, ashFall: 0, fog: 0 },
  ashfall: { id: 'ashfall', name: 'Ash fall', wind: 0.8, storm: 0, every: null, skyDim: 0.3, ashFall: 0.8, fog: 0.15 },
  fog: { id: 'fog', name: 'Fog', wind: 0.3, storm: 0, every: null, skyDim: 0.1, ashFall: 0, fog: 0.75 },
  dark: { id: 'dark', name: 'Darkness', wind: 0.7, storm: 0, every: null, skyDim: 0.85, ashFall: 0, fog: 0 },
};

export const WEATHER_IDS = Object.keys(WEATHERS) as WeatherId[];

/** the sign kinds that are weathers, and which (mutate/index.ts SignKind) */
export const SIGN_WEATHER: Readonly<Record<string, WeatherId>> = { ashfall: 'ashfall', darkness: 'dark', rain: 'rain', storm: 'storm', fog: 'fog' };

/** the weather to apply now: the numbers, and the weathers it is made of (the season's first) */
export interface WeatherNow {
  wind: number;
  storm: number;
  every: readonly [number, number] | null;
  skyDim: number;
  ashFall: number;
  fog: number;
  of: WeatherId[];
}

/**
 * The season's weather with the weather signs on the town laid over it. Each sign's weather counts at its strength
 * (a number between none and the preset's own); where two set one number the stronger wins: the darker sky, the more
 * ash, the stronger storm, the wind farthest from the map's own, the shorter wait between natural storms.
 */
export function weatherNow(season: WeatherId, signs: readonly { kind: string; strength: number }[]): WeatherNow {
  const base = WEATHERS[season];
  if (!base) throw new Error(`weather: no weather "${season}" (one of ${WEATHER_IDS.join(', ')})`);
  const now: WeatherNow = { wind: base.wind, storm: base.storm, every: base.every, skyDim: base.skyDim, ashFall: base.ashFall, fog: base.fog, of: [season] };
  for (const s of signs) {
    const id = SIGN_WEATHER[s.kind];
    if (!id || !(s.strength > 0)) continue;
    const p = WEATHERS[id];
    const k = Math.min(1, s.strength);
    const wind = 1 + (p.wind - 1) * k;
    if (Math.abs(wind - 1) > Math.abs(now.wind - 1)) now.wind = wind;
    now.storm = Math.max(now.storm, p.storm * k);
    now.skyDim = Math.max(now.skyDim, p.skyDim * k);
    now.ashFall = Math.max(now.ashFall, p.ashFall * k);
    now.fog = Math.max(now.fog, p.fog * k);
    if (p.every && (!now.every || p.every[0] < now.every[0])) now.every = p.every;
    if (!now.of.includes(id)) now.of.push(id);
  }
  return now;
}

/** a pack's weather by season: `{ "season": 3, "weather": "fog" }` (that season), `{ "from": 10, "weather":
 *  "ashfall" }` (that season on), `{ "from": 4, "to": 6, ... }` */
export interface SeasonWeather {
  season?: number;
  from?: number;
  to?: number;
  weather: WeatherId;
}

/** the weather of season `n` of the run: the last entry that covers it, else `fair` */
export function seasonWeather(list: readonly SeasonWeather[], n: number): WeatherId {
  let w: WeatherId = 'fair';
  for (const e of list) {
    const lo = e.season ?? e.from ?? 1;
    const hi = e.season ?? e.to ?? Infinity;
    if (n >= lo && n <= hi) w = e.weather;
  }
  return w;
}
