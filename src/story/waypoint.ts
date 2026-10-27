// ---- story/waypoint.ts ----------------------------------------------------------
// Where to go now (round 94; the user, on the phone: "I don't know which direction to walk... You could also add
// an indicator of where to go"). Read from the story's own objective data, never a story's names:
// - `objectiveTarget`: the first shown objective's target. What its `done` conditions name — a person to talk to
//   or kill (`talked`, `killed`), a place or room to reach (`reached`) — else, for an objective that only waits
//   on a flag (stop the dead), the person at its location who has something to say, else the location. A
//   target behind a shut lock is the lock's door instead (with what opens it).
// - `Waypoint`: on the screen, a marker over the target when it's in view; an arrow at the screen's edge
//   pointing to it, with the distance, when it isn't.
// - `describe`: "north-east · 140 m" — the atlas map's compass (north is world −y, east −x: the map draws +x to
//   the left) and a cell taken as a metre.

import type { Condition, SessionStory } from '../api/contracts/story';
import type { Units } from '../api/contracts/units';
import type { Camera } from '../render/camera';
import type { StoryRun } from '../run/run';
import type { Stage } from './play';
import './waypoint.css';

type V3 = [number, number, number];

export interface Target {
  objective: string;
  kind: 'person' | 'place' | 'door';
  /** what it's called on the screen and the map ("Reeve Hesk Marr", "Mebe", "the bone door") */
  name: string;
  /** where it is (window x, y; z the ground's or the person's) */
  at: V3;
  /** a person's place ("Mebe"): the objective's line says it */
  place?: string;
  /** a door: what opens it, when the player hasn't got it */
  needs?: string;
}

export interface TargetDeps {
  story: SessionStory;
  run: StoryRun;
  stage: Stage;
  units: Units;
  /** the cast member's unit (StoryPlay.unitOf) */
  unitOf: (character: string) => number | undefined;
  heightAt: (x: number, y: number) => number | null;
}

/** the current objective's target, or null (nothing shown, or nothing to point at) */
export function objectiveTarget(d: TargetDeps): Target | null {
  const { story, run, stage } = d;
  const shown = run.objectives().find((o) => o.state === 'shown');
  if (!shown) return null;
  const o = run.objective(shown.id);
  const conds = flatten(o.done);
  const z = (x: number, y: number) => d.heightAt(x, y) ?? 0;
  const person = (id: string): Target | null => {
    const u = d.unitOf(id);
    const v = u === undefined ? null : d.units.get(u);
    const c = story.cast.find((x) => x.id === id);
    if (!v || !v.alive || !c) return null;
    const where = story.locations.find((l) => l.id === c.location)?.name;
    return behindLock({ objective: o.id, kind: 'person', name: c.name, place: where, at: [...v.at] as V3 }, c.location, c.room ?? firstRoom(c.location));
  };
  const place = (location: string, room?: string): Target | null => {
    const l = story.locations.find((x) => x.id === location);
    const r = room ? stage.rooms?.[location]?.[room] : undefined;
    const p = r?.at ?? stage.locations[location]?.at;
    if (!l || !p) return null;
    const name = room ? `the ${roomName(l.brief.rooms?.find((x) => x.id === room)?.kind ?? room)}, ${l.name}` : l.name;
    return behindLock({ objective: o.id, kind: 'place', name, at: [p[0], p[1], z(p[0], p[1])] }, location, room);
  };
  const firstRoom = (location: string) => story.locations.find((l) => l.id === location)?.brief.rooms?.[0]?.id;
  // (a shut door between the player and where they're going: the door is where to go first)
  const behindLock = (t: Target, location: string, room: string | undefined): Target => {
    const k = room ? stage.locks?.find((x) => !x.open && x.location === location && x.room === room) : undefined;
    if (!k) return t;
    const has = (k.key.item !== undefined && run.has(k.key.item) > 0) || (k.key.character !== undefined && run.holds({ kind: 'talked', character: k.key.character })) || (k.key.objective !== undefined && run.holds({ kind: 'objective', id: k.key.objective, state: 'done' }));
    return { objective: t.objective, kind: 'door', name: `the ${k.id.replace(/-/g, ' ')}`, at: [k.at[0], k.at[1], z(k.at[0], k.at[1])], needs: has ? undefined : (k.key.item ?? k.key.character ?? k.key.objective) };
  };
  for (const c of conds) {
    if (c.kind === 'talked' || (c.kind === 'killed' && c.character)) {
      const t = person(c.character!);
      if (t) return t;
    } else if (c.kind === 'reached') {
      const t = place(c.location, c.room);
      if (t) return t;
    }
  }
  // (only a flag to wait on: whoever at its place has something to say, else the place)
  if (o.location) {
    for (const c of story.cast)
      if (c.location === o.location && story.dialogs.some((t) => t.speaker === c.id)) {
        const t = person(c.id);
        if (t) return t;
      }
    return place(o.location);
  }
  return null;
}

