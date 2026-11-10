// (trackA-opps, the season loop; docs/design/SEASON_LOOP.md) The season played on a field town: the hand dealt by the
// one dealer (season/deal.ts), cards started and undone through the opportunity contract (the ledger: people tied up,
// goods spent), Next season resolving it at once (ledger.ts nextSeason) and played as the showcase (SimTiers.showcase).
// A new district card finds its land — on in an open district of its kind, or a new one claimed on the GPU
// (CityDistricts.claimDistrict: an argmax, four words back — an event, never a frame) — and covers its share [a, b] of
// that district; each season its stage moves within the share (stageDistrict: 32 bytes up) at its moment of the
// showcase, whole exactly when the card finishes. Skip lands every stage at once: the same world as played. The CPU
// holds only the bookkeeping (pools, cards, the ledger); no DOM here.
import type { CityDistricts, OpportunityKind } from '../api/contracts/citygen';
import type { Showcase, SimTiers } from '../api/contracts/simtiers';
import type { DealerTune } from '../opps/tune';
import { card, START_INCOME, START_POOLS } from './catalog';
import { allocate, dealHand, hasLand, type Land, type Offer } from './deal';
import { commit, DISTRICT_PARTS, newLedger, nextSeason, short, uncommit, type SeasonLedger, type SeasonResult } from './ledger';
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

/** a district the season builds in: its town and id (from its claim), its centre (the town's frame) */
interface District {
  town: string;
  id: number;
  at: [number, number];
}

/** where a project builds: its district, its slot there, and its share of it [a, b] (0..1) */
interface Share {
  key: string;
  slot: 0 | 1;
  a: number;
  b: number;
}

/** one project's stage this season: its share, from → to within it (0..1 of the district) */
interface Step extends Share {
  at: number;
  from: number;
  to: number;
}

/** the showcase's steps start within this share of it (the last one still has its build's span to rise) */
const STEPS_WITHIN = 0.35;

export class SeasonLoop {
  ledger: SeasonLedger = newLedger(START_POOLS, START_INCOME);
  hand: Offer[] = [];
  /** the hand's cards started this season: hand index → project id */
  readonly started = new Map<number, string>();
  /** the town's land: districts not begun (the GPU's count), the begun ones with parts free */
  land: Land = { left: null, open: [] };
  town: string | null = null;
  summary: string | null = null;
  last: SeasonResult | null = null;
  /** the districts built in (town:id) and each project's share */
  readonly districts = new Map<string, District>();
  private shares = new Map<string, Share>();
  /** told whenever what the UI shows changes */
  readonly onChange: (() => void)[] = [];
  private recent: { template: string; place: string; turn: number }[] = [];
  private show: Showcase | null = null;
  private lastSteps: Step[] = [];
  private pending: Promise<unknown> | null = null;

  constructor(private host: SeasonHost) {}

  /** the districts not begun (the GPU's count); null until the town is made */
  get left(): number | null {
    return this.land.left;
  }

