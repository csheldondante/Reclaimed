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
import { Realm, roadLook, RUN_SEASONS, type SpellId } from '../../season/realm';
import { SITES, type SiteKey } from '../../season/realm-templates';
import { mountRunUi, type Asking, type Marker, type Phase, type RunGame } from '../../season/run-ui';
import * as W from '../../season/run-words';
import { WAVE_NO_ROAD } from '../../season/words';
import { StoryCamera, type V3 } from '../../story/camera';
import type { LevelScene } from '../level';
import { REGION } from '../streamer/defs';
import { startSeasonLoop, storeReady } from './season';

/** the world's record in the world store: the fact layer, the characters, the holdings (WorldState's snapshot) */
const WORLD_KEY = 'realm:world';
/** the sim's speed while the raiders march in (they walk from outside the town) */
const MARCH_SPEED = 3;
/** seconds raiders stay in a town with no soldier left before the fight is called */
const SACK_SECONDS = 5;
/** wall seconds an attack may take at most before it is called as it stands */
const ATTACK_SECONDS = 150;
/** the camera's zoom (screen px a cell) down a road before the raid is called, on the raiders marching, and on the
 *  fight: at 412 px across, a figure about a cell wide reads from 12 up */
const ROAD_ZOOM = 4;
const MARCH_ZOOM = 8;
const FIGHT_ZOOM = 15;
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

