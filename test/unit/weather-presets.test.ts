// (loop round 13, BACKLOG LS-126; src/weather/presets.ts) Weathers as data: the table, the season's weather from a
// pack's list, the signs laid over it, the pack words checked, and the ages pack's two uses loading and playing at the
// card table.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIGNS } from '../../src/mutate';
import { checkPack, SIGN_KINDS, WEATHER_NAMES, type Pack } from '../../src/packs/check';
import { loadPack } from '../../src/packs/load';
import { seasonWeather, SIGN_WEATHER, WEATHER_IDS, WEATHERS, weatherNow } from '../../src/weather/presets';

const AGES = JSON.parse(fs.readFileSync('packs/ages.json', 'utf8')) as Pack;
const errors = (p: Pack) => checkPack(p).filter((x) => x.level === 'error').map((x) => `${x.where}: ${x.text}`);

describe('weather presets', () => {
  it('the table has the weathers asked for, each a full bundle, and the pack words are the table\'s', () => {
    for (const id of ['clear', 'rain', 'storm', 'ashfall', 'fog', 'dark'] as const) expect(WEATHER_IDS).toContain(id);
    expect([...WEATHER_NAMES].sort()).toEqual([...WEATHER_IDS].sort());
    for (const w of Object.values(WEATHERS)) {
      expect(w.wind).toBeGreaterThan(0);
      for (const k of ['storm', 'skyDim', 'ashFall', 'fog'] as const) expect(w[k], `${w.id}.${k}`).toBeGreaterThanOrEqual(0), expect(w[k]).toBeLessThanOrEqual(1);
    }
    // (every weather sign is a sign kind a pack may name)
    for (const k of Object.keys(SIGN_WEATHER)) expect(SIGN_KINDS).toContain(k), expect(SIGNS.map((s) => s.kind)).toContain(k);
  });

  it('fair is the weather as it always was: no change from the map\'s own', () => {
    const w = weatherNow('fair', []);
    expect(w).toMatchObject({ wind: 1, storm: 0, skyDim: 0, ashFall: 0, fog: 0, of: ['fair'] });
    expect(w.every).toEqual([150, 260]);
  });

  it('signs lay their weather over the season\'s, scaled by strength; the stronger number wins', () => {
    const w = weatherNow('fog', [{ kind: 'storm', strength: 0.6 }, { kind: 'darkness', strength: 1 }, { kind: 'crime', strength: 1 }]);
    expect(w.of).toEqual(['fog', 'storm', 'dark']);
    expect(w.storm).toBeCloseTo(0.6);
    expect(w.skyDim).toBeCloseTo(WEATHERS.dark.skyDim);
    expect(w.fog).toBeCloseTo(WEATHERS.fog.fog);
    // (fog's still air, 0.3, against 0.6 of a storm's wind, 1.84: the one farthest from the map's own)
    expect(w.wind).toBeCloseTo(1 + (WEATHERS.storm.wind - 1) * 0.6);
    expect(w.every).toEqual(WEATHERS.storm.every);
    // (a sign at 0 is off)
    expect(weatherNow('clear', [{ kind: 'ashfall', strength: 0 }]).ashFall).toBe(0);
    expect(() => weatherNow('hail' as never, [])).toThrow(/no weather "hail"/);
  });

  it('a season\'s weather is the last entry that covers it, fair otherwise', () => {
    const list = [
      { from: 3, weather: 'rain' as const },
      { from: 5, to: 6, weather: 'fog' as const },
      { season: 6, weather: 'storm' as const },
    ];
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => seasonWeather(list, n))).toEqual(['fair', 'fair', 'rain', 'rain', 'fog', 'storm', 'rain']);
    expect(seasonWeather([], 4)).toBe('fair');
  });
});

describe('weather in a pack', () => {
  it('the validator says what is wrong with a weather list', () => {
    const p = structuredClone(AGES);
    p.weather = [{ season: 2, weather: 'hail' as never }, { from: 9, to: 4, weather: 'rain' }, { season: 3, from: 4, weather: 'fog' }, { weather: 'fog' } as never, { season: 20, weather: 'clear' }, { season: 2, weather: 'rain', when: 1 } as never];
    const e = errors(p).join('\n');
    expect(e).toMatch(/weather\[0\]: Unknown weather "hail"/);
    expect(e).toMatch(/weather\[1\]: "to" comes before "from"/);
    expect(e).toMatch(/weather\[2\]: Give "season" \(one season\) or "from" and "to", not both/);
    expect(e).toMatch(/weather\[3\]: Say which seasons/);
    expect(e).toMatch(/weather\[4\]: "season" is a season of the run, 1 to 16/);
    expect(e).toMatch(/weather\[5\]: "when" is not a word of a weather entry/);
    p.cards![0].if_taken = [{ sign: 'hail' } as never, { say: 'x' }];
    expect(errors(p).join('\n')).toMatch(/Unknown sign "hail"\. The signs are ashfall, darkness, deadrise, crime, rain, storm, fog/);
  });

  it('the ages pack\'s two uses check clean and load: its season list, and a storm sign in a card\'s result', () => {
    expect(errors(AGES)).toEqual([]);
    const lp = loadPack(AGES);
    expect(lp.weather).toEqual([{ from: 8, to: 9, weather: 'rain' }, { from: 14, weather: 'ashfall' }]);
    expect([1, 8, 9, 10, 14, 16].map((n) => seasonWeather(lp.weather, n))).toEqual(['fair', 'rain', 'rain', 'fair', 'ashfall', 'ashfall']);
    // (the eruption's card: a storm sign on the town when the lava took streets — the engine's `sign` helper)
    const t = lp.templates.find((x) => x.id === 'ages-mountain-stirs')!;
    expect(JSON.stringify(t)).toMatch(/"helper":"sign","args":\["storm","\$town",0\.7,1\]/);
  });
});
