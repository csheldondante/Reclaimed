// (loop round 16; DECISIONS 2026-11-17) News comes with a person. The owner: "It would be cool to have camera zoom in
// and show a person arrive with news instead of a random point on the map"; "Even better would be an event like a rider
// or advisors that make the exposition more diagetic."
//
// A messenger is one unit (the Units contract: spawned on a road into the town, ordered to go to a place of the town,
// observed while it walks) that the story camera follows in at a zoom where the figure is seen, and whose words then
// show in a panel with their name, a few lines at a time. It is short on purpose: the walk starts about WALK cells out,
// at a runner's pace, so it lasts under 6 s; the panel shows from the start ("… is coming"), and one tap on Skip ends it
// at any time. A tap on the panel turns the page. When the words are done the figure is taken away and the camera goes
// back to the town.
//
// The game decides who comes and what they say (scenes/level/loop.ts): the run's opening and each season's news by an
// advisor of the leader (season/run-words.ts ADVISORS), a new ask by its petitioner, far news by a rider down the road
// that faces the far place.
import type { Units, UnitId } from '../../api/contracts/units';
import type { StoryCamera, V3 } from '../../story/camera';

/**
 * (loop round 17; the owner 2026-11-17: "Horses and carts would be really cool. (Ships too).") How the messenger comes:
 * on foot (the leader's own people), on a horse (a rider from a far place), by cart (trade news, a merchant), or by ship
 * (to the quay, the town has a harbour: they come ashore there and walk up — no ship unit is drawn for them; the
 * town's own ships moor at the same quay). `role`: the units' kind (agent-units.ts kindOf: 'rider' the horse, 'cart');
 * `out`: cells out along the road they start, so the arrival takes under WALK_MAX s at the kind's pace (rider 6,
 * character 2.5, cart 1.7 cells/s).
 */
export type Mount = 'foot' | 'horse' | 'cart' | 'ship';
const MOUNTS: Record<Mount, { role?: string; out: number }> = {
  // (loop round 18: measured in sim time — foot 2.5, horse 5.5, cart 1.7 cells/s once the field reaches them — so the
  // walk is ~4.5 s at each pace)
  foot: { out: 11 },
  horse: { role: 'rider', out: 24 },
  cart: { role: 'cart', out: 7 },
  ship: { out: 6 },
};
/** a runner's pace, cells a second (the kind's pace class only: units.ts SpawnOpts.speed) */
const PACE = 5;
/** seconds the walk may take before the words show anyway */
const WALK_MAX = 6;
/** close enough to have arrived (cells) */
const THERE = 3;
/** the camera's zoom on the messenger: the figure a few storeys of pixels tall at phone size */
export const MESSENGER_ZOOM = 11;
/** lines a page */
const PAGE = 3;

export interface Speech {
  name: string;
  role: string;
  lines: string[];
}

export interface MessengerHost {
  units: () => Units | null;
  cam: StoryCamera;
  z: (x: number, y: number) => number;
  ui: HTMLElement;
}

const CSS = `
.run-say{position:absolute;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:36;background:rgba(22,24,28,.95);color:#f2efe8;font:15px system-ui,sans-serif;border-radius:14px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;border:2px solid #e8b84a;box-sizing:border-box}
.run-say .who{font-weight:700;font-size:15px;color:#f2e3b0}
.run-say .who i{font-style:normal;font-weight:400;color:#c8c8c8;font-size:13px;margin-left:6px}
.run-say p{margin:0;line-height:1.35}
.run-say .row{display:flex;gap:8px;align-items:center}
.run-say .row span{flex:1;font-size:12px;color:#aaa}
.run-say button{min-height:46px;min-width:88px;font:700 15px system-ui;border-radius:10px;border:0;background:#e8b84a;color:#221;padding:8px 14px}
.run-say button.quiet{background:#3a3f4a;color:#eee}
`;

export class Messenger {
  private el: HTMLElement | null = null;
  private style: HTMLStyleElement | null = null;
  private unit: UnitId | null = null;
  private unwatch: (() => void) | null = null;
  private done: (() => void) | null = null;
  private t = 0;
  private to: [number, number] = [0, 0];
  private speech: Speech | null = null;
  private page = -1;
  /** walking in, speaking, or null: none */
  state: 'walking' | 'speaking' | null = null;

  constructor(private h: MessengerHost) {}

  get busy(): boolean {
    return this.state !== null;
  }

