// (loop-skeleton; docs/design/LOOP_SKELETON.md) ?loop=1: the main game loop on the town the level opens on, run on the
// existing engine. Pick a leader → the town, with what people ask shown over their places → go to one: the presenter's
// dialog (the petition) → agree: the cost committed → Next season (the season loop's time-lapse) → … → the raiders'
// arc reaches its last stage → the attack plays with the soldiers built, spells cast → the end of the run, read from
// the fact layer's history → a new run in the same saved world.
// This file is the wiring only. The rules are season/realm.ts (the living engine joined to the season ledger), the
// templates season/realm-templates.ts, the pools the season ledger, the building and the fight the season loop and its
// war, the screens season/run-ui.ts, the dialog dialog/petition.ts. `window.rungame` for scripts.
import type { WorldSnapshot } from '../../api/contracts/world';
import type { FieldTowns } from '../../citygen/towns';
import { DialogBox, type Speaker } from '../../dialog/dialog';
import { actOf, petitionTree } from '../../dialog/petition';
import { portraitUrl } from '../../dialog/portrait';
import { meetPerson, petitionOf } from '../../living/present';
import { capitalise } from '../../living/plain';
import { newLedger, pools, total, type Pool, type Pools, type SeasonLedger } from '../../season/ledger';
import type { SeasonLoop } from '../../season/loop';
import { BASIC_SPELLS, Realm, RUN_SEASONS, SPELL_COST, type LiveReport, type RunState, type SpellId, type Spot } from '../../season/realm';
import type { Offer } from '../../living/engine';
import { LiveRunner, type LiveRun } from './live-runner';
import { applyDelta, delta, type Delta } from '../../api/snapshot-delta';
import { MemoryWorldState } from '../../api/contracts/world-state';
import { FactWorld } from '../../living/world';
import { mutators } from '../../mutate';
import type { MutateEngine } from '../../mutate/engine';
import { ROW_H, cellAt } from '../../world/lattice';
import { restoreMutators } from './mutators';
import type { SiteKey } from '../../season/realm-templates';
import { declutter, placeSites, REACH as SITE_REACH } from '../../season/sites';
import { mountRunUi, type Asking, type Marker, type Phase, type RunGame } from '../../season/run-ui';
import * as W from '../../season/run-words';
import { StoryCamera, type V3 } from '../../story/camera';
import type { LevelScene } from '../level';
import { startSeasonLoop, storeReady } from './season';

/** the world's record in the world store: the fact layer, the characters, the holdings (WorldState's snapshot).
 *  FIXED-CITY (BACKLOG LS-40): one record a page, with one town's ledger in it; a run that follows a moving group needs
 *  the group's own holdings and place saved beside the world */
const WORLD_KEY = 'realm:world';
/** the record under WORLD_KEY (round 4, BACKLOG LS-8 and LS-29): the world as what differs from the atlas's own
 *  (api/snapshot-delta.ts), and the run under way — its state, its ledger, the season's news — or null between runs.
 *  An older save is the world's snapshot whole (it has no `v`). */
interface SavedRun {
  v: 2;
  world: Delta | null;
  run: { state: RunState; ledger: SeasonLedger; notes: string[] } | null;
}
/** the zoom on a district being built while a season passes: its lots and the people working on them read */
const BUILD_ZOOM = 9;
/** how far from the home town's centre the camera may go (cells): past the mountain an outcome can name (640), short
 *  of where the town would be let go (its box 448 columns from a 320-column window: about 680) */
const HOME_REACH = 650;
/** a spell's blow: its radius (cells), its damage, its cost */
/** times a cast asks for the ground's pages under its tap before it gives up (a camera that moved meanwhile: again) */
const CAST_WAIT_FRAMES = 4;
// (round 4: damage 2 of a raider's 3 health. At 3, the first cast that ever landed killed all 6 raiders on the march for
// 1 Magic and the soldiers had no part; at 2 it wounds every raider in reach and a second cast or the soldiers finish
// them. A tunable for the owner: LOOP_SKELETON.md assumption 17)
const HEATRAY = { radius: 5, damage: 2 };
/** the live event's spell, and the dead it is cast on: how many get up, in clumps this far apart (cells), and the wall
 *  seconds the event may take before it is left as it stands */
const FIRE = { radius: 4.5, damage: 12, light: 3 };
/** the growth rune: how near the fields' place the tap must be (cells), how wide and how hard the plants grow */
const GROWTH = { reach: 60, radius: 11, strength: 45 };

class Game implements RunGame {
  phase: Phase = 'boot';
  realm: Realm | null = null;
  notes: string[] = [];
  fightLine: string | null = null;
  resultLines: string[] = [];
  armed: SpellId | null = null;
  readonly onChange: (() => void)[] = [];
  private cam: StoryCamera;
  /** the world as saved (null: the atlas's own), and its history before this page's runs */
  private saved: WorldSnapshot | null = null;
  private talk: DialogBox;
  private speakers = new Map<string, Speaker>();
  /** the live events (round 6): one runner plays the raid, the dead, a parade, a fire — scenes/level/live-runner.ts */
  private live: LiveRunner;

