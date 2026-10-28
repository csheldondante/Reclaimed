// ---- story/hero-run.ts ----------------------------------------------------------
// A run story played as a hero (round 88; the user: "I would like to try spawning as a character like in
// hoverbike and talking to people or going places or fighting things for a run story").
// Wires together, each through its own interface:
// - the stage: the story's locations realised near the spawn (story/stage-gen.ts: rooms, locks, landmarks); on a
//   streamed world kept in world units (`frame`) and stamped into the land (`realise`, story/stage-land.ts);
// - the units (contracts/units.ts; SimpleUnits until the GPU agents implement it): the cast as units, the
//   story's spawns, the fights;
// - the hero (contracts/hero.ts; hero/walker.ts on foot) and its controller (hero/touchpad.ts);
// - StoryPlay (story/play.ts): the run, the dialog, the objective list, the story cameras, the end card —
//   `reached` from the hero (BACKLOG D8), not the camera;
// - the chase camera: the story camera's `follow` on the hero, the cutaway's Orbit drawn behind its heading
//   (Orbit.prefer, the hoverbike's "settle within 30° of behind") while it walks; Dither keeps it seen.
// What a tap means: on a person — walk up to them and talk (a hostile one: go and fight); on the ground —
// walk there. Walking up to someone shows a "Talk to …" button (E). The hero's death ends the run: lost.
//
//   const hr = await HeroRun.start({ ui, camera, api, story, world, spawn, spot, size, orbit, dither, renderer, device, groundAt, say })
//   each frame: hr.update(dt)      // `holdsInput`: the level's own camera input waits (always, while it runs)

import type { AtlasEvent, RunRecord, SessionStory, StoryLocation, WorldState } from '../api/contracts';
import type { Hero, HeroWorld, RunController } from '../api/contracts/hero';
import type { Units, UnitView } from '../api/contracts/units';
import type { Sim } from '../api/world';
import type { Dither, Orbit } from '../api/cutaway';
import type { Camera } from '../render/camera';
import type { Renderer } from '../render/renderer';
import { SimpleUnits } from '../units/simple';
import { Figures, unitPose, type FigurePose } from '../units/figures';
import { Walker, STEP as WALK_STEP } from '../hero/walker';
import { findPath } from '../hero/path';
import { TouchPad } from '../hero/touchpad';
import { MAT } from '../world/materials';
import { StoryPlay, type Stage, type StageFrame, type StageLasting } from './play';
import { stageStory, type StagePiece } from './stage-gen';
import type { StageLand } from './stage-land';
import { Waypoint, describe, objectiveTarget, type Target } from './waypoint';
import type { V3 } from './camera';

/** cells: near enough to talk; a tap this near a figure (CSS px) picks it */
const TALK = 3;
const PICK_PX = 40;

export interface HeroRunDeps {
  ui: HTMLElement;
  camera: Camera;
  api: Sim;
  story: SessionStory;
  world: WorldState;
  /** where the hero starts (window x, y) */
  spawn: [number, number];
  /** a location's real spot (window x, y), from the atlas */
  spot: (l: StoryLocation) => [number, number];
  /** the window (x cells, y world units) */
  size: [number, number];
  orbit: Orbit;
  dither?: Dither;
  renderer: Renderer;
  device: GPUDevice;
  /** a screen point (CSS px) on the ground (world x, y, z) */
  groundAt: (sx: number, sy: number) => [number, number, number];
  /** a line for the player */
  say: (text: string, seconds?: number) => void;
  /** the hero (default: on foot, hero/walker.ts); a hero game's own plugs in here and draws itself */
  makeHero?: (world: HeroWorld, at: [number, number]) => Hero;
  /**
   * (round 97, heroapi) the people and monsters (default: SimpleUnits, drawn here as figures). A game's own — the
   * hoverbike game's GPU agents, whose deaths the story counts whatever killed them — draws itself.
   */
  units?: Units;
  /** (round 97) the controller (default: the TouchPad); a hero game's own input, its unclaimed taps handed back through `onTap` */
  makeController?: (hero: Hero) => RunController;
  /** (round 97) the game drives the camera itself while no story shot has it (`cameraFree`): no follow, zoom or Orbit.prefer here */
  ownCamera?: boolean;
  /** (round 97) the end card's "Start a new run" (default: reload the page) */
  again?: () => void;
  /** (round 97) what past runs left (WorldState.history()): its marks realised at play scale as the run begins */
  remember?: AtlasEvent[];
  /**
   * (round 99, runstream) the stage kept in world units: the generator's places (made in window coordinates round
   * the spawn) are moved onto it before the run plays, and everything measured against them goes through it
   * (StoryPlay's StageFrame). Default: the stage stays in the window's coordinates (a still window).
   */
  frame?: StageFrame;
  /**
   * (round 99) build the stage's pieces (window x, y as made; resolves once they're in the window and its ground read
   * back): a streamed world keeps them in world cells and stamps them into its land (story/stage-land.ts). Default:
   * queued as the world API's edits, waited for.
   */
  realise?: (pieces: StagePiece[]) => Promise<void>;
  /** (round 99) what play changes that lasts (an opened lock, a grave, a cairn): told to the stage's keeper */
  lasting?: StageLasting;
}

