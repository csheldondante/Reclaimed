// (board, docs/design/BOARD.md) The town drawn: the ground baked once, the land's scars as tiles over it (each with a
// short arrival — ash spreading from a site, water rising over the low ground first, lava creeping from the mountain),
// buildings by what the model says stands (rising from the ground when they are done), figures on the roads, and the
// markers for what can be acted on. It holds no game state: `set(state)` gives it the model's reading.
import type { SiteKey } from '../season/realm-templates';
import { dist, idx, inside, roadPath, T, townLayout, type Cell, type Layout } from './layout';
import type { Scar, Sign } from './looks';
import type { BoardState } from './model';
import { ACT, BAKE, C, FOE, HH, HW, sprite, tileSprite, type Sprite } from './sprites';
import { tileXY, toScreen, type Camera } from './view';

export type Action =
  | { kind: 'offer'; id: string }
  | { kind: 'live'; id: string }
  | { kind: 'site'; key: SiteKey }
  | { kind: 'post'; work: string; piece: 'crew' | 'soldier' };

interface Hit {
  x: number;
  y: number;
  r: number;
  act: Action;
  /** lower is tried first */
  pri: number;
}

type Overlay = 'ash' | 'flood' | 'lavarock' | 'lava' | 'mud' | 'lush' | 'dry' | 'ruin';
const SCAR_TILE: Record<Scar, Overlay> = { burned: 'ash', flooded: 'flood', melted: 'lavarock', buried: 'mud', abandoned: 'ruin', destroyed: 'ruin', occupied: 'ruin', lost: 'ruin', greened: 'lush', withered: 'dry', dried: 'dry' };
const tileOf = (o: Overlay): Sprite =>
  o === 'ash' ? tileSprite('ash', C.ash, C.ash2, 'dots') : o === 'flood' ? tileSprite('flood', C.flood, '#8fb8cc', 'waves') : o === 'lavarock' ? tileSprite('lavarock', C.lavaCrust, C.lava, 'cracks') : o === 'lava' ? tileSprite('lava', C.lava, '#ffd04a', 'cracks') : o === 'mud' ? tileSprite('mud', C.mud, '#6a5a44', 'dots') : o === 'lush' ? tileSprite('lush', C.lush, '#3f7a2e', 'dots') : o === 'dry' ? tileSprite('dry', C.dry, '#7a6d4c', 'dots') : tileSprite('ruin', '#6c6862', '#5a5650', 'dots');

const BASE_TILE: Record<number, () => Sprite> = {
  [T.Grass]: () => tileSprite('grass', C.grass, C.grass2, 'dots'),
  [T.Rock]: () => tileSprite('rock', C.rock, C.rock2, 'cracks'),
  [T.Water]: () => tileSprite('water', C.water, C.water2, 'waves'),
  [T.Field]: () => tileSprite('field', C.field, C.field2, 'furrows'),
  [T.Forest]: () => tileSprite('forestfloor', '#59683f', '#4f5e38', 'dots'),
  [T.Road]: () => tileSprite('road', C.road, '#958870', 'dots'),
  [T.Bridge]: () => tileSprite('bridge', C.wood, C.woodL, 'furrows'),
  [T.Sand]: () => tileSprite('sand', C.sand, '#9d906e', 'dots'),
};

/** the look of a site's base building (before or without packs) */
function baseSprite(key: SiteKey, built: string | null): string | null {
  const b = !!built;
  const m: Record<SiteKey, string | null> = {
    keep: b ? 'keep' : 'keep-yard',
    forge: b ? 'forge' : 'forge-shed',
    quarter: b ? 'houses' : 'houses-few',
    fields: b ? 'barn' : null,
    market: b ? 'market' : 'carts',
    gate: b ? 'gate' : 'gate-posts',
    tower: 'tower-old',
    dam: 'dam',
    shrine: 'shrine-stone',
    mill: 'mill',
    wall: null,
    watch: 'hut',
    harbour: b ? 'quay' : 'jetty',
    quarry: b ? 'quarry' : 'quarry-rock',
    woods: b ? 'lumber' : 'trees',
    river: null,
    road: b ? 'waystation' : 'milestone',
    pit: 'ore-heap',
    wagons: 'wagons',
    graves: 'graves',
  };
  return m[key];
}
/** the catalog card a site's base building is built by (season/realm-rules.ts SITE_TAGS) */
const CATALOG_SITE: Record<string, SiteKey> = { keep: 'keep', workshops: 'forge', houses: 'quarter', farms: 'fields', market: 'market', walls: 'gate', harbour: 'harbour', quarry: 'quarry', lumber: 'woods', trade: 'road' };
const THING_SPRITE: Record<string, string> = { 'works-mine': 'mine', 'works-stalls': 'stalls', 'works-shrine': 'shrine', 'works-foundry': 'foundry', 'works-muster': 'muster', 'works-granary': 'granary', 'works-watchtower': 'watchtower', 'works-wall-walk': 'wall-walk' };

interface Placed {
  key: string;
  name: string;
  cell: Cell;
  /** 0..1 built (1: standing) */
  progress: number;
  site: SiteKey;
}

interface Fig {
  key: string;
  look: string;
  /** world pixels */
  x: number;
  y: number;
  path: [number, number][];
  speed: number;
  mode: 'walk' | 'work' | 'stand' | 'leave' | 'wander';
  phase: number;
  /** a line said over its head */
  say?: string;
  until?: number;
  onArrive?: () => void;
}

