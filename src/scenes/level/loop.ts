// (loop-skeleton; docs/design/LOOP_SKELETON.md) ?loop=1: the main game loop on the town the level opens on, run on the
// existing engine. Pick a leader → the town, with what people ask shown over their places → go to one: the presenter's
// dialog (the petition) → agree: the cost committed → Next season (the season loop's time-lapse) → … → the raiders'
// arc reaches its last stage → the attack plays with the soldiers built, spells cast → the end of the run, read from
// the fact layer's history → a new run in the same saved world.
// This file is the wiring only. The rules are season/realm.ts (the living engine joined to the season ledger), the
// templates season/realm-templates.ts, the pools the season ledger, the building and the fight the season loop and its
// war, the screens season/run-ui.ts, the dialog dialog/petition.ts. `window.rungame` for scripts.
import type { WorldSnapshot } from '../../api/contracts/world';
import { Dither, Slice } from '../../api/cutaway';
import { worldApiOf } from './world-api';
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
import { POI_COLOUR } from '../../season/pois';
import { restoreMutators } from './mutators';
import type { SiteKey } from '../../season/realm-templates';
import { declutter, placeSites, REACH as SITE_REACH } from '../../season/sites';
import { mountRunUi, type Asking, type Marker, type Panel, type Phase, type RunGame } from '../../season/run-ui';
import { chainLine, fetchPacks, lawLine, lawLines, loadRunPacks, mechOf, realmExtra, recordByPlace, ruleLines, thingMarks, unlockedAbilities, worldNow, worldOf, type ThingMark } from '../../season/run-packs';
import type { Pack, PackAbility } from '../../packs/check';
import { castAbility, SHIELD_SECONDS, type LoadedPack } from '../../packs/load';
import type { RuleHit } from '../../living/rules';
import { SPELL_MECH } from '../../living/live';
import { grant, lose } from '../../season/ledger';
import { keepBuilt, lastHome, moveHome } from '../../season/realm-home';
import { leaderChoices, startLines, type LeaderChoice } from '../../season/run-packs';
import type { LeaderView } from '../../season/run-ui';
import type { Leader } from '../../season/realm';
import type { PackLeader } from '../../packs/check';
import { startThings } from '../../packs/load';
import { cardOfTemplate, siteId } from '../../season/realm-templates';
import { combosOf } from '../../season/combos';
import * as TW from '../../table/words';
import { packRoadShapes, type RoadRaster, type RoadShape } from '../../agents/roads';
import * as W from '../../season/run-words';
import { StoryCamera, type V3 } from '../../story/camera';
import { FIRE_WAKE, GROW_WAKE, QuietWorld } from '../../sim/quiet';
import { Messenger, type Mount, type Speech } from './messenger';

/** (loop round 17) the cards whose news is trade's: it comes by cart, or by ship with a harbour (realm-templates KIND) */
const TRADE_CARDS = new Set(['market', 'trade', 'harbour']);
import type { LevelScene } from '../level';
import { startSeasonLoop, storeReady } from './season';
import { seasonWeather } from '../../weather/presets';

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
  /** (loop round 10) `home`: the town the run is played from — the page opens on it to take the run up (absent in an
   *  older save: the town the page opened on) */
  run: { state: RunState; ledger: SeasonLedger; notes: string[]; home?: string } | null;
}
/** (loop round 10, LS-93) a run asked for from another town than the page's: the leader, kept while the page opens on
 *  that town (`?town=<id>`), then begun there */
const START_KEY = 'realm:start';
interface PendingStart {
  leader: string;
  home: string;
}
/** the zoom on a district being built while a season passes: its lots and the people working on them read */
const BUILD_ZOOM = 9;
/** (loop round 14) seconds between a point of interest's marks in 3D */
const POI_MARK_S = 0.6;
/** (loop round 11) bursts round a unit spell's reach as it is cast */
const SPELL_RING = 16;
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
/** (loop round 16) seconds the growth rune keeps the succession and the growing glow awake */
const GROWTH_WAKE_S = 20;
/** (loop round 17) cells round a lit point the quiet world looks for fire in (a cast's fire spreads that far and more
 *  only over a minute or two; a look every few seconds follows it while any of it burns) */
const FIRE_LOOK = 24;
/** (loop round 17) seconds the structure pass is woken after a mid-season change to the land (its loose material
 *  falls within it — no GPU count of moving cells to hold it by) */
const MUTATED_S = 15;
/** (round 8) half the width of an arterial stamped for the units' fields (cells; tunable) */
const ROAD_HALF = 2;

class Game implements RunGame {
  phase: Phase = 'boot';
  realm: Realm | null = null;
  notes: string[] = [];
  fightLine: string | null = null;
  resultLines: string[] = [];
  armed: string | null = null;
  readonly onChange: (() => void)[] = [];
  /** (round 8) the outside-authored packs played with the base cards (`&packs=`, `&pack=`), as JSON and loaded; what
   *  was wrong with any left out */
  private packs: LoadedPack[] = [];
  private played: Pack[] = [];
  private packReport: string[] = [];
  /** (round 8) the synergy rules' firings since the last season's end (the rules page), and the page open */
  private recent: RuleHit[] = [];
  private hitsNew: RuleHit[] = [];
  panel: Panel | null = null;
  /** (round 8) the pack cards done last season at a site of the town: a marker there for a season (the floor) */
  private doneMarks: { id: string; title: string; site: SiteKey; text: string }[] = [];
  private cam: StoryCamera;
  /** the world as saved (null: the atlas's own), and its history before this page's runs */
  private saved: WorldSnapshot | null = null;
  private talk: DialogBox;
  private speakers = new Map<string, Speaker>();
  /** the live events (round 6): one runner plays the raid, the dead, a parade, a fire — scenes/level/live-runner.ts */
  private live: LiveRunner;
  /** (loop round 16) the one who brings news in person (scenes/level/messenger.ts) */
  readonly messenger: Messenger;
  /** (loop round 16) the quiet world: the land's background processes asleep in play (null: `?quiet=0`) */
  readonly quiet: QuietWorld | null;

  /** (loop round 16) the quiet world's holds from the game's state, each frame: the between-seasons time-lapse wakes
   *  everything; a fire's stalls or a lava front (pouring or setting) keep the fire awake */
  private quietNow(): void {
    const q = this.quiet;
    if (!q) return;
    if (this.phase === 'season' && this.season.playing) {
      if (!q.has('timelapse')) q.hold('timelapse', 'all');
    } else if (q.has('timelapse')) q.release('timelapse');
    if (this.live.hot) {
      if (!q.has('live-hot')) q.hold('live-hot', FIRE_WAKE);
    } else if (q.has('live-hot')) q.release('live-hot');
    q.update();
  }

  /** (loop round 17, sim/quiet.ts BurningNear) anything alight within FIRE_LOOK cells of these points: the fire field's
   *  pages there read (a few KB, every few seconds while a fire is held), then looked at every other column */
  private async burningNear(at: readonly (readonly [number, number])[]): Promise<boolean> {
    const fire = worldApiOf(this.scene).fire;
    if (!fire) throw new Error('loop: no fire API to watch a fire with');
    const pts: [number, number][] = [];
    for (const [x, y] of at) for (let dy = -FIRE_LOOK; dy <= FIRE_LOOK; dy += 16) for (let dx = -FIRE_LOOK; dx <= FIRE_LOOK; dx += 16) pts.push([x + dx, y + dy]);
    await fire.loadFire(pts);
    for (const [x, y] of at)
      for (let dy = -FIRE_LOOK; dy <= FIRE_LOOK; dy += 2)
        for (let dx = -FIRE_LOOK; dx <= FIRE_LOOK; dx += 2) if ((fire.fireAt(x + dx, y + dy) ?? 0) > 0.02) return true;
    return false;
  }

