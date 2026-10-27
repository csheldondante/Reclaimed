// ---- story/hero-run.ts ----------------------------------------------------------
// A run story played as a hero (round 88; the user: "I would like to try spawning as a character like in
// hoverbike and talking to people or going places or fighting things for a run story").
// Wires together, each through its own interface:
// - the stage: the story's locations realised near the spawn (story/stage-gen.ts: rooms, locks, landmarks);
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

import type { RunRecord, SessionStory, StoryLocation, WorldState } from '../api/contracts';
import type { Hero, HeroWorld } from '../api/contracts/hero';
import type { UnitView } from '../api/contracts/units';
import type { Sim } from '../api/world';
import type { Dither, Orbit } from '../api/cutaway';
import type { Camera } from '../render/camera';
import type { Renderer } from '../render/renderer';
import { SimpleUnits } from '../units/simple';
import { Figures, unitPose, type FigurePose } from '../units/figures';
import { Walker } from '../hero/walker';
import { TouchPad } from '../hero/touchpad';
import { MAT } from '../world/materials';
import { StoryPlay, type Stage } from './play';
import { stageStory } from './stage-gen';
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
}

export class HeroRun {
  readonly units: SimpleUnits;
  readonly hero: Hero;
  readonly pad: TouchPad;
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
    this.units = new SimpleUnits(t);
    this.hero = (d.makeHero ?? ((w, at) => new Walker(w, at)))({ ground: t, units: this.units }, d.spawn);
    this.units.watch(this.hero.actor);
    this.pad = new TouchPad(d.ui, d.camera);
    this.figures = new Figures(d.device, d.renderer);
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
    const { stage } = stageStory(d.story, {
      terrain: t,
      waterAt: (x, y) => d.api.water?.depthAt(x, y) ?? null,
      plants: d.api.plants,
      spawn: d.spawn,
      spot: d.spot,
      size: d.size,
    });
    r.stage = stage;
    // (the places' edits land a few a tick: the run starts on them built, the ground read again)
    const queued = () => d.api.core.globals.events.length;
    for (let k = 0; queued() > 0; k++) {
      if (k > 200) throw new Error(`hero run: the stage's edits never landed (${queued()} queued)`);
      await new Promise((res) => setTimeout(res, 100));
    }
    await new Promise((res) => setTimeout(res, 300));
    await t.refresh();
    r.play = await StoryPlay.start({
      ui: d.ui,
      camera: d.camera,
      api: d.api,
      world: d.world,
      story: d.story,
      stage,
      hero: r.hero.role,
      units: r.units,
      player: () => (r.hero.alive ? r.hero.position() : null),
      say: (s) => d.say(s, 4),
      onBadge: (id) => {
        const u = r.play.unitOf(id);
        if (u !== undefined) r.seek(u);
      },
      again: () => location.reload(),
      opening: false,
      cut: { dither: d.dither },
    });
    r.hero.died.push(() => {
      d.say('You fall.', 4);
      r.play.run.end('lost');
    });
    r.play.run.onEnd.push((rec) => {
      r.ended = rec;
      r.pad.hidden = true;
    });
    const cam = d.camera;
    cam.zoom = r.hero.camera.zoom;
    cam.target = [...r.hero.position()] as V3;
    r.play.cam.follow(() => r.hero.position());
    r.play.cam.followRate = 6;
    return r;
  }

  /** the run has the screen: the level's own pan, zoom and taps wait */
  get holdsInput(): boolean {
    return true;
  }

  /** Talk to a cast member (as a tap on them, once there). */
  async talk(id: string): Promise<void> {
    this.approach = null;
    this.goTo = null;
    await this.play.talk(id);
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
    this.approach = {
      id: unit,
      talk: !u.hostile && !!who && this.play.canTalk(who),
    };
    this.goTo = null;
  }

  update(dt: number): void {
    // (the first frame: the hero's own zoom, over whatever the level opened at)
    if (this.t === 0) this.d.camera.zoom = this.hero.camera.zoom;
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
      hero.update(dt, it);
      this.units.update(dt);
      // (what E or the button does: talk to whoever's near)
      const c = this.talkable();
      this.pad.setAction(
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
    this.pad.setHealth(hero.health, hero.maxHealth);
    // the chase camera: drawn round behind the hero while it walks (not while a shot has the view)
    const p = hero.position();
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
    this.d.dither?.see('hero', p[0], p[1], p[2] + 1);
    play.update(dt);
    this.d.dither?.update(dt);
    this.draw();
  }

  /** the window slid: what's kept in window coordinates moves */
  shift(dx: number, dy: number, dz: number): void {
    this.hero.shift(dx, dy, dz);
    this.units.shift(dx, dy, dz);
    this.play?.shift(dx, dy, dz);
    if (this.goTo) this.goTo = [this.goTo[0] + dx, this.goTo[1] + dy];
  }

  dispose(): void {
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
    // (a person under the finger: the nearest figure on the screen within reach of it)
    const cam = this.d.camera;
    let best: UnitView | null = null;
    let bd = PICK_PX;
    for (const u of this.units.all()) {
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
    for (const u of this.units.all()) poses.push(unitPose(u, this.t));
    this.figures.draw(poses);
  }
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
