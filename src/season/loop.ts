// (trackA-opps, the season loop; docs/design/SEASON_LOOP.md) The season played on a field town: the hand dealt by the
// one dealer (season/deal.ts), cards started and undone within the pools (the ledger), Next season resolving it at once
// (ledger.ts nextSeason) and played as the showcase (SimTiers.showcase): each new district card claims its land on the
// GPU (CityDistricts.claimDistrict: an argmax, four words back — an event, never a frame), and every project's stage
// moves k/n → (k+1)/n on the GPU (stageDistrict: 16 bytes up) at its moment of the showcase. Skip lands every stage at
// once: the same world as played. The CPU holds only the bookkeeping (pools, cards, the ledger); no DOM here.
import type { CityDistricts } from '../api/contracts/citygen';
import type { Showcase, ShowStep, SimTiers } from '../api/contracts/simtiers';
import type { DealerTune } from '../opps/tune';
import { card, START_INCOME, START_POOLS } from './catalog';
import { dealHand, hasLand, type Offer } from './deal';
import { commit, newLedger, nextSeason, short, uncommit, type SeasonCard, type SeasonLedger, type SeasonResult, type StageChange } from './ledger';
import { summaryLine } from './words';

export interface SeasonHost {
  districts: Pick<CityDistricts, 'claimDistrict' | 'districtsLeft' | 'stageDistrict' | 'inWindow'>;
  tiers: Pick<SimTiers, 'showcase'>;
  tune: DealerTune;
  /** each frame of the showcase: the district it's on (window world, as the window is now) — the camera's framing */
  look?(at: [number, number]): void;
  /** wall seconds a season plays over */
  seconds: number;
}

/** where a project is being built: its town and district (from its claim) */
interface Place {
  town: string;
  id: number;
  at: [number, number];
}

/** the showcase's steps start within this share of it (the last one still has its build's span to rise) */
const STEPS_WITHIN = 0.35;

export class SeasonLoop {
  ledger: SeasonLedger = newLedger(START_POOLS, START_INCOME);
  hand: Offer[] = [];
  /** the hand's cards started this season: hand index → project id */
  readonly started = new Map<number, string>();
  /** the districts not begun in the town (the GPU's count); null until the town is made */
  left: number | null = null;
  town: string | null = null;
  summary: string | null = null;
  last: SeasonResult | null = null;
  readonly places = new Map<string, Place>();
  /** told whenever what the UI shows changes */
  readonly onChange: (() => void)[] = [];
  private recent: { template: string; place: string; turn: number }[] = [];
  private show: Showcase | null = null;
  private lastSteps: StageChange[] = [];
  private pending: Promise<unknown> | null = null;

  constructor(private host: SeasonHost) {}