export class HeroRun {
  readonly units: Units;
  readonly hero: Hero;
  readonly pad: RunController;
  readonly figures: Figures;
  play!: StoryPlay;
  stage!: Stage;
  /** walking up to someone: to talk, or (hostile) to fight */
  private approach: { id: number; talk: boolean } | null = null;
  private goTo: [number, number] | null = null;
  private t = 0;
  private ended: RunRecord | null = null;

  private constructor(private d: HeroRunDeps) {
    const t = d.api.terrain;
    if (!t) throw new Error('hero run: needs the world API terrain module');
    this.units = d.units ?? new SimpleUnits(t);
    this.hero = (d.makeHero ?? ((w, at) => new Walker(w, at)))({ ground: t, units: this.units, water: d.api.water }, d.spawn);
    this.units.watch(this.hero.actor);
    // (round 100, hitchrec: the world API's mirror reads the layers by pages round the camera; the hero's kept fresh too)
    this.cleanup.push(t.keepFresh(() => this.hero.position()));
    this.pad = d.makeController?.(this.hero) ?? new TouchPad(d.ui, d.camera);
    this.figures = new Figures(d.device, d.renderer);
    this.waypoint = new Waypoint(d.ui);
    this.pad.onTap = (sx, sy) => this.tap(sx, sy);
    this.pad.onAction = () => {
      const c = this.talkable();
      if (c) void this.talk(c);
    };
    this.hero.hurt.push(() => this.d.api.fx?.burst('dust', ...this.hero.position(), { count: 6 }));
  }

