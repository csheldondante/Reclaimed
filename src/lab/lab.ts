// (switchover, 2026-11-10) The town lab: the default town game — the atlas level at the start town, the GPU town
// (citygen/towns.ts), its living town (citylife/towns.ts) and the season loop (season/loop.ts) — driven by a script
// (scripts/lab.mjs; docs/TOOLING.md). ?lab=1 on the atlas level installs it once the start town is made. What a
// scenario drives, in the page as `reclaimed.lab`:
//   run(seconds, speed, {renderEvery})  the sim advanced `seconds` of sim time as fast as the GPU goes: the display's
//                                       frames wait, the lab steps the scene itself, drawing every Nth frame
//   look(x, y, zoom) / shot(name)       the camera (window world units); a screenshot (the runner saves it)
//   project(x, y, z) / viewport()       a window point on the screen (CSS px); the screen's size
//   towns / living / season / town      the game's own objects: the field towns, the living towns, the season loop, and
//                                       the start town's id
//   riders(id)                          (debug read) a living town's riders' rows and where its grid is in the window
// (Was the behaviour lab of round 128l: the fortress on recipes of small land, deleted with fortress mode. Its runner,
// scripts/lab.mjs, now opens this page.)
//
// Recipes (scripts/lab.mjs `recipe`, the page's ?labrecipe=): `town` (the default: the town game as it opens) and
// `gputown` (Track B's benches and gates — docs/design/TOWN_CONTRACTS.md): Muru's GPU town and its living town with no
// season loop, its walls card risen at once (CityDistricts.wallStart, wallStage 0 → 1 Skip) and the muster yard the
// ring designates; `&labkeep=1` raises a keep district too (the keep and barracks). Ready once the side map has been
// solved over the risen wall and the muster yard is valid. Its debug reads (never an order's): contracts, townIndex,
// sides(), sideCounts(), places(), markContracts() (an overlay drawn over the page for shots).
import type { LevelScene } from '../scenes/level';
import type { FieldTowns } from '../citygen/towns';
import type { LivingTowns } from '../citylife/towns';
import type { SeasonLoop } from '../season/loop';
import { TICK_DT } from '../sim/flow';
import { Renderer } from '../render/renderer';
import { ROW_H, cellPos } from '../world/lattice';
import { urlFlags } from '../flags';
import { TOWN_WORDS, SC, type TownContracts } from '../towncontracts/contracts';
import { PLACE, NAMED_PLACES, SIDE_OF, type PlaceName } from '../api/contracts/townplaces';

const STATUS = ['ok', 'none', 'rising', 'water', 'no town'];

const DT = 1 / 60;

export class TownLab {
  /** the lab steps the scene (lab.run): the display's frames wait */
  driving = false;
  /** the start town is made (and its season dealt, its people given, when those are on) */
  ready = false;
  private simT = 0;

  constructor(private scene: LevelScene) {}

  private get towns(): FieldTowns {
    const t = this.scene.fieldTowns;
    if (!t) throw new Error('town lab: no field towns');
    return t;
  }

  /** the start town's id (?town=) */
  get town(): string {
    const id = this.scene.opts.atlas?.startTown;
    if (!id) throw new Error('town lab: no start town (?town=1)');
    return id;
  }

  private get season(): SeasonLoop | null {
    return (globalThis as { season?: SeasonLoop }).season ?? null;
  }

  /** whether the start town is ready to drive: made, its people given (living), its first hand dealt (season) */
  private isReady(): boolean {
    const t = this.towns.live.get(this.town);
    if (!t?.times) return false;
    if (this.scene.livingTowns && !this.scene.livingTowns.live.has(this.town)) return false;
    const s = this.season;
    return !s || (s.town !== null && s.hand.length > 0);
  }

  /** (markContracts) the page's panels hidden while its overlay is up */
  private hidden: HTMLElement[] = [];
  /** the recipe (?labrecipe=): town, or gputown */
  readonly recipe = urlFlags().get('labrecipe') ?? 'town';
  /** (gputown) why its setup failed (the gate reads it), or null */
  recipeError: string | null = null;

  /** watched every frame until ready */
  poll(): void {
    if (this.ready) return;
    if (!this.isReady()) {
      requestAnimationFrame(() => this.poll());
      return;
    }
    if (this.recipe !== 'gputown') {
      this.ready = true;
      console.log(`[lab] ready: ${this.town}`);
      return;
    }
    void this.gputown().then(
      () => console.log(`[lab] ready: ${this.town} (gputown)`),
      (e) => {
        this.recipeError = String(e?.message ?? e);
        console.error(`[lab] gputown: ${this.recipeError}`);
      },
    ).finally(() => (this.ready = true));
  }

