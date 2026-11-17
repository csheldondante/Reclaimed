// (loop round 13, BACKLOG LS-126; src/weather/presets.ts) The weather on the level: the season's weather (the loop
// tells it: a pack's `weather` list) with the weather signs on the home town laid over it (the mutators tell them), as
// the engine's own settings — the prevailing wind (Weather.params), a storm held over the town and how often natural
// storms come (Weather.holdOver, setNatural), the sky dimmed, ash falling and fog (WorldCore.skyDim, ashFall, fog).
// Applied when either changes; nothing runs between.
import { weatherNow, type WeatherId, type WeatherNow } from '../../weather/presets';
import type { Storm } from '../../weather/weather';
import type { WorldCore } from '../world-core';

export class WeatherSet {
  private season: WeatherId = 'fair';
  private signs: { kind: string; strength: number }[] = [];
  private held: Storm | null = null;
  /** the map's own prevailing wind, as it was before any weather scaled it */
  private readonly base: [number, number];
  /** what was applied last (scripts and the census read it) */
  now: WeatherNow;
  /** (loop round 16, sim/quiet.ts) a quiet world: no natural storms but a weather's own — one with a storm held over
   *  the town (rain, storm: a card's sign or the season's) keeps its storms; fair weather brings none */
  private quietOn = false;
  set quiet(on: boolean) {
    this.quietOn = on;
    this.apply();
  }

  constructor(
    private core: WorldCore,
    /** where a held storm stands: the home town's middle (window units), or null while it is not in the window */
    private centre: () => [number, number] | null,
  ) {
    const p = core.weather.params;
    this.base = [p.baseWindX, p.baseWindY];
    this.now = weatherNow('fair', []);
  }

  /** the season's weather (the loop, each season) */
  setSeason(id: WeatherId): void {
    if (id === this.season) return;
    this.season = id;
    this.apply();
  }

  /** the weather signs on the town now (the mutators, whenever the signs change) */
  setSigns(signs: readonly { kind: string; strength: number }[]): void {
    const next = signs.map((s) => ({ kind: s.kind, strength: s.strength }));
    if (JSON.stringify(next) === JSON.stringify(this.signs)) return;
    this.signs = next;
    this.apply();
  }

  /** applied again as it stands (the home town came into the window: a held storm can stand over it now) */
  refresh(): void {
    this.apply();
  }

  private apply(): void {
    const w = weatherNow(this.season, this.signs);
    this.now = w;
    const { core } = this;
    core.skyDim = w.skyDim;
    core.ashFall = w.ashFall;
    core.fog = w.fog;
    const p = core.weather.params;
    p.baseWindX = this.base[0] * w.wind;
    p.baseWindY = this.base[1] * w.wind;
    core.weather.setNatural(this.quietOn && w.storm === 0 ? null : w.every);
    const c = this.centre();
    this.held = c ? core.weather.holdOver(this.held, c[0], c[1], w.storm) : core.weather.holdOver(this.held, 0, 0, 0);
    console.log(`[weather] ${w.of.join(' + ')}: wind x${w.wind.toFixed(2)}, storm ${w.storm.toFixed(2)}, sky dim ${w.skyDim.toFixed(2)}, ash ${w.ashFall.toFixed(2)}, fog ${w.fog.toFixed(2)}`);
  }
}