  static async start(d: HeroRunDeps): Promise<HeroRun> {
    const t = d.api.terrain;
    if (!t) throw new Error('hero run: needs the world API terrain module');
    // (the ground read back first: a read of the window as it is now, the spawn's drawn height in it)
    for (let k = 0; ; k++) {
      await t.refresh();
      if (d.api.fresh && t.heightAt(d.spawn[0], d.spawn[1], { smooth: true }) !== null) break;
      if (k > 40) throw new Error(`hero run: the ground at the spawn (${d.spawn}) never read back`);
      await new Promise((res) => setTimeout(res, 250));
    }
    const r = new HeroRun(d);
    const { stage, pieces } = stageStory(d.story, {
      terrain: t,
      waterAt: (x, y) => d.api.water?.depthAt(x, y) ?? null,
      spawn: d.spawn,
      spot: d.spot,
      size: d.size,
    });
    if (d.realise) await d.realise(pieces);
    else {
      for (const p of pieces) {
        if (p.grow) d.api.plants?.grow(p.at[0], p.at[1], { radius: p.radius, strength: p.grow });
        else t.build(p.at[0], p.at[1], p.material, { radius: p.radius, layers: p.layers });
      }
      // (the places' edits land a few a tick: the run starts on them built, the ground read again)
      const queued = () => d.api.core.globals.events.length;
      for (let k = 0; queued() > 0; k++) {
        if (k > 200) throw new Error(`hero run: the stage's edits never landed (${queued()} queued)`);
        await new Promise((res) => setTimeout(res, 100));
      }
      await new Promise((res) => setTimeout(res, 300));
    }
    await t.refresh();
    // (round 99) the stage onto its frame's coordinates (world units), made in the window as it was
    r.stage = d.frame ? onFrame(stage, d.frame) : stage;
    r.play = await StoryPlay.start({
      ui: d.ui,
      camera: d.camera,
      api: d.api,
      world: d.world,
      story: d.story,
      stage: r.stage,
      hero: r.hero.role,
      units: r.units,
      player: () => (r.hero.alive ? r.hero.position() : null),
      say: (s) => d.say(s, 4),
      onBadge: (id) => {
        const u = r.play.unitOf(id);
        if (u !== undefined) r.seek(u);
      },
      again: d.again ?? (() => location.reload()),
      opening: false,
      cut: { dither: d.dither },
      remember: d.remember,
      frame: d.frame,
      lasting: d.lasting,
    });
    r.hero.died.push(() => {
      d.say('You fall.', 4);
      r.play.run.end('lost');
    });
    r.play.run.onEnd.push((rec) => {
      r.ended = rec;
      r.pad.hidden = true;
    });
    if (!d.ownCamera) {
      const cam = d.camera;
      cam.zoom = r.hero.camera.zoom;
      cam.target = [...r.hero.position()] as V3;
      r.play.cam.follow(() => r.hero.position());
      r.play.cam.followRate = 6;
    }
    return r;
  }

  /** the run has the screen: the level's own pan, zoom and taps wait */
  get holdsInput(): boolean {
    return true;
  }

  /** (round 97) no story shot has the camera: a game that drives its own (`ownCamera`) may */
  get cameraFree(): boolean {
    return !this.play.cam.busy;
  }

  /** Talk to a cast member (as a tap on them, once there). */
  async talk(id: string): Promise<void> {
    this.approach = null;
    this.goTo = null;
    await this.play.talk(id);
  }

  /** The way the hero would take from `from` to `to` (scripts: what a walk will do), null: none found. */
  route(from: [number, number], to: [number, number]): [number, number][] | null {
    return findPath(this.d.api.terrain!, from, to, { step: WALK_STEP });
  }

  /** Send the hero to a point (window x, y), as a tap on the ground would. */
  walkTo(at: [number, number]): void {
    this.approach = null;
    this.goTo = at;
  }

  /** Walk up to a unit: talk to it (a cast member with a dialog) or fight it (hostile). */
  seek(unit: number): void {
    const u = this.units.get(unit);
    if (!u?.alive) return;
    const who = u.character;
    const talk = !u.hostile && !!who && this.play.canTalk(who);
    // (round 97) a hero that doesn't walk itself to a point (a vehicle): near enough, the talk opens; else it's told to go closer
    if (this.hero.goesTo === false) {
      const p = this.hero.position();
      if (talk && Math.hypot(u.at[0] - p[0], u.at[1] - p[1]) <= TALK + 1) void this.talk(who!);
      else if (talk) this.d.say(`Go closer to talk to ${u.name ?? who}`, 3);
      return;
    }
    this.approach = { id: unit, talk };
    this.goTo = null;
  }