  private get contracts(): TownContracts {
    const c = this.scene.townContracts;
    if (!c) throw new Error('town lab: no town contracts (?contracts=0?)');
    return c;
  }

  /**
   * (gputown) The walls card risen at once at the start town (a keep district too with ?labkeep=1), then waits — the
   * page's own frames running — for the side map solved over the risen wall and the muster yard valid. Debug reads,
   * the lab's only.
   */
  private async gputown(): Promise<void> {
    const id = this.town;
    const towns = this.towns;
    // (the world's ticks held from here, as the lab holds them between runs — lab.run advances them. The towns' clock
    // runs on with the frames, so the wall rises and is claimed. Also keeps the lab page clear of the water's blow-up
    // past ~4000 ticks at Muru: BACKLOG UC-6)
    this.scene.speed = 0;
    if (!towns.wallStart(id)) throw new Error(`gputown: ${id} isn't live`);
    towns.wallStage(id, 0, 1, true);
    if (urlFlags().get('labkeep') === '1') {
      const d = await towns.claimDistrict('keep', id);
      if (d.id < 0) throw new Error('gputown: no keep district left to claim');
      towns.stageDistrict(id, d.id, { slot: 0, a: 0, b: 1, from: 0, to: 1, end: 1 }, true);
    }
    const c = this.contracts;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // (the wall's claims are made on its mesh runs — every 2 s of the town's clock while it animates, once at its end:
    // a solve after the last of them sees the risen wall)
    await sleep(4000);
    // (the wall comes into the columns a while after its mesh run — its claims, region by region: ready once the inside
    // holds at least 40 % of the ring's columns — water, a river, is no one's side — and has held still over three looks
    // a half second apart, no solve under way)
    const ring = await towns.live.get(id)!.gen.readWall();
    const rf = new Float32Array(new Uint32Array(ring).buffer);
    let area = 0;
    for (let b = 0; b < 72; b++) area += rf[80 + 2 * b] * rf[80 + 2 * ((b + 1) % 72) + 1] - rf[80 + 2 * ((b + 1) % 72)] * rf[80 + 2 * b + 1];
    const want = (0.4 * Math.abs(area / 2)) / ROW_H;
    let last = -1;
    let still = 0;
    for (let k = 0; k < 240; k++) {
      await sleep(500);
      const ctl = await c.debugRead('ctl');
      if (ctl[SC.solves] === 0 || ctl[SC.state] !== 0) continue;
      // (a district rising re-solves as its claims come in: still within half a percent)
      const inside = (await this.sideCounts(id)).inside;
      still = Math.abs(inside - last) <= 0.005 * inside ? still + 1 : 0;
      last = inside;
      const p = await this.places(id);
      if (p?.named.muster.status === 0 && inside >= want && still >= 2) return;
    }
    const p = await this.places(id);
    throw new Error(`gputown: no muster yard or no sealed inside after 120 s (muster ${JSON.stringify(p?.named.muster)}, inside columns ${(await this.sideCounts(id)).inside} of the ${Math.round(want)} wanted)`);
  }

  /** (debug read) the side map in window order */
  async sides(): Promise<{ w: number; h: number; map: Uint32Array }> {
    const { w, h } = this.scene.core.dims;
    return { w, h, map: await this.contracts.debugRead('sides', w * h * 4) };
  }

  /** (debug read) the window's columns on a town's side, and on other towns' sides */
  async sideCounts(id: string): Promise<{ side: number; inside: number; others: number }> {
    const side = SIDE_OF(this.contracts.townIndex(id));
    const { map } = await this.sides();
    let inside = 0;
    let others = 0;
    for (const v of map) {
      if (v === side) inside++;
      else if (v) others++;
    }
    return { side, inside, others };
  }