export interface FlyText {
  text: string;
  color: string;
  from: [number, number];
  to: [number, number] | null;
  t0: number;
  dur: number;
}

/** a card's title cut to fit over a marker */
const short = (t: string): string => (t.length > 22 ? `${t.slice(0, 20).trimEnd()}…` : t);

const hash = (n: number): number => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

export class TownScene {
  readonly l: Layout = townLayout();
  private ground: OffscreenCanvas | HTMLCanvasElement;
  private readonly g0: [number, number];
  state: BoardState | null = null;
  /** cells under a scar: the overlay and when it arrives (ms) */
  private overlays = new Map<number, { o: Overlay; at: number }>();
  /** buildings drawn: key → when it began to rise (ms), for the rise from the ground */
  private placed: Placed[] = [];
  private riseAt = new Map<string, number>();
  figs: Fig[] = [];
  fly: FlyText[] = [];
  bursts: { x: number; y: number; t0: number; color: string }[] = [];
  /** live lava fronts: cells along the way and how many are reached */
  lavaFront: { cells: Cell[]; reached: number; t0: number } | null = null;
  armed: 'crew' | 'soldier' | null = null;
  /** the site picked (its sheet open) */
  focus: SiteKey | null = null;
  private hits: Hit[] = [];
  private secondary = new Map<SiteKey, Cell[]>();
  /** while true, figures are not reconciled (the raid moves its own) */
  paused = false;
  folkCount = 0;