  constructor(
    private scene: LevelScene,
    private towns: FieldTowns,
    private season: SeasonLoop,
    private mut: MutateEngine | null,
  ) {
    this.cam = new StoryCamera(scene.core.camera, scene.storyCut ?? {});
    scene.cardsOnly = true;
    // (a shot's points are window coordinates: they slide with the window)
    scene.core.onShift.push((dx, dy, dz) => this.cam.shift(dx, dy, dz));
    season.onChange.push(() => this.changed());
    // (the petition: the dialog the engine's own run uses — opps/level-opps.ts)
    this.talk = new DialogBox(scene.host.ui, {
      className: 'petition',
      speaker: (id) => {
        const sp = this.speakers.get(id);
        if (!sp) throw new Error(`petition: no speaker ${id}`);
        return sp;
      },
      check: () => true,
    });
    this.live = new LiveRunner({ scene, cam: this.cam, season, realm: () => this.realm, town: () => this.town, spot: (k) => this.spot(k), z: (x, y) => this.z(x, y), changed: () => this.changed(), ended: (run) => this.liveEnded(run) });
    let last = performance.now();
    const tick = (now: number) => {
      requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.cam.update(dt);
      this.keepNear();
      this.watchBuild(dt);
      this.live.update(dt);
      this.liveLine();
    };
    requestAnimationFrame(tick);
    // (on the window, before the map's own input: the level's input layer lies over the canvas, so a listener on the
    // canvas never heard the tap — round 1's cast was never seen. A tap on the loop's own screens is not a cast)
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!(e.target instanceof Element && e.target.closest('.run-sheet, .run-top, .run-marks button, .run-full, .dlg'))) this.cast(e);
      },
      true,
    );
  }

  get ledger(): SeasonLedger {
    return this.season.ledger;
  }
  get canSkip(): boolean {
    return this.season.playing;
  }
  get leader() {
    return this.realm?.leader ?? null;
  }
  get run() {
    const r = this.realm;
    return r ? { season: r.season, seasons: r.seasons, n: this.runs, threat: r.standingThreat(), spells: [...r.spells], fight: r.fight } : null;
  }
  /** runs begun in this world (the history's count) */
  private runs = 0;
  private changed(): void {
    for (const f of this.onChange) f();
  }
  private set(phase: Phase): void {
    this.phase = phase;
    this.changed();
  }

  // ---- the town's places ------------------------------------------------------------------------------

  // FIXED-CITY (BACKLOG LS-40): the run's place is the one town the season loop opened on; the camera, the sites, the
  // road the raid comes by and the hills and mountain round it are all read from this town
  private get town() {
    return this.season.town !== null ? this.towns.live.get(this.season.town) : undefined;
  }

  private z(x: number, y: number): number {
    return this.scene.heightAt(x, y) ?? this.scene.core.camera.target[2];
  }

  private at3(p: [number, number]): V3 {
    return [p[0], p[1], this.z(p[0], p[1])];
  }

  /** the home town's sites, each as an offset from the town's centre (x cells, y world units): placed once a town
   *  (season/sites.ts placeSites) from what the CPU knows of it — its approach roads, the atlas's ground and rivers */
  private placed: { town: string; at: Record<SiteKey, [number, number]> } | null = null;

  /**
   * Where a site of the home town is on the map (a window point): its own place in the town as laid out (LS-3) —
   * beside its road, on a bank, on high ground, round the heart; never in the atlas's water or on an approach road.
   * FIXED-CITY: one town's sites, placed once for the page.
   */
  private spot(site: SiteKey): [number, number] | null {
    const t = this.town;
    const a = this.scene.opts.atlas;
    const S = this.scene.stream;
    if (!t || !a || !S) return null;
    const c = t.centreInWindow();
    if (this.placed?.town !== t.site.id) {
      // (window point → the atlas's world units)
      const wx = (x: number) => x - c[0] + t.site.at[0];
      const wy = (y: number) => y - c[1] + t.site.at[1];
      // (the atlas's rivers near the town: a node a texel, each with the next one down — segments, with their width)
      const nf = new Float32Array(a.atlas.riverNodes.buffer, a.atlas.riverNodes.byteOffset, a.atlas.riverNodes.length);
      const nu = a.atlas.riverNodes;
      const reach = 2.5 * t.box.R;
      const segs: [number, number, number, number, number][] = [];
      for (let i = 0; i + 7 < nu.length; i += 8) {
        if (Math.hypot(nf[i] - t.site.at[0], nf[i + 1] - t.site.at[1]) > reach) continue;
        const n = nu[i + 4] * 8;
        const to = n + 7 < nu.length && n !== i ? [nf[n], nf[n + 1]] : [nf[i], nf[i + 1]];
        if (Math.hypot(to[0] - nf[i], to[1] - nf[i + 1]) > 200) continue;
        segs.push([nf[i], nf[i + 1], to[0], to[1], nf[i + 3]]);
      }
      const inRiver = (x: number, y: number) =>
        segs.some(([ax, ay, bx, by, w]) => {
          const dx = bx - ax;
          const dy = by - ay;
          const l2 = dx * dx + dy * dy;
          const k = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
          return Math.hypot(x - ax - k * dx, y - ay - k * dy) < w / 2 + 3;
        });
      const sea = a.atlas.p.sea;
      const at = placeSites({
        centre: c,
        R: t.box.R,
        roads: Array.from({ length: t.roadCount }, (_, k) => t.roadInWindow(k)),
        dry: (x, y) => a.atlas.macroAt(wx(x), wy(y)) > sea + 0.4 && !inRiver(wx(x), wy(y)),
        height: (x, y) => a.atlas.macroAt(wx(x), wy(y)),
      });
      for (const k of Object.keys(at) as SiteKey[]) at[k] = [at[k][0] - c[0], at[k][1] - c[1]];
      this.placed = { town: t.site.id, at };
      console.log(`[loop] sites placed: ${segs.length} river reaches near ${t.site.name}, ${t.roadCount} roads`);
    }
    const o = this.placed.at[site];
    return o ? [c[0] + o[0], c[1] + o[1]] : null;
  }

  markers(): Marker[] {
    const t = this.town;
    const r = this.realm;
    const cam = this.scene.core.camera;
    if (this.phase === 'event') return this.live.marks();
    if (!t || !r || (this.phase !== 'city' && this.phase !== 'petition')) return [];
    const out: Marker[] = [];
    const put = (id: string, label: string, kind: Marker['kind'], at: [number, number] | null) => {
      if (!at) return;
      const [x, y] = cam.project(at[0], at[1], this.z(at[0], at[1]));
      if (x > 0 && y > 0 && x < innerWidth && y < innerHeight) out.push({ id, label, kind, x, y });
    };
    for (const o of r.offers()) {
      if (o.status !== 'offered') continue;
      const site = r.siteOf(o);
      if (site) put(o.id, `${r.w.name(o.presenter)} · ${W.leftText(r.left(o))}`, 'ask', this.spot(site));
    }
    // (the standing threat is a card like any other: its own title and countdown, shown on the road)
    const st = r.standingThreat();
    if (st) put('threat', W.threatTag(st.title, st.left), 'threat', this.spot('road'));
    // (a live event going on without the player: its name over where it is — a tap goes back to it)
    for (const run of this.live.runs) {
      const at = this.live.where(run);
      if (at) put(`live:${run.id}`, W.underWay(run.def.title), 'ask', [at[0], at[1]]);
    }
    // (names kept apart and on the screen, between the top bar and the sheet: LS-3, LS-28)
    const sheet = document.querySelector('.run-sheet')?.getBoundingClientRect().top ?? innerHeight;
    const bar = document.querySelector('.run-top')?.getBoundingClientRect().bottom ?? 0;
    const free = declutter(out.map((m) => ({ x: m.x, y: m.y, chars: m.label.length })), innerWidth, bar + 4, sheet - 4);
    out.forEach((m, i) => ([m.x, m.y] = free[i]));
    return out;
  }

  /** (scripts) where the figures of the live event the player is at are on the screen (px): the dead, the raiders */
  deadAt(): [number, number][] {
    return this.live.figures();
  }

  // ---- live events --------------------------------------------------------------------------------------

  /** the live event the player is at, for the sheet */
  get liveNow(): { title: string; how: string; spells: SpellId[]; wantsSpells: boolean; canLeave: boolean } | null {
    const run = this.live.focus;
    return run && this.phase === 'event' ? { title: run.def.title, how: run.def.how, spells: this.allowed(), wantsSpells: !!run.def.spells?.length, canLeave: this.live.canLeave } : null;
  }

  /** the spells the player may cast now: at a live event the ones it allows ('known': those the run has unlocked); in
   *  the town, the growth rune */
  private allowed(): SpellId[] {
    const r = this.realm;
    if (!r) return [];
    if (this.phase === 'city') return ['growth'];
    const run = this.live.focus;
    if (this.phase !== 'event' || !run) return [];
    return (run.def.spells ?? []).flatMap((s) => (s === 'known' ? r.spells : BASIC_SPELLS.includes(s as SpellId) || r.spells.includes(s as SpellId) ? [s as SpellId] : []));
  }
  get citySpells(): SpellId[] {
    return this.phase === 'city' ? this.allowed() : [];
  }

  /** a live event begun (its card agreed to, or forced: the raid): the one runner plays it; the player is taken there */
  private beginLive(o: Offer): void {
    const r = this.realm!;
    const def = r.liveOf(o);
    if (!def) throw new Error(`loop: ${o.template} has no live event`);
    this.armed = null;
    const run = this.live.start(o, def, r.siteOf(o));
    this.fightLine = W.fill(def.line, this.live.numbers(run));
    this.set('event');
  }

  /** the sheet's line of the event the player is at, from its numbers as the units tell them */
  private liveLine(): void {
    const run = this.live.focus;
    if (!run || this.phase !== 'event' || this.lineHeld > performance.now()) return;
    const line = run.entry && run.entry.step !== 'in' ? W.LIVE_WAIT : W.fill(run.def.line, this.live.numbers(run));
    if (line === this.fightLine) return;
    this.fightLine = line;
    this.changed();
  }
  /** a line said about a cast stays this long (ms since the page began) before the event's own line is back */
  private lineHeld = 0;

  /**
   * A live event resolved from the state it is in: told to the realm (its numbers read, the rules applied, the
   * template's outcome for the tier that fits run through the engine), then taken out of the city.
   */
  private resolveLive(run: LiveRun): LiveReport {
    const r = this.realm!;
    const l0 = this.season.ledger;
    const before = { might: total(l0, 'might'), materials: pools(l0).materials, unrest: pools(l0).unrest };
    r.ledger = this.season.ledger;
    const rep = r.finishLive(run.id, this.live.told(run));
    this.season.setLedger(r.ledger);
    this.live.close(run);
    this.armed = null;
    if (run.def.stay && r.fight) {
      // (the soldiers fallen are in the outcome's Might: not settled again by the season's war)
      this.season.war?.settled();
      const l1 = this.season.ledger;
      const lost = { might: before.might - total(l1, 'might'), materials: before.materials - pools(l1).materials, unrest: pools(l1).unrest - before.unrest };
      this.resultLines = [...W.resultLines(r.fight, lost), ...rep.lines.slice(1)];
    }
    console.log(`[loop] live event ${run.template} over: ${rep.tier} ${JSON.stringify(rep.vars)}; ${rep.lines.join(' ')}`);
    return rep;
  }

  /** an event ended by itself (the runner's call): resolved at once; the player is back in the town, or — the raid —
   *  at its result */
  private liveEnded(run: LiveRun): void {
    const at = this.live.focus === run;
    // (the census's event has no card to resolve: taken out of the city)
    if (run.id.startsWith('measure:')) {
      this.live.close(run);
      return this.set('city');
    }
    const rep = this.resolveLive(run);
    void this.save();
    if (run.def.stay && this.realm!.fight) return this.set('result');
    this.notes = [...this.notes, ...rep.lines];
    if (at) {
      this.showTown();
      // (back in the town — or straight on to another event nobody asks about: the raid behind the refugees)
      this.flow();
    } else this.changed();
  }

  leave(): void {
    if (this.phase !== 'event' || !this.live.canLeave) return;
    this.live.leave();
    this.armed = null;
    this.showTown();
    this.set('city');
  }

  asking(): Asking[] {
    const r = this.realm;
    if (!r) return [];
    return r
      .offers()
      .filter((o) => o.status === 'offered')
      .map((o) => ({ id: o.id, who: r.w.name(o.presenter), title: o.opp.title, left: r.left(o) }));
  }

  working(): string[] {
    const r = this.realm;
    return r ? r.offers().filter((o) => o.status === 'committed').map((o) => o.opp.title) : [];
  }

  history(): { season: number; text: string }[] {
    const r = this.realm;
    if (!r) return [];
    const t0 = r.w.turn - r.season;
    return r
      .history()
      .filter((e) => SHOWN.has(e.kind) || (e.weight ?? 0) !== 0)
      .map((e) => ({ season: e.turn - t0, text: W.sentence(e.note ?? e.kind) }));
  }

  before(): string[] {
    const r = this.realm;
    const now = r ? r.history().map((e) => e.id) : [];
    const all = r ? r.history(true) : ((this.saved?.facts as { events?: { id: number; kind: string; note?: string; weight?: number }[] } | undefined)?.events ?? []);
    return all.filter((e) => !now.includes(e.id as never) && (SHOWN.has(e.kind) || (e.weight ?? 0) !== 0)).map((e) => W.sentence(e.note ?? e.kind));
  }

  /** what this run changed in the land and the world's places: the mutators' entries its events caused, each named by
   *  the place its event is about */
  land(): string[] {
    const r = this.realm;
    if (!r) return [];
    const evs = new Map(r.history().map((e) => [e.id, e]));
    void evs;
    return r.changes().map((m) => W.landLine(m.kind, r.placeName(m)));
  }

  /**
   * Where a site of the home town, or a spot out of it, is in world cells [x, row] (the mutators' coordinates). A site:
   * its place on the map. The hills (a camp's) and the mountain (the one that breaks): the highest of the atlas's
   * coarse ground on a ring round the town — near for the hills, far enough for the mountain that its lava is not the
   * town's and its ash is.
   */
  private where(spot: Spot): [number, number] | null {
    const a = this.scene.opts.atlas;
    const S = this.scene.stream;
    const t = this.town;
    if (!a || !S || !t) return null;
    if (spot === 'hills' || spot === 'mountain') {
      const [r0, r1] = spot === 'hills' ? [170, 260] : [420, 640];
      const [hx, hy] = t.site.at;
      let best: [number, number] | null = null;
      let top = -Infinity;
      for (let k = 0; k < 48; k++) {
        const ang = (k / 48) * Math.PI * 2;
        const r = r0 + ((k * 7) % 5) * ((r1 - r0) / 4);
        const x = hx + Math.cos(ang) * r;
        const y = hy + Math.sin(ang) * r;
        const z = a.atlas.macroAt(x, y);
        if (z > top) [top, best] = [z, [Math.round(x), Math.round(y / ROW_H)]];
      }
      return best;
    }
    const at = this.spot(spot);
    if (!at) return null;
    const [cx, cy] = cellAt(at[0], at[1]);
    return [S.origin[0] + cx, S.origin[1] + cy];
  }

  /**
   * A season passing with something under way: the camera closes in on where it is built (the season loop already
   * turns the camera to the district it is staging — scenes/level/season.ts `look`; at the town's zoom a new house was
   * a few pixels). Back over the town when the season is through (`next`).
   */
  private watchBuild(dt: number): void {
    if (this.phase !== 'season' || !this.season.playing || !this.building) return;
    const cam = this.scene.core.camera;
    cam.zoom *= Math.exp(Math.log(BUILD_ZOOM / cam.zoom) * Math.min(1, dt * 1.5));
  }
  /** this season's time-lapse has a project of the town's to show */
  private building = false;

  /**
   * The camera kept within HOME_REACH of the home town. FIXED-CITY (BACKLOG LS-40): the run's town must stay made — a
   * town farther than citygen's DROP (448 columns) from the window is let go, and with it the run's squads, its place
   * table slot and its roads (seen: the camera 900 cells off, then "the raid found no road", 0 roads; BACKLOG LS-48).
   * Far places are looked at on the atlas map, not by panning there. A run that follows a moving group keeps its
   * group's ground made instead.
   */
  private keepNear(): void {
    const t = this.town;
    if (!t || this.phase === 'boot' || this.phase === 'leader') return;
    const cam = this.scene.core.camera;
    const c = t.centreInWindow();
    const dx = cam.target[0] - c[0];
    const dy = cam.target[1] - c[1];
    const d = Math.hypot(dx, dy);
    if (d <= HOME_REACH) return;
    cam.target[0] = c[0] + (dx / d) * HOME_REACH;
    cam.target[1] = c[1] + (dy / d) * HOME_REACH;
  }

  // ---- saving -----------------------------------------------------------------------------------------

  /** the world as the atlas makes it, as plain JSON: what a save is the difference from */
  private base: WorldSnapshot | null = null;
  private baseWorld(): WorldSnapshot {
    const a = this.scene.opts.atlas;
    if (!a?.settlements) throw new Error('loop: no atlas world');
    return (this.base ??= JSON.parse(JSON.stringify(a.settlements.wiki.snapshot)) as WorldSnapshot);
  }
  /** a run under way in the save: taken up once the saved list of land changes is laid */
  private pending: NonNullable<SavedRun['run']> | null = null;

  async load(): Promise<void> {
    const st = await storeReady(this.scene);
    if (st?.has(WORLD_KEY)) {
      const rec = JSON.parse(new TextDecoder().decode(await st.get(WORLD_KEY))) as SavedRun | WorldSnapshot;
      if ('v' in rec && rec.v === 2) {
        this.saved = applyDelta(this.baseWorld() as never, rec.world) as unknown as WorldSnapshot;
        this.pending = rec.run;
      } else this.saved = rec as WorldSnapshot;
    }
    const before = this.before();
    console.log(`[loop] world: ${this.saved ? `saved, ${before.length} things remembered` : 'new'}`);
    // (the mutators' saved list laid over the window, with the saved world bound first: its entries' fact events are in
    // it, so nothing is recorded twice. A run then binds its own world — season/realm.ts)
    const a = this.scene.opts.atlas;
    if (this.mut && a?.settlements) {
      this.mut.useWorld(new FactWorld(MemoryWorldState.restore(structuredClone(this.saved ?? a.settlements.wiki.snapshot))));
      await restoreMutators(this.mut);
      console.log(`[loop] mutators: ${mutators.record().list.length} changes of earlier runs laid over the land, ${mutators.signs().length} signs on`);
    }
    if (this.pending && this.resume(this.pending)) return;
    this.set('leader');
  }

  /**
   * A run under way in the save taken up where it was left (LS-8): the same season, pools, board, spells and world.
   * The season is as it stood at the last save — the run's start, each answer given, each season's end, the fight's
   * end. False: the save's leader is not one of this build's.
   */
  private resume(p: NonNullable<SavedRun['run']>): boolean {
    const a = this.scene.opts.atlas;
    const home = this.season.town;
    const who = W.LEADERS.find((l) => l.id === p.state.leader);
    if (!a?.settlements || home === null || !who || !this.saved) return false;
    this.realm = new Realm({ world: this.saved, home, seed: a.atlas.p.seed, leader: who, ledger: p.ledger, land: () => this.season.land, seasons: p.state.seasons, where: (spot) => this.where(spot), regionAt: (x, y) => a.settlements!.regionAt(x, y), resume: p.state });
    this.runs = this.realm.history(true).filter((e) => e.kind === 'run-began').length;
    this.notes = p.notes;
    this.resultLines = [];
    this.season.setLedger(this.realm.ledger);
    console.log(`[loop] run ${this.runs} taken up again: ${who.name}, season ${this.realm.season} of ${p.state.seasons}; asking: ${this.asking().map((x) => `${x.who} (${x.title})`).join(', ')}`);
    this.showTown();
    this.flow();
    return true;
  }

  /**
   * The save (LS-29): the world as what differs from the atlas's own — a few entities, the events, the holdings — and
   * the run under way. Before, the world whole: 2.3 MB of JSON a season. Its size and the time it took are logged.
   */
  private async save(): Promise<void> {
    const st = this.scene.stream?.store;
    const r = this.realm;
    if (!st || !r) return;
    const t0 = performance.now();
    this.saved = r.snapshot();
    const rec: SavedRun = { v: 2, world: delta(this.baseWorld() as never, JSON.parse(JSON.stringify(this.saved)) as never), run: r.over ? null : { state: r.runState(), ledger: this.season.ledger, notes: this.notes } };
    const bytes = new TextEncoder().encode(JSON.stringify(rec));
    // (the store takes the bytes: their length said first)
    console.log(`[loop] world saved: ${bytes.length} B (${JSON.stringify(rec.world).length} B the world's changes, the rest the run), ${r.history(true).length} events, ${(performance.now() - t0).toFixed(0)} ms`);
    await st.put(WORLD_KEY, bytes, { session: 'loop', hash: 0 });
  }

  // ---- the player's moves -----------------------------------------------------------------------------

  pick(id: string): void {
    const who = W.leader(id);
    const a = this.scene.opts.atlas;
    const home = this.season.town;
    if (!a?.settlements || home === null) throw new Error('loop: no atlas world or no home town');
    // (a new run: the leader's pools; what earlier runs built is kept — the season's own ledger holds it, also after a
    // reload, where the season loop restores it with the town)
    const ledger: SeasonLedger = { ...newLedger(who.pools, who.income), built: [...this.season.ledger.built] };
    const seasons = Number(this.scene.host.params.get('runlen') ?? RUN_SEASONS);
    this.realm = new Realm({ world: this.saved ?? a.settlements.wiki.snapshot, home, seed: a.atlas.p.seed, leader: who, ledger, land: () => this.season.land, seasons, where: (spot) => this.where(spot), regionAt: (x, y) => a.settlements!.regionAt(x, y) });
    this.runs = this.realm.history(true).filter((e) => e.kind === 'run-began').length;
    this.notes = [];
    this.resultLines = [];
    this.season.setLedger(this.realm.ledger);
    void this.save();
    console.log(`[loop] run ${this.runs}: ${who.name}, ${seasons} seasons; asking: ${this.asking().map((x) => `${x.who} (${x.title})`).join(', ')}`);
    this.set('city');
    // (the town framed above the sheet: its core across the screen)
    this.showTown();
  }

  /**
   * Go to an opportunity's place and hear its presenter: the camera frames the site, the petition opens as a dialog;
   * agreeing commits its cost through the realm (the engine's commit on the ledger's holdings), refusing is remembered.
   */
  open(id: string): void {
    // (a live event going on: back to it)
    const run = id.startsWith('live:') ? this.live.runs.find((x) => `live:${x.id}` === id) : undefined;
    if (run && this.phase === 'city') {
      this.live.goTo(run);
      return this.set('event');
    }
    void this.petition(id);
  }
  private async petition(id: string): Promise<void> {
    const r = this.realm;
    if (!r || this.phase !== 'city' || this.talk.isOpen) return;
    const o = r.offers().find((x) => x.id === id && x.status === 'offered');
    if (!o) return;
    const site = r.siteOf(o);
    const at = site ? this.spot(site) : null;
    this.set('petition');
    if (at) void this.cam.frame(this.at3(at), { zoom: Math.max(6, this.scene.core.camera.zoom * 2.2), place: [0.5, 0.22] });
    const { petition, speaker } = petitionOf(r.engine, id);
    meetPerson(r.w, speaker.id, id);
    // (the cost in the pools' own words: the contract's agents are "workers 3", which is not how the player counts)
    const locks: Partial<Pools> = {};
    for (const q of o.opp.requires) if (q.kind === 'workers' || q.kind === 'army') locks[q.kind === 'workers' ? 'labor' : 'might'] = q.count;
    const turns = 'turns' in o.opp.duration ? o.opp.duration.turns : 1;
    const miss = r.short(o);
    const can = !Object.keys(miss).length;
    const tree = petitionTree({ ...petition, needs: W.costText(locks, o.opp.costs as Partial<Record<Pool, number>>, turns), takes: W.takesText(turns), agree: W.AGREE, canAgree: can ? true : W.shortText(miss) }, speaker, r.leader.name);
    this.speakers.set(speaker.id, { name: speaker.name, title: capitalise(speaker.role), colour: speaker.persona.portrait.cloth, portrait: portraitUrl(speaker.persona.portrait) });
    const path = await this.talk.open(tree);
    const last = path.at(-1);
    const act = last ? actOf(tree, last.node, last.choice) : undefined;
    console.log(`[loop] petition ${o.template}: ${act ?? 'closed'}`);
    if (act === 'commit' && can) {
      r.ledger = this.season.ledger;
      const done = r.commit(id);
      this.season.setLedger(r.ledger);
      this.notes = [...this.notes, W.agreedLine(speaker.name, o.opp.title)];
      // (a live event's card: agreed, it begins — played in the city while the season goes on, resolved by its own end
      // or the season's)
      if (r.liveOf(done)) {
        void this.save();
        return this.beginLive(done);
      }
    } else if (act === 'refuse') {
      r.refuse(id);
      this.notes = [...this.notes, W.refusedLine(speaker.name)];
    }
    void this.cam.release();
    // (an answer given is kept: a reload comes back to this season with it)
    if (act === 'commit' || act === 'refuse') void this.save();
    this.set('city');
  }

  /** (scripts) answer the open petition: the dialog's own buttons are the player's way */
  get talking(): boolean {
    return this.talk.isOpen;
  }

  next(): void {
    const r = this.realm;
    if (this.phase !== 'city' || !r || this.season.playing) return;
    // (the opportunities' season first: commitments due resolve into the fact layer, offers past their time fire their
    // expiry, the arc moves on; then the ledger's own season plays as the time-lapse)
    // (round 6: the live events still going are told to the realm as they stand and taken out of the city; the season's
    // end resolves each from that state)
    for (const run of [...this.live.runs]) {
      r.tellLive(run.id, this.live.told(run));
      this.live.close(run);
    }
    this.armed = null;
    r.ledger = this.season.ledger;
    this.notes = r.endSeason();
    this.season.setLedger(r.ledger);
    this.building = this.season.ledger.projects.length > 0;
    this.set('season');
    void this.season.next().then(async () => {
      while (this.season.playing) await new Promise((res) => setTimeout(res, 100));
      r.afterSeason(this.season.ledger);
      this.season.setLedger(r.ledger);
      await this.save();
      if (this.building && !r.forcedLive()) this.showTown();
      this.building = false;
      this.flow();
    });
  }

  skip(): void {
    this.season.skip();
  }

  /** what comes next: the attack if the arc brought it, the end if the threat is past */
  private flow(): void {
    const r = this.realm!;
    // (a live event nobody asks about — the raid in the run's last season, refugees on the road: it begins. One left
    // under way by a reload that the player must stay at: again from its start)
    const stay = r.liveRunning().find((o) => r.liveOf(o)?.stay && !this.live.runs.some((x) => x.id === o.id));
    if (stay) return this.beginLive(stay);
    const forced = r.over ? null : r.forcedLive();
    if (forced) {
      r.ledger = this.season.ledger;
      const o = r.commit(forced.id);
      this.season.setLedger(r.ledger);
      void this.save();
      return this.beginLive(o);
    }
    if (r.raid !== null) console.error('[loop] the raid is due and its card was not dealt');
    if (r.over) return this.set('end');
    this.set('city');
  }

  proceed(): void {
    if (this.phase === 'result') this.flow();
  }

  again(): void {
    this.set('leader');
  }

  map(): void {
    this.scene.atlasMap?.open();
  }

  /** the camera on the latest change this run made to the land that the window holds (its kind; null: none) */
  showLast(): string | null {
    const S = this.scene.stream;
    const m = this.realm?.changes().at(-1);
    if (!S || !m) return null;
    const x = m.cell[0] - S.origin[0];
    const y = (m.cell[1] - S.origin[1]) * ROW_H;
    void this.cam.look(this.at3([x, y]), { zoom: Math.max(3, Math.min(7, innerWidth / (2.6 * m.radius))), ease: 1.2, place: [0.5, 0.36] });
    return m.kind;
  }

  /** the camera back on the whole town, above the sheet */
  showTown(): void {
    const t = this.town;
    // (the sites' reach across the screen: every name a card can stand at is in view)
    if (t) void this.cam.look(this.at3(t.centreInWindow()), { zoom: innerWidth / (2 * (SITE_REACH + 0.06) * t.box.R), place: [0.5, 0.36], ease: 1.2 });
  }

  /** (scripts) the camera `dx`, `dy` cells off the town's centre: the window slides off the town (LS-45's bisect) */
  lookOff(dx: number, dy: number): void {
    const t = this.town;
    if (!t) return;
    const c = t.centreInWindow();
    void this.cam.look(this.at3([c[0] + dx, c[1] + dy]), { zoom: 5, ease: 1.2, place: [0.5, 0.36] });
  }

  /** (scripts) the live events as the units tell them: each one's numbers, and the squads' posts */
  liveDebug(): unknown {
    const forces = this.scene.townForces;
    const war = this.season.war;
    return { focus: this.live.focus?.template ?? null, runs: this.live.runs.map((r) => ({ template: r.template, t: Math.round(r.t), entry: r.entry, fighting: r.fighting, numbers: this.live.numbers(r), state: this.live.state(r) })), squads: war?.squadGroups.map((g) => forces?.report(g)) ?? [], war: war?.debug() };
  }

  /** (scripts: the census) a live event of the run played now without its card, to measure a frame while one runs.
   *  It is never resolved: the page is closed after */
  measureEvent(template: string): boolean {
    const r = this.realm;
    const t = r?.engine.templates.find((x) => x.id === template);
    const def = t?.play?.event;
    if (!r || !def || this.phase !== 'city') return false;
    const site = (t.bind.find((b) => b.as === 'site')?.where?.[0] as { args?: unknown[] } | undefined)?.args?.[1] as SiteKey | undefined;
    this.live.start({ id: `measure:${template}`, template } as Offer, def, site ?? null);
    this.set('event');
    return true;
  }

  /** (scripts) the raid as the fight's screen counts it, or null: no raid on */
  fightView(): { n: number; alive: number; soldiers: number; fallen: number; stage: 'coming' | 'there' | 'fighting'; failed: boolean } | null {
    const run = this.live.runs.find((r) => r.def.tag === 'raid');
    if (!run) return null;
    const v = this.live.numbers(run);
    return { n: v.raiders, alive: v.alive, soldiers: v.soldiers, fallen: v.fallen, stage: run.fighting ? 'fighting' : run.groups.get('raiders')?.arrived ? 'there' : 'coming', failed: false };
  }

  /** (scripts) where a site of the town is on the screen (px) */
  siteAt(site: SiteKey): [number, number] | null {
    const at = this.spot(site);
    return at ? (this.scene.core.camera.project(at[0], at[1], this.z(at[0], at[1])) as [number, number]) : null;
  }

  /** (scripts) the camera on a site of the town at a zoom */
  lookAt(site: SiteKey, zoom: number): void {
    const at = this.spot(site);
    if (at) void this.cam.look(this.at3(at), { zoom, ease: 1.2, place: [0.5, 0.36] });
  }

  /** (scripts) where the figures the event's camera follows are on the screen now (px), or null: none read */
  raidAt(): [number, number] | null {
    const run = this.live.focus;
    const p = run && (!run.entry || run.entry.step === 'in') && run.def.camera.follow ? this.live.where(run) : null;
    return p && this.live.figures().length ? this.scene.core.camera.project(p[0], p[1], p[2]) : null;
  }

  arm(spell: SpellId | null): void {
    this.armed = spell;
    this.changed();
  }

  /** a tap on the map with a spell armed that may be cast now: cast there */
  private cast(e: PointerEvent): void {
    const id = this.armed;
    if (!id || !this.allowed().includes(id)) return;
    const rect = this.scene.host.canvas.getBoundingClientRect();
    // (the map's own tool and pan are not given this press: the cast is the gesture)
    e.stopPropagation();
    e.preventDefault();
    this.castAt(id, e.clientX - rect.left, e.clientY - rect.top, CAST_WAIT_FRAMES);
  }

  /** what the player is told about a cast: on the event's sheet for a few seconds, or in the town's news */
  private tell(line: string): void {
    if (this.phase === 'event') {
      this.fightLine = line;
      this.lineHeld = performance.now() + 3500;
    } else this.notes = [...this.notes.filter((t) => t !== line), line];
    this.changed();
  }

  /**
   * The cast at a screen point: where the press's ray meets the level the event's figures stand at (their own places,
   * which the units already read while an event is on) — the ground under a press answers null until its page has been
   * read and again after its chunk has run, and a finger has no hover before its press to have asked for it (LS-46).
   * With no figure read (a fire, the growth rune), the ground's pages are asked for once and waited for.
   * Each spell is the real system's call where one exists: Fire sets what will burn alight (the fire system) and
   * burns the units there; Rain is a storm over the tap (the weather's own, which puts fire out); the growth rune grows
   * the plants there (the ecology's) and marks the field for the season. Heat ray's look is still the lightning strike.
   */
  private castAt(id: SpellId, sx: number, sy: number, tries: number): void {
    if (this.armed !== id) return;
    const r = this.realm!;
    const cam = this.scene.core.camera;
    const w = this.scene.worldApi;
    if (!w?.fire || !w.fx || !w.plants || !w.terrain) throw new Error('loop: this level has no world API for fire, particles, plants and ground');
    const api = { fire: w.fire, fx: w.fx, plants: w.plants, terrain: w.terrain };
    const z = id === 'heatray' || id === 'fire' ? this.live.figuresZ() : null;
    const g = z !== null ? cam.groundAt(sx, sy, () => z) : cam.groundAt(sx, sy, this.scene.heightAt);
    if (!g) {
      const terrain = api.terrain;
      if (tries <= 0) return console.warn('[loop] spell: the ground under the tap was never read');
      // (the screen's reach in cells round the camera's target, both ways)
      const reach = Math.max(innerWidth, innerHeight) / cam.zoom;
      const [tx, ty] = cam.target;
      return void terrain.load(tx - reach, ty - reach, tx + reach, ty + reach).then(
        () => this.castAt(id, sx, sy, tries - 1),
        (e) => console.warn(`[loop] spell: the ground's pages could not be read: ${e}`),
      );
    }
    if (id === 'growth') {
      // (a rune over the fields: anywhere else it has no field to feed)
      const f = this.spot('fields');
      if (!f || Math.hypot(g[0] - f[0], g[1] - f[1]) > GROWTH.reach) return this.tell(W.GROWTH_MISS);
    }
    if (pools(this.season.ledger).magic < SPELL_COST[id]) {
      this.tell(W.shortText({ magic: SPELL_COST[id] }));
      return this.arm(null);
    }
    r.ledger = this.season.ledger;
    r.cast(id, id === 'growth' ? 'fields' : undefined);
    this.season.setLedger(r.ledger);
    const run = this.live.focus;
    if (run && this.phase === 'event') run.casts[id] = (run.casts[id] ?? 0) + 1;
    if (id === 'heatray') {
      this.scene.units?.strike?.({ at: [g[0], g[1]], radius: HEATRAY.radius, damage: HEATRAY.damage }, 'spell');
      this.scene.powers.scriptStrike(g[0], g[1], g[2]);
    } else if (id === 'fire') {
      this.scene.units?.strike?.({ at: [g[0], g[1]], radius: FIRE.radius, damage: FIRE.damage }, 'spell');
      api.fire.ignite(g[0], g[1], { radius: FIRE.light, intensity: 0.9 });
      api.fx.burst('flame', g[0], g[1], g[2] + 0.5, { count: 40 });
    } else if (id === 'rain') {
      this.scene.core.weather.spawn(g[0], g[1]);
      api.fx.burst('splash', g[0], g[1], g[2] + 0.5, { count: 30 });
      this.tell(W.RAIN_CAST);
    } else {
      api.plants.grow(g[0], g[1], { radius: GROWTH.radius, strength: GROWTH.strength });
      api.fx.burst('leaves', g[0], g[1], g[2] + 1, { count: 50 });
      this.tell(W.GROWTH_CAST);
      void this.save();
    }
    console.log(`[loop] ${id} at ${g[0].toFixed(0)}, ${g[1].toFixed(0)}`);
    this.arm(null);
  }
}