/** a spell's blow: its radius (cells), its damage, its cost */
const HEATRAY = { radius: 5, damage: 3, magic: 1 };

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

  constructor(
    private scene: LevelScene,
    private towns: FieldTowns,
    private season: SeasonLoop,
  ) {
    this.cam = new StoryCamera(scene.core.camera, scene.storyCut ?? {});
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
      this.watchFight(dt);
    };
    requestAnimationFrame(tick);
    // (on the window, before the map's own input: the level's input layer lies over the canvas, so a listener on the
    // canvas never heard the tap — round 1's cast was never seen. A tap on the loop's own screens is not a cast)
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!(e.target instanceof Element && e.target.closest('.run-sheet, .run-top, .run-marks, .run-full, .dlg'))) this.cast(e);
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
   * Where a site of the home town is on the map (a window point). A stand-in rule (BACKLOG LS-3): a ring round the
   * town's centre by the site's place in the list, the gates and roads farther out — not yet the town's own lot of
   * that kind.
   */
  private spot(site: SiteKey): [number, number] | null {
    const t = this.town;
    if (!t) return null;
    const i = SITES.findIndex((s) => s.key === site);
    const c = t.centreInWindow();
    const out = SITES[i].kind === 'gate' || SITES[i].kind === 'fields';
    const r = t.box.R * (out ? 0.34 + 0.03 * (i % 3) : 0.1 + 0.035 * (i % 6));
    return [c[0] + Math.cos(i * 2.399) * r, c[1] + Math.sin(i * 2.399) * r];
  }

  markers(): Marker[] {
    const t = this.town;
    const r = this.realm;
    const cam = this.scene.core.camera;
    if (!t || !r || (this.phase !== 'city' && this.phase !== 'petition')) return [];
    const out: Marker[] = [];
    const put = (id: string, label: string, kind: Marker['kind'], at: [number, number] | null) => {
      if (!at) return;
      const [x, y] = cam.project(at[0], at[1], this.z(at[0], at[1]));
      if (x > -50 && y > -50 && x < innerWidth + 50 && y < innerHeight + 50) out.push({ id, label, kind, x, y });
    };
    for (const o of r.offers()) {
      if (o.status !== 'offered') continue;
      const site = r.siteOf(o);
      if (site) put(o.id, `${r.w.name(o.presenter)} · ${W.leftText(r.left(o))}`, 'ask', this.spot(site));
    }
    const n = r.threatIn();
    if (n !== null && n > 0) put('threat', W.threatTag(n), 'threat', this.spot('road'));
    return out;
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

  land(): string[] {
    const r = this.realm;
    return r ? r.physical.map((p) => W.landLine(p.kind, r.w.name(p.at))) : [];
  }

  // ---- saving -----------------------------------------------------------------------------------------

  async load(): Promise<void> {
    const st = await storeReady(this.scene);
    if (st?.has(WORLD_KEY)) this.saved = JSON.parse(new TextDecoder().decode(await st.get(WORLD_KEY))) as WorldSnapshot;
    const before = this.before();
    console.log(`[loop] world: ${this.saved ? `saved, ${before.length} things remembered` : 'new'}`);
    this.set('leader');
  }

  /** the world's record saved whole: the fact layer, the characters, the holdings */
  private async save(): Promise<void> {
    const st = this.scene.stream?.store;
    const r = this.realm;
    if (!st || !r) return;
    this.saved = r.snapshot();
    const bytes = new TextEncoder().encode(JSON.stringify(this.saved));
    // (the store takes the bytes: their length said first)
    console.log(`[loop] world saved: ${bytes.length} B, ${r.history(true).length} events`);
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
    this.realm = new Realm({ world: this.saved ?? a.settlements.wiki.snapshot, home, seed: a.atlas.p.seed, leader: who, ledger, land: () => this.season.land, seasons });
    this.runs = this.realm.history(true).filter((e) => e.kind === 'run-began').length;
    this.notes = [];
    this.resultLines = [];
    this.season.setLedger(this.realm.ledger);
    void this.save();
    console.log(`[loop] run ${this.runs}: ${who.name}, ${seasons} seasons; asking: ${this.asking().map((x) => `${x.who} (${x.title})`).join(', ')}`);
    this.set('city');
    // (the town framed above the sheet: its core across the screen)
    const t = this.town;
    if (t) void this.cam.look(this.at3(t.centreInWindow()), { zoom: innerWidth / (0.9 * t.box.R), place: [0.5, 0.36], ease: 1.2 });
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
      r.commit(id);
      this.season.setLedger(r.ledger);
      this.notes = [...this.notes, W.agreedLine(speaker.name, o.opp.title)];
    } else if (act === 'refuse') {
      r.refuse(id);
      this.notes = [...this.notes, W.refusedLine(speaker.name)];
    }
    void this.cam.release();
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
    this.set('season');
    void this.season.next().then(async () => {
      while (this.season.playing) await new Promise((res) => setTimeout(res, 100));
      r.afterSeason(this.season.ledger);
      this.season.setLedger(r.ledger);
      await this.save();
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
        a.unwatch = units.observe(ids);
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
    this.attack = null;
    a.unwatch?.();
    this.cam.follow(null);
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
    this.realm!.fought(fight);
    this.resultLines = [...(f?.failed ? [WAVE_NO_ROAD] : []), ...W.resultLines(this.realm!.fight!, lost)];
    // (the fight is in the history, and a district burned is named for the mutators: saved at once)
    void this.save();
    console.log(`[loop] attack over: ${JSON.stringify({ ...fight, ...lost })}`);
    this.set('result');
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
    if (this.phase !== 'attack' || this.armed !== 'heatray') return;
    const rect = this.scene.host.canvas.getBoundingClientRect();
    const g = this.scene.core.camera.groundAt(e.clientX - rect.left, e.clientY - rect.top, this.scene.heightAt);
    if (!g) return console.warn('[loop] heat ray: no ground under the tap');
    if (pools(this.season.ledger).magic < HEATRAY.magic) {
      this.fightLine = W.shortText({ magic: HEATRAY.magic });
      return this.arm(null);
    }
    this.season.setLedger(lose(this.season.ledger, { magic: HEATRAY.magic }));
    this.realm!.ledger = this.season.ledger;
    this.scene.units?.strike?.({ at: [g[0], g[1]], radius: HEATRAY.radius, damage: HEATRAY.damage }, 'spell');
    this.scene.powers.scriptStrike(g[0], g[1], g[2]);
    console.log(`[loop] heat ray at ${g[0].toFixed(0)}, ${g[1].toFixed(0)}`);
    this.arm(null);
  }
}

/** the history's kinds the end-of-run screen always shows (the rest: those with a weight) */
const SHOWN = new Set(['built', 'founding', 'relieved', 'fell', 'raid-held', 'raid-broke', 'tribute-paid', 'made-safe', 'flooded', 'burned', 'melted', 'buried', 'lens-lit', 'farm-burned', 'scouts-seen']);

export function startRunLoop(scene: LevelScene, towns: FieldTowns): void {
  let game: Game | null = null;
  const season = startSeasonLoop(scene, towns, {
    ui: false,
    dealer: false,
    // (the raid is the arc's last stage — the realm's — not the fixed schedule; LS-16: the attack screen calls it, with
    // the camera down the road it comes by)
    raid: () => game?.realm?.raid ?? null,
    calls: true,
    ready: () => void game!.load(),
  });
  game = new Game(scene, towns, season);
  scene.seasonUi = mountRunUi(scene.host.ui, game);
  (globalThis as { rungame?: Game }).rungame = game;
}