  /** the town found and counted (retried until it's made), then the first hand */
  async init(): Promise<void> {
    for (;;) {
      const c = await this.host.districts.districtsLeft();
      if (c) {
        this.town = c.town;
        this.land = { left: c.left, open: [] };
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
    const { offers } = dealHand({ ledger: this.ledger, land: this.land, recent: this.recent, tune: this.host.tune });
    this.hand = offers;
    this.started.clear();
    for (const o of offers) this.recent.push({ template: o.card.id, place: 'town', turn: this.ledger.season });
  }

  /** whether a hand card can be started now: its people free, its goods held, land for it */
  canStart(i: number): { ok: boolean; short: ReturnType<typeof short>; land: boolean } {
    const o = this.hand[i];
    const s = short(this.ledger, o.card);
    const land = hasLand(this.ledger, this.land, o.card);
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

  /** a new district card's land (allocate): its share of an open district of its kind, or of a new one claimed on
   *  the GPU */
  private async place(project: string, kind: OpportunityKind, parts: number): Promise<void> {
    const a = allocate(this.land, kind, parts);
    const fail = (left?: number) => {
      // (none left: the dealer offers no district card without land, so only a race lands here — its project goes
      // on in the pools, with nothing to show: SEASON_LOOP.md)
      console.warn(`[season] ${project}: no land left for ${kind}`);
      if (left !== undefined) this.land = { ...this.land, left };
    };
    if (!a) return fail();
    let key = a.key;
    let land = a.land;
    if (key === null) {
      const got = await this.host.districts.claimDistrict(kind, this.town ?? undefined);
      if (got.id < 0) return fail(got.left);
      key = `${got.town}:${got.id}`;
      this.districts.set(key, { town: got.town, id: got.id, at: got.at });
      // (the new district's entry under its real key; the GPU's count of districts left)
      const fresh = land.open.at(-1)!;
      land = { left: got.left, open: [...land.open.slice(0, -1), { ...fresh, key }] };
    }
    const d = land.open.find((x) => x.key === key)!;
    const b = (DISTRICT_PARTS - d.room) / DISTRICT_PARTS;
    this.shares.set(project, { key, slot: a.slot, a: b - parts / DISTRICT_PARTS, b });
    this.land = land;
  }

  /**
   * Next season: the last one's showcase landed first, then resolved at once — new district cards find their land,
   * the ledger moves on (people back from finished cards), each card's district stage plays as the showcase, the next
   * hand is dealt.
   */
  async next(): Promise<SeasonResult> {
    this.settle();
    if (this.pending) throw new Error('season: one is resolving');
    const run = (async () => {
      const r = nextSeason(this.ledger);
      for (const ch of r.changes) {
        const c = card(ch.card);
        if (ch.first && c.work.kind === 'district') await this.place(ch.project, c.work.district, c.work.parts);
      }
      this.ledger = r.ledger;
      this.last = r;
      this.summary = summaryLine(r, card);
      const shown: Step[] = [];
      for (const ch of r.changes) {
        const sh = this.shares.get(ch.project);
        if (!sh) continue;
        shown.push({ ...sh, at: ch.at, from: sh.a + (sh.b - sh.a) * ch.from, to: sh.a + (sh.b - sh.a) * ch.to });
        if (ch.done) {
          // (its district free for the next card of the kind)
          this.shares.delete(ch.project);
          this.land = { ...this.land, open: this.land.open.map((d) => (d.key === sh.key ? { ...d, busy: d.busy.map((b, k) => b && k !== sh.slot) as [boolean, boolean] } : d)) };
        }
      }
      this.lastSteps = shown;
      const when = (st: Step) => st.at * (STEPS_WITHIN / 0.5);
      this.show = this.host.tiers.showcase(
        shown.map((st) => ({ at: when(st), apply: () => this.stage(st, false) })),
        {
          seconds: this.host.seconds,
          frame: (t) => {
            // (the camera on the latest district begun)
            const due = shown.filter((st) => when(st) <= t).at(-1);
            const d = due ? this.districts.get(due.key)! : null;
            const focus = d ? this.host.districts.inWindow(d.town, d.at) : null;
            if (focus) this.host.look?.(focus);
          },
        },
      );
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

  private stage(st: Step, atOnce: boolean): void {
    const d = this.districts.get(st.key);
    // (end: the parts given out in the district — the lots past every share not begun)
    const o = this.land.open.find((x) => x.key === st.key);
    const end = o ? (DISTRICT_PARTS - o.room) / DISTRICT_PARTS : st.b;
    if (d) this.host.districts.stageDistrict(d.town, d.id, { slot: st.slot, a: st.a, b: st.b, from: st.from, to: st.to, end }, atOnce);
  }

  /** Skip: every stage of the season there at once — the same as played */
  skip(): void {
    if (!this.show?.playing) return;
    this.show.skip();
    for (const st of this.lastSteps) this.stage(st, true);
    this.changed();
  }

  /** the world as the ledger says: the showcase still playing skipped */
  settle(): void {
    this.skip();
  }

  get progress(): number {
    return this.show?.progress ?? 0;
  }
}