function flatten(cs: readonly Condition[]): Condition[] {
  return cs.flatMap((c) => (c.kind === 'any' ? flatten(c.of) : [c]));
}

const roomName = (kind: string) => kind.toLowerCase();

const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** "north-east · 140 m" from `from` to `to` (window coordinates; north world −y, east world −x) */
export function describe(from: V3, to: V3): string {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const d = Math.hypot(dx, dy);
  if (d < 6) return 'here';
  // (clockwise from north: east is −x on the atlas map)
  const bearing = Math.atan2(-dx, -dy);
  const k = (((Math.round(bearing / (Math.PI / 4)) % 8) + 8) % 8);
  return `${DIRS[k]} · ${Math.round(d / 5) * 5} m`;
}

/** On the screen: a marker over the target in view, an arrow at the edge pointing to it when not. */
export class Waypoint {
  private marker: HTMLDivElement;
  private arrow: HTMLDivElement;
  private label: HTMLDivElement;

  constructor(ui: HTMLElement) {
    this.marker = document.createElement('div');
    this.marker.className = 'wp-marker';
    this.marker.innerHTML = '<span class="wp-chev"></span><span class="wp-name"></span>';
    this.arrow = document.createElement('div');
    this.arrow.className = 'wp-arrow';
    this.arrow.innerHTML = '<span class="wp-tip"></span>';
    this.label = document.createElement('div');
    this.label.className = 'wp-dist';
    ui.append(this.marker, this.arrow, this.label);
    this.hide();
  }

  hide(): void {
    this.marker.style.display = this.arrow.style.display = this.label.style.display = 'none';
  }

  /** each frame: the target (null: none), the player, the camera */
  update(t: Target | null, me: V3, cam: Camera): void {
    if (!t) return this.hide();
    const W = cam.viewportW;
    const H = cam.viewportH;
    const [sx, sy] = cam.project(t.at[0], t.at[1], t.at[2] + (t.kind === 'person' ? 3.2 : 2));
    const m = 36;
    // (the bottom of the screen is the controls': the arrow keeps above them)
    const top = 64;
    const bottom = H - 200;
    const onScreen = sx > m && sx < W - m && sy > top && sy < bottom;
    const name = this.marker.querySelector('.wp-name')!;
    const text = t.needs ? `${t.name} · needs the ${t.needs}` : t.name;
    if (onScreen) {
      this.arrow.style.display = this.label.style.display = 'none';
      this.marker.style.display = '';
      if (name.textContent !== text) name.textContent = text;
      this.marker.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px)`;
      return;
    }
    this.marker.style.display = 'none';
    // the arrow: where the line from the screen's middle to the target leaves the box
    const cx = W / 2;
    const cy = (top + bottom) / 2;
    const dx = sx - cx;
    const dy = sy - cy;
    const k = Math.min((W / 2 - m) / Math.max(1e-3, Math.abs(dx)), ((bottom - top) / 2) / Math.max(1e-3, Math.abs(dy)));
    const ax = cx + dx * k;
    const ay = cy + dy * k;
    const ang = Math.atan2(dy, dx);
    this.arrow.style.display = this.label.style.display = '';
    this.arrow.style.transform = `translate(${ax.toFixed(0)}px, ${ay.toFixed(0)}px) rotate(${ang.toFixed(3)}rad)`;
    const d = Math.hypot(t.at[0] - me[0], t.at[1] - me[1]);
    const lt = `${Math.round(d / 5) * 5} m`;
    if (this.label.textContent !== lt) this.label.textContent = lt;
    // (the distance just inside the arrow)
    this.label.style.transform = `translate(${(ax - Math.cos(ang) * 40).toFixed(0)}px, ${(ay - Math.sin(ang) * 40).toFixed(0)}px)`;
  }

  dispose(): void {
    this.marker.remove();
    this.arrow.remove();
    this.label.remove();
  }
}