  /** (debug read) a town's named places decoded: window x, y, z; status (STATUS); approach; aux */
  async places(id: string): Promise<{ town: number; live: boolean; named: Record<string, { status: number; at: [number, number, number]; approach: [number, number, number]; aux: number }> } | null> {
    const i = this.contracts.townIndex(id);
    if (i < 0) return null;
    const words = await this.contracts.debugRead('places', TOWN_WORDS * 4 * (i + 1));
    const o = i * TOWN_WORDS;
    const f = new Float32Array(words.buffer);
    const off = [f[o + 4], f[o + 5], f[o + 6]];
    const names = (Object.entries(PLACE) as [PlaceName, number][]).sort((a, b) => b[1] - a[1]);
    const named: Record<string, { status: number; at: [number, number, number]; approach: [number, number, number]; aux: number }> = {};
    for (let p = 0; p < NAMED_PLACES; p++) {
      const e = o + 16 + p * 8;
      const [n, v] = names.find(([, v]) => v <= p)!;
      const key = n.endsWith('0') ? `${n.slice(0, -1)}${p - v}` : n;
      named[key] = { status: words[e + 3], at: [f[e] + off[0], f[e + 1] + off[1], f[e + 2] + off[2]], approach: [f[e + 4] + off[0], f[e + 5] + off[1], f[e + 6] + off[2]], aux: words[e + 7] };
    }
    return { town: i, live: words[o] === 1, named };
  }

