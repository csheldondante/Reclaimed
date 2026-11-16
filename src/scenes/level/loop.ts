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
import { lose, newLedger, pools, total, type Pool, type Pools, type SeasonLedger } from '../../season/ledger';
import type { SeasonLoop } from '../../season/loop';
import { Realm, roadLook, RUN_SEASONS, type RunState, type SpellId, type Spot } from '../../season/realm';
import { applyDelta, delta, type Delta } from '../../api/snapshot-delta';
import { MemoryWorldState } from '../../api/contracts/world-state';
import { FactWorld } from '../../living/world';
import { mutators } from '../../mutate';
import type { MutateEngine } from '../../mutate/engine';
import { ROW_H, cellAt } from '../../world/lattice';
import { restoreMutators } from './mutators';
import { DEAD_RISE, type SiteKey } from '../../season/realm-templates';
import { declutter, placeSites, REACH as SITE_REACH } from '../../season/sites';
import { mountRunUi, type Asking, type Marker, type Phase, type RunGame } from '../../season/run-ui';
import * as W from '../../season/run-words';
import { WAVE_NO_ROAD } from '../../season/words';
import { StoryCamera, type V3 } from '../../story/camera';
import type { LevelScene } from '../level';
import { REGION } from '../streamer/defs';
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
/** the sim's speed while the raiders march in (they walk from outside the town) */
const MARCH_SPEED = 3;
/** seconds raiders stay in a town with no soldier left before the fight is called */
const SACK_SECONDS = 5;
/** wall seconds an attack may take at most before it is called as it stands */
const ATTACK_SECONDS = 150;
/** the camera's zoom (screen px a cell) down a road before the raid is called, on the raiders marching, and on the
 *  fight: at 412 px across, a figure about a cell wide reads from 12 up */
const ROAD_ZOOM = 4;
const MARCH_ZOOM = 10;
const FIGHT_ZOOM = 22;
/** the zoom on a district being built while a season passes: its lots and the people working on them read */
const BUILD_ZOOM = 9;
/** the camera's pitch on the fight (radians): lower than the town's 60°, so a standing figure is taller on the screen
 *  (its height × zoom × cos pitch: 1.6 cells × 22 × 0.77 = 27 px) */
const FIGHT_PITCH = (40 * Math.PI) / 180;
/** the zoom the camera pulls back to when a fight is over: the district round it in view */
const AFTER_ZOOM = 5;
/** the window slides when the camera comes within this many regions of its edge (scenes/streamer.ts update): the
 *  cells round the camera's target the window is sure to hold are half the window less that; and the margin kept
 *  inside it for the spawn point's crowd */
const SLIDE_REGIONS = 1.25;
const SURE_MARGIN = 12;
/** frames the window must be still before a raid is called: the place table's spawn points wake a solve at most every
 *  120 frames (towncontracts/places.wgsl WET_GAP), and the solve lands a frame or two later */
const PLACE_SETTLE_FRAMES = 130;
/** frames after a raid's call by which a refused spawn has been told (the units' events are read a frame or two
 *  behind): the raiders are watched and the sim sped up only after */
const SPAWN_TOLD_FRAMES = 20;

/** how far from the home town's centre the camera may go (cells): past the mountain an outcome can name (640), short
 *  of where the town would be let go (its box 448 columns from a 320-column window: about 680) */
const HOME_REACH = 650;
/** a spell's blow: its radius (cells), its damage, its cost */
/** times a cast asks for the ground's pages under its tap before it gives up (a camera that moved meanwhile: again) */
const CAST_WAIT_FRAMES = 4;
// (round 4: damage 2 of a raider's 3 health. At 3, the first cast that ever landed killed all 6 raiders on the march for
// 1 Magic and the soldiers had no part; at 2 it wounds every raider in reach and a second cast or the soldiers finish
// them. A tunable for the owner: LOOP_SKELETON.md assumption 17)
const HEATRAY = { radius: 5, damage: 2, magic: 1 };
/** the live event's spell, and the dead it is cast on: how many get up, in clumps this far apart (cells), and the wall
 *  seconds the event may take before it is left as it stands */