  update(dt: number): void {
    // (the first frame: the hero's own zoom, over whatever the level opened at)
    if (this.t === 0 && !this.d.ownCamera) this.d.camera.zoom = this.hero.camera.zoom;
    this.t += dt;
    const play = this.play;
    const talking = play.dialog.isOpen;
    const hero = this.hero;
    this.pad.hidden = talking || !!this.ended || !hero.alive;
    if (talking || this.ended) {
      hero.update(dt, { move: [0, 0] });
    } else {
      const it = this.pad.intent();
      if (Math.hypot(...it.move) > 0.05) {
        this.approach = null;
        this.goTo = null;
      }
      // walking up to someone
      const a = this.approach;
      let attack = !!it.attack;
      if (a) {
        const u = this.units.get(a.id);
        if (!u?.alive || (a.talk && u.hostile)) this.approach = null;
        else {
          const p = hero.position();
          const dist = Math.hypot(u.at[0] - p[0], u.at[1] - p[1]);
          if (a.talk && dist <= TALK) {
            this.approach = null;
            void this.talk(u.character!);
          } else if (!a.talk && dist <= 2.2) attack = true;
          else it.goTo = [u.at[0], u.at[1]];
        }
      } else if (this.goTo) {
        it.goTo = this.goTo;
        this.goTo = null;
      }
      it.attack = attack;
      // (round 97) talk as an intent: whoever's near
      if (it.talk) {
        const c = this.talkable();
        if (c) void this.talk(c);
      }
      hero.update(dt, it);
      this.units.update(dt);
      // (what E or the button does: talk to whoever's near)
      const c = this.talkable();
      this.pad.setAction?.(
        c
          ? `Talk to ${
              this.d.story.cast
                .find((x) => x.id === c)!
                .name.split(' ')
                .slice(-1)[0]
            }`
          : null,
      );
    }
    this.pad.setHealth?.(hero.health, hero.maxHealth);
    // the chase camera: drawn round behind the hero while it walks (not while a shot has the view; not when the game drives it)
    const p = hero.position();
    if (!this.d.ownCamera) {
      const o = this.d.orbit;
      o.prefer =
        hero.speed() > 0.5
          ? {
              az: hero.heading() + Math.PI,
              dead: hero.camera.behind,
              firm: hero.camera.firm,
            }
          : null;
      if (!play.cam.busy) o.update(p[0], p[1], p[2], dt);
    }
    this.d.dither?.see('hero', p[0], p[1], p[2] + 1);
    play.update(dt);
    this.d.dither?.update(dt);
    this.draw();
    // (round 94) where to go: the marker or the edge arrow, and the objective's line ("Mebe · north-east · 140 m")
    this.target = this.ended || talking ? null : objectiveTarget({ story: this.d.story, run: play.run, stage: this.stage, units: this.units, unitOf: (c) => play.unitOf(c), heightAt: (x, y) => this.d.api.terrain!.heightAt(x, y), toWin: this.d.frame?.toWin });
    this.waypoint.update(this.target, p, this.d.camera);
    this.hintT -= dt;
    if (this.hintT <= 0) {
      this.hintT = 0.3;
      const t = this.target;
      if (t) play.hud.hint(t.objective, `→ ${t.name}${t.place ? ` in ${t.place}` : ''}${t.needs ? ` (needs the ${t.needs})` : ''} · ${describe(p, t.at)}`);
    }
    // (round 94) a warp put the hero down elsewhere: once the ground there is read
    if (this.placeAt && this.d.api.fresh && this.d.api.terrain!.heightAt(this.placeAt[0], this.placeAt[1], { smooth: true }) !== null) {
      this.hero.place(this.placeAt);
      this.placeAt = null;
    }
  }

  /** the current objective's target (story/waypoint.ts): the map pins it */
  target: Target | null = null;
  private hintT = 0;
  private readonly waypoint: Waypoint;
  /** (round 94) where a warp put the hero (window x, y), waiting for the ground there */
  private placeAt: [number, number] | null = null;

  /**
   * the window slid: what's kept in window coordinates moves (round 99: the units only when they're the run's own
   * SimpleUnits — a game's own units keep themselves in step with the window, as the GPU agents do through
   * WorldCore.onShift)
   */
  shift(dx: number, dy: number, dz: number): void {
    this.hero.shift(dx, dy, dz);
    if (!this.d.units) this.units.shift(dx, dy, dz);
    this.play?.shift(dx, dy, dz);
    if (this.goTo) this.goTo = [this.goTo[0] + dx, this.goTo[1] + dy];
  }