  constructor(
    private scene: LevelScene,
    private towns: FieldTowns,
    private season: SeasonLoop,
    private mut: MutateEngine | null,
  ) {
    // (loop round 17: the dither only — the slice, cutting the land over a held point it takes for "under a roof", cut
    // the hills round the town to dark sections at the town's framing: local/round17/shots2's after-town)
    this.cam = new StoryCamera(scene.core.camera, scene.storyCut ? { dither: scene.storyCut.dither } : {});
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
    // (loop round 16, sim/quiet.ts: the world asleep in play but for what wakes it; `?quiet=0` as before)
    this.quiet = scene.host.params.get('quiet') === '0' ? null : new QuietWorld(scene.core.sim, (at) => this.burningNear(at));
    if (this.quiet && scene.weatherSet) scene.weatherSet.quiet = true;
    // (loop round 17: the watched fires' points slide with the land; a change to the land mid-season (a front's end, a
    // card's mutator) wakes the structure pass so what it left loose falls now, not at the next time-lapse — LS-147)
    if (this.quiet) {
      const q = this.quiet;
      scene.core.onShift.push((dx, dy) => q.shift(dx, dy));
      mutators.applied.push((spec) => {
        if (this.phase === 'season' && this.season.playing) return;
        q.wake('mutated', { systems: ['structure'] }, MUTATED_S);
        console.log(`[quiet] ${spec.kind}: the structure woken ${MUTATED_S} s`);
      });
    }
    this.live = new LiveRunner({ scene, cam: this.cam, season, realm: () => this.realm, town: () => this.town, spot: (k) => this.spot(k), z: (x, y) => this.z(x, y), changed: () => this.changed(), ended: (run) => this.liveEnded(run) });
    // (round 7, LS-63: the runner's window points move with the land)
    scene.core.onShift.push((dx, dy, dz) => this.live.shift(dx, dy, dz));
    // (loop round 16: news comes with a person)
    this.messenger = new Messenger({ units: () => scene.units ?? null, cam: this.cam, z: (x, y) => this.z(x, y), ui: scene.host.ui });
    scene.core.onShift.push((dx, dy) => this.messenger.shift(dx, dy));
    let last = performance.now();
    const tick = (now: number) => {
      requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.cam.update(dt);
      this.keepNear();
      this.feedRoads();
      this.watchBuild(dt);
      this.live.update(dt);
      this.liveLine();
      this.poiMarks(dt);
      this.quietNow();
      this.messenger.update(dt);
    };
    requestAnimationFrame(tick);
    // (loop round 14, season/pois.ts: the points of interest on the atlas map — a pin each, its kind's colour, a
    // cleared one says so; the map's own pins kept)
    const map = scene.atlasMap;
    if (map) {
      const prev = map.marks;
      map.marks = () => [...(prev?.() ?? []), ...(this.realm?.pois() ?? []).map((p) => ({ at: p.cell, name: p.state === 'cleared' ? `${p.name} (cleared)` : p.name, colour: POI_COLOUR[p.kind] }))];
    }
    // (on the window, before the map's own input: the level's input layer lies over the canvas, so a listener on the
    // canvas never heard the tap — round 1's cast was never seen. A tap on the loop's own screens is not a cast)
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!(e.target instanceof Element && e.target.closest('.run-sheet, .run-top, .run-marks button, .run-full, .dlg, .run-say'))) this.cast(e);
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
  /** (round 7, LS-63) the live fire at the market dealt instead of the instant fire-wards hazard (it burns in the town
   *  now); `?livefire=0`: the old hazard */
  private get liveFire(): boolean {
    return this.scene.host.params.get('livefire') !== '0';
  }
  private changed(): void {
    // (round 8: the pack things standing at the town's sites, read again when anything changed — not each frame:
    // `Realm.things` walks every far town)
    this.things = this.realm && this.packs.length ? thingMarks(this.realm, this.packs) : [];
    // (loop round 13: the season's weather — the packs' `weather` lists, in their order; the signs are laid over it)
    if (this.realm) this.scene.weatherSet?.setSeason(seasonWeather(this.packs.flatMap((p) => p.weather), Math.min(this.realm.season, this.realm.seasons)));
    for (const f of this.onChange) f();
  }
  /** (round 8) the pack things in play and their remains, as last read */
  private things: ThingMark[] = [];
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