  /**
   * (debug, for shots) The side map and a town's named places drawn over the page: every `step`th column of the town's
   * box tinted by its side (the town's: teal; another town's: amber; open: a faint red dot), each valid named place a dot
   * with its name and a line from its approach; the invalid ones listed. Draw again after the camera moves.
   */
  async markContracts(id: string, o: { step?: number; clear?: boolean; labels?: boolean } = {}): Promise<{ drawn: number; invalid: string[] }> {
    document.getElementById('lab-contracts')?.remove();
    // (the page's panels hidden while it's drawn: the shot is the map)
    for (const el of this.hidden) el.style.visibility = '';
    this.hidden = [];
    if (o.clear) return { drawn: 0, invalid: [] };
    for (const el of document.body.children) {
      if (!(el instanceof HTMLElement) || el.contains(this.scene.host.canvas)) continue;
      el.style.visibility = 'hidden';
      this.hidden.push(el);
    }
    const t = this.towns.live.get(id);
    if (!t) throw new Error(`markContracts: ${id} isn't live`);
    const cv = document.createElement('canvas');
    cv.id = 'lab-contracts';
    cv.width = innerWidth;
    cv.height = innerHeight;
    Object.assign(cv.style, { position: 'fixed', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '50' });
    document.body.append(cv);
    const g = cv.getContext('2d')!;
    const cam = this.scene.core.camera;
    const { w, h, map } = await this.sides();
    // (o.labels: the solve's own words instead — walkable and open (red), not walkable (blue: water, a closed gate),
    // sealed (teal); a column standing over 2.5 above a neighbour (a wall) white)
    const label = o.labels ? await this.contracts.debugRead('label') : null;
    // (each column's top as the last solve read it: window z)
    const top = new Float32Array((await this.contracts.debugRead('top')).buffer);
    const side = SIDE_OF(this.contracts.townIndex(id));
    const step = o.step ?? 2;
    const p = t.gridPlace();
    let drawn = 0;
    for (let y = Math.max(0, p.dy); y < Math.min(h, p.dy + t.box.h); y += step)
      for (let x = Math.max(0, p.dx); x < Math.min(w, p.dx + t.box.w); x += step) {
        const v = map[y * w + x];
        const [px, py] = cellPos(x, y);
        const z = top[y * w + x];
        if (!(z > -1e8)) continue;
        const [sx, sy] = cam.project(px, py, z);
        if (sx < -4 || sy < -4 || sx > innerWidth + 4 || sy > innerHeight + 4) continue;
        g.fillStyle = v === side ? 'rgba(20,200,190,0.55)' : v ? 'rgba(240,170,20,0.6)' : 'rgba(220,40,40,0.28)';
        let r = v ? 2.2 : 1.3;
        if (label) {
          const l = label[y * w + x];
          const t0 = top[y * w + x];
          const wall = x + 1 < w && y + 1 < h && (t0 - top[y * w + x + 1] > 2.5 || t0 - top[(y + 1) * w + x] > 2.5 || t0 - top[y * w + x - 1] > 2.5);
          g.fillStyle = wall ? 'rgba(255,255,255,0.9)' : l === 0xffffffff ? 'rgba(40,80,255,0.6)' : l === 0 ? 'rgba(220,40,40,0.45)' : 'rgba(20,200,190,0.6)';
          r = 1.6;
        }
        g.fillRect(sx - r, sy - r, 2 * r, 2 * r);
        drawn++;
      }
    const pl = await this.places(id);
    const invalid: string[] = [];
    g.font = 'bold 12px sans-serif';
    for (const [name, e] of Object.entries(pl?.named ?? {})) {
      if (e.status !== 0) {
        // (the gate and spawn slots past the town's arterials are none by design: not listed)
        if (!(/^(gate|spawn)/.test(name) && e.status === 1)) invalid.push(`${name} ${STATUS[e.status]}`);
        continue;
      }
      const [ax, ay] = cam.project(...e.approach);
      const [sx, sy] = cam.project(...e.at);
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(sx, sy);
      g.stroke();
      g.fillStyle = name.startsWith('gate') ? '#ffd23f' : name.startsWith('spawn') ? '#ff5d5d' : '#7ae7ff';
      g.beginPath();
      g.arc(sx, sy, 6, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#000';
      g.lineWidth = 3;
      g.strokeText(name, sx + 8, sy - 6);
      g.fillStyle = '#fff';
      g.fillText(name, sx + 8, sy - 6);
    }
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(0, innerHeight - 52, innerWidth, 52);
    g.fillStyle = '#fff';
    g.font = '12px sans-serif';
    g.fillText(`side map: teal inside ${t.site.name}'s wall (side ${side}), red open (0)`, 8, innerHeight - 32);
    g.fillText(`not valid: ${invalid.join(', ') || 'none'}`.slice(0, 70), 8, innerHeight - 12);
    return { drawn, invalid };
  }

  /**
   * The sim advanced `seconds` of the world's ticks at `speed`, frames as fast as the GPU goes, drawing every
   * `renderEvery`th. Time stops after (speed 0) unless `keep`. The towns' clock runs with the frames' dt (FieldTowns
   * update): a season's stages are best set at once (season.skip()).
   */
  async run(seconds: number, speed = 16, o: { renderEvery?: number; keep?: boolean; dt?: number } = {}): Promise<{ simSeconds: number; frames: number; wallMs: number; xRealtime: number }> {
    if (this.driving) throw new Error('lab.run: already running');
    if (!(speed > 0 && speed <= 64)) throw new Error('lab.run: speed must be in (0, 64]');
    const every = Math.max(1, Math.round(o.renderEvery ?? 8));
    const dt = o.dt ?? DT;
    if (!(dt > 0 && dt <= 0.1)) throw new Error('lab.run: dt must be in (0, 0.1] (main.ts caps a frame at 0.1 s)');
    const { core } = this.scene;
    const device = this.scene.host.gpu.device;
    const skipped = Renderer.skip.has('render');
    const t0 = performance.now();
    const tick0 = core.ticksRun;
    let sim = 0;
    let frames = 0;
    let idle = 0;
    this.driving = true;
    const before = this.scene.speed;
    this.scene.speed = speed;
    try {
      while (sim < seconds - 1e-6) {
        if (!skipped) {
          if (frames % every === 0) Renderer.skip.delete('render');
          else Renderer.skip.add('render');
        }
        const t = core.ticksRun;
        this.scene.frame(performance.now(), dt, true);
        sim = (core.ticksRun - tick0) * TICK_DT;
        frames++;
        idle = core.ticksRun === t ? idle + 1 : 0;
        if (idle > 600) throw new Error('lab.run: the world ran no tick in 600 frames (held: the streamer busy, or the planner)');
        await device.queue.onSubmittedWorkDone();
        if (document.querySelector('.fatal')) throw new Error('lab.run: the fatal overlay came up');
      }
    } finally {
      if (!skipped) Renderer.skip.delete('render');
      this.scene.speed = o.keep ? before : 0;
      this.driving = false;
    }
    this.simT += sim;
    const wallMs = performance.now() - t0;
    return { simSeconds: +sim.toFixed(2), frames, wallMs: Math.round(wallMs), xRealtime: +(sim / (wallMs / 1000)).toFixed(1) };
  }

  /** the camera on window point (x, y), at `zoom`; `aimY` the share of the screen's height from the top the point sits
   *  at (default 0.32: above the season's card sheet, as the season loop frames its districts) */
  look(x: number, y: number, zoom?: number, aimY = 0.32): void {
    const cam = this.scene.core.camera;
    if (zoom) cam.zoom = zoom;
    const z = this.scene.heightAt(x, y);
    const dy = ((0.5 - aimY) * innerHeight) / cam.zoom / Math.sin(cam.elevation);
    cam.target = [x, y + dy, z ?? cam.target[2]];
  }

  /** a screenshot (the runner's `__labShot`: scripts/lab.mjs saves it as <name>.png), after two drawn frames */
  async shot(name: string): Promise<string | null> {
    if (this.driving) throw new Error('lab.shot: not while running');
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await frames();
    await this.scene.host.gpu.device.queue.onSubmittedWorkDone();
    const hook = (window as unknown as { __labShot?: (n: string) => Promise<string> }).__labShot;
    return hook ? hook(name) : null;
  }

  /**
   * (debug read: the follow gate's) A living town's riders' rows (citylife/routes.wgsl Rider, 16 words each: pos xyz,
   * heading, job | st << 8 | leg << 16, route, cursor, home, s, timer, load, phase, goal xy, aux, col) and where its
   * grid is in the window (window = grid + [dx, dy·ROW_H, dz]) and the window in the world (world = window + origin: a
   * slide moves the window, not the riders). Null: no living town there.
   */
  async riders(id: string): Promise<{ n: number; rows: Float32Array; words: Uint32Array; place: [number, number, number]; origin: [number, number] } | null> {
    const l = this.scene.livingTowns?.live.get(id);
    if (!l) return null;
    const n = l.life.riders;
    const buf = await l.life.debugRead(l.life.rid, Math.max(16, n * 64));
    const p = l.town.gridPlace();
    const o = this.scene.stream?.origin ?? [0, 0];
    return { n, rows: new Float32Array(buf), words: new Uint32Array(buf), place: [p.dx, p.dy * ROW_H, p.dz], origin: [o[0], o[1] * ROW_H] };
  }

  readonly api = (() => {
    const lab = this;
    return {
      get ready() {
        return lab.ready;
      },
      get town() {
        return lab.town;
      },
      get towns() {
        return lab.towns;
      },
      get living(): LivingTowns | null {
        return lab.scene.livingTowns ?? null;
      },
      get season() {
        return lab.season;
      },
      /** sim seconds the lab has run since the page opened */
      get simT() {
        return lab.simT;
      },
      get dims() {
        return { w: lab.scene.core.dims.w, h: lab.scene.core.dims.h };
      },
      run: (seconds: number, speed?: number, o?: { renderEvery?: number; keep?: boolean; dt?: number }) => this.run(seconds, speed, o),
      look: (x: number, y: number, zoom?: number, aimY?: number) => this.look(x, y, zoom, aimY),
      shot: (name: string) => this.shot(name),
      project: (x: number, y: number, z: number) => this.scene.core.camera.project(x, y, z),
      viewport: () => [this.scene.core.camera.viewportW, this.scene.core.camera.viewportH],
      ground: (x: number, y: number) => this.scene.heightAt(x, y),
      riders: (id: string) => this.riders(id),
      /** (gputown) the page's recipe, and why its setup failed (null: it didn't) */
      get recipe() {
        return lab.recipe;
      },
      get recipeError() {
        return lab.recipeError;
      },
      /** the town contracts (towncontracts/contracts.ts) and a town's index in them — what an order carries */
      get contracts() {
        return lab.contracts;
      },
      townIndex: (id: string) => lab.contracts.townIndex(id),
      sides: () => this.sides(),
      sideCounts: (id: string) => this.sideCounts(id),
      places: (id: string) => this.places(id),
      markContracts: (id: string, o?: { step?: number; clear?: boolean; labels?: boolean }) => this.markContracts(id, o),
      camera: () => this.scene.core.camera,
      /** the profiler's smoothed GPU ms of a pass (with ?perf=1: the town contracts' is 'towncontracts'); null untimed */
      gpuMs: (pass: string) => this.scene.host.profiler?.passMs.get(pass) ?? null,
      /** (the page can't be put back: scripts/lab.mjs loads it again for each scenario) */
      resettable: false,
    };
  })();
}

/** ?lab=1 on the atlas level: the town lab on the scene, as `reclaimed.lab` (ready once the start town is) */
export function startTownLab(scene: LevelScene): TownLab {
  const lab = new TownLab(scene);
  scene.lab = lab;
  const R = (window as unknown as { reclaimed?: Record<string, unknown> }).reclaimed;
  if (!R) throw new Error("town lab: no window.reclaimed (the level's test API) yet");
  R.lab = lab.api;
  lab.poll();
  return lab;
}