/** the history's kinds the end-of-run screen always shows (the rest: those with a weight) */
const SHOWN = new Set(['built', 'founding', 'relieved', 'fell', 'raid-held', 'raid-broke', 'tribute-paid', 'made-safe', 'flooded', 'burned', 'melted', 'buried', 'lens-lit', 'farm-burned', 'scouts-seen']);

export function startRunLoop(scene: LevelScene, towns: FieldTowns, mut: MutateEngine | null): void {
  let game: Game | null = null;
  const season = startSeasonLoop(scene, towns, {
    ui: false,
    dealer: false,
    // (the raid is the arc's last stage — the realm's — not the fixed schedule; LS-16: the attack screen calls it, with
    // the camera down the road it comes by)
    raid: () => game?.realm?.raid ?? null,
    calls: true,
    // (consequences come home: refugees in the streets, a camp's ore wagons — the fact layer's, through the realm)
    life: (l) => {
      // (round 6: the trade route's wagons and ships by the share of its far towns still standing)
      const x = game?.realm?.life();
      return x ? { ...l, commuters: l.commuters + x.people, wagons: Math.round(l.wagons * x.trade) + x.wagons, ships: Math.round(l.ships * x.trade) } : l;
    },
    ready: () => void game!.load(),
  });
  game = new Game(scene, towns, season, mut);
  scene.seasonUi = mountRunUi(scene.host.ui, game);
  (globalThis as { rungame?: Game }).rungame = game;
}