  /**
   * (round 94; the user: "Keep warp on for now because the character is way too slow") The map warped the window:
   * everything kept moves by the jump (the story's places stay where they are on the atlas, far off now), and
   * the hero is put down at `at` (window x, y) once the ground there is read.
   */
  warped(dx: number, dy: number, dz: number, at: [number, number]): void {
    this.shift(dx, dy, dz);
    this.approach = null;
    this.goTo = null;
    this.placeAt = at;
  }

  /** (round 99) a stage point (world units on a streamed world) in the window as it is now */
  winOf(p: [number, number]): [number, number] {
    return this.d.frame ? this.d.frame.toWin(p) : [p[0], p[1]];
  }

  /** (round 99) a window point on the stage's coordinates (world units on a streamed world) */
  worldOf(p: [number, number]): [number, number] {
    return this.d.frame ? this.d.frame.toWorld(p) : [p[0], p[1]];
  }

  /** (round 99) what's undone with the run (the stage's land hook, its watch) */
  readonly cleanup: (() => void)[] = [];
  /** (round 99) the stage's places in world cells, when a streamed world keeps them (startAtlasRun) */
  land: StageLand | null = null;

  dispose(): void {
    for (const f of this.cleanup) f();
    this.waypoint.dispose();
    this.pad.dispose();
    this.figures.dispose();
    this.play?.dispose();
    this.d.dither?.forget('hero');
  }

  /** the nearest cast member near enough to talk to */
  private talkable(): string | null {
    const p = this.hero.position();
    for (const u of this.units.query([p[0], p[1]], TALK + 0.5)) if (u.character && this.play.canTalk(u.character)) return u.character;
    return null;
  }

  private tap(sx: number, sy: number): void {
    if (this.play.cam.busy) return this.play.cam.skip();
    if (this.ended || !this.hero.alive) return;
    // (round 97) the hero's own mechanics first: a tap it claims never walks it or opens a talk
    if (this.hero.claims?.(sx, sy)) return;
    // (a person under the finger: the nearest figure on the screen within reach of it)
    const cam = this.d.camera;
    let best: UnitView | null = null;
    let bd = PICK_PX;
    for (const u of this.units.all?.() ?? []) {
      if (!u.alive) continue;
      const [x, y] = cam.project(u.at[0], u.at[1], u.at[2] + 1.2);
      const dd = Math.hypot(x - sx, y - sy);
      if (dd < bd) {
        bd = dd;
        best = u;
      }
    }
    if (best) return this.seek(best.id);
    const g = this.d.groundAt(sx, sy);
    this.walkTo([g[0], g[1]]);
  }

  private draw(): void {
    const poses: FigurePose[] = [];
    // (a Walker is drawn here; any other hero draws itself)
    const h = this.hero instanceof Walker ? this.hero : null;
    if (h) poses.push(walkerPose(h));
    // (a game's own units draw themselves)
    if (!this.d.units) for (const u of this.units.all?.() ?? []) poses.push(unitPose(u, this.t));
    this.figures.draw(poses);
  }
}

/** (round 99) a stage made in window coordinates, onto a frame's (every spot through `toWorld`) */
function onFrame(s: Stage, f: StageFrame): Stage {
  const w = (p: [number, number]) => f.toWorld(p);
  const map = <T extends { at: [number, number] }>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, at: w(v.at) }]));
  return {
    locations: map(s.locations),
    cast: map(s.cast),
    rooms: s.rooms ? Object.fromEntries(Object.entries(s.rooms).map(([k, v]) => [k, map(v)])) : undefined,
    locks: s.locks?.map((k) => ({ ...k, at: w(k.at) })),
  };
}

function walkerPose(h: Walker): FigurePose {
  const sw = h.swingT > 0 ? h.swingT * 2 - 1 : null;
  return {
    at: h.position(),
    heading: h.heading(),
    height: 2.4,
    torso: MAT.Steel,
    head: MAT.Canvas,
    legs: MAT.Asphalt,
    weapon: MAT.Steel,
    phase: h.phase,
    moving: h.pace > 0.3,
    swing: sw,
    lean: sw === null ? 0 : 0.5,
    flash: h.flash > 0 ? Math.min(1, h.flash * 3) : 0,
    dead: !h.alive,
  };
}
