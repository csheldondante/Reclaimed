// (round 128r, Track A "Next season") The season played: a tap resolves it (season/ledger.ts — the instant truth), its
// AtlasEvents go to the world state, its changes are realised in the window (season/realise.ts) and shown as the
// showcase (SimTiers.showcase: a few seconds, the camera on each change, Skip jumps to the end). The world never lags
// the ledger: another Next season, or anything that must see the world as the ledger says (a save), calls `settle`
// first — the showcase still playing is skipped, so every write is in.
import type { Showcase, SimTiers } from '../api/contracts/simtiers';
import type { AtlasEvent } from '../api/contracts/world';
import { nextSeason, type PlanView, type SeasonLedger, type SeasonResult } from './ledger';
import { prepare, type SeasonBasin, type SeasonWorld } from './realise';

export interface SeasonHost {
  world: SeasonWorld;
  plan: PlanView;
  tiers: Pick<SimTiers, 'showcase'>;
  /** the camera on a change while the season plays (window world) */
  look(x: number, y: number): void;
  /** the season's AtlasEvents applied to the world state (WorldState.apply), with the season as their run */
  apply?(e: Omit<AtlasEvent, 'regions' | 'run'>, season: number): void;
  /** wall seconds a season plays over */
  seconds: number;
}

export class SeasonPlay {
  /** the summary of the last season */
  summary: string | null = null;
  /** the last season's result (what it changed) */
  last: SeasonResult | null = null;
  /** the structures the last season's floods covered */
  flooded: number[] = [];
  private show: Showcase | null = null;
  private pending: Promise<unknown> | null = null;
  private floods = new Map<string, SeasonBasin>();
  /** told when a season starts playing and when it has played (the bar draws itself again) */
  readonly onChange: (() => void)[] = [];

  constructor(
    private host: SeasonHost,
    public ledger: SeasonLedger,
  ) {}

  /** a season resolving or playing */
  get playing(): boolean {
    return this.pending !== null || !!this.show?.playing;
  }

  get progress(): number {
    return this.show?.progress ?? 0;
  }

  /**
   * The next season: the last one's showcase finished first (settle), then resolved at once and played. Resolves once
   * it's realised and the showcase has started (`showcase.done` for its end). A tap while one is resolving waits for it.
   */
  async next(): Promise<SeasonResult> {
    await this.settle();
    const run = (async () => {
      const r = nextSeason(this.ledger, this.host.plan);
      const real = await prepare(r, this.host.world, this.floods);
      this.ledger = r.ledger;
      for (const e of r.atlas) this.host.apply?.(e, r.ledger.season);
      this.last = r;
      this.summary = r.summary;
      this.flooded = real.flooded;
      this.show = this.host.tiers.showcase(real.steps, {
        seconds: this.host.seconds,
        frame: (t) => {
          const f = real.focus(t);
          if (f) this.host.look(f[0], f[1]);
        },
      });
      for (const h of this.onChange) h();
      void this.show.done.then(() => this.onChange.forEach((h) => h()));
      return r;
    })();
    this.pending = run;
    try {
      return await run;
    } finally {
      this.pending = null;
    }
  }

  /** resolves when the season showing now has played (at once if none) */
  get done(): Promise<void> {
    return this.show?.done ?? Promise.resolve();
  }

  /** Skip: the showcase's changes left applied now. */
  skip(): void {
    this.show?.skip();
  }

  /** The world as the ledger says: a season resolving awaited, the showcase skipped. Call before a save or a new season. */
  async settle(): Promise<void> {
    if (this.pending) await this.pending.catch(() => undefined);
    this.show?.skip();
  }

  /** the floods standing (by card) */
  get standing(): string[] {
    return [...this.floods.keys()];
  }
}