  /**
   * (loop round 14, season/pois.ts) The points of interest the window holds, marked in 3D with the plain marker (VISION
   * §5: "a plain marker is the floor"): a standing one a column of sparks and a thread of smoke every POI_MARK_S, a
   * cleared one smoke only. Nothing is built there yet (BACKLOG LS-134: each kind its own look).
   */
  private poiT = 0;
  private poiMarks(dt: number): void {
    if ((this.poiT += dt) < POI_MARK_S) return;
    this.poiT = 0;
    const S = this.scene.stream;
    const fx = this.scene.worldApi?.fx;
    const terrain = this.scene.worldApi?.terrain;
    if (!S || !fx || !terrain || !this.realm) return;
    for (const p of this.realm.pois()) {
      const x = p.cell[0] - S.origin[0];
      const y = (p.cell[1] - S.origin[1]) * ROW_H;
      if (!terrain.inWindow(x, y)) continue;
      const z = this.z(x, y);
      // (loop round 15: round 14's 14 sparks and 6 smoke a 1.2 s were not seen at phone size — a tight column now, twice
      // as often, three times the sparks)
      if (p.state === 'standing') fx.burst('sparks', x, y, z + 1, { count: 36, speed: 1.5, spread: 0.4, vel: [0, 0, 12] });
      fx.burst('smoke', x, y, z + 1, { count: 12 });
    }
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
    // (loop round 16: while a messenger comes in, a ring round them and their name over them — nothing else)
    if (this.messenger.busy) {
      const m = this.messenger.walker;
      if (!m) return [];
      const [x, y] = cam.project(m.at[0], m.at[1], m.at[2]);
      return [
        { id: 'folk-messenger', label: '', kind: 'folk', x, y },
        { id: 'folk-messenger-name', label: m.name, kind: 'side', x, y },
      ];
    }
    if (!t || !r || (this.phase !== 'city' && this.phase !== 'petition')) return [];
    const out: Marker[] = [];
    const put = (id: string, label: string, kind: Marker['kind'], at: [number, number] | null) => {
      if (!at) return;
      const [x, y] = cam.project(at[0], at[1], this.z(at[0], at[1]));
      if (x > 0 && y > 0 && x < innerWidth && y < innerHeight) out.push({ id, label, kind, x, y });
    };
    // (loop round 16: the names over the town are the only way in — every ask has one. One at a site of the town stands
    // over it; one bound to a far place or a point of interest, or one whose site is off the screen, is a marker at the
    // screen's edge pointing its way; one with no place at all stands at the keep)
    const edges: { id: string; label: string; at: [number, number] }[] = [];
    for (const o of r.offers()) {
      if (o.status !== 'offered') continue;
      const label = `${r.w.name(o.presenter)} · ${W.leftText(r.left(o))}`;
      const site = r.siteOf(o);
      const at = site ? this.spot(site) : (this.offerPlace(o) ?? this.spot('keep'));
      if (!at) continue;
      const [x, y] = cam.project(at[0], at[1], this.z(at[0], at[1]));
      if (x > 0 && y > 0 && x < innerWidth && y < innerHeight) out.push({ id: o.id, label, kind: 'ask', x, y });
      else edges.push({ id: o.id, label, at });
    }
    // (the standing threat is a card like any other: its own title and countdown, shown on the road)
    const st = r.standingThreat();
    if (st) put('threat', W.threatTag(st.title, st.left), 'threat', this.spot('road'));
    // (round 8: a pack thing at its site — or its remains, from this run or an earlier one; one in the town itself
    // stands by the keep. And the floor: a pack card done last season, at its site, for a season)
    for (const t of this.things) put(`thing:${t.id}`, t.ruined ? W.remainsOf(t.name) : t.name, 'thing', this.spot(t.site ?? 'keep'));
    for (const d of this.doneMarks) put(`done:${d.id}`, W.doneHere(d.title), 'done', this.spot(d.site));
    // (a live event going on without the player: its name over where it is — a tap goes back to it)
    for (const run of this.live.runs) {
      const at = this.live.where(run);
      if (at) put(`live:${run.id}`, W.underWay(run.def.title), 'ask', [at[0], at[1]]);
    }
    // (names kept apart and on the screen, between the top bar and the sheet: LS-3, LS-28)
    const sheetBox = document.querySelector('.run-sheet')?.getBoundingClientRect();
    const sheet = sheetBox && sheetBox.height > 0 ? sheetBox.top : innerHeight;
    const bar = document.querySelector('.run-top')?.getBoundingClientRect().bottom ?? 0;
    // (the edge markers: from the middle of the band the town is shown in, toward where the place is, stopped short of
    // the band's edge; an arrow says which way)
    const mid: [number, number] = [innerWidth / 2, (bar + sheet) / 2];
    for (const e of edges) {
      const [px, py] = cam.project(e.at[0], e.at[1], this.z(e.at[0], e.at[1]));
      let dx = px - mid[0];
      let dy = py - mid[1];
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) [dx, dy] = [0, -1];
      const hw = innerWidth / 2 - 60;
      const hh = (sheet - bar) / 2 - 50;
      const k = Math.min(hw / Math.max(1e-6, Math.abs(dx)), hh / Math.max(1e-6, Math.abs(dy)));
      out.push({ id: e.id, label: `${arrowOf(dx, dy)} ${e.label}`, kind: 'edge', x: mid[0] + dx * k, y: mid[1] + dy * k + 24 });
    }
    const free = declutter(out.map((m) => ({ x: m.x, y: m.y, chars: m.label.length })), innerWidth, bar + 4, sheet - 4);
    out.forEach((m, i) => ([m.x, m.y] = free[i]));
    return out;
  }

  /**
   * (loop round 16) Where an ask that stands at no site of the town is, as a window point: a point of interest's cell, a
   * far town's place (its own, or the town the card is bound to). Null: it names no place on the map.
   */
  private offerPlace(o: Offer): [number, number] | null {
    const r = this.realm;
    const S = this.scene.stream;
    if (!r || !S) return null;
    const e = r.w.facts.entity(o.place) as { at?: { at?: [number, number] } } | undefined;
    if (e?.at?.at) return [e.at.at[0] - S.origin[0], (e.at.at[1] - S.origin[1]) * ROW_H];
    const ids = [o.place, ...Object.values(o.bind ?? {})].filter((x): x is string => typeof x === 'string');
    for (const id of ids) {
      const s = r.w.ws.settlements.find((x) => x.id === id);
      if (s) return [s.at[0] - S.origin[0], s.at[1] - S.origin[1] * ROW_H];
      const p = r.w.facts.entity(id) as { at?: { at?: [number, number] } } | undefined;
      if (p?.at?.at) return [p.at.at[0] - S.origin[0], (p.at.at[1] - S.origin[1]) * ROW_H];
    }
    return null;
  }

  /** (scripts) where the figures of the live event the player is at are on the screen (px): the dead, the raiders */
  deadAt(): [number, number][] {
    return this.live.figures();
  }

  // ---- live events --------------------------------------------------------------------------------------

  /** the live event the player is at, for the sheet */
  get liveNow(): { id: string; title: string; how: string; spells: SpellId[]; abilities: { id: string; name: string }[]; wantsSpells: boolean; canLeave: boolean; canSettle: boolean } | null {
    const run = this.live.focus;
    // (round 8: "settle it now" for an event the player may leave — the raid is played out; a census event has no card)
    return run && this.phase === 'event' ? { id: run.id, title: run.def.title, how: run.def.how, spells: this.allowed(), abilities: this.eventAbilities().map((a) => ({ id: a.id, name: W.castOn(a.name, a.cost.magic ?? 0) })), wantsSpells: !!run.def.spells?.length, canLeave: this.live.canLeave, canSettle: this.live.canSettle && !run.id.startsWith('measure:') } : null;
  }

  /** (round 8) the pack abilities the run has unlocked that may be cast into the live event the player is at: one with
   *  `in_event` naming the event's kind */
  private eventAbilities(): PackAbility[] {
    const r = this.realm;
    const run = this.live.focus;
    if (!r || !run || this.phase !== 'event' || !this.packs.length) return [];
    return unlockedAbilities(r, this.packs).filter((a) => a.in_event?.kinds.includes(run.def.tag));
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
    // (round 8: a card a rule started is dealt as the arc's, at the town; its own site is still its binding's)
    const bound = o.bind?.site ? ((r.w.facts.entity(o.bind.site)?.attrs?.site as SiteKey | undefined) ?? null) : null;
    const run = this.live.start(o, def, r.siteOf(o) ?? bound);
    if (!run.site) console.warn(`[loop] live event ${o.template} has no site: played at the town's heart`);
    this.fightLine = W.fill(def.line, this.live.numbers(run));
    this.set('event');
  }

  /** the sheet's line of the event the player is at, from its numbers as the units tell them */
  private liveLine(): void {
    const run = this.live.focus;
    if (!run || this.phase !== 'event' || this.lineHeld > performance.now()) return;
    const line = run.entry && run.entry.step !== 'in' ? W.LIVE_WAIT : W.fill(run.def.line, this.live.numbers(run));
    // (round 8: the sheet drawn again when "Settle it now" becomes possible, too)
    const settle = this.live.canSettle && this.live.canLeave ? 2 : this.live.canSettle ? 1 : this.live.canLeave ? 3 : 0;
    if (line === this.fightLine && settle === this.settleShown) return;
    this.settleShown = settle;
    this.fightLine = line;
    this.changed();
  }
  /** (round 8) what the sheet last showed of "Settle it now" and "Back to the town" (a key: the sheet is drawn again
   *  when it changes — before, "Back to the town" could be allowed with the sheet not showing it) */
  private settleShown = 0;
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
    this.notes = [...this.notes, ...this.chained(rep.lines)];
    this.markDone(this.realm!.w.turn, true);
    if (at) {
      this.showTown();
      // (back in the town — or straight on to another event nobody asks about: the raid behind the refugees)
      this.flow();
    } else this.changed();
  }

  /**
   * (round 8; the card table's "settle it now") The live event the player is at resolved now, from the state it is
   * in (the units' counts, the casts made): its result and the rules it sets off apply at once, and an event a rule
   * starts begins at once — the next bout of a chain is played in the same season.
   */
  settle(id: string): void {
    const run = this.live.focus;
    const r = this.realm;
    // (loop round 10, job 5: one press settles the event it was pressed for — not one begun since; the chain of bouts
    // goes on without limit, a press each, as the owner wants the engines unbounded and paced by the player's actions)
    if (!r || !run || run.id !== id || this.phase !== 'event' || !this.live.canSettle || run.id.startsWith('measure:')) return;
    r.tellLive(run.id, this.live.told(run));
    r.ledger = this.season.ledger;
    const rep = r.resolveNow(run.id);
    this.season.setLedger(r.ledger);
    this.live.close(run);
    this.armed = null;
    console.log(`[loop] settled now: ${run.template} ${rep.tier} ${JSON.stringify(rep.vars)}; ${rep.lines.join(' ')}`);
    this.notes = [...this.notes, ...this.chained(rep.lines)];
    this.markDone(r.w.turn, true);
    void this.save();
    this.showTown();
    this.flow();
  }

  /** (round 8) a season's or an event's lines with each rule firing worded as the card table words a chain: the rule
   *  that had set the card going → what happened → this rule */
  private chained(lines: readonly string[]): string[] {
    const hits = this.hitsNew.splice(0);
    return lines.map((l) => {
      const h = hits.find((x) => `${x.text}.` === l);
      return h ? chainLine(h) : l;
    });
  }

  /** (round 8, the floor) the pack cards done or run out since `since`, each marked at its site for a season */
  private markDone(since: number, keep: boolean): void {
    const r = this.realm;
    if (!r || !this.packs.length) return;
    const pack = new Set(r.engine.templates.filter((t) => t.themes.some((x) => x.startsWith('pack:'))).map((t) => t.id));
    const fresh = r
      .record()
      .filter((e) => e.turn >= since && pack.has(e.card))
      .flatMap((e) => {
        const site = r.w.facts.entity(e.place)?.attrs?.site as SiteKey | undefined;
        return site ? [{ id: `${e.card}:${e.turn}`, title: e.title, site, text: TW.recordLine(e.run, e.leader, e.title, e.result) }] : [];
      });
    this.doneMarks = keep ? [...this.doneMarks.filter((d) => !fresh.some((f) => f.id === d.id)), ...fresh] : fresh;
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
    // (round 9: one line for one thing — a bout's result was told twice on the end screen in round 8's cards walk, two
    // records of one season with the same words; the second is left out here. Which two records they were is not found)
    const seen = new Set<string>();
    return r
      .history()
      .filter((e) => SHOWN.has(e.kind) || (e.weight ?? 0) !== 0)
      .map((e) => ({ season: e.turn - t0, text: W.sentence(e.note ?? e.kind) }))
      .filter((l) => !seen.has(`${l.season}|${l.text}`) && !!seen.add(`${l.season}|${l.text}`));
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
    // (loop round 12: a front lays an entry at each point it reached, all named by the card's place — one line each)
    return [...new Set(r.changes().map((m) => W.landLine(m.kind, r.placeName(m))))];
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

  /**
   * (round 8, LS-77) The units' fields made to prefer the town's roads: its arterials (the atlas roads it was given,
   * `FieldTown.roadInWindow`) stamped as road bands into the agents' road bits (`Agents.setRoads`, which had no caller
   * since the fortress went), so a step along them costs ROAD_COST of one on open ground in every field. Shapes in world
   * cells (x, y world units), placed by the window's origin each frame — a slide moves only the offset. The streets
   * inside the town are the GPU's raster, which the CPU does not have: not stamped (LS-88). `?roads=0`: off.
   * FIXED-CITY: one town's roads.
   */
  private feedRoads(): void {
    const t = this.town;
    const S = this.scene.stream;
    const agents = (this.scene.units as { agents?: { setRoads(s: Float32Array, ox: number, oy: number): void; setRoadRaster(r: RoadRaster | null): void } } | null)?.agents;
    if (!t || !S || !agents || this.scene.host.params.get('roads') === '0') return;
    // (round 9, LS-88: every street of the town, from its road raster on the GPU — citygen's ROADS, drawn again on each
    // mesh run (meshRuns its version) — at the grid's place in the window now; `?streets=0`: the arterials alone)
    if (t.times && this.scene.host.params.get('streets') !== '0') {
      const p = t.gridPlace();
      agents.setRoadRaster({ buf: t.routes.roads, gw: t.box.w, gh: t.box.h, ox: p.dx, oy: p.dy, version: t.meshRuns });
    }
    if (this.roadsOf?.town !== t.site.id) {
      const bands: RoadShape[] = [];
      for (let k = 0; k < t.roadCount; k++) {
        const line = t.roadInWindow(k).map(([x, y]) => [x + S.origin[0], y + S.origin[1] * ROW_H] as [number, number]);
        for (let i = 1; i < line.length; i++) bands.push({ a: line[i - 1], b: line[i], half: ROAD_HALF });
      }
      if (!bands.length) return;
      this.roadsOf = { town: t.site.id, shapes: packRoadShapes(bands) };
      console.log(`[loop] roads for the units' fields: ${bands.length} bands on ${t.roadCount} arterials`);
    }
    agents.setRoads(this.roadsOf.shapes, -S.origin[0], -S.origin[1]);
  }
  private roadsOf: { town: string; shapes: Float32Array } | null = null;

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
    // (round 8: the packs first — a run taken up again needs its cards. A pack with errors is left out: its report is
    // a page the town sheet opens, and the base game plays)
    const asked = await fetchPacks(this.scene.host.params);
    const got = loadRunPacks(asked.json);
    this.packs = got.packs;
    this.played = got.played;
    this.packReport = [...asked.errors, ...got.report];
    if (asked.json.length || asked.errors.length) console.log(`[loop] packs: ${this.packs.map((p) => p.id).join(', ') || 'none'} played${this.packReport.length ? `; left out:\n${this.packReport.join('\n')}` : ''}`);
    if (this.packReport.length) this.panel = { title: W.PACKS_BAD, sections: this.packReport.map((t) => ({ lines: t.split('\n') })) };
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
    // (loop round 10, LS-93: the page plays from the run's home. A run under way is taken up at its own town; a run
    // asked for from another town begins once the page has opened there; with no run, a new one continues from where
    // the world's last run was played (the card table's rule, CT-56 (8)). The page is opened again on that town —
    // `?town=<id>`, which the level opens on and the town generator builds as the window nears it)
    const home = this.season.town;
    const startBytes = st?.has(START_KEY) ? await st.get(START_KEY) : null;
    const start = startBytes ? (JSON.parse(new TextDecoder().decode(startBytes)) as PendingStart) : null;
    if (this.pending) {
      if (this.pending.home && this.pending.home !== home) return this.openOn(this.pending.home);
      if (this.resume(this.pending)) return;
    } else if (start) {
      if (start.home !== home) return this.openOn(start.home);
      await st!.delete(START_KEY);
      this.set('leader');
      return this.begin(start.leader);
    } else if (this.saved && home !== null) {
      const last = lastHome(worldOf(this.saved));
      if (last && last !== home) return this.openOn(last);
    }
    this.set('leader');
  }

  /**
   * (loop round 10, LS-93) The page opened again on another town of the world (`?town=<id>`, without `fresh`): the
   * level opens there and the town generator builds it, as it does the start town. The saved world goes with it (the
   * store is the world's). A town the page already asked for and did not open on is an error, not a loop.
   */
  private openOn(town: string): void {
    const u = new URL(location.href);
    if (u.searchParams.get('town') === town) throw new Error(`loop: the page asked for ${town} and opened on ${this.season.town}`);
    u.searchParams.set('town', town);
    u.searchParams.delete('fresh');
    console.log(`[loop] the run is played from ${town}: the page opens there`);
    this.set('boot');
    location.assign(u.toString());
  }

  /** (loop round 10, LS-93) the towns this page can play from: those the town generator builds (a village and up) */
  private canHome = (id: string): boolean => !!this.scene.opts.atlas?.fieldTowns?.includes(id);

  /** (loop round 10, LS-93) the leaders the start screen shows, read from the saved world (cached until it changes) */
  private choices: { w: FactWorld; list: LeaderChoice[] } | null = null;
  leaders(): LeaderView[] {
    const home = this.season.town;
    const a = this.scene.opts.atlas;
    if (home === null || !a?.settlements) return [];
    if (!this.choices) {
      const w = worldOf(this.saved ?? this.baseWorld());
      this.choices = { w, list: leaderChoices(w, this.played, W.LEADERS, home, this.canHome) };
    }
    const w = this.choices.w;
    return this.choices.list.map((c) => ({ id: c.id, name: c.name, line: c.line, pools: c.pools, locked: c.locked, note: c.home && c.home !== home ? W.playsFrom(w.name(c.home)) : null }));
  }

  /** a leader by id: a base leader, or a pack leader as the Realm takes one (pools, income) */
  private leaderOf(id: string): { who: Leader; pack: PackLeader | null } | null {
    const base = W.LEADERS.find((l) => l.id === id);
    if (base) return { who: base, pack: null };
    const p = this.played.flatMap((x) => x.leaders ?? []).find((l) => l.id === id);
    if (!p) return null;
    return { who: { id: p.id, name: p.name, line: p.line, pools: { magic: 0, might: 0, labor: 0, materials: 0, intel: 0, unrest: 0, ...p.pools }, income: { ...(p.income ?? {}) } }, pack: p };
  }

  /**
   * A run under way in the save taken up where it was left (LS-8): the same season, pools, board, spells and world.
   * The season is as it stood at the last save — the run's start, each answer given, each season's end, the fight's
   * end. False: the save's leader is not one of this build's.
   */
  private resume(p: NonNullable<SavedRun['run']>): boolean {
    const a = this.scene.opts.atlas;
    const home = this.season.town;
    const got = this.leaderOf(p.state.leader);
    if (!a?.settlements || home === null || !got || !this.saved) return false;
    const who = got.who;
    this.realm = null;
    this.realm = new Realm({ world: this.saved, home, seed: a.atlas.p.seed, leader: who, ledger: p.ledger, land: () => this.season.land, seasons: p.state.seasons, where: (spot) => this.where(spot), regionAt: (x, y) => a.settlements!.regionAt(x, y), resume: p.state, liveFire: this.liveFire, ...this.packOptions(home, who.id, () => p.ledger, got.pack) });
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
    this.nowCache = null;
    this.choices = null;
    const rec: SavedRun = { v: 2, world: delta(this.baseWorld() as never, JSON.parse(JSON.stringify(this.saved)) as never), run: r.over ? null : { state: r.runState(), ledger: this.season.ledger, notes: this.notes, home: r.home } };
    const bytes = new TextEncoder().encode(JSON.stringify(rec));
    // (the store takes the bytes: their length said first)
    console.log(`[loop] world saved: ${bytes.length} B (${JSON.stringify(rec.world).length} B the world's changes, the rest the run), ${r.history(true).length} events, ${(performance.now() - t0).toFixed(0)} ms`);
    await st.put(WORLD_KEY, bytes, { session: 'loop', hash: 0 });
  }

  // ---- the player's moves -----------------------------------------------------------------------------

  pick(id: string): void {
    const a = this.scene.opts.atlas;
    const home = this.season.town;
    if (!a?.settlements || home === null) throw new Error('loop: no atlas world or no home town');
    const choice = this.leaders().find((l) => l.id === id);
    if (!choice || choice.locked !== null) return;
    // (loop round 10, LS-93: a pack leader who plays from a far town — the page opens on it, and the run begins there)
    const far = this.choices?.list.find((c) => c.id === id)?.home ?? null;
    if (far && far !== home) {
      const st = this.scene.stream?.store;
      if (!st) throw new Error('loop: no world store to keep the run asked for');
      const rec: PendingStart = { leader: id, home: far };
      void st.put(START_KEY, new TextEncoder().encode(JSON.stringify(rec)), { session: 'loop', hash: 0 }).then(() => this.openOn(far));
      return;
    }
    this.begin(id);
  }

  /** a run begun with this leader at the town the page is on (picked here, or picked on the page before it opened on
   *  this town: then the choice was read from the town it was made at) */
  private begin(id: string): void {
    const a = this.scene.opts.atlas;
    const home = this.season.town;
    if (!a?.settlements || home === null) throw new Error('loop: no atlas world or no home town');
    const got = this.leaderOf(id);
    if (!got) throw new Error(`loop: no leader ${id}`);
    const who = got.who;
    // (a run played from another town than the world's last run: the old home becomes a far town — the card table's
    // one path, season/realm-home.ts)
    let world = this.saved ?? a.settlements.wiki.snapshot;
    const was = this.saved ? lastHome(worldOf(this.saved)) : null;
    const movedFrom = was && was !== home ? was : null;
    if (movedFrom) world = moveHome(world, movedFrom, home).world;
    // (a new run: the leader's pools; what earlier runs built is kept — the season's own ledger holds it, also after a
    // reload, where the season loop restores it with the town. FIXED-CITY (CT-56 (2)): the 3D town's districts are its
    // season save's; the record's built:<card> tags say the same for a town played here)
    const ledger: SeasonLedger = { ...newLedger(who.pools, who.income), built: [...this.season.ledger.built] };
    const seasons = Number(this.scene.host.params.get('runlen') ?? RUN_SEASONS);
    this.realm = null;
    this.realm = new Realm({ world, home, seed: a.atlas.p.seed, leader: who, ledger, land: () => this.season.land, seasons, where: (spot) => this.where(spot), regionAt: (x, y) => a.settlements!.regionAt(x, y), liveFire: this.liveFire, ...this.packOptions(home, who.id, () => ledger, got.pack) });
    // (ages, as the card table: a pack leader's start — its things in play, its laws in force for the run)
    if (got.pack) {
      startThings(this.realm.w, this.packs, got.pack, home, (k) => siteId(home, k as SiteKey));
      for (const l of got.pack.laws ?? []) this.realm.enact(l, TW.leaderStart(who.name));
    }
    // (round 8, as the card table: with packs the deal is made again once the Realm can be read — its first deal, made
    // while it was being built, saw no tags)
    if (this.packs.length) this.realm.afterSeason(this.realm.ledger);
    this.recent = [];
    this.hitsNew = [];
    this.doneMarks = [];
    this.runs = this.realm.history(true).filter((e) => e.kind === 'run-began').length;
    this.notes = [];
    this.resultLines = [];
    this.season.setLedger(this.realm.ledger);
    void this.save();
    console.log(`[loop] run ${this.runs}: ${who.name} at ${home}${movedFrom ? ` (moved from ${movedFrom})` : ''}, ${seasons} seasons; asking: ${this.asking().map((x) => `${x.who} (${x.title})`).join(', ')}`);
    // (loop round 10, LS-93: the run's start says what the world is now — the card table's lines, one copy: which run
    // and who leads, how earlier runs ended, a move of home, "While you were gone", the far towns, laws left, "Earlier
    // runs opened", "Not yet found")
    // (loop round 16: spoken by the leader's steward, who walks in to the keep — not a page over the town)
    const lines = startLines(this.realm, this.packs, this.played, { run: this.runs, leaderLine: who.line, movedFrom });
    this.set('city');
    void this.announce({ ...W.ADVISORS.steward, lines }, null);
  }

  /**
   * (loop round 16) News brought in person: the messenger walks in by a road — the one facing `from` (a far place's
   * window point), else the first — to the keep (or the market, or the town's middle), the camera after them, and says
   * the lines. Then the camera goes back over the town.
   */
  private async announce(speech: Speech, from: [number, number] | null, to?: [number, number] | null, how: Mount = 'foot'): Promise<void> {
    const t = this.town;
    if (!t) return;
    const c = t.centreInWindow();
    const dest = to ?? this.spot('keep') ?? this.spot('market') ?? c;
    // (no far place: the road on the keep's side of the town, so the walk is short and does not cross the town — round
    // 16's first stills had the steward on a bridge across the river, still walking at 6 s)
    const k = this.roadToward(from ?? dest);
    const road = t.roadCount ? t.roadInWindow(k) : [];
    // (loop round 17: by ship only where the town has a harbour built — to its quay; else by cart on the road)
    const quay = how === 'ship' && this.realm?.ledger.built.includes('harbour') ? this.spot('harbour') : null;
    if (how === 'ship' && !quay) how = 'cart';
    this.changed();
    await this.messenger.bring(speech, road.length >= 2 ? road : null, dest, how, quay);
    this.changed();
    if (this.phase === 'city') this.showTown();
  }

  /** (loop round 16) the town's road whose far end faces a window point (as the raid's road faces its camp) */
  private roadToward(at: [number, number]): number {
    const t = this.town;
    if (!t || !t.roadCount) return 0;
    const c = t.centreInWindow();
    const want = Math.atan2(at[1] - c[1], at[0] - c[0]);
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < t.roadCount; k++) {
      const end = t.roadInWindow(k).at(-1);
      if (!end) continue;
      const a = Math.atan2(end[1] - c[1], end[0] - c[0]);
      const d = Math.abs(Math.atan2(Math.sin(a - want), Math.cos(a - want)));
      if (d < bd) [bd, best] = [d, k];
    }
    return best;
  }

  /**
   * (loop round 16) After a season: what it brought, in person. With news, the chronicler brings it and names the new
   * asks; with only new asks, the first one's petitioner comes in to where they stand (one bound to a far place by the
   * road facing it, the scout captain's road); with neither, nobody comes (loop round 17).
   */
  private seasonNews(before: Set<string>): void {
    const r = this.realm;
    if (!r) return;
    const fresh = r.offers().filter((o) => o.status === 'offered' && !before.has(o.id));
    const asks = fresh.map((o) => W.newAsk(r.w.name(o.presenter), o.opp.title));
    const far = fresh.map((o) => (r.siteOf(o) ? null : this.offerPlace(o))).find((p) => p !== null) ?? null;
    // (loop round 17: how they come — a far place's news on a horse; trade's by cart, or by ship to the quay with a
    // harbour built; the leader's own people on foot)
    const harbour = r.ledger.built.includes('harbour');
    const trade = (o: Offer) => TRADE_CARDS.has(cardOfTemplate(o.template) ?? '');
    const byTrade: Mount = harbour ? 'ship' : 'cart';
    if (this.notes.length) {
      const how: Mount = far ? 'horse' : fresh.some(trade) ? byTrade : 'foot';
      void this.announce({ ...(far ? W.ADVISORS.scout : W.ADVISORS.chronicler), lines: [...this.notes, ...asks] }, far, null, how);
      return;
    }
    const o = fresh[0];
    if (o) {
      const site = r.siteOf(o);
      const place = site ? null : this.offerPlace(o);
      const { speaker } = petitionOf(r.engine, o.id);
      const how: Mount = place ? 'horse' : trade(o) ? byTrade : 'foot';
      void this.announce({ name: speaker.name, role: speaker.role, lines: [W.comeToAsk(o.opp.title), ...asks.slice(1)] }, place, site ? this.spot(site) : null, how);
      return;
    }
    // (loop round 17; the owner 2026-11-17: "I would just leave them visible on the map" — nothing new, nobody comes: the
    // asks stay on the map)
    console.log('[loop] a quiet season: no news, no new ask — no messenger');
  }

  /**
   * Go to an opportunity's place and hear its presenter: the camera frames the site, the petition opens as a dialog;
   * agreeing commits its cost through the realm (the engine's commit on the ledger's holdings), refusing is remembered.
   */
  open(id: string): void {
    this.messenger.skip();
    // (a live event going on: back to it)
    const run = id.startsWith('live:') ? this.live.runs.find((x) => `live:${x.id}` === id) : undefined;
    if (run && this.phase === 'city') {
      this.live.goTo(run);
      return this.set('event');
    }
    // (round 8: a pack thing's card; a card done last season — its line in the record)
    if (id.startsWith('thing:')) return void this.thingPanel(id.slice(6));
    if (id.startsWith('done:')) {
      const d = this.doneMarks.find((x) => `done:${x.id}` === id);
      return d ? this.show({ title: d.title, sections: [{ lines: [d.text] }] }) : undefined;
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
    // (round 8, laws: the terms in force — `Realm.terms` — with the printed cost beside them when a law changes it; and
    // the laws taking it brings, in "You get")
    const printed = W.costText(locks, o.opp.costs as Partial<Record<Pool, number>>, turns);
    const t = r.terms(o);
    const now = W.costText(t.locks as Partial<Pools>, t.costs as Partial<Pools>, t.turns);
    // (loop round 16: what it would combine with that the town has, and what it opens)
    const brings = [...this.lawsBrought(o.template).map((id) => W.bringsLaw(lawLine(r, id))), ...this.combos(o.template)];
    const tree = petitionTree({ ...petition, needs: now === printed ? now : W.lawCost(now, printed), takes: W.takesText(t.turns), get: [petition.get, ...brings].join(' '), agree: W.AGREE, canAgree: can ? true : W.shortText(miss) }, speaker, r.leader.name);
    // (round 8, the portrait slot: art for the card if a file is there — local/art/<card id>.png or the pack card's
    // `image` — else the pixel face)
    const art = await this.artFor(o.template, this.played.flatMap((p) => p.cards ?? []).find((c) => c.id === o.template)?.image);
    this.speakers.set(speaker.id, { name: speaker.name, title: capitalise(speaker.role), colour: speaker.persona.portrait.cloth, portrait: art ?? portraitUrl(speaker.persona.portrait) });
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
    // (round 8: a card that ends the run, or a law won by it, ends it now; a rule it set off may start an event)
    if (r.over || r.forcedLive()) return this.flow();
    this.set('city');
  }

  // ---- (round 8) packs, laws, rules, the record, things -----------------------------------------------------

  /** the Realm's options for the packs (as the card table's), and the rule firings told to this game */
  private packOptions(home: string, leader: string, ledger: () => SeasonLedger, pack: PackLeader | null = null): Partial<ConstructorParameters<typeof Realm>[0]> {
    const onRules = (hits: RuleHit[]) => {
      this.hitsNew.push(...hits);
      this.recent.push(...hits);
    };
    if (!this.packs.length) return { onRules };
    return { onRules, extra: realmExtra(this.packs, this.played, () => this.realm, { home, ledger, leader, ...(pack?.deck_out ? { deckOut: pack.deck_out } : {}) }) };
  }

  /**
   * (loop round 16, the owner: "The choices were so far not that synergistic") What a card would combine with, read from
   * the synergy rules as they stand: the thing the card makes (a building's site worked; a pack thing put in play)
   * with its tags laid beside the things already there. A rule not firing now whose missing thing this card's thing is
   * becomes "With your <thing>: <what it gives>"; one it would start by itself, "<what it gives>". And what taking it
   * opens for later (a pack card's `unlock`). Plain lines for the petition's "You get".
   */
  private combos(template: string): string[] {
    return this.realm ? combosOf(this.realm, template, this.packs, this.played) : [];
  }

  /** the laws a card's effects bring: a `law` effect, or a thing it puts in play that carries laws (any result's) */
  private lawsBrought(template: string): string[] {
    const t = this.realm?.engine.template(template);
    if (!t) return [];
    const all = [...(t.outcome ?? []), ...Object.values(t.outcomes ?? {}).flatMap((o) => (o as { effects?: unknown[] }).effects ?? [])];
    const out: string[] = [];
    for (const e of all) {
      const x = e as { helper?: string; args?: unknown[] };
      if (x.helper === 'law') out.push(String(x.args?.[0]));
      if (x.helper === 'packPut') out.push(...(this.packs.flatMap((p) => p.things).find((th) => th.id === String(x.args?.[0]))?.laws ?? []));
    }
    return [...new Set(out)];
  }

  /** (job 3, the portrait slot) a picture for a card or thing id: the pack entry's `image` URL, else
   *  local/art/<id>.png if the dev server has it (asked once a page), else null */
  private art = new Map<string, string | null>();
  private async artFor(id: string, image?: string): Promise<string | null> {
    if (image) return image;
    if (this.art.has(id)) return this.art.get(id)!;
    let url: string | null = null;
    try {
      const r = await fetch(`local/art/${id}.png`, { method: 'HEAD' });
      url = r.ok && (r.headers.get('content-type') ?? '').startsWith('image/') ? `local/art/${id}.png` : null;
    } catch {
      url = null;
    }
    this.art.set(id, url);
    return url;
  }

  /** the town sheet's pages */
  views(): { label: string; on: () => void }[] {
    if (!this.realm) return [];
    return [
      { label: W.LAWS, on: () => this.show(this.lawsPanel()) },
      { label: W.RULES, on: () => this.show(this.rulesPanel()) },
      { label: W.REMEMBERED, on: () => this.show(this.recordPanel()) },
      ...(this.packReport.length ? [{ label: TW.PACK_TITLE, on: () => this.show({ title: W.PACKS_BAD, sections: this.packReport.map((t) => ({ lines: t.split('\n') })) }) }] : []),
    ];
  }
  private show(p: Panel): void {
    this.panel = p;
    this.changed();
  }
  closePanel(): void {
    this.panel = null;
    this.changed();
  }

  /** the laws in force, in the order they came */
  private lawsPanel(): Panel {
    const ls = lawLines(this.realm!);
    return { title: TW.LAWS_TITLE, sections: [{ lines: [TW.LAWS_HELP] }, { lines: ls.length ? ls.map((l) => `${l.name}. ${l.text} ${TW.lawFrom(l.from, l.until, l.times)}`) : [TW.LAWS_NONE] }] };
  }
  /** every rule: what it reads and gives, ready or the one thing it lacks, what it paid last season */
  private rulesPanel(): Panel {
    const rs = ruleLines(this.realm!, this.recent);
    return { title: TW.RULES_TITLE, sections: [{ lines: [TW.RULES_HELP] }, ...rs.map((x) => ({ head: x.name, lines: [x.says, W.ruleWhy(x.when, x.why), ...x.fired, ...(x.laws.length && !x.off ? [`${TW.CHANGED_BY}: ${x.laws.join(', ')}.`] : [])] }))] };
  }
  /** every card resolved or run out in this world, by place */
  private recordPanel(): Panel {
    const r = this.realm!;
    const by = recordByPlace(r.w, r.home, TW.TOWN);
    return { title: TW.RECORD_TITLE, sections: by.length ? by.map((x) => ({ head: x.place, lines: x.lines })) : [{ lines: [TW.RECORD_NONE] }] };
  }
  /** a pack thing's card: its picture, its text and tags, and the pack abilities that can be cast on it now */
  private async thingPanel(id: string): Promise<void> {
    const r = this.realm;
    const t = this.things.find((x) => x.id === id);
    if (!r || !t) return;
    const image = await this.artFor(t.def, t.image);
    const magic = pools(this.season.ledger).magic;
    const abilities = t.ruined ? [] : unlockedAbilities(r, this.packs).filter((a) => a.target && a.target.tags.every((x) => t.tags.includes(x)));
    this.show({
      title: t.ruined ? capitalise(W.remainsOf(t.name)) : t.name,
      image,
      sections: [{ lines: [t.text] }, { head: W.TAGS, lines: [t.tags.join(', ')] }, ...abilities.map((a) => ({ head: a.name, lines: [a.text] }))],
      actions: abilities.filter((a) => magic >= (a.cost.magic ?? 0)).map((a) => ({ label: W.castOn(a.name, a.cost.magic ?? 0), on: () => this.castOnThing(a, t) })),
    });
  }
  /** a pack ability cast on a thing in play (Table.cast's own branch): its Magic spent, its tags written, its laws */
  private castOnThing(a: PackAbility, t: ThingMark): void {
    const r = this.realm!;
    r.ledger = this.season.ledger;
    let l = lose(r.ledger, { magic: a.cost.magic ?? 0 });
    const gains = castAbility(r.w, a, t.id, this.packs);
    for (const [k, n] of Object.entries(gains) as [Pool, number][]) l = k === 'unrest' ? lose(l, { unrest: n }) : n > 0 ? grant(l, { [k]: n }) : lose(l, { [k]: -n });
    r.ledger = l;
    r.w.facts.record({ kind: 'ability-cast', by: ['player'], to: [t.id], note: TW.castNote(a.name, t.name) });
    for (const e of a.effect ?? []) if ('law' in e) r.enact(e.law, `${a.name} (${TW.CAST_WORD})`, e.seasons);
    r.refreshLaws();
    this.season.setLedger(r.ledger);
    this.notes = [...this.notes, TW.castLine(a.name, t.name, a.cost.magic ?? 0)];
    const at = this.spot(t.site ?? 'keep');
    if (at) this.scene.worldApi?.fx?.burst('sparks', at[0], at[1], this.z(at[0], at[1]) + 2, { count: 40 });
    void this.save();
    this.closePanel();
  }

  /** what ended the run: an ending a card or rule named, or a law's win (null: the raid, or not over) */
  get endTitle(): string | null {
    const r = this.realm;
    if (!r) return null;
    if (r.ended) return TW.endedTitle(r.ended.result, r.ended.name);
    const w = r.won();
    return w ? TW.wonTitle(w.law) : null;
  }

  /** what the world is now, before a run: how the last one ended, laws earlier runs left, far towns emptied */
  worldNow(): string[] {
    const a = this.scene.opts.atlas;
    const home = this.season.town;
    if (!this.saved || home === null || !a) return [];
    return (this.nowCache ??= worldNow(worldOf(this.saved), this.packs, home));
  }
  private nowCache: string[] | null = null;

  /** (scripts) answer the open petition: the dialog's own buttons are the player's way */
  get talking(): boolean {
    return this.talk.isOpen;
  }

  next(): void {
    const r = this.realm;
    if (this.phase !== 'city' || !r || this.season.playing) return;
    this.messenger.skip();
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
    this.recent = [];
    const turn = r.w.turn;
    // (loop round 16: the asks there were, so the season's news can name the new ones)
    const asked = new Set(r.offers().map((o) => o.id));
    const had = new Set(this.things.filter((t) => !t.ruined).map((t) => t.id));
    this.notes = this.chained(r.endSeason());
    this.season.setLedger(r.ledger);
    this.markDone(turn, false);
    this.building = this.season.ledger.projects.length > 0;
    this.set('season');
    // (round 8: the season turn shows what the packs' cards built — the camera on the new thing's site and dust there,
    // its name in the news; a marker stands there from now on)
    const built = this.things.filter((t) => !t.ruined && !had.has(t.id));
    for (const t of built) {
      this.notes = [...this.notes, W.builtThing(t.name)];
      const at = this.spot(t.site ?? 'keep');
      if (at) this.scene.worldApi?.fx?.burst('dust', at[0], at[1], this.z(at[0], at[1]) + 1, { count: 60 });
    }
    const first = built[0] && this.spot(built[0].site ?? 'keep');
    if (first && !this.building) void this.cam.look(this.at3(first), { zoom: BUILD_ZOOM, ease: 1.2, place: [0.5, 0.36] });
    void this.season.next().then(async () => {
      while (this.season.playing) await new Promise((res) => setTimeout(res, 100));
      r.afterSeason(this.season.ledger);
      this.season.setLedger(r.ledger);
      await this.save();
      this.building = false;
      this.flow();
      // (loop round 16: back in the town, the season's news comes in person — the camera follows the messenger in, and
      // goes back over the town when they are done)
      if (this.phase === 'city') this.seasonNews(asked);
      else if (first && !r.forcedLive()) this.showTown();
    });
  }

  skip(): void {
    this.season.skip();
  }

  /** what comes next: a live event nobody asks about (the raid card in the last season), the end once the run is over
   *  (its last season ended, an ending card, a law's win), else the town */
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
    if (r.over) {
      // (round 8: an ending says what made it)
      if (r.ended && !this.resultLines.length) this.resultLines = [TW.endedBy(r.ended.by)];
      this.panel = null;
      // (loop round 10, job 3: what this town built written on it in the world's record — `built:<card>`, the card
      // table's one path (season/realm-home.ts) — so a later run's world, here or played from another town, shows what
      // stood; then saved)
      keepBuilt(r.w, r.home, this.season.ledger.built);
      void this.save();
      return this.set('end');
    }
    this.set('city');
  }

  proceed(): void {
    if (this.phase !== 'result') return;
    // (loop round 10: the raid is the last season's card and the season goes on after it — its result is the town's
    // news now; before, the season's old line "The raiders break camp and march on the town" stood under a raid held)
    this.notes = [...this.resultLines];
    this.flow();
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
    // (loop round 16: the bar is one row now — the town in the middle of the screen between the top bar and it)
    if (t) void this.cam.look(this.at3(t.centreInWindow()), { zoom: innerWidth / (2 * (SITE_REACH + 0.06) * t.box.R), place: [0.5, 0.48], ease: 1.2 });
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
    if (!id || !(this.allowed() as string[]).concat(this.eventAbilities().map((a) => a.id)).includes(id)) return;
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
  private castAt(id: string, sx: number, sy: number, tries: number): void {
    if (this.armed !== id) return;
    const r = this.realm!;
    const cam = this.scene.core.camera;
    const w = this.scene.worldApi;
    if (!w?.fire || !w.fx || !w.plants || !w.terrain) throw new Error('loop: this level has no world API for fire, particles, plants and ground');
    const api = { fire: w.fire, fx: w.fx, plants: w.plants, terrain: w.terrain };
    // (round 8: a pack ability cast into the event — what it does is its `in_event` numbers through the laws)
    const ability = this.eventAbilities().find((a) => a.id === id);
    const mech = this.packs.length ? mechOf(r, this.packs) : r.spellMech(SPELL_MECH);
    const z = id === 'heatray' || id === 'fire' || (ability && (mech[id]?.kills || mech[id]?.berserk || mech[id]?.hides)) ? this.live.figuresZ() : null;
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
    const cost = ability ? (ability.cost.magic ?? 0) : SPELL_COST[id as SpellId];
    if (pools(this.season.ledger).magic < cost) {
      this.tell(W.shortText({ magic: cost }));
      return this.arm(null);
    }
    r.ledger = this.season.ledger;
    const run = this.live.focus;
    if (ability) {
      // (Table.cast's own branch: its Magic spent and the cast written; what it does in the city is below)
      r.ledger = lose(r.ledger, { magic: cost });
      if (run) r.w.facts.record({ kind: 'ability-cast', by: ['player'], to: [r.home], note: TW.castNote(ability.name, run.def.title) });
    } else r.cast(id as SpellId, id === 'growth' ? 'fields' : undefined);
    this.season.setLedger(r.ledger);
    if (run && this.phase === 'event') run.casts[id] = (run.casts[id] ?? 0) + 1;
    // (round 8, laws: a law's `kills` scales the hand-aimed blow — a law that makes Fire put down 3 where it put down 1
    // makes its blow reach √3 as far. Tunable: the reach, not the damage, so a wider blow takes more; LS-87)
    const reach = (base: number) => Math.sqrt(Math.max(0.25, (mech[id]?.kills ?? base) / base));
    if (ability) {
      const m = mech[id] ?? {};
      if (m.kills) {
        this.scene.units?.strike?.({ at: [g[0], g[1]], radius: FIRE.radius * Math.sqrt(m.kills), damage: FIRE.damage }, 'spell');
        this.scene.powers.scriptStrike(g[0], g[1], g[2]);
      }
      if (m.douses) {
        this.scene.core.weather.spawn(g[0], g[1]);
        api.fx.burst('splash', g[0], g[1], g[2] + 0.5, { count: 30 });
      }
      // (loop round 10, LS-94: spells on the units themselves, on the GPU — the foes within reach turn on anyone near,
      // one another too; your people within reach are hidden from the foes and from sight)
      const units = this.scene.units;
      if ((m.berserk || m.hides) && !units?.spell) throw new Error('loop: these units take no spells (Units.spell)');
      // (loop round 14, LS-108: "I would let any units brawl" — anyone within reach, a protest crowd of your own people
      // too: every kind has a blow; the caster aims it)
      if (m.berserk) units!.spell!({ at: [g[0], g[1]], radius: m.berserk, who: 'any', berserk: true });
      // (loop round 11: your hidden people are drawn faint to you — the foes still do not see them)
      if (m.hides) units!.spell!({ at: [g[0], g[1]], radius: m.hides, who: 'friends', hidden: true, faint: true });
      // (loop round 12, docs/design/FRONTS.md: a shield round the tap — the liquids flow round it; its dome and rim are
      // the shields' own sparks)
      if (m.shield) {
        const shields = this.scene.worldApi?.shields;
        if (!shields) throw new Error('loop: this level has no shields (world API fx)');
        // (loop round 14: its store and recharge are the ability's — the shields' defaults when it gives none)
        const s = shields.raise(g[0], g[1], { radius: m.shield, seconds: m.seconds ?? SHIELD_SECONDS, z: g[2], energy: m.energy, regen: m.regen });
        // (its end told, whichever way it comes — never silently after its event)
        const name = ability.name;
        const told = (x: { id: number }, how: 'drained' | 'time' | 'dropped') => {
          if (x.id !== s.id) return;
          shields.onEnd.splice(shields.onEnd.indexOf(told), 1);
          console.log(`[loop] ${name} ended: ${how}`);
          this.tell(TW.shieldEndLine(name, how));
        };
        shields.onEnd.push(told);
      }
      api.fx.burst('sparks', g[0], g[1], g[2] + 1, { count: 40 });
      // (loop round 11: the spell's reach marked on the ground as it is cast — a ring of sparks at its edge; the units
      // it took carry their own mark, drawn on the GPU: units.wgsl unitDraw)
      const ring = m.berserk || m.hides;
      if (ring) {
        for (let k = 0; k < SPELL_RING; k++) {
          const a = (k / SPELL_RING) * Math.PI * 2;
          const [x, y] = [g[0] + Math.cos(a) * ring, g[1] + Math.sin(a) * ring];
          api.fx.burst('sparks', x, y, this.z(x, y) + 0.6, { count: 6, speed: 3 });
        }
      }
      this.tell(TW.castLine(ability.name, run?.def.title ?? '', cost));
    } else if (id === 'heatray') {
      this.scene.units?.strike?.({ at: [g[0], g[1]], radius: HEATRAY.radius * reach(SPELL_MECH.heatray.kills!), damage: HEATRAY.damage }, 'spell');
      this.scene.powers.scriptStrike(g[0], g[1], g[2]);
    } else if (id === 'fire') {
      this.scene.units?.strike?.({ at: [g[0], g[1]], radius: FIRE.radius * reach(SPELL_MECH.fire.kills!), damage: FIRE.damage }, 'spell');
      api.fire.ignite(g[0], g[1], { radius: FIRE.light, intensity: 0.9 });
      api.fx.burst('flame', g[0], g[1], g[2] + 0.5, { count: 40 });
    } else if (id === 'rain') {
      this.scene.core.weather.spawn(g[0], g[1]);
      api.fx.burst('splash', g[0], g[1], g[2] + 0.5, { count: 30 });
      this.tell(W.RAIN_CAST);
    } else {
      // (loop round 16: the succession and the growing glow woken for the spell — the quiet world's only growth in play)
      this.quiet?.wake('growth', GROW_WAKE, GROWTH_WAKE_S);
      api.plants.grow(g[0], g[1], { radius: GROWTH.radius, strength: GROWTH.strength });
      api.fx.burst('leaves', g[0], g[1], g[2] + 1, { count: 50 });
      this.tell(W.GROWTH_CAST);
      void this.save();
    }
    console.log(`[loop] ${id} at ${g[0].toFixed(0)}, ${g[1].toFixed(0)}`);
    this.arm(null);
  }
}