  constructor() {
    const n = this.l.n;
    // (the ground: one canvas, world x from -n*HW to n*HW, y from -HH to 2n*HH)
    const W = 2 * n * HW;
    const H = 2 * n * HH + 2 * HH;
    const s = 1.25;
    this.ground = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W * s, H * s) : Object.assign(document.createElement('canvas'), { width: W * s, height: H * s });
    this.g0 = [-n * HW, -HH];
    const g = this.ground.getContext('2d') as CanvasRenderingContext2D;
    g.scale(s, s);
    g.translate(-this.g0[0], -this.g0[1]);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const sp = BASE_TILE[this.l.tiles[idx(x, y)]]();
        const [wx, wy] = tileXY(x, y);
        g.drawImage(sp.img, wx - sp.ax, wy - sp.ay, sp.w, sp.h);
      }
    // (secondary cells per site: room beside a site for a second thing, off the roads)
    const siteSet = new Set(Object.values(this.l.sites).map((c) => idx(c.x, c.y)));
    for (const [k, c] of Object.entries(this.l.sites) as [SiteKey, Cell][]) {
      const out: Cell[] = [];
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const x = c.x + dx;
        const y = c.y + dy;
        if (!inside(x, y)) continue;
        const t = this.l.tiles[idx(x, y)];
        if (t === T.Road || t === T.Water || t === T.Bridge || siteSet.has(idx(x, y))) continue;
        out.push({ x, y });
      }
      this.secondary.set(k, out);
    }
  }

  /** the world point of a site (its main cell's centre) */
  siteXY(k: SiteKey): [number, number] {
    const c = this.l.sites[k];
    return tileXY(c.x, c.y);
  }
  /** the world bounds of the town */
  bounds(): [number, number, number, number] {
    const n = this.l.n;
    return [-n * HW * 0.85, 0, n * HW * 0.85, 2 * n * HH];
  }

  // ---- state ----------------------------------------------------------------------------------------------------------

  /** take the model's reading. `animate`: new scars and buildings arrive over time (else at once) */
  set(s: BoardState, now: number, animate: boolean): void {
    this.state = s;
    // (scars)
    const want = new Map<number, { o: Overlay; delay: number }>();
    for (const sv of Object.values(s.sites)) for (const sc of sv.look.scars) for (const [cell, d] of this.scarCells(sv.key, sc)) {
      const i = idx(cell.x, cell.y);
      if (!want.has(i)) want.set(i, { o: SCAR_TILE[sc], delay: d });
    }
    const next = new Map<number, { o: Overlay; at: number }>();
    for (const [i, w] of want) {
      const was = this.overlays.get(i);
      next.set(i, was && was.o === w.o ? was : { o: w.o, at: animate ? now + w.delay * 1000 : 0 });
    }
    this.overlays = next;
    // (buildings)
    const placed = this.placeAll(s);
    const before = new Set(this.placed.filter((p) => p.progress >= 1).map((p) => p.key));
    let k = 0;
    for (const p of placed) if (p.progress >= 1 && !before.has(p.key) && animate && this.placed.length) this.riseAt.set(p.key, now + 200 * k++);
    this.placed = placed;
    if (!this.paused) this.reconcile(s, now);
  }

  /** the cells a scar covers at a site, each with its delay (s) from the moment it appears */
  private scarCells(k: SiteKey, sc: Scar): [Cell, number][] {
    const c = this.l.sites[k];
    const l = this.l;
    const out: [Cell, number][] = [];
    const ring = (r: number, step: number, keep: (x: number, y: number) => boolean = () => true): void => {
      for (let y = c.y - r; y <= c.y + r; y++) for (let x = c.x - r; x <= c.x + r; x++) if (inside(x, y) && dist({ x, y }, c) <= r && keep(x, y)) out.push([{ x, y }, dist({ x, y }, c) * step]);
    };
    const dry = (x: number, y: number) => l.tiles[idx(x, y)] !== T.Water;
    if (sc === 'flooded') {
      // (water rises over the low ground first, then the site)
      for (let y = 0; y < l.n; y++) for (let x = 0; x < l.n; x++) if (l.height[idx(x, y)] === 0 && dry(x, y) && dist({ x, y }, c) <= 5) out.push([{ x, y }, 0.1 + dist({ x, y }, c) * 0.08]);
      ring(1, 0.2, dry);
      return out.map(([q, d]) => [q, l.height[idx(q.x, q.y)] === 0 ? d * 0.5 : 0.6 + d]);
    }
    if (sc === 'melted') {
      // (a tongue of lava come down from the mountain's side, creeping tile by tile onto the site, then round it)
      const n = Math.max(Math.abs(c.x - 1), Math.abs(c.y - 1));
      const len = Math.min(5, n);
      for (let i = len; i >= 0; i--) {
        const x = Math.round(c.x - ((c.x - 1) * i) / n);
        const y = Math.round(c.y - ((c.y - 1) * i) / n);
        if (inside(x, y) && dry(x, y)) out.push([{ x, y }, (len - i) * 0.18]);
      }
      ring(1, 0.18, dry);
      return out.map(([q, d]) => [q, dist(q, c) <= 1 ? len * 0.18 + d : d]);
    }
    if (sc === 'greened' || sc === 'withered' || sc === 'dried') ring(2, 0.15, dry);
    else if (sc === 'burned' || sc === 'buried') ring(1, 0.25, dry);
    else ring(0, 0);
    return out;
  }

  /** every building on the board, with how far along it is */
  private placeAll(s: BoardState): Placed[] {
    const out: Placed[] = [];
    for (const sv of Object.values(s.sites)) {
      const main = this.l.sites[sv.key];
      const free = [...(this.secondary.get(sv.key) ?? [])];
      const ruined = sv.look.ruined;
      const burnt = sv.look.scars.some((x) => x === 'burned' || x === 'melted');
      const base = baseSprite(sv.key, sv.built);
      const things = sv.things.filter((t) => t.building || true);
      let mainUsed = false;
      const put = (key: string, name: string, progress: number, preferMain: boolean): void => {
        const cell = preferMain && !mainUsed ? main : (free.shift() ?? main);
        if (cell === main) mainUsed = true;
        out.push({ key, name, cell, progress, site: sv.key });
      };
      const baseIsPlain = !sv.built;
      // (a pack's building takes the site's own cell while the site has only its plain look)
      const packFirst = baseIsPlain && things.some((t) => t.building);
      if (ruined) put(`${sv.key}:ruin`, burnt ? 'rubble-burned' : 'rubble', 1, true);
      else if (base && !packFirst) put(`${sv.key}:base:${base}`, base, 1, true);
      for (const t of things) put(`${sv.key}:thing:${t.id}`, t.ruined ? (burnt ? 'rubble-burned' : 'rubble') : t.building ? (THING_SPRITE[t.def] ?? 'hall') : 'policy-flag', 1, t.building);
      if (packFirst && base && !ruined) put(`${sv.key}:base:${base}`, base, 1, false);
      if (sv.raising && !ruined) {
        const b = sv.raising.builds;
        const site = b ? CATALOG_SITE[b] : undefined;
        const name = site ? baseSprite(site, b) : b ? (THING_SPRITE[b] ?? 'hall') : null;
        if (name) {
          const p = Math.max(0.12, sv.raising.done);
          if (site === sv.key) {
            // (the site's own building raised: it replaces the plain look)
            const i = out.findIndex((q) => q.site === sv.key && q.key.includes(':base:'));
            if (i >= 0) out.splice(i, 1);
            out.push({ key: `${sv.key}:base:${name}`, name, cell: main, progress: p, site: sv.key });
          } else put(`${sv.key}:thing:thing:${b}`, name, p, !mainUsed);
        }
      }
    }
    // (the walls: a ring round the core once they are built)
    if (s.walls) for (const c of this.wallCells()) out.push({ key: `wall:${c.x},${c.y}`, name: c.v ? 'wall-ring-v' : 'wall-ring', cell: c, progress: 1, site: 'gate' });
    // (houses on the plots near the roads: more with each houses card built)
    const houses = 6 + 8 * s.built.filter((b) => b === 'houses').length + (s.built.includes('market') ? 3 : 0);
    for (const [i, c] of this.l.plots.slice(0, houses).entries()) out.push({ key: `plot:${c.x},${c.y}`, name: hash(i + 17) > 0.6 ? 'plot2' : 'plot', cell: c, progress: 1, site: 'quarter' });
    return out;
  }

  private wallCells(): (Cell & { v: boolean })[] {
    const out: (Cell & { v: boolean })[] = [];
    const [x0, y0, x1, y1] = [6, 5, 20, 16];
    const ok = (x: number, y: number) => inside(x, y) && this.l.tiles[idx(x, y)] !== T.Road && this.l.tiles[idx(x, y)] !== T.Water && this.l.tiles[idx(x, y)] !== T.Bridge && !Object.values(this.l.sites).some((s) => s.x === x && s.y === y);
    for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) if (ok(x, y)) out.push({ x, y, v: false });
    for (let y = y0 + 1; y < y1; y++) for (const x of [x0, x1]) if (ok(x, y)) out.push({ x, y, v: true });
    return out;
  }

  // ---- figures --------------------------------------------------------------------------------------------------------

  /** where a role stands near a site: offsets round its main cell */
  private spot(k: SiteKey, i: number): [number, number] {
    const [x, y] = this.siteXY(k);
    const a = i * 2.1 + 0.6;
    const r = 18 + 6 * (i % 3);
    return [x + Math.cos(a) * r, y + 10 + Math.sin(a) * r * 0.5];
  }
  private walkTo(f: Fig, to: [number, number]): void {
    const cell = this.cellAt(f.x, f.y);
    const dest = this.cellAt(to[0], to[1]);
    const p = roadPath(this.l, cell, dest).map((c) => tileXY(c.x, c.y));
    p.push(to);
    f.path = p;
  }
  private cellAt(wx: number, wy: number): Cell {
    const u = Math.round((wx / HW + wy / HH) / 2);
    const v = Math.round((wy / HH - wx / HW) / 2);
    return { x: Math.max(0, Math.min(this.l.n - 1, u)), y: Math.max(0, Math.min(this.l.n - 1, v)) };
  }

  /** the figures the state asks for: posted pieces at their things, crews on projects, free ones at home, and the
   *  townspeople. New ones walk out from the keep; gone ones walk back and vanish */
  reconcile(s: BoardState, now: number): void {
    const want = new Map<string, { look: string; at: [number, number]; mode: Fig['mode'] }>();
    const n = new Map<string, number>();
    const military = s.built.includes('keep') || s.built.includes('walls');
    for (const p of s.pieces) {
      let site: SiteKey | null = p.site;
      let mode: Fig['mode'] = p.kind === 'crew' ? 'work' : 'stand';
      if (p.where === 'free') {
        site = p.kind === 'soldier' ? (military ? 'gate' : 'keep') : 'market';
        mode = 'stand';
      }
      if (!site) continue;
      const k = `${p.kind}@${site}`;
      const i = n.get(k) ?? 0;
      n.set(k, i + 1);
      want.set(`${k}#${i}`, { look: p.kind, at: this.spot(site, i + (p.kind === 'soldier' ? 3 : 0)), mode });
    }
    const home = this.siteXY('keep');
    for (const f of this.figs) {
      if (f.key.startsWith('folk') || f.key.startsWith('news') || f.key.startsWith('undead') || f.key.startsWith('thief')) continue;
      const w = want.get(f.key);
      if (!w) {
        if (f.mode !== 'leave') {
          f.mode = 'leave';
          this.walkTo(f, home);
        }
        continue;
      }
      const d = Math.hypot(f.x - w.at[0], f.y - w.at[1]);
      const goal = f.path.at(-1);
      if (d > 2 && (!goal || Math.hypot(goal[0] - w.at[0], goal[1] - w.at[1]) > 2)) {
        f.mode = 'walk';
        this.walkTo(f, w.at);
        f.onArrive = () => (f.mode = w.mode);
      } else if (!f.path.length) f.mode = w.mode;
      want.delete(f.key);
    }
    for (const [key, w] of want) {
      const f: Fig = { key, look: w.look, x: home[0], y: home[1] + 8, path: [], speed: 55, mode: 'walk', phase: hash(key.length * 31 + key.charCodeAt(key.length - 1)) * 6 };
      this.walkTo(f, w.at);
      f.onArrive = () => (f.mode = w.mode);
      this.figs.push(f);
    }
    // (townspeople: more with houses and with the market; fewer under plague, darkness and in a sacked town)
    const houses = s.built.filter((b) => b === 'houses').length;
    let folk = 34 + 30 * houses + (s.built.includes('market') ? 16 : 0) + 6 * s.far.filter((x) => x.partner).length;
    if (s.signs.includes('deadrise') || s.signs.includes('darkness')) folk = Math.round(folk * 0.6);
    folk = Math.min(180, folk);
    this.folkCount = folk;
    const have = this.figs.filter((f) => f.key.startsWith('folk'));
    for (let i = have.length; i < folk; i++) {
      const c = this.l.roads[Math.floor(hash(i * 7 + 3) * this.l.roads.length)];
      const [x, y] = tileXY(c.x, c.y);
      this.figs.push({ key: `folk${i}`, look: `folk${i % C.folk.length}_`, x: x + (hash(i) - 0.5) * 20, y: y + (hash(i + 1) - 0.5) * 10, path: [], speed: 22 + hash(i + 9) * 18, mode: 'wander', phase: hash(i + 5) * 6 });
    }
    if (have.length > folk) this.figs = this.figs.filter((f) => !f.key.startsWith('folk') || Number(f.key.slice(4)) < folk);
    // (signs with people: the dead walk out of the burial ground, thieves in the market streets)
    const extra = (kind: 'undead' | 'thief', on: boolean, count: number, from: SiteKey): void => {
      const mine = this.figs.filter((f) => f.key.startsWith(kind));
      if (!on) {
        this.figs = this.figs.filter((f) => !f.key.startsWith(kind));
        return;
      }
      for (let i = mine.length; i < count; i++) {
        const [x, y] = this.spot(from, i);
        this.figs.push({ key: `${kind}${i}`, look: kind, x, y, path: [], speed: kind === 'undead' ? 12 : 30, mode: 'wander', phase: i });
      }
    };
    extra('undead', s.signs.includes('deadrise'), 8, 'graves');
    extra('thief', s.signs.includes('crime'), 5, 'market');
    void now;
  }

  /** a messenger with news: in by the road (on foot, horse or cart) or the river (ship), a line over their head */
  news(text: string, mount: 'foot' | 'horse' | 'cart' | 'ship', now: number): Fig {
    const e = mount === 'ship' ? this.l.entries.river : this.l.entries.east;
    const start = mount === 'ship' ? tileXY(e.x, e.y) : tileXY(e.x - 5, e.y);
    const look = mount === 'foot' ? 'messenger' : mount;
    const f: Fig = { key: `news${now}`, look, x: start[0], y: start[1], path: [], speed: mount === 'foot' ? 60 : 110, mode: 'walk', phase: 0, say: text };
    if (mount === 'ship') {
      const h = this.l.sites.harbour;
      f.path = [];
      for (let x = e.x; x <= h.x; x++) f.path.push(tileXY(x, h.y + 1.5));
    } else this.walkTo(f, this.siteXY('keep'));
    this.figs.push(f);
    return f;
  }

  // ---- drawing --------------------------------------------------------------------------------------------------------

  /** draw the town; `dt` seconds since the last frame */
  draw(g: CanvasRenderingContext2D, cam: Camera, w: number, h: number, dpr: number, now: number, dt: number): void {
    const s = this.state;
    if (!s) return;
    this.step(dt, now);
    g.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * (w / 2 - cam.x * cam.zoom), dpr * (h / 2 - cam.y * cam.zoom));
    g.imageSmoothingEnabled = true;
    const gw = this.ground.width / 1.25;
    const gh = this.ground.height / 1.25;
    g.drawImage(this.ground, this.g0[0], this.g0[1], gw, gh);
    // (the scars: each tile grows in from its centre when it arrives)
    for (const [i, o] of this.overlays) {
      const t = (now - o.at) / 450;
      if (t <= 0) continue;
      const k = Math.min(1, t);
      const x = i % this.l.n;
      const y = Math.floor(i / this.l.n);
      const sp = tileOf(o.o);
      const [wx, wy] = tileXY(x, y);
      g.globalAlpha = o.o === 'flood' ? 0.88 * k : k;
      g.drawImage(sp.img, wx - sp.ax * k, wy - sp.ay * k, sp.w * k, sp.h * k);
    }
    g.globalAlpha = 1;
    // (a live lava front: glowing tiles creeping in)
    if (this.lavaFront) {
      const lf = this.lavaFront;
      const shown = Math.min(lf.reached, Math.floor((now - lf.t0) / 140));
      const sp = tileOf('lava');
      for (const c of lf.cells.slice(0, shown)) {
        const [wx, wy] = tileXY(c.x, c.y);
        g.globalAlpha = 0.75 + 0.25 * Math.sin(now / 200 + c.x);
        g.drawImage(sp.img, wx - sp.ax, wy - sp.ay, sp.w, sp.h);
      }
      g.globalAlpha = 1;
    }
    // (sprites in depth order: trees, buildings, figures)
    type D = { d: number; f: () => void };
    const list: D[] = [];
    const n = this.l.n;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        if (this.l.tiles[idx(x, y)] === T.Forest && !this.overlays.has(idx(x, y))) {
          const [wx, wy] = tileXY(x, y);
          const sp = sprite('trees');
          list.push({ d: wy, f: () => g.drawImage(sp.img, wx - sp.ax, wy - sp.ay + 4, sp.w, sp.h) });
        }
    for (const p of this.placed) {
      const [wx, wy] = tileXY(p.cell.x, p.cell.y);
      const sp = sprite(p.name);
      const rise = this.riseAt.get(p.key);
      list.push({ d: wy + 1, f: () => this.drawBuilding(g, sp, wx, wy, p.progress, rise, now) });
    }
    for (const f of this.figs) {
      const look = f.look === 'messenger' || f.look === 'horse' || f.look === 'cart' || f.look === 'ship' || f.look.startsWith('folk') ? f.look : f.look === 'crew' && f.mode === 'work' ? 'crewwork' : f.look;
      const moving = f.mode === 'walk' || f.mode === 'leave' || (f.mode === 'wander' && f.path.length > 0);
      const frame = f.mode === 'work' ? Math.floor(now / 260 + f.phase) % 2 : moving ? Math.floor(now / 180 + f.phase) % 2 : 0;
      const sp = sprite(look.endsWith('_') ? `${look}${frame}` : `${look}${frame}`);
      const flip = f.path.length > 0 && f.path[0][0] < f.x;
      list.push({
        d: f.y + 2,
        f: () => {
          if (flip) {
            g.save();
            g.translate(f.x, f.y);
            g.scale(-1, 1);
            g.drawImage(sp.img, -sp.ax, -sp.ay, sp.w, sp.h);
            g.restore();
          } else g.drawImage(sp.img, f.x - sp.ax, f.y - sp.ay, sp.w, sp.h);
        },
      });
    }
    list.sort((a, b) => a.d - b.d);
    for (const x of list) x.f();
    // (fire on burning sites: a live fire event at its site)
    for (const lv of s.live) if (lv.ev.hazard && 'site' in lv.at && lv.ev.hazard.points > 0 && !this.lavaFront) this.flames(g, lv.at.site, now, Math.max(0.4, lv.ev.hazard.burned / Math.max(1, lv.ev.hazard.points)));
    // (bursts: a spell landing)
    this.bursts = this.bursts.filter((b) => now - b.t0 < 700);
    for (const b of this.bursts) {
      const t = (now - b.t0) / 700;
      g.globalAlpha = 1 - t;
      g.fillStyle = b.color;
      g.beginPath();
      g.ellipse(b.x, b.y, 10 + 60 * t, 5 + 30 * t, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    // (screen space from here)
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.signs(g, s.signs, w, h, now);
    this.hits = [];
    this.markers(g, cam, w, h, now);
    this.flyTexts(g, now);
  }

  private drawBuilding(g: CanvasRenderingContext2D, sp: Sprite, wx: number, wy: number, progress: number, rise: number | undefined, now: number): void {
    let p = progress;
    if (rise !== undefined) {
      const t = (now - rise) / 1100;
      if (t < 0) p = 0;
      else if (t < 1) p = Math.min(p, t);
      else this.riseAt.delete([...this.riseAt].find(([, v]) => v === rise)?.[0] ?? '');
    }
    if (p >= 1) {
      g.drawImage(sp.img, wx - sp.ax, wy - sp.ay, sp.w, sp.h);
      return;
    }
    // (under construction: a ghost of what will stand, the part built so far solid from the ground up, scaffold poles)
    g.globalAlpha = 0.22;
    g.drawImage(sp.img, wx - sp.ax, wy - sp.ay, sp.w, sp.h);
    g.globalAlpha = 1;
    const shown = sp.h * p;
    if (shown > 0.5) g.drawImage(sp.img, 0, (sp.h - shown) * BAKE, sp.w * BAKE, shown * BAKE, wx - sp.ax, wy - sp.ay + sp.h - shown, sp.w, shown);
    if (rise === undefined || now - rise > 1100) {
      g.strokeStyle = '#d8c39a';
      g.lineWidth = 1.2;
      const top = wy - sp.ay + sp.h - Math.max(shown, 18) - 6;
      g.beginPath();
      for (const dx of [-0.3, 0, 0.3]) {
        g.moveTo(wx + dx * sp.w * 0.8, wy + 4);
        g.lineTo(wx + dx * sp.w * 0.8, top);
      }
      g.moveTo(wx - sp.w * 0.26, top + 4);
      g.lineTo(wx + sp.w * 0.26, top + 4);
      g.stroke();
    }
  }

  private flames(g: CanvasRenderingContext2D, k: SiteKey, now: number, strength: number): void {
    const [x, y] = this.siteXY(k);
    for (let i = 0; i < 10 * strength + 4; i++) {
      const fx = x + (hash(i) - 0.5) * 70;
      const fy = y + (hash(i + 40) - 0.5) * 30;
      const h = 14 + 18 * Math.abs(Math.sin(now / 120 + i * 1.7));
      g.fillStyle = i % 3 ? '#ff9a2e' : '#ffd04a';
      g.globalAlpha = 0.85;
      g.beginPath();
      g.moveTo(fx - 5, fy);
      g.quadraticCurveTo(fx - 4, fy - h * 0.6, fx, fy - h);
      g.quadraticCurveTo(fx + 4, fy - h * 0.6, fx + 5, fy);
      g.fill();
    }
    g.globalAlpha = 0.3;
    g.fillStyle = '#333';
    for (let i = 0; i < 5; i++) {
      const t = ((now / 1600 + i / 5) % 1);
      g.beginPath();
      g.arc(x + Math.sin(i * 3 + t * 4) * 12, y - 30 - t * 70, 8 + t * 14, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  /** the signs over the whole town (screen space) */
  private signs(g: CanvasRenderingContext2D, signs: readonly Sign[], w: number, h: number, now: number): void {
    if (signs.includes('darkness')) {
      g.fillStyle = 'rgba(10,8,30,0.5)';
      g.fillRect(0, 0, w, h);
    }
    if (signs.includes('ashfall')) {
      g.fillStyle = 'rgba(90,86,82,0.28)';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#d8d4cf';
      for (let i = 0; i < 70; i++) {
        const x = (hash(i) * w + Math.sin(now / 900 + i) * 20 + now * 0.01) % w;
        const y = (hash(i + 99) * h + now * 0.03) % h;
        g.fillRect(x, y, 2, 2);
      }
    }
    if (signs.includes('rain') || signs.includes('storm')) {
      g.strokeStyle = 'rgba(190,210,230,0.45)';
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i < (signs.includes('storm') ? 120 : 60); i++) {
        const x = (hash(i) * w + now * 0.12) % w;
        const y = (hash(i + 7) * h + now * 0.6) % h;
        g.moveTo(x, y);
        g.lineTo(x - 4, y + 12);
      }
      g.stroke();
      if (signs.includes('storm') && Math.sin(now / 1300) > 0.985) {
        g.fillStyle = 'rgba(255,255,255,0.25)';
        g.fillRect(0, 0, w, h);
      }
    }
    if (signs.includes('fog')) {
      g.fillStyle = 'rgba(220,222,226,0.3)';
      g.fillRect(0, 0, w, h);
    }
  }

  // ---- markers and taps -----------------------------------------------------------------------------------------------

  private badge(g: CanvasRenderingContext2D, x: number, y: number, text: string, fill: string, ink: string, act: Action, pri: number, pulse = 0): void {
    const r = 15 + pulse;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = '#101214';
    g.stroke();
    g.fillStyle = ink;
    g.font = '700 15px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x, y + 1);
    // (a tap target 48 px across)
    this.hits.push({ x, y, r: 24, act, pri });
  }
  private label(g: CanvasRenderingContext2D, x: number, y: number, text: string, color = '#f4efe2', bg = 'rgba(16,18,20,0.78)'): void {
    g.font = '600 12px system-ui, sans-serif';
    const tw = g.measureText(text).width;
    g.fillStyle = bg;
    g.beginPath();
    g.roundRect(x - tw / 2 - 5, y - 9, tw + 10, 18, 6);
    g.fill();
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x, y + 0.5);
  }

  private markers(g: CanvasRenderingContext2D, cam: Camera, w: number, h: number, now: number): void {
    const s = this.state!;
    const pulse = 2 * Math.sin(now / 220);
    for (const sv of Object.values(s.sites)) {
      const [wx, wy] = this.siteXY(sv.key);
      const [x, y] = toScreen(cam, w, h, wx, wy);
      if (x < -60 || y < -80 || x > w + 60 || y > h + 60) continue;
      // (the site itself: a tap opens it)
      this.hits.push({ x, y: y - 18 * cam.zoom, r: Math.max(24, 34 * cam.zoom), act: { kind: 'site', key: sv.key }, pri: 5 });
      let bx = x;
      const by = y - Math.max(46, 78 * cam.zoom);
      // (a piece in hand: only the places it can go are marked)
      const offers = this.armed ? [] : s.offers.filter((o) => 'site' in o.at && o.at.site === sv.key);
      const lives = this.armed ? [] : s.live.filter((o) => 'site' in o.at && o.at.site === sv.key);
      const works = s.works.filter((x2) => x2.site === sv.key);
      const n = offers.length + lives.length;
      bx -= ((n - 1) * 36) / 2;
      for (const lv of lives) {
        const foe = lv.ev.groups.some((q) => q.side === 'foe');
        this.badge(g, bx, by, foe ? '⚔' : '🔥', foe ? FOE : '#ff9a2e', '#111', { kind: 'live', id: lv.ev.id }, 1, pulse);
        bx += 36;
      }
      for (const [j, o] of offers.entries()) {
        this.badge(g, bx, by, o.card.threat ? String(o.card.left) : '!', ACT, '#06232a', { kind: 'offer', id: o.card.id }, 1, o.card.threat ? pulse : 0);
        // (what it is, in a few words, so the map can be read without opening every marker)
        if (cam.zoom >= 0.5) this.label(g, bx, by - 26 - (j % 2) * 19, short(o.card.title), ACT);
        if (o.card.threat) {
          g.strokeStyle = '#f4efe2';
          g.lineWidth = 2;
          g.beginPath();
          g.arc(bx, by, 19 + pulse, 0, Math.PI * 2);
          g.stroke();
        }
        bx += 36;
      }
      // (a use that can be made now: a cyan spark on the thing)
      if (!this.armed && works.some((x2) => x2.uses.some((u) => u.can))) {
        g.fillStyle = ACT;
        g.beginPath();
        g.arc(x + 26 * Math.max(0.6, cam.zoom), y - 30 * Math.max(0.6, cam.zoom), 6 + pulse * 0.6, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#101214';
        g.lineWidth = 2;
        g.stroke();
      }
      // (a piece in hand: every thing with room for it)
      if (this.armed) {
        const room = works.find((x2) => x2.slots.some((sl) => sl.kind === this.armed && sl.posted < sl.n));
        if (room) {
          const sl = room.slots.find((q) => q.kind === this.armed)!;
          g.strokeStyle = ACT;
          g.lineWidth = 3;
          g.beginPath();
          g.ellipse(x, y, 34 * Math.max(0.7, cam.zoom) + pulse, 17 * Math.max(0.7, cam.zoom) + pulse / 2, 0, 0, Math.PI * 2);
          g.stroke();
          this.badge(g, x, y - 34 * Math.max(0.7, cam.zoom), `${sl.posted}/${sl.n}`, ACT, '#06232a', { kind: 'post', work: room.id, piece: this.armed }, 0, pulse);
        }
      }
      // (what has no look of its own: its words)
      const marks = [...sv.look.marks, ...(sv.key === 'keep' ? s.homeMarks : [])];
      marks.slice(0, 3).forEach((m, i) => this.label(g, x, y + 14 + i * 19, m, '#ffe9a8'));
      if (this.focus === sv.key) {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 2;
        g.setLineDash([5, 4]);
        g.beginPath();
        g.ellipse(x, y, 40 * Math.max(0.7, cam.zoom), 20 * Math.max(0.7, cam.zoom), 0, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
      }
      if (cam.zoom > 0.75 || this.focus === sv.key) this.label(g, x, y + (marks.length ? 14 + marks.length * 19 : 14), sv.name, '#e8e2d2', 'rgba(16,18,20,0.55)');
    }
    // (offers and events at the town itself: at the keep)
    const town = [...s.live.filter((o) => 'town' in o.at), ...s.offers.filter((o) => 'town' in o.at)];
    if (town.length) {
      const [x, y] = toScreen(cam, w, h, ...this.siteXY('keep'));
      let bx = x - ((town.length - 1) * 36) / 2;
      const by = y - Math.max(46, 78 * cam.zoom) - 40;
      for (const o of town) {
        if ('ev' in o) this.badge(g, bx, by, o.ev.groups.some((q) => q.side === 'foe') ? '⚔' : '🔥', o.ev.groups.some((q) => q.side === 'foe') ? FOE : '#ff9a2e', '#111', { kind: 'live', id: o.ev.id }, 1, pulse);
        else this.badge(g, bx, by, o.card.threat ? String(o.card.left) : '!', ACT, '#06232a', { kind: 'offer', id: o.card.id }, 1);
        bx += 36;
      }
    }
    // (speech over a messenger)
    for (const f of this.figs) {
      if (!f.say) continue;
      const [x, y] = toScreen(cam, w, h, f.x, f.y);
      this.bubble(g, x, y - 34 * cam.zoom - 10, f.say, w);
    }
  }

  private bubble(g: CanvasRenderingContext2D, x: number, y: number, text: string, w: number): void {
    g.font = '600 14px system-ui, sans-serif';
    const words = text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const wd of words) {
      const t = cur ? `${cur} ${wd}` : wd;
      if (g.measureText(t).width > 230 && cur) {
        lines.push(cur);
        cur = wd;
      } else cur = t;
    }
    if (cur) lines.push(cur);
    const lw = Math.max(...lines.map((l) => g.measureText(l).width)) + 18;
    const lh = lines.length * 18 + 10;
    const bx = Math.max(8, Math.min(w - lw - 8, x - lw / 2));
    const by = y - lh - 8;
    g.fillStyle = '#fbf6ea';
    g.strokeStyle = '#101214';
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(bx, by, lw, lh, 10);
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(x - 6, by + lh);
    g.lineTo(x, by + lh + 8);
    g.lineTo(x + 6, by + lh);
    g.fill();
    g.fillStyle = '#1a1a1a';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    lines.forEach((l, i) => g.fillText(l, bx + 9, by + 6 + i * 18));
  }

  private flyTexts(g: CanvasRenderingContext2D, now: number): void {
    this.fly = this.fly.filter((f) => now - f.t0 < f.dur);
    for (const f of this.fly) {
      const t = Math.max(0, (now - f.t0) / f.dur);
      if (now < f.t0) continue;
      const e = t * t * (3 - 2 * t);
      const x = f.to ? f.from[0] + (f.to[0] - f.from[0]) * e : f.from[0];
      const y = f.to ? f.from[1] + (f.to[1] - f.from[1]) * e - Math.sin(t * Math.PI) * 40 : f.from[1] - 50 * t;
      g.globalAlpha = t > 0.85 ? (1 - t) / 0.15 : 1;
      g.font = '800 17px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 4;
      g.strokeStyle = '#101214';
      g.strokeText(f.text, x, y);
      g.fillStyle = f.color;
      g.fillText(f.text, x, y);
    }
    g.globalAlpha = 1;
  }

  /** what a tap at a screen point hits (the most specific first) */
  hit(sx: number, sy: number): Action | null {
    const c = this.hits.filter((h) => Math.hypot(h.x - sx, h.y - sy) <= h.r).sort((a, b) => a.pri - b.pri || Math.hypot(a.x - sx, a.y - sy) - Math.hypot(b.x - sx, b.y - sy));
    return c[0]?.act ?? null;
  }

  // ---- movement -------------------------------------------------------------------------------------------------------

  private step(dt: number, now: number): void {
    for (const f of this.figs) {
      if (f.until && now > f.until) f.say = undefined;
      if (f.mode === 'wander' && !f.path.length) {
        // (a townsperson picks somewhere down the road; the dead and thieves keep near where they are)
        if (hash(Math.floor(now / 1000) * 13 + f.phase * 100) < 0.5 * dt * 2) {
          const near = f.key.startsWith('undead') || f.key.startsWith('thief');
          const c0 = this.cellAt(f.x, f.y);
          const pool = near ? this.l.roads.filter((r) => dist(r, c0) < 6) : this.l.roads;
          const c = pool[Math.floor(hash(now + f.phase * 1000) * pool.length)] ?? c0;
          const [tx, ty] = tileXY(c.x, c.y);
          this.walkTo(f, [tx + (hash(f.phase) - 0.5) * 24, ty + (hash(f.phase + 2) - 0.5) * 12]);
        }
      }
      if (!f.path.length) continue;
      const [tx, ty] = f.path[0];
      const d = Math.hypot(tx - f.x, ty - f.y);
      const v = f.speed * dt;
      if (d <= v) {
        f.x = tx;
        f.y = ty;
        f.path.shift();
        if (!f.path.length) {
          if (f.mode === 'leave') f.mode = 'stand';
          const cb = f.onArrive;
          f.onArrive = undefined;
          cb?.();
        }
      } else {
        f.x += ((tx - f.x) / d) * v;
        f.y += ((ty - f.y) / d) * v;
      }
    }
    // (gone pieces vanish at the keep)
    this.figs = this.figs.filter((f) => !(f.mode === 'stand' && f.key.includes('@') && !this.wanted(f.key)));
  }
  private wanted(key: string): boolean {
    const s = this.state;
    if (!s) return true;
    const [kind, rest] = key.split('@');
    const [site, i] = rest.split('#');
    const military = s.built.includes('keep') || s.built.includes('walls');
    const n = s.pieces.filter((p) => p.kind === kind && (p.where === 'free' ? (p.kind === 'soldier' ? (military ? 'gate' : 'keep') : 'market') : p.site) === site).length;
    return Number(i) < n;
  }
}