  /** the town found and counted (retried until it's made), then the first hand */
  async init(): Promise<void> {
    for (;;) {
      const c = await this.host.districts.districtsLeft();
      if (c) {
        this.town = c.town;
        this.left = c.left;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.deal();
    this.changed();
  }

  get playing(): boolean {
    return this.pending !== null || !!this.show?.playing;
  }

  private changed(): void {
    for (const f of this.onChange) f();
  }

  private deal(): void {
    const { offers } = dealHand({ ledger: this.ledger, districtsLeft: this.left, recent: this.recent, tune: this.host.tune });
    this.hand = offers;
    this.started.clear();
    for (const o of offers) this.recent.push({ template: o.card.id, place: 'town', turn: this.ledger.season });
  }

  /** whether a hand card can be started now: paid, and land for it */
  canStart(i: number): { ok: boolean; short: ReturnType<typeof short>; land: boolean } {
    const o = this.hand[i];
    const s = short(this.ledger, o.card);
    const land = o.card.work.kind !== 'district' || hasLand(this.ledger, this.left);
    return { ok: !this.playing && !this.started.has(i) && !Object.keys(s).length && land, short: s, land };
  }

  start(i: number): void {
    if (!this.canStart(i).ok) throw new Error(`season: hand card ${i} can't be started`);
    const before = new Set(this.ledger.projects.map((p) => p.id));
    this.ledger = commit(this.ledger, this.hand[i].card);
    this.started.set(i, this.ledger.projects.find((p) => !before.has(p.id))!.id);
    this.changed();
  }

  undo(i: number): void {
    const id = this.started.get(i);
    if (id === undefined || this.playing) return;
    this.ledger = uncommit(this.ledger, id);
    this.started.delete(i);
    this.changed();
  }

  /**
   * Next season: the last one's showcase landed first, then resolved at once — new district cards claim their land
   * (one GPU claim each, in the order started), the ledger moves on, the stages play as the showcase, the next hand is
   * dealt.
   */
  async next(): Promise<SeasonResult> {
    this.settle();
    if (this.pending) throw new Error('season: one is resolving');
    const run = (async () => {
      const r = nextSeason(this.ledger);
      for (const ch of r.changes) {
        const c = card(ch.card);
        if (!ch.first || c.work.kind !== 'district') continue;
        const got = await this.host.districts.claimDistrict(c.work.district, this.town ?? undefined);
        this.left = got.left;
        if (got.id >= 0) this.places.set(ch.project, { town: got.town, id: got.id, at: got.at });
        // (none left: the dealer offers no district card without land, so only a race of two in one season lands here
        // — its project goes on in the pools, with nothing to show: SEASON_LOOP.md)
        else console.warn(`[season] ${ch.project}: no district left for ${c.work.district}`);
      }
      this.ledger = r.ledger;
      this.last = r;
      this.summary = summaryLine(r, card);
      const shown = r.changes.filter((ch) => this.places.has(ch.project));
      const at = (ch: StageChange) => {
        const p = this.placeOf(ch)!;
        return this.host.districts.inWindow(p.town, p.at);
      };
      this.lastSteps = shown;
      const steps: ShowStep[] = shown.map((ch) => ({ at: ch.at * (STEPS_WITHIN / 0.5), apply: () => this.stage(ch, false) }));
      this.show = this.host.tiers.showcase(steps, {
        seconds: this.host.seconds,
        frame: (t) => {
          // (the camera on the latest change begun)
          const due = shown.filter((ch) => ch.at * (STEPS_WITHIN / 0.5) <= t).at(-1);
          const focus = due ? at(due) : null;
          if (focus) this.host.look?.(focus);
        },
      });
      // (a finished project's place kept for its last stage's step, till the next season)
      this.donePlaces.clear();
      for (const ch of r.changes)
        if (ch.done && this.places.has(ch.project)) {
          this.donePlaces.set(ch.project, this.places.get(ch.project)!);
          this.places.delete(ch.project);
        }
      this.deal();
      void this.show.done.then(() => this.changed());
      return r;
    })();
    this.pending = run;
    this.changed();
    try {
      return await run;
    } finally {
      this.pending = null;
      this.changed();
    }
  }

  private placeOf(ch: StageChange): Place | undefined {
    return this.places.get(ch.project) ?? this.donePlaces.get(ch.project);
  }
  /** the places of projects finished this season (their last stage still to show) */
  private donePlaces = new Map<string, Place>();

  private stage(ch: StageChange, atOnce: boolean): void {
    const p = this.placeOf(ch);
    if (p) this.host.districts.stageDistrict(p.town, p.id, ch.from, ch.to, atOnce);
  }

  /** Skip: every stage of the season there at once — the same as played */
  skip(): void {
    if (!this.show?.playing) return;
    this.show.skip();
    for (const ch of this.lastSteps) this.stage(ch, true);
    this.changed();
  }

  /** the world as the ledger says: the showcase still playing skipped */
  settle(): void {
    this.skip();
  }

  /** what's being built, oldest first: its card, seasons left */
  building(): { card: SeasonCard; left: number; started: boolean }[] {
    return this.ledger.projects.map((p) => ({ card: p.card, left: p.card.seasons - p.worked, started: p.worked > 0 }));
  }

  get progress(): number {
    return this.show?.progress ?? 0;
  }
}
