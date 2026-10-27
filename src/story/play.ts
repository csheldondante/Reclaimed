// ---- story/play.ts -------------------------------------------------------------
// A SessionStory played on a level (round 83): the run (run/run.ts), the dialog (dialog/dialog.ts), the
// objective list (run/hud.ts) and the story cameras (story/camera.ts) wired together, over the world API.
// - The cast stand where the Stage puts them, as markers: a pillar of their material built into the ground
//   (world API terrain.build) and a tappable badge over it (their initial and name).
// - Tapping a badge opens their dialog at the run's entry for it, the camera framing them over the panel.
// - The player's position (the camera's target in a god's-eye game; a hero's when there is one) reaching a
//   staged location notes `reached`; a done objective with a location gets a reveal shot of it.
// - An outcome's AtlasEvents go to the WorldState (the run applies them); what can be seen now is realised at
//   play scale here, where it happened (an `overgrow` grows plants and scatters petals, a `flood` pours
//   water, a `mark` raises a cairn). The rest is atlas scale only: the region generator realises it next time.
// The Stage is what the region generator will hand over once it builds a story's locations (system 3): where
// each place and person is in this window. Until then it's written by hand beside the story.
//
//   const play = await StoryPlay.start({ ui, camera, api, world, story, stage, cut: { dither, slice } })
//   each frame: play.update(dt)     // `holdsInput`: a talk or a shot has the screen (the level's controls wait)

import type { AtlasEvent, Bark, DialogTree, Outcome, RunRecord, SessionStory, WorldState } from '../api/contracts';
import type { Sim } from '../api/world';
import type { Dither, Slice } from '../api/cutaway';
import type { Camera } from '../render/camera';
import type { UnitId, Units } from '../api/contracts/units';
import { DialogBox } from '../dialog/dialog';
import { StoryRun } from '../run/run';
import { ObjectiveHud } from '../run/hud';
import { StoryCamera, type V3 } from './camera';
import './play.css';

/** Where a story's places and people are in this level's world (world x, y). */
export interface Stage {
  /** each story location: where, and how near counts as `reached` (cells) */
  locations: Record<string, { at: [number, number]; radius: number }>;
  /** each cast member: where they stand, their colour (badge, dialog), the pillar's material and height (cells) */
  cast: Record<string, { at: [number, number]; colour: string; material: string; height?: number }>;
  /** (round 88) each location's rooms: where, and how near counts as in it (`reached { location, room }`) */
  rooms?: Record<string, Record<string, { at: [number, number]; radius: number }>>;
  /** (round 88) locked doorways (a brief's locks): opened when the player comes to one holding its key */
  locks?: StageLock[];
}

export interface StageLock {
  id: string;
  location: string;
  /** (round 94) the room it shuts (behind it) */
  room?: string;
  at: [number, number];
  /** what opens it: an item held, a character talked to, an objective done */
  key: { item?: string; character?: string; objective?: string };
  material: string;
  open: boolean;
}

export interface StoryPlayDeps {
  ui: HTMLElement;
  camera: Camera;
  /** the world API over the level (terrain for heights and the pillars; plants, water, fx for what outcomes show) */
  api: Sim;
  world: WorldState;
  story: SessionStory;
  stage: Stage;
  hero?: string;
  /** the cutaway's dither and slice, when the level has them (speakers kept seen) */
  cut?: { dither?: Dither; slice?: Slice };
  /** where the player is (default: the camera's target) */
  player?: () => V3 | null;
  /**
   * (round 88) the units system: the cast stand as units (tap or walk up to talk; `killed` when they die), an
   * outcome's `spawn` appears as units and its `hostile` turns cast members on the player. Without it the cast
   * are pillars with badges, and spawns are only noted.
   */
  units?: Units;
  /** a line for the player (a lock that won't open, one that does) */
  say?: (text: string) => void;
  /** (round 88) a cast member's badge tapped (a hero walks up to them first); default: talk at once */
  onBadge?: (id: string) => void;
  /** (round 88) false: no opening look at the first objective (a hero's run opens on the hero) */
  opening?: boolean;
  /** (round 88) the end card offers a new run */
  again?: () => void;
  /**
   * (round 97, heroapi) what past runs left (the world's history): what of it can be seen at play scale (a mark's
   * cairn, an overgrowth, a flood) is realised where it happened as the run begins, so the world shows its marks
   */
  remember?: AtlasEvent[];
}