/** (loop round 16) an arrow pointing a screen direction (y down), in eight ways */
function arrowOf(dx: number, dy: number): string {
  const a = Math.atan2(dy, dx);
  return ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'][((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

/** the history's kinds the end-of-run screen always shows (the rest: those with a weight) */
const SHOWN = new Set(['built', 'founding', 'relieved', 'fell', 'raid-held', 'raid-broke', 'tribute-paid', 'made-safe', 'flooded', 'burned', 'melted', 'buried', 'lens-lit', 'farm-burned', 'scouts-seen']);

export function startRunLoop(scene: LevelScene, towns: FieldTowns, mut: MutateEngine | null): void {
  let game: Game | null = null;
  const season = startSeasonLoop(scene, towns, {
    ui: false,
    dealer: false,
    // (the raid is a card — card-table round 5, CT-51: the raiders' standing threat run out sets it, and the forced
    // `raid` card's live event plays it in the last season — not the fixed schedule; LS-16: the attack screen calls it,
    // with the camera down the road it comes by)
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
  // (loop round 17, LS-152 ii: the story camera's cutaway — what hides the site or the speaker it holds or follows is
  // dithered, as the hero runs' story does (runs.ts startStory); the loop's story camera takes the dither only (Game))
  const t = worldApiOf(scene).terrain;
  if (t && !scene.storyCut) scene.storyCut = { dither: new Dither(t, scene.core.camera), slice: new Slice(t, scene.core.camera) };
  game = new Game(scene, towns, season, mut);
  scene.seasonUi = mountRunUi(scene.host.ui, game);
  (globalThis as { rungame?: Game }).rungame = game;
}