  /**
   * A messenger along `road` (window points from the town outward) to `to`, saying `speech`. Resolves once their words
   * are done or skipped. With no road (or no units) they are already there: the words show at once over `to`.
   */
  bring(speech: Speech, road: [number, number][] | null, to: [number, number], how: Mount = 'foot', quay: [number, number] | null = null): Promise<void> {
    this.end();
    this.speech = speech;
    this.to = to;
    this.t = 0;
    this.page = -1;
    this.mount();
    const units = this.h.units();
    const m = MOUNTS[how];
    // (by ship: ashore at the quay, a few cells toward where they are going)
    const from = how === 'ship' && quay ? toward(quay, to, 1) : road ? startOn(road, to, m.out) : null;
    if (units && from) {
      this.unit = units.spawn('character', from, null, { name: speech.name, role: m.role, speed: PACE, colour: '#ffd23c', job: { kind: 'go', to } });
      this.unwatch = units.observe(this.unit);
      this.state = 'walking';
      // (by ship: the camera first over the quay, the water behind)
      const look = how === 'ship' && quay ? quay : from;
      void this.h.cam.look(this.at3(look), { zoom: MESSENGER_ZOOM, ease: 0.7, place: [0.5, 0.42] }).then(() => {
        if (this.state === 'walking') this.h.cam.follow(() => this.where());
      });
      console.log(`[messenger] ${speech.name} (${speech.role}, ${how}) from ${from.map(Math.round).join(', ')} to ${to.map(Math.round).join(', ')}: ${speech.lines.length} lines`);
    } else {
      void this.h.cam.look(this.at3(to), { zoom: MESSENGER_ZOOM, ease: 0.7, place: [0.5, 0.42] });
      console.log(`[messenger] ${speech.name} (${speech.role}) at ${to.map(Math.round).join(', ')} (no road): ${speech.lines.length} lines`);
      this.speak();
    }
    this.draw();
    return new Promise((res) => (this.done = res));
  }

  /** each frame: the walk timed, the words shown on arrival */
  update(dt: number): void {
    if (this.state !== 'walking') return;
    this.t += dt;
    const p = this.where();
    if (this.t >= WALK_MAX || (p && Math.hypot(p[0] - this.to[0], p[1] - this.to[1]) < THERE)) this.speak();
  }

  /** everything said at once: the messenger gone, the camera the player's */
  skip(): void {
    if (this.state) console.log(`[messenger] skipped`);
    this.end();
  }

  /** the window slid (WorldCore.onShift): points move with the land */
  shift(dx: number, dy: number): void {
    this.to = [this.to[0] - dx, this.to[1] - dy];
  }

  /** the messenger's name, and where they stand now (null: not walking, or not yet read) — a ring is drawn round them */
  get walker(): { name: string; at: V3 } | null {
    const at = this.where();
    return this.speech && at ? { name: this.speech.name, at } : null;
  }

  private where(): V3 | null {
    const u = this.unit !== null ? this.h.units()?.get(this.unit) : null;
    return u?.at ?? null;
  }

  private at3(p: [number, number]): V3 {
    return [p[0], p[1], this.h.z(p[0], p[1])];
  }

  private speak(): void {
    this.state = 'speaking';
    this.page = 0;
    this.draw();
  }

  private next(): void {
    if (this.state !== 'speaking' || !this.speech) return;
    if ((this.page + 1) * PAGE >= this.speech.lines.length) return this.end();
    this.page++;
    this.draw();
  }

  private mount(): void {
    if (!this.style) {
      this.style = document.createElement('style');
      this.style.textContent = CSS;
      this.h.ui.append(this.style);
    }
    this.el = document.createElement('div');
    this.el.className = 'run-say';
    this.el.onclick = (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      this.next();
    };
    this.h.ui.append(this.el);
  }

  private draw(): void {
    const s = this.speech;
    const el = this.el;
    if (!s || !el) return;
    el.replaceChildren();
    const who = document.createElement('div');
    who.className = 'who';
    who.append(s.name);
    const role = document.createElement('i');
    role.textContent = s.role;
    who.append(role);
    el.append(who);
    const lines = this.state === 'speaking' ? s.lines.slice(this.page * PAGE, (this.page + 1) * PAGE) : [comingLine(s.role)];
    for (const t of lines) {
      const p = document.createElement('p');
      p.textContent = t;
      el.append(p);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const more = this.state === 'speaking' && (this.page + 1) * PAGE < s.lines.length;
    const hint = document.createElement('span');
    hint.textContent = more ? 'Tap for more' : '';
    row.append(hint);
    const b = document.createElement('button');
    if (this.state === 'speaking' && !more) {
      b.textContent = 'Done';
      b.onclick = () => this.end();
    } else {
      b.textContent = 'Skip';
      b.className = 'quiet';
      b.onclick = () => this.skip();
    }
    row.append(b);
    el.append(row);
  }

  private end(): void {
    const was = this.state !== null || this.el !== null;
    this.state = null;
    this.unwatch?.();
    this.unwatch = null;
    if (this.unit !== null) this.h.units()?.remove(this.unit);
    this.unit = null;
    this.el?.remove();
    this.el = null;
    if (was) this.h.cam.follow(null);
    const d = this.done;
    this.done = null;
    d?.();
  }
}

/** what the panel says while they walk in */
const comingLine = (role: string): string => `The ${role} is coming with news.`;

/** `d` cells from `a` toward `b` */
const toward = (a: [number, number], b: [number, number], d: number): [number, number] => {
  const L = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-3);
  return [a[0] + ((b[0] - a[0]) / L) * d, a[1] + ((b[1] - a[1]) / L) * d];
};

/** where on a road (window points, the town outward) a messenger starts: `out` cells farther out than `to`, or the
 *  road's last point */
function startOn(road: [number, number][], to: [number, number], out: number): [number, number] | null {
  if (road.length < 2) return null;
  const c = road[0];
  const want = Math.hypot(to[0] - c[0], to[1] - c[1]) + out;
  for (const p of road) if (Math.hypot(p[0] - c[0], p[1] - c[1]) >= want) return [p[0], p[1]];
  const last = road[road.length - 1];
  return [last[0], last[1]];
}