const FIRE = { radius: 4.5, damage: 12, magic: 1 };
const DEAD = { n: 5, spread: 7, seconds: 120 };

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
  /** the attack under way: when it began (s), when the town was first left with no soldier, the raiders watched */
  private attack: {
    t: number;
    sackAt: number | null;
    unwatch: (() => void) | null;
    following: boolean;
    /** the raid's size */
    n: number;
    /** the road the raid is being called down (the town's arterials' order), and whether straight for the heart */
    road: number;
    direct: boolean;
    /** the camera going to the road, the window settling there, the raid called */
    step: 'look' | 'settle' | 'called';
    /** frames the window has been still with the camera on the road */
    calm: number;
    /** the middle of the raiders alive (window point), once they are watched */
    mid: (() => V3 | null) | null;
  } | null = null;
  private speed0 = 1;
  /** the live event under way (the dead rising): its units still up, when it began, how it ends */
  private event: { up: Set<number>; t: number; unwatch: () => void; end: (won: boolean) => void } | null = null;
  private pitch0 = Math.PI / 3;

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
    let last = performance.now();
    const tick = (now: number) => {
      requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.cam.update(dt);
      this.keepNear();
      this.watchBuild(dt);
      this.watchFight(dt);
      this.watchEvent(dt);
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
    return r ? { season: r.season, seasons: r.seasons, n: this.runs, threatIn: r.threatIn(), averted: r.averted, spells: [...r.spells], fight: r.fight } : null;
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
    if (this.phase === 'attack') return this.fightMarks();
    if (this.phase === 'event') return this.eventMarks();
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
    const n = r.threatIn();
    if (n !== null && n > 0) put('threat', W.threatTag(n), 'threat', this.spot('road'));
    // (names kept apart and on the screen, between the top bar and the sheet: LS-3, LS-28)
    const sheet = document.querySelector('.run-sheet')?.getBoundingClientRect().top ?? innerHeight;
    const bar = document.querySelector('.run-top')?.getBoundingClientRect().bottom ?? 0;
    const free = declutter(out.map((m) => ({ x: m.x, y: m.y, chars: m.label.length })), innerWidth, bar + 4, sheet - 4);
    out.forEach((m, i) => ([m.x, m.y] = free[i]));
    return out;
  }

  /** the fight's marks (LS-24): a ring round every raider and soldier alive, and each side's name and count over its
   *  middle — a figure is a few px of colour at any zoom the town still reads at */
  private fightMarks(): Marker[] {
    const a = this.attack;
    const war = this.season.war;
    const units = this.scene.units;
    const forces = this.scene.townForces;
    const f = war?.fight;
    if (!a || !a.unwatch || !war || !units || !forces || !f) return [];
    const cam = this.scene.core.camera;
    const out: Marker[] = [];
    const side = (ids: number[], kind: 'raider' | 'soldier', name: string) => {
      let n = 0;
      let sx = 0;
      let top = Infinity;
      let low = -Infinity;
      for (const id of ids) {
        const at = units.get(id)?.at;
        if (!at) continue;
        const [x, y] = cam.project(at[0], at[1], at[2]);
        if (x < -20 || y < -20 || x > innerWidth + 20 || y > innerHeight + 20) continue;
        out.push({ id: String(id), label: '', kind, x, y });
        n++;
        sx += x;
        top = Math.min(top, y);
        low = Math.max(low, y);
      }
      // (the raiders' name above their figures, the soldiers' below theirs: the two never lie on each other when the
      // lines meet — LS-47)
      if (n) out.push({ id: kind === 'raider' ? 'theirs' : 'ours', label: `${name} ${ids.length}`, kind: 'side', x: sx / n, y: kind === 'raider' ? top : low });
    };
    side(forces.members(f.raiders), 'raider', W.RAIDERS_TAG);
    side(war.squadGroups.flatMap((g) => forces.members(g)), 'soldier', W.SOLDIERS_TAG);
    return out;
  }

  /** the live event's marks: a ring round each of the dead still up, and their count */
  private eventMarks(): Marker[] {
    const units = this.scene.units;
    const ev = this.event;
    if (!ev || !units) return [];
    const cam = this.scene.core.camera;
    const out: Marker[] = [];
    let sx = 0;
    let top = Infinity;
    for (const id of ev.up) {
      const at = units.get(id)?.at;
      if (!at) continue;
      const [x, y] = cam.project(at[0], at[1], at[2]);
      out.push({ id: String(id), label: '', kind: 'raider', x, y });
      sx += x;
      top = Math.min(top, y);
    }
    if (out.length) out.push({ id: 'theirs', label: `${W.DEAD_TAG} ${ev.up.size}`, kind: 'side', x: sx / out.length, y: top });
    return out;
  }

  /** (scripts) where the dead still up are on the screen (px) */
  deadAt(): [number, number][] {
    return this.eventMarks().filter((m) => m.kind === 'raider').map((m) => [m.x, m.y]);
  }

  /**
   * The small live event (item 4: play alternates between choosing and casting): a few of the dead get up at the burial
   * ground; the camera goes there, the player casts Fire on them (1 Magic a cast). True: all are down. False: left as
   * they stand (the player's choice, no Magic, or DEAD.seconds passed) — the rest are taken away and the card stays
   * offered until it lapses. The dead are the units' own 'shambler' kind; Fire is the units' area blow with the
   * lightning strike as its look, as Heat ray is (a stand-in look: BACKLOG LS-7).
   */
  private playDead(at: [number, number]): Promise<boolean> {
    const units = this.scene.units;
    if (!units) return Promise.resolve(true);
    const up = new Set<number>();
    for (let k = 0; k < DEAD.n; k++) {
      const clump = k < 3 ? -1 : 1;
      up.add(units.spawn('shambler', [at[0] + clump * DEAD.spread * 0.5 + (k % 3) * 1.4, at[1] + clump * 2 + (k % 2) * 1.6], null, { hostile: true }) as number);
    }
    const unwatch = units.observe([...up]);
    units.died.push((v) => void this.event?.up.delete(v.id as number));
    this.pitch0 = this.scene.core.camera.elevation;
    this.armed = null;
    // (the camera on them, then after them: the dead walk toward whoever is near — round 3's first event left the screen)
    const mid = (): V3 | null => {
      let n = 0;
      const m: V3 = [0, 0, 0];
      for (const id of up) {
        const p = units.get(id)?.at;
        if (!p) continue;
        n++;
        for (let k = 0; k < 3; k++) m[k] += p[k];
      }
      return n ? [m[0] / n, m[1] / n, m[2] / n] : null;
    };
    void this.cam.look(this.at3(at), { zoom: FIGHT_ZOOM * 0.7, ease: 1.2, place: [0.5, 0.36] }).then(() => {
      if (this.event?.up === up) this.cam.follow(mid);
    });

    console.log(`[loop] the dead rise: ${up.size} at ${at.map((v) => Math.round(v))}`);
    return new Promise((res) => {
      this.event = { up, t: 0, unwatch, end: res };
      this.fightLine = W.deadLine(up.size, pools(this.season.ledger).magic);
      this.set('event');
    });
  }

  private watchEvent(dt: number): void {
    const ev = this.event;
    if (!ev || this.phase !== 'event') return;
    ev.t += dt;
    const cam = this.scene.core.camera;
    if (!this.cam.busy) cam.elevation += (FIGHT_PITCH - cam.elevation) * Math.min(1, dt * 1.2);
    const magic = pools(this.season.ledger).magic;
    const line = W.deadLine(ev.up.size, magic);
    if (line !== this.fightLine) {
      this.fightLine = line;
      this.changed();
    }
    if (ev.up.size === 0) this.endEvent(true);
    else if (ev.t > DEAD.seconds) this.endEvent(false);
  }

  leave(): void {
    if (this.event) this.endEvent(false);
  }

  private endEvent(won: boolean): void {
    const ev = this.event;
    if (!ev) return;
    this.event = null;
    this.cam.follow(null);
    ev.unwatch();
    for (const id of ev.up) this.scene.units?.remove(id);
    this.scene.core.camera.elevation = this.pitch0;
    this.armed = null;
    console.log(`[loop] the dead: ${won ? 'all burned' : `${ev.up.size} left`}`);
    ev.end(won);
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
      // (the live event's card is played before it is committed: all burned, it resolves as any card does)
      const won = o.template !== DEAD_RISE || (await this.playDead(at ?? this.town!.centreInWindow()));
      if (won) {
        r.ledger = this.season.ledger;
        r.commit(id);
        this.season.setLedger(r.ledger);
        this.notes = [...this.notes, W.agreedLine(speaker.name, o.opp.title)];
      } else this.notes = [...this.notes, W.DEAD_LEFT];
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
    this.notes = r.endSeason();
    this.season.setLedger(r.ledger);
    // (the close-up on the district being built is off: BACKLOG LS-54)
    this.building = false;
    this.set('season');
    void this.season.next().then(async () => {
      while (this.season.playing) await new Promise((res) => setTimeout(res, 100));
      r.afterSeason(this.season.ledger);
      this.season.setLedger(r.ledger);
      await this.save();
      if (this.building && r.raid === null) this.showTown();
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
    if (r.raid !== null) return this.beginAttack();
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

  // ---- the attack -------------------------------------------------------------------------------------

  /**
   * The attack begins (LS-16): the raid is called by this screen, a road at a time, once the camera looks down that
   * road. A spawn point stands only on ground the world's window holds (townplaces UC-13), and the window is where the
   * camera is: round 1 let the season post the raid with the camera wherever the last card left it, and at Muru the one
   * dry spawn point (the east road's, 184 cells from the centre of a 320-cell window) was outside it in three walks of
   * four.
   */
  private beginAttack(): void {
    const n = this.realm!.raid ?? 0;
    this.attack = { t: 0, sackAt: null, unwatch: null, following: false, n, road: -1, direct: false, step: 'look', calm: 0, mid: null };
    this.fightLine = W.ATTACK_WAIT;
    this.speed0 = this.scene.speed;
    this.pitch0 = this.scene.core.camera.elevation;
    this.set('attack');
    this.nextRoad();
  }

  /** the camera down the next road into town (then, with walls and no road's gate standing, each road again straight
   *  for the town's heart); none left: the raid found no road, said loudly */
  private nextRoad(): void {
    const a = this.attack!;
    const t = this.town;
    const war = this.season.war;
    const roads = t?.roadCount ?? 0;
    a.road++;
    if (a.road >= roads && war?.walled && !a.direct) {
      a.direct = true;
      a.road = 0;
    }
    if (!t || a.road >= roads) {
      console.error(`[loop] the raid found no road into ${t?.site.name ?? 'the town'}: ${roads} roads tried`);
      return this.endAttack(war?.fight ?? null);
    }
    const { w, h } = this.scene.core.dims;
    const at = roadLook(t.roadInWindow(a.road), Math.min(w, h) / 2 - SLIDE_REGIONS * REGION - SURE_MARGIN);
    if (!at) return this.nextRoad();
    a.step = 'look';
    a.calm = 0;
    // (the road before's raiders were never made: nothing of theirs is watched)
    a.unwatch?.();
    a.unwatch = null;
    a.mid = null;
    a.following = false;
    console.log(`[loop] the camera down road ${a.road}`);
    void this.cam.look(this.at3(at), { zoom: ROAD_ZOOM, ease: 1.2, place: [0.5, 0.4] }).then(() => {
      if (this.attack === a && a.step === 'look') a.step = 'settle';
    });
  }

  /** each frame of an attack: the raid called once the window is still on its road, the raiders watched and followed,
   *  its line, and its end */
  private watchFight(dt: number): void {
    const a = this.attack;
    const war = this.season.war;
    if (!a || !war || this.phase !== 'attack') return;
    a.t += dt;
    if (a.step !== 'called') {
      // (the window still on the road: the land a slide brought is written and the place table has solved over it —
      // its spawn points wake a solve at most every PLACE_SETTLE_FRAMES)
      a.calm = a.step === 'settle' && !this.scene.stream?.busy ? a.calm + 1 : 0;
      if (a.calm > PLACE_SETTLE_FRAMES && war.call(a.n, a.road, a.direct)) {
        a.step = 'called';
        a.calm = 0;
      }
      if (a.t > ATTACK_SECONDS) this.endAttack(null);
      return;
    }
    const f = war.fight;
    if (!f) return this.endAttack(null);
    const units = this.scene.units;
    const forces = this.scene.townForces;
    // (this road's spawn point was refused — water, or no gate on it: the next road)
    if (f.failed && !forces?.members(f.raiders).length) {
      this.scene.speed = this.speed0;
      return this.nextRoad();
    }
    // (watched once they stand: a spawn's refusal comes a few frames after its call, with the group's members gone)
    if (!a.unwatch && units && forces && a.calm++ > SPAWN_TOLD_FRAMES) {
      const ids = forces.members(f.raiders);
      if (ids.length) {
        // (the soldiers watched too: the fight's marks stand on each)
        const un = [units.observe(ids), units.observe(war.squadGroups.flatMap((g) => forces.members(g)))];
        a.unwatch = () => un.forEach((u) => u());
        const mid = (): V3 | null => {
          let n = 0;
          const s: V3 = [0, 0, 0];
          for (const id of forces.members(war.fight?.raiders ?? -1)) {
            const at = units.get(id)?.at;
            if (!at) continue;
            n++;
            for (let k = 0; k < 3; k++) s[k] += at[k];
          }
          return n ? [s[0] / n, s[1] / n, s[2] / n] : null;
        };
        a.mid = mid;
        this.scene.speed = Math.max(this.speed0, MARCH_SPEED);
        // (the camera to the raiders once their place is read, then sliding after them)
        const go = () => {
          if (this.attack !== a) return;
          const p = mid();
          if (!p) return void setTimeout(go, 100);
          void this.cam.look(p, { zoom: MARCH_ZOOM, ease: 1, place: [0.5, 0.4] }).then(() => {
            if (this.attack !== a) return;
            this.cam.follow(mid);
            a.following = true;
          });
        };
        go();
      }
    }
    if (f.stage !== 'coming') this.scene.speed = this.speed0;
    // (the camera closes in as the raiders reach the town and the fight starts: figures read on a phone)
    if (a.following && !this.cam.busy) {
      const cam = this.scene.core.camera;
      const want = f.stage === 'coming' ? MARCH_ZOOM : FIGHT_ZOOM;
      cam.zoom *= Math.exp(Math.log(want / cam.zoom) * Math.min(1, dt * 1.2));
      // (and comes down: figures stand taller on the screen)
      cam.elevation += (FIGHT_PITCH - cam.elevation) * Math.min(1, dt * 1.2);
    }
    const line = f.failed ? WAVE_NO_ROAD : W.attackLine(f.n, f.alive, f.soldiers, f.stage);
    if (line !== this.fightLine) {
      this.fightLine = line;
      this.changed();
    }
    if (f.stage !== 'coming' && f.soldiers === 0 && f.alive > 0) a.sackAt ??= a.t;
    const over = f.failed || f.alive === 0 || (a.sackAt !== null && a.t - a.sackAt > SACK_SECONDS) || a.t > ATTACK_SECONDS;
    if (over) this.endAttack(f);
  }

  private endAttack(f: NonNullable<SeasonLoop['war']>['fight'] | null): void {
    const a = this.attack!;
    // (where the raiders stand as it ends: the district that burns if they broke in, and what the camera pulls back to)
    const mid = a.mid?.() ?? null;
    const S = this.scene.stream;
    const cell = mid && S ? ([S.origin[0] + cellAt(mid[0], mid[1])[0], S.origin[1] + cellAt(mid[0], mid[1])[1]] as [number, number]) : undefined;
    this.attack = null;
    a.unwatch?.();
    this.cam.follow(null);
    this.scene.core.camera.elevation = this.pitch0;
    this.scene.speed = this.speed0;
    this.armed = null;
    const l0 = this.season.ledger;
    const before = { might: total(l0, 'might'), materials: pools(l0).materials, unrest: pools(l0).unrest };
    // (raiders who found no road, or none came: nobody got in)
    const fight = { raiders: f && !f.failed ? f.n : 0, left: f && !f.failed ? f.alive : 0, fallen: f?.fallen ?? 0 };
    const settled = this.season.war?.resolve(l0) ?? null;
    if (settled) this.season.setLedger(settled.ledger);
    const l1 = this.season.ledger;
    const lost = { might: before.might - total(l1, 'might'), materials: before.materials - pools(l1).materials, unrest: pools(l1).unrest - before.unrest };
    this.realm!.ledger = this.season.ledger;
    this.realm!.fought(fight, cell);
    if (mid) void this.cam.look(mid, { zoom: AFTER_ZOOM, ease: 1.5, place: [0.5, 0.36] });
    this.resultLines = [...(f?.failed ? [WAVE_NO_ROAD] : []), ...W.resultLines(this.realm!.fight!, lost)];
    // (the fight is in the history, and a district burned is named for the mutators: saved at once)
    void this.save();
    console.log(`[loop] attack over: ${JSON.stringify({ ...fight, ...lost })}`);
    this.set('result');
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

  /** (scripts) the fight as the units stand: each squad's post and report, where each soldier and raider is (window
   *  cells) and what it is doing */
  fightDebug(watch = false): unknown {
    const war = this.season.war;
    const units = this.scene.units;
    const forces = this.scene.townForces;
    if (!war || !units || !forces) return null;
    if (watch) units.observe(war.squadGroups.flatMap((g) => forces.members(g)));
    const who = (ids: number[]) =>
      ids.map((id) => {
        const v = units.get(id);
        return v ? `${v.at ? v.at.map((x) => Math.round(x)).join(',') : 'unread'} ${v.state} ${v.job.kind}${v.hostile ? ' hostile' : ''} hp${v.health}` : 'gone';
      });
    const { w, h } = this.scene.core.dims;
    return { window: [w, h], origin: this.scene.stream?.origin, war: war.debug(), soldiers: war.squadGroups.map((g) => who(forces.members(g) as number[])), raiders: who(forces.members(war.fight?.raiders ?? -1) as number[]), town: this.town?.centreInWindow().map((v) => Math.round(v)) };
  }

  /** (scripts) where the raiders are on the screen now (px), or null: none watched */
  raidAt(): [number, number] | null {
    const p = this.attack?.mid?.();
    return p ? this.scene.core.camera.project(p[0], p[1], p[2]) : null;
  }

  arm(spell: SpellId | null): void {
    this.armed = spell;
    this.changed();
  }

  /** a tap on the map with a spell armed: cast there (Heat ray: a blow over an area on the units there, shown with
   *  the level's own lightning strike — a stand-in look) */
  private cast(e: PointerEvent): void {
    const id = this.phase === 'event' && this.armed === 'fire' ? 'fire' : this.phase === 'attack' && this.armed === 'heatray' ? 'heatray' : null;
    if (!id) return;
    const rect = this.scene.host.canvas.getBoundingClientRect();
    // (the map's own tool and pan are not given this press: the cast is the gesture)
    e.stopPropagation();
    e.preventDefault();
    this.castAt(id, e.clientX - rect.left, e.clientY - rect.top, CAST_WAIT_FRAMES);
  }

  /** the height the figures a spell is cast on stand at (the raiders of the fight, the dead of the event): the mean of
   *  those the units read (they are observed while either is on); null: none read */
  private figuresZ(): number | null {
    const units = this.scene.units;
    const ids = this.event ? [...this.event.up] : (this.scene.townForces?.members(this.season.war?.fight?.raiders ?? -1) ?? []);
    const zs = ids.map((id) => units?.get(id)?.at?.[2]).filter((z): z is number => z !== undefined);
    return zs.length ? zs.reduce((s, z) => s + z, 0) / zs.length : null;
  }

  /**
   * The cast at a screen point: where the press's ray meets the level the figures stand at (their own places, which
   * the units already read while a fight or the event is on). Before, it asked for the ground under the press
   * (scene.heightAt): that answers null until the column's page has been read and again after its chunk has run — in
   * a fight the chunks under the figures run every tick, and a finger has no hover before its press to have asked for
   * the page, so the cast found no ground or waited for it past the fight's end (LS-46; a touch and a mouse press both
   * cast nothing, 2 of 2). With no figure read (none in play), the ground's pages are asked for once and waited for.
   */
  private castAt(id: 'fire' | 'heatray', sx: number, sy: number, tries: number): void {
    const sp = id === 'fire' ? FIRE : HEATRAY;
    if (this.armed !== id) return;
    const cam = this.scene.core.camera;
    const z = this.figuresZ();
    const g = z !== null ? cam.groundAt(sx, sy, () => z) : cam.groundAt(sx, sy, this.scene.heightAt);
    if (!g) {
      const terrain = this.scene.worldApi?.terrain;
      if (tries <= 0 || !terrain) return console.warn('[loop] spell: the ground under the tap was never read');
      // (the screen's reach in cells round the camera's target, both ways)
      const r = Math.max(innerWidth, innerHeight) / cam.zoom;
      const [tx, ty] = cam.target;
      return void terrain.load(tx - r, ty - r, tx + r, ty + r).then(
        () => this.castAt(id, sx, sy, tries - 1),
        (e) => console.warn(`[loop] spell: the ground's pages could not be read: ${e}`),
      );
    }
    if (pools(this.season.ledger).magic < sp.magic) {
      this.fightLine = W.shortText({ magic: sp.magic });
      return this.arm(null);
    }
    this.season.setLedger(lose(this.season.ledger, { magic: sp.magic }));
    this.realm!.ledger = this.season.ledger;
    this.scene.units?.strike?.({ at: [g[0], g[1]], radius: sp.radius, damage: sp.damage }, 'spell');
    this.scene.powers.scriptStrike(g[0], g[1], g[2]);
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
      const x = game?.realm?.life();
      return x ? { ...l, commuters: l.commuters + x.people, wagons: l.wagons + x.wagons } : l;
    },
    ready: () => void game!.load(),
  });
  game = new Game(scene, towns, season, mut);
  scene.seasonUi = mountRunUi(scene.host.ui, game);
  (globalThis as { rungame?: Game }).rungame = game;
}