/** (round 97) cells: within this of a cast member (or a place's edge) counts as having seen them (`saw`) */
export const SIGHT = 16;

interface Placed {
  id: string;
  /** (round 88) its unit, when the cast are units */
  unit?: UnitId;
  at: V3;
  height: number;
  badge: HTMLButtonElement;
  tree: DialogTree | null;
}

export class StoryPlay {
  readonly run: StoryRun;
  readonly dialog: DialogBox;
  readonly cam: StoryCamera;
  readonly hud: ObjectiveHud;
  private placed = new Map<string, Placed>();
  private reached = new Set<string>();
  private lockSaid = new Map<string, number>();
  private look = 0;
  private card?: HTMLDivElement;
  private layer: HTMLDivElement;
  /** (round 97) who and what the player has seen (`saw`, noted once each) */
  private seen = new Set<string>();
  /** (round 97) barks showing: over their speaker (or the narrator's, through `say`), and the time left */
  private barks: { el: HTMLDivElement; by: string; t: number }[] = [];
  /** (round 97) the world's marks seen at play scale: their names over them */
  private marks: { el: HTMLDivElement; at: V3 }[] = [];
  /** (round 97) talks an outcome opened while another had the screen: opened in turn */
  private talks: { character: string; node?: string }[] = [];

  private constructor(private d: StoryPlayDeps) {
    const { story, stage } = d;
    // (every place and person the story names must be on the stage: nothing is put somewhere made up)
    const missing = [
      ...story.locations.filter((l) => !stage.locations[l.id]).map((l) => `location "${l.id}"`),
      ...story.cast.filter((c) => !stage.cast[c.id]).map((c) => `character "${c.id}"`),
    ];
    if (missing.length) throw new Error(`story "${story.id}": not on the stage: ${missing.join(', ')}`);
    this.run = new StoryRun(story, d.world, { hero: d.hero ?? 'wanderer' });
    this.dialog = new DialogBox(d.ui, {
      speaker: (id) => {
        const c = story.cast.find((x) => x.id === id);
        if (!c) throw new Error(`story "${story.id}": no character "${id}"`);
        return { name: c.name, title: c.role, colour: stage.cast[id].colour };
      },
      check: (c) => this.run.holds(c),
      entry: (t) => this.run.entry(t),
    });
    this.run.hear(this.dialog);
    this.cam = new StoryCamera(d.camera, d.cut);
    this.hud = new ObjectiveHud(d.ui, this.run);
    this.layer = document.createElement('div');
    this.layer.className = 'story-badges';
    d.ui.append(this.layer);
    this.run.onObjective.push((id, state) => {
      if (state !== 'done') return;
      // (the shot goes where the change is seen: an atlas event's place, else the objective's)
      const o = this.run.objective(id);
      const there = o.outcome.atlas?.map((e) => placeOf(e)).find((l) => l !== undefined) ?? o.location;
      if (there) void this.cam.reveal(this.where(there), { hold: 3 });
    });
    this.run.onOutcome.push((o, cause) => this.realise(o, cause));
    // (the card once the camera's done showing what the end brought)
    this.run.onEnd.push((r) => void this.cam.idle().then(() => this.endCard(r)));
  }

  /** Put the cast on the stage (the ground read first) and begin. */
  static async start(d: StoryPlayDeps): Promise<StoryPlay> {
    const p = new StoryPlay(d);
    const t = d.api.terrain;
    if (!t) throw new Error('story: needs the world API terrain module');
    await t.refresh();
    for (const c of d.story.cast) {
      const s = d.stage.cast[c.id];
      const ground = t.heightAt(s.at[0], s.at[1]);
      if (ground === null) throw new Error(`story: character "${c.id}" stands at ${s.at} — outside the world`);
      // (round 88: as a unit, when there are units; else a pillar of their material)
      const big = /lich|warden|lord|king/.test(c.role);
      const unit = d.units?.spawn(c.role, s.at, c.faction, { name: c.name, character: c.id, role: c.role, health: big ? 12 : 4, damage: big ? 2 : 1, sight: 12, speed: big ? 2.6 : 3 });
      const height = unit !== undefined ? 2.6 : (s.height ?? 6);
      if (unit === undefined) t.build(s.at[0], s.at[1], s.material, { radius: 1.3, layers: height });
      const badge = document.createElement('button');
      badge.className = 'story-badge';
      badge.style.setProperty('--c', s.colour);
      badge.innerHTML = '<span class="i"></span><span class="n"></span>';
      badge.querySelector('.i')!.textContent = c.name.trim()[0]?.toUpperCase() ?? '?';
      badge.querySelector('.n')!.textContent = c.name;
      const tree = d.story.dialogs.find((x) => x.speaker === c.id) ?? null;
      if (!tree) badge.classList.add('mute');
      badge.addEventListener('pointerdown', (e) => e.stopPropagation());
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        if (d.onBadge) d.onBadge(c.id);
        else void p.talk(c.id);
      });
      p.layer.append(badge);
      p.placed.set(c.id, { id: c.id, unit, at: [s.at[0], s.at[1], ground], height, badge, tree });
    }
    // (round 88) a unit dies: `killed` (a cast member's badge goes)
    d.units?.died.push((u) => {
      if (u.character) p.placed.get(u.character)?.badge.classList.add('gone');
      p.run.note({ kind: 'killed', character: u.character, unitKind: u.role });
    });
    // (the opening: the camera eases to where the first shown objective is, or the first cast member's place)
    const first = p.run.objectives().find((o) => o.state === 'shown');
    const open = (first && p.run.objective(first.id).location) ?? d.story.cast[0]?.location;
    if (open && d.opening !== false) void p.cam.look(p.where(open));
    // (round 97) what past runs left, where it can be seen
    for (const e of d.remember ?? []) p.realiseEvent(e, null);
    return p;
  }

  /** A talk or a shot has the screen: the level's own pan, zoom and taps wait. */
  get holdsInput(): boolean {
    return this.dialog.isOpen || this.cam.busy;
  }

  /** Open a character's dialog, the camera framing them. Resolves when the talk ends and the camera's let go. */
  async talk(id: string): Promise<void> {
    const p = this.placed.get(id);
    if (!p) throw new Error(`story: no character "${id}" on the stage`);
    if (!p.tree) throw new Error(`story: "${id}" has no dialog`);
    if (this.dialog.isOpen || this.cam.busy) return;
    if (!this.canTalk(id)) return;
    this.follow(p);
    const top: V3 = [p.at[0], p.at[1], p.at[2] + p.height * 0.7];
    void this.cam.frame(top);
    await this.dialog.open(p.tree);
    await this.cam.release();
  }

  update(dt: number): void {
    this.run.update(dt);
    this.cam.update(dt);
    const cam = this.d.camera;
    // (the player's place, a few times a second, while no shot has the camera)
    this.look -= dt;
    if (this.look <= 0 && !this.cam.busy && !this.run.over) {
      this.look = 0.25;
      const me = this.d.player?.() ?? (cam.target.slice() as V3);
      if (me) {
        for (const [id, l] of Object.entries(this.d.stage.locations)) {
          const inside = Math.hypot(me[0] - l.at[0], me[1] - l.at[1]) <= l.radius;
          if (inside && !this.reached.has(id)) {
            this.reached.add(id);
            this.run.note({ kind: 'reached', location: id });
          } else if (!inside) this.reached.delete(id);
        }
        // (round 88) its rooms
        for (const [loc, rooms] of Object.entries(this.d.stage.rooms ?? {}))
          for (const [room, r] of Object.entries(rooms)) {
            const key = `${loc}/${room}`;
            const inside = Math.hypot(me[0] - r.at[0], me[1] - r.at[1]) <= r.radius;
            if (inside && !this.reached.has(key)) {
              this.reached.add(key);
              this.run.note({ kind: 'reached', location: loc, room });
            } else if (!inside) this.reached.delete(key);
          }
        this.locks(me);
        this.sightings(me);
      }
    }
    // (round 97) talks opened by outcomes, in turn, once the screen's free and the player is by the speaker (a talk
    // as an event is the speaker addressing them: it waits till they come within SIGHT; one who can't talk now —
    // dead, hostile — is dropped)
    if (this.talks.length && !this.dialog.isOpen && !this.cam.busy && !this.run.over) {
      const me = this.d.player?.() ?? (cam.target.slice() as V3);
      this.talks = this.talks.filter((t) => this.canTalk(t.character));
      const t = this.talks.find((x) => {
        const p = this.placed.get(x.character);
        return !!p && !!me && Math.hypot(me[0] - p.at[0], me[1] - p.at[1]) <= SIGHT;
      });
      if (t) {
        this.talks = this.talks.filter((x) => x !== t);
        void this.talkAt(t.character, t.node);
      }
    }
    this.updateBarks(dt);
    for (const p of this.placed.values()) this.follow(p);
    // the badges over the pillars (hidden while a talk has the screen)
    const talking = this.dialog.isOpen;
    for (const p of this.placed.values()) {
      const by = cam.project(p.at[0], p.at[1], p.at[2])[1];
      const [tx, ty] = cam.project(p.at[0], p.at[1], p.at[2] + p.height);
      const on = !talking && tx > -40 && tx < cam.viewportW + 40 && ty > -40 && by < cam.viewportH + 40;
      p.badge.style.display = on ? '' : 'none';
      if (on) {
        // (the badge's hit area runs from over the pillar down to its foot: the pillar is tappable too)
        const h = Math.max(0, by - ty);
        p.badge.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
        p.badge.style.setProperty('--h', `${h.toFixed(0)}px`);
      }
    }
  }

  /** (round 88) can the player talk to them now: they have a dialog, and (as a unit) are alive and not hostile */
  canTalk(id: string): boolean {
    const p = this.placed.get(id);
    if (!p?.tree) return false;
    if (p.unit === undefined) return true;
    const u = this.d.units!.get(p.unit);
    return !!u && u.alive && !u.hostile;
  }

  /** (round 88) a cast member's unit, if they're units */
  unitOf(id: string): UnitId | undefined {
    return this.placed.get(id)?.unit;
  }

  /** (round 88) the cast member a unit stands for */
  characterOf(unit: UnitId): string | undefined {
    for (const p of this.placed.values()) if (p.unit === unit) return p.id;
    return undefined;
  }

  /** (round 88) the window slid (a streamed world): what the stage keeps in window coordinates moves with it */
  shift(dx: number, dy: number, dz: number): void {
    const st = this.d.stage;
    const mv = (a: [number, number]) => {
      a[0] += dx;
      a[1] += dy;
    };
    for (const l of Object.values(st.locations)) mv(l.at);
    for (const c of Object.values(st.cast)) mv(c.at);
    for (const rs of Object.values(st.rooms ?? {})) for (const r of Object.values(rs)) mv(r.at);
    for (const k of st.locks ?? []) mv(k.at);
    for (const p of this.placed.values()) {
      p.at[0] += dx;
      p.at[1] += dy;
      p.at[2] += dz;
    }
    for (const m of this.marks) {
      m.at[0] += dx;
      m.at[1] += dy;
      m.at[2] += dz;
    }
  }

  /** (round 97) a talk an outcome opened (`Outcome.talk`): at `node` when given */
  private async talkAt(id: string, node?: string): Promise<void> {
    const p = this.placed.get(id);
    if (!p?.tree || this.dialog.isOpen || this.cam.busy) return;
    this.follow(p);
    void this.cam.frame([p.at[0], p.at[1], p.at[2] + p.height * 0.7]);
    await this.dialog.open(p.tree, node);
    await this.cam.release();
  }

  /** (round 97) who and what's come into sight: `saw`, once each (a cast member alive; a place within SIGHT of its edge) */
  private sightings(me: V3): void {
    for (const p of this.placed.values()) {
      const key = `c:${p.id}`;
      if (this.seen.has(key) || Math.hypot(me[0] - p.at[0], me[1] - p.at[1]) > SIGHT) continue;
      if (p.unit !== undefined && !this.d.units!.get(p.unit)?.alive) continue;
      this.seen.add(key);
      this.run.note({ kind: 'saw', character: p.id });
    }
    for (const [id, l] of Object.entries(this.d.stage.locations)) {
      const key = `l:${id}`;
      if (this.seen.has(key) || Math.hypot(me[0] - l.at[0], me[1] - l.at[1]) > l.radius + SIGHT) continue;
      this.seen.add(key);
      this.run.note({ kind: 'saw', location: id });
    }
  }

  /** (round 97) a bark: over its speaker while they're on the screen, else (and the narrator's) through `say` */
  bark(b: Bark): void {
    const seconds = b.seconds ?? 4;
    const who = b.by && this.d.story.cast.find((c) => c.id === b.by);
    if (!who || !this.placed.has(who.id)) return void this.d.say?.(b.line);
    const el = document.createElement('div');
    el.className = 'story-bark';
    el.style.setProperty('--c', this.d.stage.cast[who.id]?.colour ?? '#f1ebdd');
    el.innerHTML = '<span class="l"><b class="w"></b><span class="t"></span></span>';
    el.querySelector('.w')!.textContent = who.name;
    el.querySelector('.t')!.textContent = b.line;
    this.layer.append(el);
    this.barks.push({ el, by: who.id, t: seconds });
  }

  private updateBarks(dt: number): void {
    const cam = this.d.camera;
    for (const m of this.marks) {
      const [x, y] = cam.project(...m.at);
      const on = x > -60 && x < cam.viewportW + 60 && y > -20 && y < cam.viewportH + 20;
      m.el.style.display = on ? '' : 'none';
      if (on) m.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
    for (const b of this.barks) {
      b.t -= dt;
      const p = this.placed.get(b.by)!;
      const [x, y] = cam.project(p.at[0], p.at[1], p.at[2] + p.height + 0.6);
      const on = x > 0 && x < cam.viewportW && y > 0 && y < cam.viewportH && !this.dialog.isOpen;
      b.el.style.display = on ? '' : 'none';
      if (on) b.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      b.el.classList.toggle('out', b.t < 0.4);
      if (b.t <= 0) b.el.remove();
    }
    this.barks = this.barks.filter((b) => b.t > 0);
  }

  /** a unit's cast member stands where their unit is */
  private follow(p: Placed): void {
    if (p.unit === undefined) return;
    const u = this.d.units!.get(p.unit);
    if (!u) return;
    p.at = u.at;
    p.badge.classList.toggle('foe', u.hostile);
  }

  /** (round 88) a locked doorway the player comes to: opened with its key, else they're told what it needs */
  private locks(me: V3): void {
    for (const k of this.d.stage.locks ?? []) {
      if (k.open || Math.hypot(me[0] - k.at[0], me[1] - k.at[1]) > 4.5) continue;
      const has =
        (k.key.item !== undefined && this.run.has(k.key.item) > 0) ||
        (k.key.character !== undefined && this.run.holds({ kind: 'talked', character: k.key.character })) ||
        (k.key.objective !== undefined && this.run.holds({ kind: 'objective', id: k.key.objective, state: 'done' }));
      if (has) {
        k.open = true;
        const t = this.d.api.terrain;
        // (only the plug: each column under it whose top is the lock's material loses that — a dig would take the
        // floor round it too, and leave a pit too deep to climb back out of)
        if (t)
          for (let dy = -3.2; dy <= 3.2; dy += 0.7)
            for (let dx = -3.2; dx <= 3.2; dx += 0.7) {
              const x = k.at[0] + dx;
              const y = k.at[1] + dy;
              if (dx * dx + dy * dy <= 10.5 && t.materialAt(x, y) === k.material) void t.take(x, y, 12);
            }
        this.d.api.fx?.burst('dust', k.at[0], k.at[1], (t?.heightAt(k.at[0], k.at[1]) ?? me[2]) + 1, { count: 30 });
        this.d.say?.(`${k.key.item ? `The ${k.key.item} turns` : 'It opens'}: the ${k.id.replace(/-/g, ' ')} gives way`);
      } else {
        const now = performance.now();
        if (now - (this.lockSaid.get(k.id) ?? -1e9) < 6000) continue;
        this.lockSaid.set(k.id, now);
        const who = (id: string) => this.d.story.cast.find((c) => c.id === id)?.name ?? id;
        const need = k.key.item ? `the ${k.key.item}` : k.key.character ? `a word with ${who(k.key.character)}` : 'something done first';
        this.d.say?.(`The ${k.id.replace(/-/g, ' ')} is shut. It needs ${need}.`);
      }
    }
  }

  dispose(): void {
    this.dialog.dispose();
    this.hud.dispose();
    this.layer.remove();
    this.card?.remove();
    this.barks = [];
  }

  /** a staged location's point (its ground) */
  private where(location: string): V3 {
    const l = this.d.stage.locations[location];
    if (!l) throw new Error(`story: location "${location}" isn't on the stage`);
    const z = this.d.api.terrain?.heightAt(l.at[0], l.at[1]) ?? this.d.camera.target[2];
    return [l.at[0], l.at[1], z];
  }

  /** where an outcome happened: its objective's location, or the speaker of the dialog that caused it */
  private causeAt(cause: string): V3 | null {
    const o = this.d.story.objectives.find((x) => x.id === cause);
    if (o?.location) return this.where(o.location);
    const tree = this.d.story.dialogs.find((x) => cause.startsWith(`${x.id}/`));
    if (tree) return this.placed.get(tree.speaker)!.at;
    return null;
  }

  /** what of an outcome can be seen now, at play scale */
  private realise(o: Outcome, cause: string): void {
    const api = this.d.api;
    const units = this.d.units;
    // (round 88) cast members turned on the player; units appearing
    for (const c of o.hostile ?? []) {
      const u = this.placed.get(c)?.unit;
      if (u !== undefined && units) units.setHostile(u, true);
    }
    if (units)
      for (const sp of o.spawn ?? []) {
        // (round the speaker, when a talk at that place set it off; else in the place's way in)
        const tree = this.d.story.dialogs.find((x) => cause.startsWith(`${x.id}/`));
        const speaker = tree && this.d.story.cast.find((c) => c.id === tree.speaker && c.location === sp.location);
        const first = this.d.story.locations.find((l) => l.id === sp.location)?.brief.rooms?.[0]?.id;
        const room = first ? this.d.stage.rooms?.[sp.location]?.[first] : undefined;
        const c = speaker ? this.placed.get(speaker.id)!.at : room ? room.at : this.where(sp.location);
        const n = sp.count ?? 1;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + 0.4;
          const r = speaker ? 3 : Math.min(3, (room?.radius ?? 4) * 0.6);
          const at: [number, number] = [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
          const z = api.terrain?.heightAt(at[0], at[1]);
          if (z === null || z === undefined) continue;
          const id = units.spawn(sp.role, at, sp.faction, { role: sp.role, hostile: !!sp.hostile, health: 2, sight: 11, speed: 2.4 });
          // (round 97) on their way somewhere (the dead walking down to the town)
          if (sp.toward) {
            const to = this.where(sp.toward);
            units.order(id, { kind: 'go', to: [to[0], to[1]] });
          }
          api.fx?.burst('dust', at[0], at[1], z + 0.5, { count: 12 });
        }
      }
    // (round 97) barks, and a talk as an event (opened once the screen's free)
    for (const b of o.say ?? []) this.bark(b);
    if (o.talk) this.talks.push(o.talk);
    for (const e of o.atlas ?? []) this.realiseEvent(e, cause);
  }

  /** an AtlasEvent's play-scale stand-in, where it happened (cause: why, to place one without a location; null: from the history) */
  private realiseEvent(e: Omit<AtlasEvent, 'id' | 'run'>, cause: string | null): void {
    const api = this.d.api;
    const place = placeOf(e);
    const at: V3 | null = e.area
      ? [e.area.at[0], e.area.at[1], api.terrain?.heightAt(e.area.at[0], e.area.at[1]) ?? 0]
      : place && this.d.stage.locations[place]
        ? this.where(place)
        : cause !== null
          ? this.causeAt(cause)
          : null;
    if (!at) return;
    const r = e.area?.radius ?? 8;
    if (!play(e.kind)) return;
    {
      switch (e.kind) {
        case 'overgrow':
          api.plants?.grow(at[0], at[1], { radius: r, strength: 30 + 60 * e.magnitude });
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            api.fx?.burst('petals', at[0] + Math.cos(a) * r * 0.5, at[1] + Math.sin(a) * r * 0.5, at[2] + 2, { count: 24 });
          }
          api.fx?.burst('seeds', at[0], at[1], at[2] + 3, { count: 30, spread: r * 0.4 });
          break;
        case 'flood':
          api.water?.flood(at[0], at[1], { radius: r, depth: 1 + 2 * e.magnitude });
          break;
        case 'mark': {
          api.terrain?.build(at[0] + 2, at[1] + 2, 'plaster', { radius: 1, layers: 3 });
          // (round 97) and its name over it, so the world's marks read as such ("The Bellwarden's Grave")
          const name = e.detail?.name ? String(e.detail.name) : null;
          if (name) {
            const el = document.createElement('div');
            el.className = 'story-mark';
            el.textContent = name;
            this.layer.append(el);
            this.marks.push({ el, at: [at[0] + 2, at[1] + 2, at[2] + 3] });
          }
          break;
        }
      }
    }
  }

  private endCard(r: RunRecord): void {
    const el = document.createElement('div');
    el.className = 'story-end';
    const title = { won: 'The run is won', lost: 'The run is lost', fled: 'You fled', abandoned: 'Abandoned' }[r.end];
    el.innerHTML = `<h2></h2><p class="sub">What the world will remember</p><ul></ul><p class="ev"></p><button>Go on</button>`;
    el.querySelector('h2')!.textContent = title;
    const ul = el.querySelector('ul')!;
    for (const d of r.deeds) {
      const li = document.createElement('li');
      li.textContent = d;
      ul.append(li);
    }
    el.querySelector('.ev')!.textContent = r.events.length ? `${r.events.length} change${r.events.length === 1 ? '' : 's'} to the world: ${r.events.map(describe).join('; ')}` : 'The world is as it was.';
    el.querySelector('button')!.addEventListener('click', () => el.remove());
    if (this.d.again) {
      const b = document.createElement('button');
      b.textContent = 'Start a new run';
      b.addEventListener('click', () => this.d.again!());
      el.append(b);
    }
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.d.ui.append(el);
    this.card = el;
  }
}

/** The story location an AtlasEvent names (`location`: where in its region it's seen; run/validate.ts checks it). */
const placeOf = (e: Omit<AtlasEvent, 'id' | 'run'>): string | undefined => e.location;

/** the AtlasEvent kinds with a play-scale stand-in here */
const play = (k: AtlasEvent['kind']) => k === 'overgrow' || k === 'flood' || k === 'mark';

function describe(e: AtlasEvent): string {
  const name = e.detail?.name ? ` "${String(e.detail.name)}"` : '';
  return `${e.kind}${name} (region ${e.regions.join(', ')}, ${e.magnitude})`;
}
