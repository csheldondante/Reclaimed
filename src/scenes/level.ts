// The playable valley: world + diegetic powers + HUD + level goal.

import type { Ambience } from '../audio/ambience';
import { Nature, reclamation, worldHealth } from '../game/nature';
import { Powers } from '../game/powers';
import { Director } from '../game/director';
import { Reach } from '../game/reach';
import { gatesOf, levelById, type LevelDef } from '../game/levels';
import { Trial } from '../game/trial';
import { DIFFICULTY_LEVEL, loadDifficulty, loadLevelProgress, saveProgress, type Difficulty } from '../game/progress';
import { EventKind } from '../sim/globals';
import { EDIT_OP, Editor, LAYER_TOOLS } from '../ui/editor';
import { Controls } from '../input/controls';
import { ignoreTeardown } from '../gpu/pipeline';
import { PK } from '../sim/particles';
import { Physics } from '../physics/physics';
import type { LavaSystem } from '../sim/lava';
import { installPhysics } from '../physics/install';
import { installAgents } from '../agents/install';
import type { Agents } from '../agents/agents';
import { attachSim, type Sim } from '../api/world';
import { LEVEL_H, type Block, type Town } from '../build/town';
import type { BuildCrew } from '../agents/buildcrew';
import type { Waker, WakeOptions } from '../physics/wake';
import { box, table } from '../physics/shapes';
import { boxMesh, rockMesh, type SkinMesh } from '../physics/mesh';
import { BODIES } from '../ui/editor';
import type { WorldStats } from '../sim/systems';
import { Hud } from '../ui/hud';
import type { PerfOverlay } from '../ui/perf-overlay';
import { WorldCore, type Host, type Scene } from './world-core';
import { Streamer, shiftGrid, REGION, TIER, boxOf } from './streamer';
import { Atlas, atlasParamsFrom } from '../atlas/atlas';
import { EV, eventAt } from '../atlas/coarse';
import { FarLand } from '../atlas/far';
import type { MapData } from '../world/mapgen';
import { Sleep } from '../sim/sleep';
import { AtlasMap } from '../api/atlas-map';
import { warpWindow } from '../api/atlas-world';
import { Dither, Orbit, Slice } from '../api/cutaway';
import { Puck } from '../api/puck';

/** round 83, V21: ?cutaway=1 — the camera on a puck (api/puck.ts), sliced under a roof and orbiting round a cliff */
const CUTAWAY = new URLSearchParams(location.search).get('cutaway') === '1';
import { cpuLine, cpuStats, frameSteps } from '../gpu/cpustat';
import { type Interval, CHUNK, columnSlots, K_HEADROOM, packColumn, readColumn, SLOT_WORDS, sfMat, sfZ, sfPack } from '../world/layout';
import { modelById, modelColumns, restingBase, seatColumn, type VoxelModel } from '../world/models';
import { Integrity } from '../game/integrity';
import { WorldVox } from '../game/fracture';
import { MAT } from '../world/materials';
import { cellAt, cellPos, poiWorld, ROW_H } from '../world/lattice';
import { qRotate, qYawPitchRoll } from '../grids/structures';

export interface LevelOptions {
  /** play this map instead of generating the level's (a loaded sandbox map) */
  map?: MapData;
  /** a story level played freely (the old rules: green grows anywhere, no reach) */
  free?: boolean;
  /** sandbox: restart with a loaded map, or a fresh one (undefined) */
  onLoadMap?: (map: MapData | undefined) => void;
  /** (create's, for an atlas level: the atlas, the window it made, and where that window is) */
  atlas?: { atlas: Atlas; map: MapData; origin: [number, number]; oz: number; outside: Interval[][]; ground: Float32Array };
}

/** sandbox: column slots per chunk, so placed models and strata have room */
// (round 79: 16, the most a column holds — layers.wgsl MAX_K: the mesas' undercuts, lips, talus, bigger caves
// and alcoves had 344 columns merged to fit in 12 after a tier's slide)
const SANDBOX_K = 16;
/** the atlas's columns: what a sandbox chunk holds less its headroom (more and the chunk would grow: a streamed world's chunks are all one K) */
const ATLAS_COL_K = SANDBOX_K - K_HEADROOM;
const WARMUP_TICKS = 1800; // ~30 s of sim: rivers reach equilibrium before the player looks

export class LevelScene implements Scene {
  readonly core: WorldCore;
  private nature = new Nature();
  private powers!: Powers;
  private hud!: Hud;
  private controls!: Controls;
  private abort = new AbortController();
  private keys = new Set<string>();
  private lensOn = false;
  private lensK = 0;
  private hoverWorld: [number, number] | null = null;
  /** Town tool, plan mode: the building crew and its workers (sendBuilders) */
  private buildCrew?: BuildCrew;
  /** Town tool: the plan's outlines (drawPlan) */
  private planAdd?: SVGPathElement;
  private planDel?: SVGPathElement;
  private builders?: number[];
  /** Town tool: the block under the cursor (pickTown) */
  private townHover?: Block;
  private townPicking = false;
  private surfaceCache: Uint32Array;
  private surfaceRefresh = 0;
  private renderW = 1;
  private renderH = 1;
  private initialContam = 0;
  private lastCollapsed = -1;
  private nextGroan = 20;
  private life = 0;
  private reclaimed = 0;
  private completed = false;
  private saveTimer = 0;
  private speed: number;
  private fps = 60;
 /** sleep and wake (round 80, sim/sleep.ts): the atlas level's; ?sleep=0 off */
  private sleep?: Sleep;
  private noSim = (new URLSearchParams(location.search).get('skip') ?? '').split(',').includes('sim');
  private ticksAvg = 1;
  /** the last frames' times (ms) and every hitch (a frame over 50 ms) since the level began: the phone's profile (round 79) */
  private frameMs: number[] = [];
  private hitches = 0;
  /** the long frames and what ran in each (round 80) */
  longFrames: string[] = [];
  private worstMs = 0;
  /** ?drive=speed (round 79): the camera drives itself along the atlas's nearest road at that many cells a
   *  second, zooming out with speed as the hoverbike's does — a stand-in for riding, to profile on a phone */
  private drive?: { speed: number; path: [number, number][]; s: number; dir: number; zoom: number };
  /** slow readbacks of veg and water for positional audio (refreshed ~1 Hz) */
  private vegCache?: Float32Array;
  private waterCache?: Float32Array;
  private audioRefresh = 0;
  private nextFlock = 12;
  private director!: Director;
  /** the first-play intro is running (camera directed, weather held back) */
  private intro = false;
  private smokeSeen = -1;
  private fieldRefresh = 0;
  private washedSeen = -1;
  private smokeRefresh = 0;

  /** story rules (round 30): green spreads only by seeds; the player works within its reach */
  private story = false;
  private reach?: Reach;
  private reachRefresh = 0;
  private reachBusy = false;

  /** sandbox only */
  private editor?: Editor;
  /** brush currently being dragged (sandbox) */
  private brushAt?: [number, number];
  /** the next brush event starts a new press (layer tools: a fresh layer) */
  private strokeStart = false;
  /** sandbox: physics voxels (docs/PHYSICS.md) */
  physics?: Physics;
  /** the agents layer (docs/AGENTS.md): units walking the surfaces by shared fields */
  agents!: Agents;
  /** the world as modules (docs/WORLD_API.md), made on first use of reclaimed.world */
  private worldApi?: Sim;
  /** round 83, V21: ?cutaway (api/puck.ts, api/cutaway.ts) */
  cutaway?: { puck: Puck; slice: Slice; orbit: Orbit; dither: Dither };
  /** a stand-in character's feet kept seen (Dither) for ?cutaway (scripts/cutshot.mjs); none when unset */
  cutFeet?: [number, number, number];
  /** the landform brush's stroke (range, mesa; round 64) */
  private raising?: import('../api/terrain').RaiseStroke;
  /** molten rock: the beam melts the ground into it, vents pour it (sim/lava.ts) */
  lava?: LavaSystem;
  /** sandbox: the heat beam's pointer while held */
  private beamAt?: [number, number];
  private beamWoke = -Infinity;
  private digWoke = -Infinity;
  private beamLine?: SVGLineElement;
  private beamDot?: SVGCircleElement;
  private beamPicking = false;
  /** sandbox: structural integrity and falling pieces (F7) */
  private integrity?: Integrity;
  /** sandbox: a smash drag in progress */
  private smashing = false;
  /** (round 83) flying: a drag turns the view — where the pointer was */
  private flyDrag?: [number, number];
  /** sandbox: the brush's footprint drawn on the ground under the cursor */
  private ring?: SVGPolylineElement;
  /** Break tool: the sphere's equator (the ring is its outline) */
  private ring2?: SVGPolylineElement;
  /** Break tool: the voxel under the cursor (x, y, z: the sphere's centre, as smashAt aims) */
  private smashHover?: [number, number, number];
  private smashPicking = false;
  /** the streamed world (level.stream, round 66): the window slides with the camera */
  stream?: Streamer;
  /** meteors in flight (round 48): from the sky to where they'll hit, t seconds of dur */
  private meteors: { from: [number, number, number]; to: [number, number, number]; t: number; dur: number }[] = [];

  private constructor(
    private host: Host,
    private audio: Ambience,
    private perf: PerfOverlay,
    readonly level: LevelDef,
    private onExit: () => void,
    private opts: LevelOptions,
  ) {
    const dims = { w: 256, h: 256, zMax: level.zMax ?? 64 };
    if (!level.generate) throw new Error(`level "${level.id}" is not built yet`);
    this.core = new WorldCore(host, opts.map ?? opts.atlas?.map ?? level.generate(dims), host.quality.particles, level.sandbox ? SANDBOX_K : undefined, true, level.meshRoom);
    // (grids, the rendering branch, opens in free play; ?mode=story for the story's rules)
    this.story = !!level.story && !opts.free && host.params.get('mode') === 'story';
    this.core.globals.story = this.story;
    // (round 79) the sea past a streamed window's edge, from the start (the warmup drained it otherwise)
    if (opts.atlas) this.core.globals.seaZ = opts.atlas.atlas.p.sea - opts.atlas.oz;
    this.speed = Math.max(1, Number(host.params.get('speed') ?? 1));
    const dq = host.params.get('difficulty');
    const diff: Difficulty = dq === 'easy' || dq === 'medium' || dq === 'hard' ? dq : loadDifficulty();
    this.core.globals.difficulty = DIFFICULTY_LEVEL[diff];
    const p = host.params;
    if (p.get('day')) this.core.dayNight.dayLength = Math.max(10, Number(p.get('day')));
    if (p.get('tod')) this.core.dayNight.timeOfDay = Number(p.get('tod')) % 1;
    // the season (round 51): ?season=0..1 (0.5: autumn colours, 0.65: leaves falling), ?year=<s> to let it turn
    if (p.get('season')) this.core.globals.season = Number(p.get('season')) % 1;
    if (p.get('year')) this.core.yearLength = Math.max(10, Number(p.get('year')));
    this.core.camera.target = [dims.w * 0.55, dims.h * ROW_H * 0.5, 14];
    if (opts.atlas) {
      // (the atlas's land stands higher: look at the ground in the middle)
      const c = (dims.h / 2) * dims.w + dims.w / 2;
      this.core.camera.target = [dims.w / 2, dims.h * ROW_H * 0.5, this.core.map.surface[c]];
      // the atlas's climate before the world settles (warmed at the default, its snow melted and froze to sheets)
      this.core.globals.climate = opts.atlas.atlas.climateAt(opts.atlas.origin[0] + dims.w / 2, opts.atlas.origin[1] + dims.h / 2, opts.atlas.oz);
    }
    this.surfaceCache = new Uint32Array(dims.w * dims.h);
    for (let i = 0; i < this.surfaceCache.length; i++) this.surfaceCache[i] = sfPack(this.core.map.surface[i], 0);
  }

  private worldEvents: Promise<void> = Promise.resolve();
  /** the geysers in the window (Atlas.geysersIn: found again when the window moves), the time, which are going */
  private geysers: import('../atlas/atlas').Geyser[] = [];
  private geysersAt = '';
  private geyserT = 0;
  private geyserOn = new Set<number>();

  /**
   * Geysers (round 75): each goes for a few seconds every half a minute or so — a jet of water and a
   * plume of steam out of its vent, its water spilling over the sinter round it; a few puffs of steam
   * before it goes.
   */
  private stepGeysers(dt: number): void {
    const S = this.stream;
    const a = this.opts.atlas;
    if (!S || !a) return;
    const { core } = this;
    const { w: W, h: H } = core.dims;
    const key = `${S.origin[0]},${S.origin[1]}`;
    if (key !== this.geysersAt) {
      this.geysersAt = key;
      this.geysers = a.atlas.geysersIn(S.origin[0], S.origin[1], W, H);
      this.geyserOn.clear();
    }
    this.geyserT += dt;
    const parts = core.sim.particles;
    const dev = core.host.gpu.device;
    this.geysers.forEach((g, k) => {
      const x = g.x - S.origin[0];
      const y = g.y - S.origin[1];
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x;
      const [px, py] = cellPos(x, y);
      const z = core.map.surface[i];
      const t = (this.geyserT + g.phase) % g.period;
      const going = t < g.last;
      if (going) {
        // (the jet surges and falls back through its eruption)
        const surge = Math.sin((t / g.last) * Math.PI);
        const jet = 14 + 22 * surge;
        parts.burst({ kind: PK.Splash, x: px, y: py, z: z + 0.5, count: 36, speed: 2.4, spread: 0.45, vel: [0, 0, jet] });
        // (the column of spray up its height, and the steam boiling off the top of it)
        const up = (jet * jet) / 30;
        for (let h = 2; h < up; h += 4) parts.burst({ kind: PK.Haze, x: px, y: py, z: z + h, count: 1, speed: 0.6, spread: 0.6, payload: MAT.Snow, vel: [0, 0, 3] });
        parts.burst({ kind: PK.Haze, x: px, y: py, z: z + up, count: 3, speed: 1.5, spread: 1.6, payload: MAT.Snow, vel: [0, 0, 5] });
      } else if (t > g.period - 3 && Math.random() < 0.15) {
        parts.burst({ kind: PK.Haze, x: px, y: py, z: z + 1, count: 2, speed: 0.6, spread: 0.5, payload: MAT.Snow, vel: [0, 0, 2] });
      }
      if (going !== this.geyserOn.has(k)) {
        if (going) this.geyserOn.add(k);
        else this.geyserOn.delete(k);
        dev.queue.writeBuffer(core.world.waterSource, i * 4, new Float32Array([going ? 0.08 : 0]));
      }
    });
  }
  private atlasCtl?: HTMLDivElement;
  private far?: FarLand;

  /**
   * Buttons for the atlas level, for touch (round 72): the free camera on and off; while flying,
   * held: forward, back, up, down (a finger's drag looks round, a pinch moves along the view);
   * a great meteor or an eruption at the ground in the middle of the screen.
   */
  private atlasControls(): void {
    const d = document.createElement('div');
    d.className = 'atlas-ctl';
    d.style.cssText = 'position:absolute;right:8px;bottom:8px;display:flex;flex-wrap:wrap;gap:6px;max-width:220px;justify-content:flex-end;z-index:5;';
    const btn = (label: string, title: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.style.cssText = 'min-width:44px;height:44px;font:18px system-ui,sans-serif;border-radius:8px;border:1px solid #888;background:rgba(20,22,24,0.8);color:#eee;touch-action:none;';
      d.appendChild(b);
      return b;
    };
    const hold = (b: HTMLButtonElement, key: string) => {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.keys.add(key);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => this.keys.delete(key));
    };
    const moves: HTMLButtonElement[] = [];
    // (round 80) the atlas as a map: where you are; tap to warp
    const a = this.opts.atlas;
    if (a && this.stream) {
      const S = this.stream;
      const dims = this.core.dims;
      const map = new AtlasMap(
        { atlas: a.atlas, core: this.core, stream: S, warp: (x, y) => warpWindow(a.atlas, S, dims, x, y), toWorld: (x, y) => [S.origin[0] + x, S.origin[1] + y / ROW_H] },
        this.host.ui,
      );
      btn('🗺', 'the atlas map: where you are; tap a place to warp there').addEventListener('click', () => map.toggle());
    }
    const fly = btn('✈', 'free camera (F)');
    const mv = (label: string, key: string, title: string) => {
      const b = btn(label, title);
      hold(b, key);
      b.style.display = 'none';
      moves.push(b);
    };
    mv('⇧', 'w', 'forward (W)');
    mv('⇩', 's', 'back (S)');
    mv('▲', 'e', 'up (E)');
    mv('▼', 'q', 'down (Q)');
    const show = () => {
      for (const b of moves) b.style.display = this.core.camera.fly ? '' : 'none';
      fly.style.background = this.core.camera.fly ? 'rgba(60,90,140,0.9)' : 'rgba(20,22,24,0.8)';
    };
    fly.addEventListener('click', () => {
      this.toggleFly();
      show();
    });
    window.addEventListener('keydown', (e) => e.key.toLowerCase() === 'f' && setTimeout(show), { signal: this.abort.signal });
    const atMiddle = (f: (x: number, y: number) => void) => {
      const cam = this.core.camera;
      const g = cam.groundAt(cam.viewportW / 2, cam.viewportH / 2, this.heightAt);
      const [x, y] = cellAt(g[0], g[1]);
      f(x, y);
    };
    btn('☄', 'a great meteor at the middle of the screen (M at the pointer)').addEventListener('click', () => atMiddle((x, y) => this.worldAt(x, y, (wx, wy, c) => c.meteor(wx, wy))));
    btn('🌋', 'an eruption at the middle of the screen (V at the pointer)').addEventListener('click', () => atMiddle((x, y) => this.worldAt(x, y, (wx, wy, c) => c.erupt(wx, wy))));
    this.host.ui.appendChild(d);
    this.atlasCtl = d;
  }
  private coarseFrame = 0;

  /** Window cell (x, y) as a world point (world units), for the coarse world. */
  private worldAt(x: number, y: number, f: (wx: number, wy: number, c: import('../atlas/coarse').Coarse) => void): void {
    const a = this.opts.atlas;
    if (!a || !this.stream) throw new Error('the coarse world is the atlas level\'s');
    const gx = this.stream.origin[0] + x;
    const gy = this.stream.origin[1] + y;
    f(gx + 0.5 + 0.5 * (((gy % 2) + 2) % 2), (gy + 0.5) * ROW_H, a.atlas.coarse);
  }

  /**
   * A coarse event, in the window's columns too where it reaches into it (coarse.ts eventAt: the same
   * shapes, cell by cell), with what can be seen of it: a meteor's flash and blast, an eruption's vent.
   */
  private async worldEventHere(e: import('../atlas/coarse').CoarseEvent): Promise<void> {
    const a = this.opts.atlas;
    const S = this.stream;
    if (!a || !S) return;
    const { w: W, h: H } = this.core.dims;
    const { worldW, worldH } = a.atlas;
    const reach = e.kind === EV.meteor ? e.r * 3 : e.kind === EV.ash ? e.r * 3.5 : e.r;
    // the event's middle in window cells (the short way round the torus)
    let ex = e.x - (S.origin[0] + 0.5);
    let ey = e.y / ROW_H - (S.origin[1] + 0.5);
    ex -= Math.round(ex / worldW) * worldW;
    ey -= Math.round(ey / (worldH / ROW_H)) * (worldH / ROW_H);
    // (round 80: what it cuts or buries in the window wakes — its columns change under a sleeping chunk)
    this.sleep?.wake(ex + 0.5, (ey + 0.5) * ROW_H, reach + 16, Sleep.EVENT_S, performance.now() / 1000);
    const rc = reach / ROW_H;
    const x0 = Math.floor(ex - reach);
    const x1 = Math.ceil(ex + reach);
    const y0 = Math.floor(ey - rc);
    const y1 = Math.ceil(ey + rc);
    if (x1 < 0 || y1 < 0 || x0 >= W || y0 >= H) return;
    const n = await S.editLive(x0, y0, x1, y1, (x, y) => {
      const gx = S.origin[0] + x;
      const gy = S.origin[1] + y;
      const d = eventAt(e, gx + 0.5 + 0.5 * (((gy % 2) + 2) % 2), (gy + 0.5) * ROW_H, worldW, worldH);
      return { ...d, cap: e.kind === EV.cone ? MAT.Basalt : 0 };
    });
    for (let i = 0; i < this.surfaceCache.length; i++) this.surfaceCache[i] = sfPack(this.core.map.surface[i], 0);
    this.integrity?.clear();
    const cx = Math.min(W - 1, Math.max(0, Math.round(ex)));
    const cy = Math.min(H - 1, Math.max(0, Math.round(ey)));
    const [px, py] = cellPos(cx, cy);
    const z = this.core.map.surface[cy * W + cx];
    if (e.kind === EV.meteor && n) this.impact([px, py, z]);
    if (e.kind === EV.cone && n) this.lava?.addVent(px, py, 60, 12, 3, 0);
  }

  /** The free camera on (from where the fixed view looks from, the same way) or off (looking at the ground under the screen's middle). */
  toggleFly(): void {
    const { camera } = this.core;
    if (camera.fly) {
      const g = camera.groundAt(camera.viewportW / 2, camera.viewportH / 2, this.heightAt);
      camera.fly = null;
      camera.target = [g[0], g[1], g[2]];
      this.editor?.setVisible(true);
      this.hud.say('Fixed view', 2);
      return;
    }
    const [tx, ty, tz] = camera.target;
    const e = camera.eye;
    const d = Math.max(40, camera.viewportH / camera.zoom);
    camera.fly = { pos: [tx + e[0] * d, ty + e[1] * d, tz + e[2] * d], yaw: Math.atan2(-e[1], -e[0]), pitch: -Math.asin(e[2]), fov: (60 * Math.PI) / 180 };
    this.editor?.setVisible(false);
    this.hud.say('Free camera — WASD or ⇧⇩▲▼ to fly (Q/E down/up, Shift faster), drag to turn, wheel or pinch to move along the view; F or ✈ back', 6);
  }

  /** forget the steps so far (driveprofile: from when riding starts) */
  cpuReset(): void {
    cpuStats.clear();
  }

  /** the main thread's worst steps (round 80, for driveprofile) */
  cpuWorst(): Record<string, { max: number; n: number }> {
    return Object.fromEntries([...cpuStats.entries()].map(([k, v]) => [k, { max: +v.max.toFixed(1), n: v.n }]));
  }

  /** the phone's profile (round 79): frame times over the last 300 frames, hitches, the streamer's slides */
  private perfLines(): string[] {
    const f = [...this.frameMs].sort((a, b) => a - b);
    const q = (p: number) => (f.length ? f[Math.min(f.length - 1, Math.floor(p * f.length))] : 0);
    const out = [`frame ms p50 ${q(0.5).toFixed(1)}  p95 ${q(0.95).toFixed(1)}  worst ${this.worstMs.toFixed(0)}  hitches(>50) ${this.hitches}`];
    const S = this.stream;
    if (S) out.push(`stream slides ${S.stats.slides}  z ${S.stats.tiers}  last ${S.stats.lastMs}ms  made ${S.stats.generated}  thawed ${S.stats.thawed}${S.busy ? '  BUSY' : ''}`);
    if (this.drive) out.push(`drive ${this.drive.speed}/s  zoom ${this.core.camera.zoom.toFixed(2)}`);
    out.push(`cpu worst ms: ${cpuLine()}`);
    // (the last long frames and what ran in them: '-' is the GPU's or the browser's)
    for (const l of this.longFrames.slice(-3)) out.push(`long ${l.slice(0, 90)}`);
    if (this.sleep) out.push(`awake chunks ${this.sleep.awake} of ${(this.core.dims.w / CHUNK) * (this.core.dims.h / CHUNK)}`);
    return out;
  }

  /** ?drive: along the road from where it is, back again at its end (world points, the window's origin taken off) */
  private driveOn(dt: number): void {
    const d = this.drive!;
    const S = this.stream;
    if (!S || d.path.length < 2) return;
    d.s += d.dir * d.speed * dt;
    let len = 0;
    for (let k = 1; k < d.path.length; k++) {
      const seg = Math.hypot(d.path[k][0] - d.path[k - 1][0], d.path[k][1] - d.path[k - 1][1]);
      if (d.s <= len + seg || k === d.path.length - 1) {
        const t = Math.max(0, Math.min(1, (d.s - len) / seg));
        const wx = d.path[k - 1][0] + (d.path[k][0] - d.path[k - 1][0]) * t;
        const wy = d.path[k - 1][1] + (d.path[k][1] - d.path[k - 1][1]) * t;
        if (d.s > len + seg) d.dir = -1;
        const cam = this.core.camera;
        cam.target[0] = wx - S.origin[0];
        cam.target[1] = wy - S.origin[1] * ROW_H;
        break;
      }
      len += seg;
    }
    if (d.s < 0) d.dir = 1;
    this.core.camera.zoom = d.zoom / (1 + d.speed / 40);
  }

  /** Flying: WASD along the view (level), Q/E down and up; the window's middle follows the camera. */
  private flyKeys(dt: number): void {
    const { camera, dims } = this.core;
    const fly = camera.fly!;
    const k = this.keys;
    const speed = (k.has('shift') ? 120 : 35) * dt;
    const { f } = camera.basis();
    const hl = Math.hypot(f[0], f[1]) || 1;
    const fx = f[0] / hl;
    const fy = f[1] / hl;
    let m = 0;
    let s = 0;
    if (k.has('w') || k.has('arrowup')) m += 1;
    if (k.has('s') || k.has('arrowdown')) m -= 1;
    if (k.has('d') || k.has('arrowright')) s += 1;
    if (k.has('a') || k.has('arrowleft')) s -= 1;
    fly.pos[0] += (fx * m + fy * s) * speed;
    fly.pos[1] += (fy * m - fx * s) * speed;
    if (k.has('e')) fly.pos[2] += speed;
    if (k.has('q')) fly.pos[2] -= speed;
    // (inside the window, over the ground under it)
    fly.pos[0] = Math.max(1, Math.min(dims.w - 1, fly.pos[0]));
    fly.pos[1] = Math.max(1, Math.min(dims.h * ROW_H - 1, fly.pos[1]));
    fly.pos[2] = Math.max(this.heightAt(fly.pos[0], fly.pos[1]) + 1.5, Math.min(dims.zMax + 200, fly.pos[2]));
    // the window streams round where the camera is
    camera.target[0] = fly.pos[0];
    camera.target[1] = fly.pos[1];
  }

  /** Builds the level and settles it (rivers, slopes) before returning. */
  static async create(host: Host, audio: Ambience, perf: PerfOverlay, levelId: string, onExit: () => void, opts: LevelOptions = {}): Promise<LevelScene> {
    const level = levelById(levelId);
    if (level.atlas && !opts.map) {
      // the world's atlas first (atlas/atlas.ts), then the window onto it where we start (?at=x,y cells, or its own spawn)
      const zMax = level.zMax ?? 64;
      // (the atlas is taller than the window: it slides in z — round 69)
      const atlas = await Atlas.build(host.gpu.device, atlasParamsFrom(host.params));
      const at = host.params.get('at');
      const [cx, cy] = at ? (at.split(',').map(Number) as [number, number]) : atlas.spawn();
      // (?win=: a wider window, whole regions — round 79, the user: "stream in a few more blocks out to see
      // more of the terrain at a time … nice for debugging even if too slow for mobile")
      const W = Number(host.params.get('win') ?? 256);
      if (!(W >= 256 && W % REGION === 0)) throw new Error(`?win= must be 256 or more, whole regions of ${REGION}`);
      const origin: [number, number] = [Math.round((cx - W / 2) / REGION) * REGION, Math.round((cy - W / 2) / REGION) * REGION];
      const { map, oz, outside, ground } = await atlas.window({ w: W, h: W, zMax }, origin[0], origin[1], ATLAS_COL_K, TIER);
      // (round 80: its column batches timed in the perf overlay)
      atlas.profiler = host.profiler;
      opts = { ...opts, atlas: { atlas, map, origin, oz, outside, ground } };
    }
    const s = new LevelScene(host, audio, perf, level, onExit, opts);
    // ecology excluded so nothing grows during settling; ground debris (dust,
    // litter, fallen leaves) accumulates fast so the level opens with it lying about.
    // A saved map was settled when it was saved: a short prime only.
    // (a streamed world: none — the strips that come in later get no such start)
    s.core.globals.debrisBoost = opts.map || level.stream ? 1 : 10;
    await s.core.warmup(opts.map ? 30 : WARMUP_TICKS, (sys) => sys.name !== 'ecology');
    s.core.globals.debrisBoost = 1;
    s.attach();
    return s;
  }

  private heightAt = (x: number, y: number): number => {
    const { w, h } = this.core.dims;
    const [cx, cy] = cellAt(x, y);
    const ix = Math.max(0, Math.min(w - 1, cx));
    const iy = Math.max(0, Math.min(h - 1, cy));
    return sfZ(this.surfaceCache[iy * w + ix]);
  };

  private attach(): void {
    const { core, host, audio } = this;
    const { camera, sim, weather, globals, map, dims } = core;
    const readSurface = async () => new Uint32Array((await core.readBuffer('surface')).buffer);

    this.hud = new Hud(host.ui, (on) => (this.lensOn = on));
    this.powers = new Powers({
      weather,
      audio,
      hud: this.hud,
      particles: sim.particles,
      globals,
      camera,
      dims,
      readSurface,
      heightAt: this.heightAt,
      birdsFlushed: async () => new Uint32Array((await core.readBuffer('particleCounters')).buffer)[1],
      waterAt: (x, y) => {
        const [cx, cy] = cellAt(x, y);
        return cx < 0 || cy < 0 || cx >= dims.w || cy >= dims.h ? 0 : (this.waterCache?.[cy * dims.w + cx] ?? 0);
      },
    });
    // tapped metal rings by its size: count the metal voxels connected to the
    // tapped one (a capped flood fill on a read-back of the layers; round 20)
    this.powers.metalSize = async (x, y, z) => {
      const w = new WorldVox(core.packed, new Uint32Array((await core.readBuffer('layers')).buffer));
      const metal = (m: number) => m === MAT.Rust || m === MAT.Steel;
      let start: [number, number, number] | undefined;
      for (const zz of [z, z - 1, z + 1]) if (metal(w.matAt(x, y, zz))) start = [x, y, zz];
      if (!start) return 1;
      const seen = new Set<string>([start.join(',')]);
      const stack = [start];
      while (stack.length && seen.size < 3000) {
        const [a, b, c] = stack.pop()!;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const k = `${a + dx},${b + dy},${c + dz}`;
          if (seen.has(k) || !metal(w.matAt(a + dx, b + dy, c + dz))) continue;
          seen.add(k);
          stack.push([a + dx, b + dy, c + dz]);
        }
      }
      return seen.size;
    };

    // a few animals already live in the one healthy corner when the level opens
    const hz = map.surface[map.poi.healthy[1] * dims.w + map.poi.healthy[0]];
    const [hx, hy] = poiWorld(map.poi.healthy);
    sim.particles.burst({ kind: PK.Rabbit, x: hx, y: hy, z: hz + 0.3, count: 4, speed: 1, spread: 4 });
    sim.particles.burst({ kind: PK.Deer, x: hx + 2, y: hy - 2, z: hz + 0.4, count: 2, speed: 1, spread: 3 });
    // birds already perch in its trees (they look for crowns as they arrive)
    sim.particles.burst({ kind: PK.Bird, x: hx, y: hy, z: hz + 8, count: 5, speed: 3, spread: 3 });
    this.director = new Director(camera);
    const p = host.params;
    this.intro = !this.story && !!this.level.intro && (p.get('tutorial') === '1' || (p.get('tutorial') !== '0' && p.get('skipmenu') !== '1' && loadLevelProgress(this.level.id) === 0));
    this.agents = installAgents(core);
    if (this.level.sandbox) {
      // the physics voxels (one GPU solver for every material, docs/PHYSICS.md)
      // and lava; the map's own ruins stay terrain until something touches
      // them (wake): the beam, the break tool, a body hitting them
      const kit = installPhysics(core, { wakeOnTouch: false });
      this.physics = kit.physics;
      this.lava = kit.lava;
      this.waker = kit.waker;
      kit.physics.onTouch = (cols) => {
        for (const c of cols) {
          const [x, y] = cellPos(c % dims.w, Math.floor(c / dims.w));
          void this.wake(x, y, -1, 1.5);
        }
      };
      this.editor = new Editor(host.ui, (sp) => (this.speed = sp), {
        undo: () => this.undo(),
        capture: () => this.core.captureMap(),
        load: (map) => this.opts.onLoadMap?.(map),
        fresh: () => this.opts.onLoadMap?.(undefined),
        say: (t) => this.hud.say(t, 3),
        crew: () => this.sendBuilders(),
      });
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'brush-ring');
      // inline: the UI layer's own rules give its children pointer events, and
      // a full-screen overlay that takes them swallows every click after the
      // ring first appears (round 14: "it doesn't let me place objects")
      svg.style.pointerEvents = 'none';
      this.ring = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      svg.appendChild(this.ring);
      this.ring2 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      this.ring2.setAttribute('class', 'equator');
      svg.appendChild(this.ring2);
      // the heat beam: a line down from the sky to where it's aimed, and a dot there
      // (its own overlay: the brush ring's hides when no brush is out)
      const beamSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      beamSvg.setAttribute('class', 'brush-ring');
      beamSvg.style.pointerEvents = 'none';
      this.beamLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      this.beamLine.setAttribute('class', 'heat-beam');
      beamSvg.appendChild(this.beamLine);
      this.beamDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      this.beamDot.setAttribute('class', 'heat-beam-dot');
      this.beamDot.setAttribute('r', '0');
      beamSvg.appendChild(this.beamDot);
      host.ui.appendChild(beamSvg);
      host.ui.appendChild(svg);
      // pours keep landing after the press: the edit pass runs every tick
      core.sim.edit.always = true;
      // the physics playground (F7, G5): what breaks free falls as rigid
      // pieces; the structure system only collapses damage
      const integ = new Integrity(core);
      this.integrity = integ;
      core.integrity = integ;
      // lightning seeks what you see (loose ground, fallen bodies) and breaks
      // the bodies it strikes (round 19)
      this.powers.topAt = (x, y) => integ.topAt(x, y);
      this.powers.onStrike = (x, y, z) => {
        integ.breakBodies([x, y, z], 2.6);
        integ.markDirty(x, y, 16);
      };
      this.integrity.onChips = (x, y, z, count) => {
        core.sim.particles.burst({ kind: PK.Chip, x, y, z, count, speed: 3, spread: 0.8 });
        this.audio.chip(camera.project(x, y, z)[0] / camera.viewportW);
      };
      this.integrity.onCollapse = (x, y, z, amount) => this.audio.collapse(amount, camera.project(x, y, z)[0] / camera.viewportW);
      // dust grains, and a see-through cloud of the material (one puff per five grains)
      this.integrity.onDust = (x, y, z, count, spread, mat) => {
        core.sim.particles.burst({ kind: PK.Dust, x, y, z, count, speed: 1.4, spread });
        core.sim.particles.burst({ kind: PK.Haze, x, y, z: z + 0.5, count: Math.ceil(count / 5), speed: 0.8, payload: mat, spread: spread * 0.8 });
      };
      core.globals.spanCollapse = false;
      weather.holdNatural(1e9);
    }

    const zoomAt = (sx: number, sy: number, factor: number) => {
      // (flying: the wheel moves along the view)
      if (camera.fly) {
        const { f } = camera.basis();
        const step = Math.log(factor) * 40;
        for (let i = 0; i < 3; i++) camera.fly.pos[i] += f[i] * step;
        return;
      }
      const before = camera.screenDeltaToWorld(sx - camera.viewportW / 2, sy - camera.viewportH / 2);
      camera.zoom = Math.max(0.8, Math.min(24, camera.zoom * factor));
      const after = camera.screenDeltaToWorld(sx - camera.viewportW / 2, sy - camera.viewportH / 2);
      camera.target[0] += before[0] - after[0];
      camera.target[1] += before[1] - after[1];
    };
    const toRender = (x: number, y: number): [number, number] => [
      (x / camera.viewportW) * this.renderW,
      (y / camera.viewportH) * this.renderH,
    ];
    this.controls = new Controls(host.canvas, {
      tap: (sx, sy) => {
        // (round 83: flying, the pointer only turns the view)
        if (camera.fly) return;
        if (this.editor?.tool === 'smash') return void this.smashAt(sx, sy, true);
        if (this.editor?.tool === 'place') return void this.placeAtPick(sx, sy);
        if (this.editor?.tool === 'town') return void this.townAtPick(sx, sy);
        if (this.editor?.tool === 'drop') return void this.dropAtPick(sx, sy);
        if (this.editor?.tool === 'beam') return;
        if (this.editor?.tool === 'volcano') return void this.ventAtPick(sx, sy);
        if (this.editor?.tool === 'meteor') return void this.meteorAtPick(sx, sy);
        const [wx, wy] = camera.groundAt(sx, sy, this.heightAt);
        if (this.editTool(wx, wy, true)) return;
        // (story: nothing answers out in the fog beyond the green's reach)
        if (this.reach && !this.reach.contains(wx, wy)) return;
        const [rx, ry] = toRender(sx, sy);
        core.renderer.pick(rx, ry).then((hit) => this.powers.tap(hit, wx, wy, sx, sy));
      },
      dragStart: (sx, sy) => {
        if (camera.fly) {
          this.flyDrag = [sx, sy];
          return true;
        }
        if (this.editor?.tool === 'smash') {
          this.smashAt(sx, sy, true);
          this.smashing = true;
          return true;
        }
        if (this.editor?.tool === 'drop') {
          this.dropAtPick(sx, sy);
          return true;
        }
        // the heat beam: on while held, aimed at what's under the pointer (frame())
        if (this.editor?.tool === 'beam') {
          this.beamAt = this.beamAim(sx, sy);
          return true;
        }
        // (a press that turns into a drag still places, once)
        if (this.editor?.tool === 'place') {
          this.placeAtPick(sx, sy);
          return true;
        }
        if (this.editor?.tool === 'town') {
          this.townAtPick(sx, sy);
          return true;
        }
        const [wx, wy] = camera.groundAt(sx, sy, this.heightAt);
        if (this.editTool(wx, wy, false)) return true;
        if (this.reach && !this.reach.contains(wx, wy)) return false;
        return this.powers.gustStart(wx, wy);
      },
      dragMove: (sx, sy) => {
        if (this.flyDrag) {
          const [px, py] = this.flyDrag;
          this.flyDrag = [sx, sy];
          if (camera.fly) {
            camera.fly.yaw -= (sx - px) * 0.004;
            camera.fly.pitch = Math.max(-1.5, Math.min(1.5, camera.fly.pitch - (sy - py) * 0.004));
          }
          return;
        }
        if (this.beamAt) return void (this.beamAt = this.beamAim(sx, sy));
        if (this.smashing) {
          this.pickSmash(sx, sy);
          return void this.smashAt(sx, sy, false);
        }
        const [wx, wy] = camera.groundAt(sx, sy, this.heightAt);
        if (this.brushAt) this.brushAt = [wx, wy];
        else this.powers.gustMove(wx, wy);
      },
      dragEnd: () => {
        if (this.flyDrag) return void (this.flyDrag = undefined);
        if (this.beamAt) {
          this.beamAt = undefined;
          if (this.physics) this.physics.beam = null;
          if (this.lava) this.lava.beam = null;
          this.beamLine?.setAttribute('x1', '0');
          this.beamLine?.setAttribute('x2', '0');
          this.beamLine?.setAttribute('y1', '0');
          this.beamLine?.setAttribute('y2', '0');
          this.beamDot?.setAttribute('r', '0');
          return;
        }
        this.smashing = false;
        this.raising?.end();
        this.raising = undefined;
        if (this.brushAt) this.brushAt = undefined;
        else this.powers.gustEnd();
      },
      hover: (sx, sy) => {
        const hw = camera.groundAt(sx, sy, this.heightAt).slice(0, 2) as [number, number];
        this.hoverWorld = this.reach && !this.reach.contains(hw[0], hw[1]) ? null : hw;
        if (this.editor?.tool === 'smash') this.pickSmash(sx, sy);
        if (this.editor?.tool === 'town') this.pickTown(sx, sy);
      },
      pan: (dx, dy) => {
        // (flying: a right drag looks round)
        if (camera.fly) {
          camera.fly.yaw -= dx * 0.004;
          camera.fly.pitch = Math.max(-1.5, Math.min(1.5, camera.fly.pitch - dy * 0.004));
          return;
        }
        const [wx, wy] = camera.screenDeltaToWorld(dx, dy);
        camera.target[0] -= wx;
        camera.target[1] -= wy;
      },
      zoomAt,
    });

    const signal = this.abort.signal;
    window.addEventListener(
      'keydown',
      (e) => {
        this.keys.add(e.key.toLowerCase());
        if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && this.editor) {
          e.preventDefault();
          this.undo();
          return;
        }
        if (e.key.toLowerCase() === 'e' && this.editor?.tool === 'place') this.editor.rotate();
        if (e.key === 'Escape' && this.intro) this.director.cancel();
        // (the atlas level, round 71) M: a great meteor where the pointer is; V: an eruption there
        if (this.opts.atlas && this.hoverWorld && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement)) {
          const [hx, hy] = cellAt(this.hoverWorld[0], this.hoverWorld[1]);
          if (e.key.toLowerCase() === 'm') this.worldAt(hx, hy, (wx, wy, c) => c.meteor(wx, wy));
          if (e.key.toLowerCase() === 'v') this.worldAt(hx, hy, (wx, wy, c) => c.erupt(wx, wy));
        }
        // F: the free camera (round 69: fly round the world in perspective), and back
        if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement)) this.toggleFly();
        if (e.key === ' ') {
          e.preventDefault();
          if (!this.lensOn) this.hud.say('Life lens — green: growing · magenta: toxic · grey: sealed · amber: too dry · blue: ready for life', 4);
          this.lensOn = true;
        }
      },
      { signal },
    );
    window.addEventListener(
      'keyup',
      (e) => {
        this.keys.delete(e.key.toLowerCase());
        if (e.key === ' ') this.lensOn = false;
      },
      { signal },
    );

    const self = this;
    const api = {
      core,
      sim,
      world: core.world,
      weather,
      camera,
      renderer: core.renderer,
      map,
      packed: core.packed,
      globals,
      nature: this.nature,
      powers: this.powers,
      readBuffer: (n: Parameters<WorldCore['readBuffer']>[0]) => core.readBuffer(n),
      probe: (...a: Parameters<WorldCore['probe']>) => core.probe(...a),
      integrity: () => this.integrity,
      // agents: agents.spawn(200, x, y, { group: 0 }); agents.goTo(0, x, y)
      agents: this.agents,
      // physics voxels (sandbox): phys.drop('steel', 5, 1, 10, x, y, 6) — a w × d × h box
      // of a material, its centre at world (x, y), `above` cells over the ground
      phys: {
        get physics() {
          return self.physics;
        },
        shapes: { box, table },
        meshes: { box: boxMesh, rock: rockMesh },
        /** wake ruin (or, with opts, terrain) within r of (x, y, z) into bodies (physics/wake.ts) */
        wake: (x: number, y: number, z: number, r: number, opts?: WakeOptions) => this.waker?.wake(x, y, z, r, opts),
        /**
         * a mesh as a body over a lattice `voxel` cells apart (round 49): its
         * lowest point `above` the ground under (x, y), turned by yaw/pitch/roll (degrees)
         */
        dropMesh: async (mesh: SkinMesh, voxel: number, x: number, y: number, above = 0, yaw = 0, pitch = 0, roll = 0, vel: [number, number, number] = [0, 0, 0]) => {
          const phys = this.physics;
          if (!phys) return null;
          const r = Math.PI / 180;
          const q = qYawPitchRoll(yaw * r, pitch * r, roll * r);
          let lo = [Infinity, Infinity, Infinity];
          let hi = [-Infinity, -Infinity, -Infinity];
          for (let i = 0; i < mesh.pos.length; i += 3) {
            lo = lo.map((v, k) => Math.min(v, mesh.pos[i + k]));
            hi = hi.map((v, k) => Math.max(v, mesh.pos[i + k]));
          }
          // (the lattice's low corner is the mesh frame's origin: about its bounds' corner)
          const ext = hi.map((v, k) => Math.ceil((v - lo[k]) / voxel - 1e-6) * voxel) as [number, number, number];
          const pts: [number, number, number][] = [];
          for (let k = 0; k <= 2; k++) for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) pts.push(qRotate(q, [(ext[0] * i) / 2, (ext[1] * j) / 2, (ext[2] * k) / 2]));
          const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
          const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
          const lowZ = Math.min(...pts.map((p) => p[2]));
          const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
          let ground = 0;
          for (const p of pts) {
            const [gx, gy] = cellAt(x - cx + p[0], y - cy + p[1]);
            if (gx < 0 || gy < 0 || gx >= dims.w || gy >= dims.h) continue;
            const col = readColumn(core.packed, slots, gx, gy);
            if (col.length) ground = Math.max(ground, col[col.length - 1].z1);
          }
          return phys.spawnMesh(mesh, voxel, [x - cx, y - cy, ground + above - lowZ], q, vel);
        },
        spawn: async (m: VoxelModel, x: number, y: number, above = 0, yaw = 0, pitch = 0, roll = 0, vel: [number, number, number] = [0, 0, 0], floor = 0) => {
          const r = Math.PI / 180;
          const q = qYawPitchRoll(yaw * r, pitch * r, roll * r);
          const vs = m.voxel ?? 1;
          const [w, d, h] = m.size.map((n) => n * vs);
          // its lowest point `above` the highest ground (loose ground too) under its footprint
          const pts: [number, number, number][] = [];
          for (let k = 0; k <= 4; k++) for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) pts.push(qRotate(q, [(w * i) / 4, (d * j) / 4, (h * k) / 4]));
          const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
          const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
          const lowZ = Math.min(...pts.map((p) => p[2]));
          const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
          // (floor: something under it the layers don't hold, a body it was dropped on)
          let ground = floor;
          for (const p of pts) {
            const [gx, gy] = cellAt(x - cx + p[0], y - cy + p[1]);
            if (gx < 0 || gy < 0 || gx >= dims.w || gy >= dims.h) continue;
            const col = readColumn(core.packed, slots, gx, gy);
            if (col.length) ground = Math.max(ground, col[col.length - 1].z1);
          }
          return this.physics?.spawn(m, [x - cx, y - cy, ground + above - lowZ], q, vel) ?? null;
        },
        /** the layers' intervals of the column at world (x, y) (tests) */
        column: async (x: number, y: number) => {
          const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
          const [gx, gy] = cellAt(x, y);
          return readColumn(core.packed, slots, gx, gy);
        },
        // (voxel: each voxel's edge in cells, round 49; w, d, h count voxels)
        drop: (mat: string, w: number, d: number, h: number, x: number, y: number, above = 0, yaw = 0, pitch = 0, roll = 0, voxel = 1) => {
          const id = MAT[(mat[0].toUpperCase() + mat.slice(1)) as keyof typeof MAT];
          if (id === undefined) throw new Error(`no material "${mat}"`);
          return api.phys.spawn({ ...box(id, w, d, h), voxel }, x, y, above, yaw, pitch, roll);
        },
      },
      trial: new Trial(core, this.powers, gatesOf(map), map.poi.healthy),
      // structure grids: grids.place('officetower', x, y, yawDeg, pitchDeg, rollDeg) at world (x, y)
      grids: {
        list: core.structures.list,
        place: (id: string, x: number, y: number, yaw = 0, pitch = 0, roll = 0, sink = 0) => {
          const m = modelById(id);
          if (!m) throw new Error(`no model "${id}"`);
          const r = Math.PI / 180;
          return core.structures.place(m, x, y, qYawPitchRoll(yaw * r, pitch * r, roll * r), this.heightAt, sink);
        },
      },
      // regions and rooms (docs/PLACES.md): places.load(plan), places.get(name).bury('sand', 2)…
      places: core.places,
      // the world as modules a game uses (docs/WORLD_API.md): api.terrain.heightAt(x, y), api.wind.gust(…), api.fx.burst('dust', …)
      // (`world` stays the GPU buffers, for tests)
      get api() {
        return (self.worldApi ??= attachSim(core));
      },
      scene: this,
    };
    if (this.level.stream) {
      const a = this.opts.atlas;
      this.stream = a
        ? new Streamer(
            core,
            {
              // (round 80: a tile of its columns a frame — streaming mustn't stall the frame)
              region: (x0, y0, w, h) => a.atlas.regionLand(x0, y0, w, h, Infinity, true),
              wrap: [a.atlas.p.cols, a.atlas.p.rows],
              height: a.atlas.p.zTop,
              // (round 71: the coarse world changes while a region is away)
              snapshot: (x0, y0, w, h) => a.atlas.snapshot(x0, y0, w, h),
              changes: (s, x0, y0, w, h) => a.atlas.changes(s, x0, y0, w, h),
            },
            a.origin,
            { oz: a.oz, outside: a.outside, ground: a.ground },
          )
        : new Streamer(core);
      // (round 79) the atlas's columns run past the window: what's above and below it drawn too
      if (a && core.renderer.enableBand(a.atlas.p.zTop)) this.stream.refreshBand();
      // (round 79) the sea past the window's edge: the sea in it stays
      if (a) core.globals.seaZ = a.atlas.p.sea - this.stream.oz;
      // (round 80) sleep and wake: what's still sleeps, what the player and the world's events touch wakes
      if (a && host.params.get('sleep') !== '0') {
        this.sleep = new Sleep(dims.w / CHUNK, dims.h / CHUNK);
        this.sleep.settleAll(Sleep.SETTLE_S, performance.now() / 1000);
        core.sleep = this.sleep;
        const sl = this.sleep;
        this.stream.onSlide.push((dx, dy, dz) => {
          const t = performance.now() / 1000;
          // (a slide in z: every column cut again — the surfaces made again everywhere, the water settles)
          if (dz) sl.settleAll(2, t);
          else sl.shift(dx, dy, t);
        });
      }
      // (round 79) ?drive=speed: along the road nearest the window's middle (unwrapped from its first point)
      const dv = Number(host.params.get('drive') ?? 0);
      if (a && dv > 0) {
        const mx = this.stream.origin[0] + dims.w / 2;
        const my = (this.stream.origin[1] + dims.h / 2) * ROW_H;
        let best: Float32Array | null = null;
        let bd = Infinity;
        for (const r of a.atlas.settlement.roads)
          for (let k = 0; k < r.path.length; k += 2) {
            const dd = Math.hypot(r.path[k] - mx, r.path[k + 1] - my);
            if (dd < bd) {
              bd = dd;
              best = r.path;
            }
          }
        const W = a.atlas.worldW;
        const H = a.atlas.worldH;
        const path: [number, number][] = [];
        if (best)
          for (let k = 0; k < best.length; k += 2) {
            const prev = path[path.length - 1];
            let x = best[k];
            let y = best[k + 1];
            if (prev) {
              x = prev[0] + (((x - prev[0] + W * 1.5) % W) - W / 2);
              y = prev[1] + (((y - prev[1] + H * 1.5) % H) - H / 2);
            }
            path.push([x, y]);
          }
        // (from its point nearest the middle: its start may be far off)
        let s0 = 0;
        let sNear = 0;
        let dNear = Infinity;
        for (let k = 0; k < path.length; k++) {
          if (k > 0) s0 += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
          const dd = Math.hypot(((path[k][0] - mx + W * 1.5) % W) - W / 2, ((path[k][1] - my + H * 1.5) % H) - H / 2);
          if (dd < dNear) {
            dNear = dd;
            sNear = s0;
          }
        }
        this.drive = { speed: dv, path, s: sNear, dir: 1, zoom: core.camera.zoom };
      }
      this.stream.onSlide.push((dx, dy, dz) => {
        // what the level keeps in window coordinates
        shiftGrid(this.surfaceCache, dims.w, dims.h, 1, dx, dy);
        this.hoverWorld = null;
        // the climate follows the latitude (the atlas's: snow it lays is snow the sim keeps), and the window's height
        if (a) core.globals.climate = a.atlas.climateAt(this.stream!.origin[0] + dims.w / 2, this.stream!.origin[1] + dims.h / 2, this.stream!.oz);
        if (a) core.globals.seaZ = a.atlas.p.sea - this.stream!.oz;
        if (dz) {
          // (a slide in z: every column moved; what's falling or lying loose in window z goes)
          for (let i = 0; i < this.surfaceCache.length; i++) this.surfaceCache[i] = sfPack(core.map.surface[i], 0);
          this.integrity?.clear();
        }
      });
      // (round 80) a warp (the map's): the window somewhere else — what the level keeps in window coordinates again
      this.stream.onWarp.push((_ox, _oy, nz) => {
        if (a) core.globals.climate = a.atlas.climateAt(this.stream!.origin[0] + dims.w / 2, this.stream!.origin[1] + dims.h / 2, nz);
        if (a) core.globals.seaZ = a.atlas.p.sea - nz;
        this.sleep?.settleAll(Sleep.SETTLE_S + 1, performance.now() / 1000);
        for (let i = 0; i < this.surfaceCache.length; i++) this.surfaceCache[i] = sfPack(core.map.surface[i], 0);
        this.hoverWorld = null;
        this.integrity?.clear();
        const i = Math.floor(dims.h / 2) * dims.w + Math.floor(dims.w / 2);
        core.camera.target = [dims.w / 2, (dims.h / 2) * ROW_H, core.map.surface[i]];
        if (core.camera.fly) this.toggleFly();
      });
      // (round 71) an event of the coarse world in sight is made in the window's columns too
      // the atlas level's buttons (round 72: a phone has no F, WASD, M or V)
      if (a) this.atlasControls();
      // the land beyond the window (round 73): the atlas's ground and the coarse world, out to the sky
      if (a) {
        // (round 83: the rings of less detail between the window and the far land — ?lod=0 none, ?lod=low three
        // coarser ones, fewer vertices)
        const lodQ = new URLSearchParams(location.search).get('lod');
        const lod = lodQ === '0' ? null : lodQ === 'low' ? { spacings: [4, 8, 16], n: 129 } : { spacings: [2, 4, 8, 16], n: 193 };
        const far = new FarLand(host.gpu.device, a.atlas, core.renderer.targets, lod);
        // (round 83: the rings draw past the window's edge — no wall down it)
        if (far.lod) core.renderer.openEdges();
        this.far = far;
        const S = this.stream;
        core.renderer.extraDraws.push((pass, clear) => {
          far.org = [S.origin[0], S.origin[1] * ROW_H, S.oz];
          far.win = [dims.w + 0.5, dims.h * ROW_H];
          far.zMax = dims.zMax;
          const c = core.camera.fly ? core.camera.fly.pos : core.camera.target;
          far.mid = [c[0], c[1]];
          // (the puck keeps the target's height on the ground; without it the height isn't the ground's)
          const [tx, ty, tz] = core.camera.target;
          far.focus = core.camera.fly ? null : [tx, ty, this.cutaway ? tz : this.heightAt(tx, ty)];
          far.draw(pass, clear);
        });
      }
      // (one after another: each reads the window back and writes it)
      if (a) a.atlas.coarse.onEvent.push((e) => (this.worldEvents = this.worldEvents.then(() => this.worldEventHere(e))));
      // (round 69: the atlas's forms of a weak material are judged when they come in, like anything
      // built — what can't stand falls; the first window's, region by region)
      const integ = this.integrity;
      if (a && integ) {
        this.stream.onArrive.push((x0, y0, x1, y1) => integ.markBox(x0, y0, x1, y1));
        const m = a.map.structural;
        if (m)
          for (let y = 0; y < dims.h; y += REGION)
            for (let x = 0; x < dims.w; x += REGION) {
              const b = boxOf(m, dims.w, x, y, REGION, REGION);
              if (b) integ.markBox(...b);
            }
      }
    }
    (window as unknown as { reclaimed: unknown }).reclaimed = Object.assign(api, {
      stream: this.stream,
      atlas: this.opts.atlas?.atlas,
      toggleFly: () => this.toggleFly(),
      // the coarse world's events at a window cell (round 71): coarse.meteor(x, y, r), coarse.erupt(x, y)
      // (round 80: `coarse`, not `world` — that's the GPU world, as everything else reads it: worldapitest broke)
      coarse: {
        meteor: (x: number, y: number, r?: number) => this.worldAt(x, y, (wx, wy, c) => c.meteor(wx, wy, r)),
        erupt: (x: number, y: number) => this.worldAt(x, y, (wx, wy, c) => c.erupt(wx, wy)),
        // (round 75) the geysers in the window and the time they keep
        geysers: () => ({ list: this.geysers, t: this.geyserT, on: [...this.geyserOn] }),
      },
    });
    core.places.groundAt = this.heightAt;
    // ?plan=voronoi|bands|tree (seed: ?planseed=): places from a generated plan (the places test hook)
    const plan = host.params.get('plan');
    // (a generated map's own plan: its places — landforms.ts)
    const own = (map as { plan?: { plan: import('../world/places').Plan; seed: number } }).plan;
    if (own && !plan) core.places.load(own.plan, own.seed);
    if (plan) {
      const seed = Number(host.params.get('planseed') ?? 1);
      if (plan === 'voronoi') core.places.load({ partition: 'voronoi', spacing: 22, group: [1, 3], shape: 'chain' }, seed);
      else if (plan === 'tree') core.places.load({ partition: 'voronoi', spacing: 22, group: [1, 3], shape: 'tree' }, seed);
      else if (plan === 'bands') core.places.load({ partition: 'bands', freq: 0.03, tunnel: 0.06, island: 0.05, shape: 'tree' }, seed);
      else throw new Error(`?plan: no plan "${plan}" (voronoi, tree, bands)`);
    }
    // ?structure=model,x,y,yaw,pitch,roll (grid cells, degrees): a structure grid
    // placed at load (the grids branch's test hook)
    const sp = host.params.get('structure');
    if (sp) {
      const [id, ...nums] = sp.split(',');
      const [x, y, yaw, pitch, roll, sink] = nums.map(Number);
      const m = modelById(id);
      if (!m) throw new Error(`?structure: no model "${id}"`);
      const [wx, wy] = poiWorld([x, y]);
      const r = Math.PI / 180;
      // (the ground's heights arrive with the first surface readback: wait for it)
      const placeIt = () => {
        if (!this.surfaceCache?.length) return void setTimeout(placeIt, 200);
        core.structures.place(m, wx, wy, qYawPitchRoll((yaw || 0) * r, (pitch || 0) * r, (roll || 0) * r), this.heightAt, sink || 0);
      };
      placeIt();
    }

    if (this.story) {
      // the story opens on the green that's left (game/reach.ts: the reach grows from it)
      const [hx, hy] = map.poi.healthy;
      this.reach = new Reach(dims.w, dims.h, [hx, hy]);
      core.world.writeReach(this.reach.revealed);
      camera.target = [...poiWorld([hx, hy]), 12];
      void this.refreshReach();
    }
    if (this.intro) {
      weather.holdNatural(600);
      void this.runIntro();
    } else this.openValley();
  }

  /** Grow the reach from the green as it is now (story levels; ~1 Hz). */
  private async refreshReach(): Promise<void> {
    const reach = this.reach;
    if (!reach || this.reachBusy) return;
    this.reachBusy = true;
    try {
      const { core } = this;
      const [veg, drift] = await Promise.all([core.readBuffer('veg'), core.readTexture(core.world.drift)]);
      // green under blown dust or ash is dormant: it doesn't reach
      const d = drift.data;
      const buried = (i: number) => {
        const m = Math.round(d[i * 4 + 2]);
        return (m === 0 || m === MAT.Drift || m === MAT.Ash) && Math.min(d[i * 4 + 1], d[i * 4]) > 0.5;
      };
      if (reach.update(veg, buried)) core.world.writeReach(reach.revealed);
    } catch (e) {
      ignoreTeardown(e);
    } finally {
      this.reachBusy = false;
    }
  }

  /** Keep the camera over the reach: pan within it, zoom out no wider than it. */
  private confineToReach(): void {
    const reach = this.reach;
    if (!reach || this.director.flying) return;
    const cam = this.core.camera;
    const [x0, y0, x1, y1] = reach.bounds;
    const extent = Math.max(x1 - x0, y1 - y0) + 24;
    // (the iso view spans about twice as much across as up; a margin of fog shows around it)
    const minZoom = Math.min(24, Math.max(0.8, Math.min(cam.viewportW, cam.viewportH * 2) / (extent * 2.5)));
    this.director.limits = { minZoom, maxZoom: 24, bounds: [x0, y0, x1, y1] };
  }

  /** The valley without the intro (or after it): dust storms roll in, the usual hint. */
  private openValley(): void {
    const { weather, dims } = this.core;
    if (this.story) {
      const touch = matchMedia('(pointer: coarse)').matches;
      const look = touch ? 'Two fingers to look around.' : 'Right-drag to look around.';
      // (on a phone the life lens is the ◎ button, not Space)
      const lens = touch ? 'hold ◎' : 'hold Space';
      setTimeout(() => this.hud.say(`Life clings on by the pond. Tap the green to loose its seeds; drag to make wind and carry them to ground that is ready (${lens}: blue). ${look}`, 10), 800);
      return;
    }
    if (this.level.sandbox) {
      setTimeout(() => this.hud.say('Sandbox: pick a tool on the right. Try 💥 Break on the towers and overhangs in the physics garden (bottom left), or on a wall of the sand basin.', 10), 800);
      return;
    }
    // dust storms roll across the dead valley as the level opens
    weather.spawnDust(dims.w * 0.5, dims.h * 0.45);
    weather.spawnDust(dims.w * 0.4, dims.h * 0.6, 70);
    weather.holdNatural(70);
    const touch = matchMedia('(pointer: coarse)').matches;
    const look = touch ? 'Two fingers to look around.' : 'Right-drag to look around.';
    setTimeout(() => this.hud.say(`The valley is quiet. Touch things; drag to make wind. Swirl over water to raise a storm. ${look}`, 8), 800);
  }

  resize(renderW: number, renderH: number, cssW: number, cssH: number): void {
    this.renderW = renderW;
    this.renderH = renderH;
    const first = this.core.camera.viewportW <= 1;
    this.core.resize(renderW, renderH, cssW, cssH);
    // open framed on the valley; portrait phones get closer than the width
    // alone would allow (the map is a diamond, its middle is what matters)
    // (a story level opens close on its green)
    if (first) this.core.camera.zoom = this.story ? 7 : Math.max(1.5, Math.min(cssW * 1.9, cssH * 1.6) / 300);
  }

  frame(now: number, dt: number): void {
    const cpu0 = performance.now();
    const { core, audio, powers, hud } = this;
    const { camera, weather, globals, sim, map, dims } = core;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
    const fms = dt * 1000;
    this.frameMs.push(fms);
    if (this.frameMs.length > 300) this.frameMs.shift();
    if (fms > 50) {
      this.hitches++;
      // (what ran in it: none — the GPU's, or the browser's)
      this.longFrames.push(`${fms.toFixed(0)}ms${this.stream?.busy ? ' busy' : ''}: ${frameSteps.join(', ') || '-'}`);
      if (this.longFrames.length > 24) this.longFrames.shift();
    }
    frameSteps.length = 0;
    this.worstMs = Math.max(this.worstMs, fms);
    this.host.profiler.beginFrame();

    // keyboard pan
    const panSpeed = 500 / camera.zoom;
    let kx = 0;
    let ky = 0;
    const k = this.keys;
    if (this.drive) this.driveOn(dt);
    else if (camera.fly) this.flyKeys(dt);
    else {
    if (k.has('a') || k.has('arrowleft')) kx -= 1;
    if (k.has('d') || k.has('arrowright')) kx += 1;
    if (k.has('w') || k.has('arrowup')) ky -= 1;
    if (k.has('s') || k.has('arrowdown')) ky += 1;
    if (kx || ky) {
      const [wx, wy] = camera.screenDeltaToWorld(kx * panSpeed * dt, ky * panSpeed * dt);
      camera.target[0] += wx;
      camera.target[1] += wy;
    }
    }
    camera.target[0] = Math.max(0, Math.min(dims.w, camera.target[0]));
    camera.target[1] = Math.max(0, Math.min(dims.h * ROW_H, camera.target[1]));
    if (this.reach) {
      this.reachRefresh -= dt;
      if (this.reachRefresh <= 0) {
        this.reachRefresh = 1;
        void this.refreshReach();
      }
      this.confineToReach();
    }
    this.director.update(dt);
    // geysers (round 75)
    if (this.opts.atlas) this.stepGeysers(dt * this.speed);
    // the coarse world goes on (round 71): a step every 4th frame (a step a frame cost ~1.5 ms)
    if (this.opts.atlas && ++this.coarseFrame % 4 === 0) this.opts.atlas.atlas.coarse.step(1);

    const simDt = dt * this.speed;
    if (this.hoverWorld) powers.hover(this.hoverWorld[0], this.hoverWorld[1], dt);
    powers.update(dt);
    this.surfaceRefresh -= dt;
    if (this.surfaceRefresh <= 0) {
      this.surfaceRefresh = 1;
      void core.readBuffer('surface').then((f) => (this.surfaceCache = new Uint32Array(f.buffer)));
    }

    const stats = sim.stats.latest;
    if (stats && this.initialContam === 0) this.initialContam = stats.soilContam;
    if (stats) {
      if (this.lastCollapsed >= 0 && stats.collapsed > this.lastCollapsed) audio.crumble(stats.collapsed - this.lastCollapsed);
      this.lastCollapsed = stats.collapsed;
      // clean land + life weighted by stage (round 8)
      this.reclaimed = reclamation(stats);
    }
    const health = worldHealth(stats, this.initialContam);
    core.pollution += (health.pollution - core.pollution) * Math.min(1, dt * 0.5);
    this.life += (health.life - this.life) * Math.min(1, dt * 0.5);
    this.nature.update(simDt, stats);
    // oil smoke the wind has torn apart pays Nature back (GPU counter, ~2 Hz)
    // storms feel the painted wind (CPU copy of the field, ~4 Hz)
    this.fieldRefresh -= dt;
    if (this.fieldRefresh <= 0) {
      this.fieldRefresh = 0.25;
      void core.readWindField().then((f) => (core.weather.windField = f), ignoreTeardown);
    }
    this.smokeRefresh -= dt;
    if (this.smokeRefresh <= 0) {
      this.smokeRefresh = 0.5;
      void core.readBuffer('particleCounters').then((f) => {
        const u = new Uint32Array(f.buffer);
        const n = u[2];
        if (this.smokeSeen >= 0 && n > this.smokeSeen) this.nature.smokeDispersed(n - this.smokeSeen);
        this.smokeSeen = n;
        // grime blown into water washes away: plinks and a little Nature
        if (this.washedSeen >= 0 && u[3] > this.washedSeen) {
          this.nature.grimeWashed(u[3] - this.washedSeen);
          this.audio.wash(u[3] - this.washedSeen);
        }
        this.washedSeen = u[3];
      }, ignoreTeardown);
    }

    this.lensK += ((this.lensOn ? 1 : 0) - this.lensK) * Math.min(1, dt * 8);
    const lc = this.hoverWorld ?? [camera.target[0], camera.target[1]];
    globals.lens = [lc[0], lc[1], 24, this.lensK < 0.01 ? 0 : this.lensK];

    // (a slide in progress: the sim waits for the regions coming in)
    void this.stream?.update();
    // (round 80) what's awake this frame: round the player (the camera's target), the events, the storms
    if (this.sleep) {
      globals.sleep = this.sleep.update(performance.now() / 1000, [camera.target[0], camera.target[1], 40], globals.events, weather.storms, core.sim.tick);
      globals.drowse = this.sleep.drowse;
      globals.settle = this.sleep.settling.map((s) => s.rect);
    }
    // (?skip=sim, round 80: the frame without the sim — on a phone, how much of it the sim is)
    const ticks = this.stream?.busy || this.noSim ? 0 : core.advance(now, simDt, this.speed);
    this.ticksAvg = this.ticksAvg * 0.95 + ticks * 0.05;
    // (round 83, V21: ?cutaway=1 — the camera's puck, the slice and the orbit round it; `cutFeet` a script's
    // stand-in character, kept seen)
    if (CUTAWAY && !camera.fly) {
      const t = (this.worldApi ??= attachSim(core)).terrain!;
      const c = (this.cutaway ??= { puck: new Puck(t, camera), slice: new Slice(t, camera), orbit: new Orbit(t, camera), dither: new Dither(t, camera) });
      c.puck.update(dt);
      const p = c.puck.pos;
      if (p) {
        c.slice.update(p[0], p[1], p[2], dt);
        c.orbit.update(p[0], p[1], p[2], dt);
      }
      if (this.cutFeet) c.dither.see('feet', ...this.cutFeet);
      else c.dither.forget('feet');
      c.dither.update(dt);
    } else if (camera.fly) {
      // (round 83: flying, nothing's cut — the slice left from the fixed view cut the world under the flyer)
      camera.cut = { slice: null, see: [], boxes: [] };
    }
    core.render();

    hud.setWind(powers.windTier());
    const goal = this.level.goal ?? 1;
    hud.setReclaim(this.reclaimed, goal);
    // the brush paints every frame while held
    if (this.brushAt && this.editor) this.brush(this.brushAt[0], this.brushAt[1]);
    this.stepMeteors(dt);
    this.drawRing();
    if (this.beamAt && this.physics && !this.beamPicking) this.aimBeam(this.beamAt);
    if (this.integrity) {
      // cyclones batter what they pass: look there
      for (const cy of weather.cyclones) this.integrity.markDirty(cy.x, cy.y, cy.radius * 2.5);
      this.integrity.update(dt * this.speed);
    }
    weather.dustiness = core.pollution;
    this.birdArrivals(dt, stats);

    // progress feeds the menu scene; the level ends at the goal
    this.saveTimer -= dt;
    if (this.saveTimer <= 0 && this.level.goal) {
      this.saveTimer = 5;
      saveProgress(this.level.id, (this.reclaimed / this.level.goal) * 0.95);
    }
    if (!this.completed && this.level.goal && this.reclaimed >= this.level.goal) {
      this.completed = true;
      saveProgress(this.level.id, 1);
      this.showComplete();
    }

    if (globals.time > this.nextGroan) {
      this.nextGroan = globals.time + 14 + Math.random() * 16;
      const [dx, dy] = poiWorld(map.poi.dam);
      const near = 1 - Math.min(1, Math.hypot(camera.target[0] - dx, camera.target[1] - dy) / 120);
      const holding = stats ? Math.min(1, stats.waterVolume / 20000) : 1;
      audio.groan(near * holding);
    }
    const light = core.light;
    this.audioRefresh -= dt;
    if (this.audioRefresh <= 0) {
      this.audioRefresh = 1;
      void core.readBuffer('veg').then((f) => (this.vegCache = f));
      void core.readBuffer('water').then((f) => (this.waterCache = f));
    }
    const drag = powers.dragWind();
    audio.dragWind(drag ? Math.min(1, drag.strength / 15) : 0, drag ? camera.project(drag.x, drag.y, 0)[0] / camera.viewportW : 0.5);
    // one roar: the loudest cyclone (nearest and strongest) sets it
    let roar = 0;
    let roarPan = 0.5;
    for (const cy of weather.cyclones) {
      const near = Math.max(0, 1 - Math.hypot(cy.x - camera.target[0], cy.y - camera.target[1]) / (camera.viewportW / camera.zoom));
      const level = cy.strength * (0.3 + 0.7 * near);
      if (level > roar) {
        roar = level;
        roarPan = camera.project(cy.x, cy.y, 0)[0] / camera.viewportW;
      }
    }
    audio.cyclone(roar, roarPan);
    const heard = this.heard();
    audio.update({
      pollution: core.pollution,
      life: this.life,
      ...heard,
      // barren land howls; living land in view quiets it
      barren: Math.min(1, (1 - heard.lifeNear) * 0.7 + core.pollution * 0.3),
      night: light.night,
      fire: stats ? Math.min(1, stats.fireCells / 120) : 0,
      wind: Math.min(1, Math.hypot(weather.windX, weather.windY) / 6 + weather.storms.reduce((a, s) => a + s.intensity * 0.3, 0)),
    });
    this.perf.update(
      {
        fps: this.fps,
        cpuFrameMs: performance.now() - cpu0,
        ticksPerFrame: this.ticksAvg,
        instancesOpaque: core.renderer.instanceCounts.opaque,
        instancesWater: core.renderer.instanceCounts.water,
        renderW: this.renderW,
        renderH: this.renderH,
        stats,
        adapter: this.host.gpu.adapterInfo,
        quality: this.host.qualityName,
        extra: () => this.perfLines(),
      },
      this.host.profiler,
      sim,
    );
  }

  /**
   * What the ambient bed hears from the view centre (DECISIONS round 4): rain
   * from storms in or near view, moving water nearby (the river, the dam's
   * spillway), and living land for birdsong/insects — each fading with
   * distance, within a hearing radius that grows as the camera zooms out.
   */
  private heard(): { rain: number; rainPan: number; flow: number; lifeNear: number; zoom: number; frogs: number } {
    const { camera, weather, dims, map } = this.core;
    const [cx, cy] = camera.target;
    const R = Math.max(18, Math.min(160, camera.viewportW / camera.zoom / 2));
    const zoom = Math.max(0, Math.min(1, Math.log(camera.zoom / 1.2) / Math.log(10)));
    let rain = weather.rainAt(cx, cy);
    let rainPan = 0;
    for (const st of weather.storms) {
      const d = Math.max(0, Math.hypot(st.x - cx, st.y - cy) - st.radius * 0.8);
      const r = st.intensity * (1 + st.downpour) * Math.max(0, 1 - d / R);
      if (r > rain * 0.5) rainPan = Math.max(-1, Math.min(1, (camera.project(st.x, st.y, 0)[0] / camera.viewportW) * 2 - 1));
      rain = Math.max(rain, r * 0.8);
    }
    let water = 0;
    let life = 0;
    let n = 0;
    // water with green around it (frogs; round 20)
    let frogs = 0;
    const veg = this.vegCache;
    const wat = this.waterCache;
    for (let j = -4; j <= 4; j++)
      for (let i = -4; i <= 4; i++) {
        const x = Math.floor(cx + (i / 4) * R);
        const y = Math.floor(cy + (j / 4) * R);
        if (x < 0 || y < 0 || x >= dims.w || y >= dims.h) continue;
        const fall = Math.max(0, 1 - Math.hypot(i, j) / 5.2);
        const k = y * dims.w + x;
        if (veg) life += fall * Math.min(1, Math.max(0, (veg[k] - 1.2) / 2.3));
        if (wat) water += fall * Math.min(1, wat[k] / 0.6);
        if (wat && veg && wat[k] > 0.1) {
          let green = 0;
          for (const o of [2, -2, 2 * dims.w, -2 * dims.w]) {
            const q = k + o;
            if (q >= 0 && q < veg.length && veg[q] >= 1.5) green++;
          }
          frogs += fall * (green / 4);
        }
        n += fall;
      }
    const [dx, dy] = poiWorld(map.poi.dam);
    const dam = Math.max(0, 1 - Math.hypot(dx - cx, dy - cy) / (R * 1.2));
    return {
      rain,
      rainPan,
      flow: Math.min(1, (n ? (water / n) * 2.2 : 0) + dam * 0.6),
      lifeNear: n ? Math.min(1, (life / n) * 1.6) : 0,
      zoom,
      frogs: n ? Math.min(1, (frogs / n) * 6) : 0,
    };
  }

  /** Flocks fly in from the map edge by day once there are woods to settle in. */
  private birdArrivals(dt: number, stats: WorldStats | undefined): void {
    const { dims, sim } = this.core;
    if (!stats || this.core.light.night > 0.4) return;
    this.nextFlock -= dt * this.speed;
    if (this.nextFlock > 0) return;
    const woods = stats.matureCells / stats.cells;
    this.nextFlock = woods > 0.002 ? Math.max(12, 40 - woods * 400) * (0.6 + Math.random() * 0.8) : 20;
    if (woods <= 0.002) return;
    const side = Math.floor(Math.random() * 4);
    const t = 10 + Math.random() * (dims.w - 20);
    const x = side === 0 ? 1.5 : side === 1 ? dims.w - 1.5 : t;
    const y = side === 2 ? 1.5 : side === 3 ? dims.h * ROW_H - 1.5 : side < 2 ? t * ROW_H : 0;
    sim.particles.burst({ kind: PK.Bird, x, y, z: this.heightAt(x, y) + 11, count: 2 + Math.floor(Math.random() * 4), speed: 5, spread: 1.5 });
  }

  /**
   * The diegetic first-play intro (DECISIONS round 9): the whole valley;
   * closer, where something tries to grow out of the dust and withers; the
   * wind clears the dust and a patch of green takes and holds; the player
   * tries it (grow on the green, wither on the dust, a drag); then the valley
   * is theirs. Esc skips.
   */
  private async runIntro(): Promise<void> {
    const { camera, dims, map } = this.core;
    const d = this.director;
    const hud = this.hud;
    const powers = this.powers;
    const [tx, ty] = poiWorld(map.poi.tutorial);
    // (the scene is attached before its first resize)
    await d.waitFor(() => camera.viewportW > 1, 5);
    const wide = Math.max(1.5, Math.min(camera.viewportW * 1.9, camera.viewportH * 1.6) / 300);
    camera.target = [dims.w * 0.5, dims.h * ROW_H * 0.5, 14];
    camera.zoom = wide;
    d.lock();
    hud.say('A valley, dead a long time.', 4);
    await d.hold(3);
    await d.fly(tx, ty, 14, 3);
    d.lock();
    // something tries to grow out of the dust…
    powers.scriptTap(tx, ty);
    await d.hold(0.4);
    powers.scriptTap(tx, ty);
    hud.say('Life keeps trying — but the dust and waste smother it.', 6);
    await d.hold(6.5);
    // …the wind clears it…
    hud.say('Wind can carry the dust away.', 5);
    for (let k = 0; k < 3; k++) {
      await powers.scriptStroke([[tx - 9, ty - 2 + k], [tx + 9, ty + 2 - k]], 0.9);
    }
    await d.hold(2.5);
    // …and on clear ground, green takes and holds
    powers.scriptTap(tx, ty);
    await d.hold(0.6);
    powers.scriptTap(tx, ty);
    hud.say('Where the ground is clear, life holds.', 5);
    await d.hold(4);
    // the player's turn
    d.confine(tx, ty, 16, 9, 20);
    const grows: [number, number][] = [];
    powers.onGrowTap = (x, y) => grows.push([x, y]);
    hud.say('Your turn. Touch the green — again, and again.', 30);
    await d.waitFor(() => grows.length >= 2, 25);
    await d.hold(1.5);
    hud.say('Now touch the dust.', 30);
    const before = grows.length;
    await d.waitFor(() => grows.length > before && this.hostileAt(grows[grows.length - 1]), 25);
    await d.hold(2);
    let stroked = false;
    powers.onStroke = () => (stroked = true);
    hud.say('Drag across the dust to blow it away. Drag again for a gust, again for a gale.', 30);
    await d.waitFor(() => stroked, 25);
    await d.hold(2.5);
    // show you've got it: clear the litter around the green and grow there
    const litterNear = () => this.countSurface(tx, ty, 13, 18);
    const litter0 = Math.max(1, litterNear());
    hud.say('Clear the scraps from around the green, then grow something where they were.', 60);
    await d.waitFor(() => litterNear() <= litter0 * 0.45, 60);
    const grown0 = grows.length;
    await d.waitFor(() => grows.length > grown0 && !this.hostileAt(grows[grows.length - 1]) && Math.hypot(grows[grows.length - 1][0] - tx, grows[grows.length - 1][1] - ty) > 3, 30);
    hud.say('The valley will remember that.', 3);
    await d.hold(3);
    // something new: waste the wind can't move
    const [hx, hy] = poiWorld(map.poi.heap);
    await d.fly(hx, hy, 13, 2);
    d.confine(hx, hy, 14, 9, 18);
    hud.say('Some waste is packed too hard for wind. Try it.', 20);
    stroked = false;
    await d.waitFor(() => stroked, 12);
    await d.hold(2.5);
    // …but fire can take it: a storm comes (the player brings the lightning)
    const storm = this.core.weather.spawnToward(hx, hy);
    if (storm) {
      const at = camera.project(storm.x, storm.y, 0)[0] / Math.max(1, camera.viewportW);
      this.audio.thunder(0.1, 0.8, Math.max(0, Math.min(1, at)));
    }
    hud.say('Thunder. A storm is coming — wait for it, or lean on it with the wind.', 40);
    d.confine(hx, hy, 40, 3, 18);
    await d.fly(hx, hy, 5, 2.5);
    await d.waitFor(() => this.core.weather.coverAt(hx, hy) > 0.3, 70);
    await d.fly(hx, hy, 11, 1.5);
    d.confine(hx, hy, 12, 9, 16);
    hud.say('Tap beneath the storm: lightning will find the heap.', 40);
    await d.waitFor(() => this.countSurface(hx, hy, 4, 12) === 0, 45);
    hud.say('Fire leaves ash — and ash rides the wind. Blow it away.', 40);
    const ash0 = Math.max(1, this.countSurface(hx, hy, 6, 17));
    await d.waitFor(() => this.countSurface(hx, hy, 6, 17) <= ash0 * 0.5, 40);
    powers.onGrowTap = undefined;
    powers.onStroke = undefined;
    // the valley is theirs
    d.lock();
    await d.fly(dims.w * 0.5, dims.h * 0.5, wide, 3);
    d.free();
    this.intro = false;
    this.openValley();
  }

  /**
   * Sandbox: if an editor tool is active, handle the press — a brush starts
   * painting (or paints once for a tap), a spawn tool places its weather.
   * Returns false for the normal hands.
   */
  private editTool(wx: number, wy: number, tap: boolean): boolean {
    const ed = this.editor;
    if (!ed || ed.tool === 'wind') return false;
    const w = this.core.weather;
    if (ed.tool === 'storm') {
      const s = w.spawn(wx, wy);
      if (s) s.age = 5;
      return true;
    }
    if (ed.tool === 'duststorm') {
      w.placeDust(wx, wy);
      return true;
    }
    if (ed.tool === 'cyclone') {
      w.spawnCyclone(wx, wy, 1);
      return true;
    }
    if (ed.tool === 'place') {
      void this.placeModel(wx, wy);
      return true;
    }
    // landforms: a stroke the world API raises as it goes (round 64)
    if (ed.tool === 'range' || ed.tool === 'mesa') {
      this.core.snapshot();
      const api = (this.worldApi ??= attachSim(this.core));
      this.raising = api.terrain!.raise(ed.tool, ed.tool === 'range' ? { radius: ed.radius, height: ed.radius * 2.6 } : { radius: ed.radius, level: this.heightAt(wx, wy) + 10 });
      this.raising.to(wx, wy);
      if (tap) {
        this.raising.end();
        this.raising = undefined;
      } else this.brushAt = [wx, wy];
      return true;
    }
    // each press can be undone
    if (EDIT_OP[ed.tool]) this.core.snapshot();
    this.strokeStart = true;
    if (tap) this.brush(wx, wy);
    else this.brushAt = [wx, wy];
    return true;
  }

  /** Break tool: find the voxel under the cursor for the sphere outline (one pick in flight at a time). */
  private pickSmash(sx: number, sy: number): void {
    if (this.smashPicking) return;
    this.smashPicking = true;
    const { core } = this;
    const { camera } = core;
    core.renderer.pick((sx / camera.viewportW) * this.renderW, (sy / camera.viewportH) * this.renderH).then((hit) => {
      this.smashPicking = false;
      this.smashHover = hit ? [...cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w)), hit.z] : undefined;
    }, ignoreTeardown);
  }

  /** The town (round 65): made on first use, its grid seeded by the map. */
  private get town(): Town {
    return (this.worldApi ??= attachSim(this.core)).town({ seed: 7 });
  }

  /** Town tool: the block a press there would add (or, shift held, take away). */
  private townPick(sx: number, sy: number): Promise<Block | null> {
    const { core } = this;
    const { camera } = core;
    const remove = this.keys.has('shift');
    return core.renderer.pick((sx / camera.viewportW) * this.renderW, (sy / camera.viewportH) * this.renderH).then((hit) => {
      if (!hit) return null;
      return this.town.pickBlock(hit.cell, hit.z + 0.5, remove, !!this.editor?.plan);
    });
  }

  /** Town tool: add the block a press lands on (Townscaper's way: town.pickBlock), or take it away with shift; in plan mode, plan it. */
  private townAtPick(sx: number, sy: number): void {
    const remove = this.keys.has('shift');
    const plan = !!this.editor?.plan;
    this.townPick(sx, sy).then((b) => {
      if (!b) return;
      if (plan) this.town.plan(b.cell, b.level, !remove);
      else if (remove) this.town.remove(b.cell, b.level);
      else this.town.add(b.cell, b.level);
      this.townHover = undefined;
    }, ignoreTeardown);
  }

  /**
   * Town tool, plan mode: six workers to build the plan (agents/buildcrew.ts)
   * from the nearest pile of bricks or logs to the view's centre (lay one
   * with ▲ Build, brick). Groups 10-12 and fields 0-1 (a crew at a time).
   */
  private sendBuilders(): void {
    const api = (this.worldApi ??= attachSim(this.core));
    const A = api.agents;
    const T = api.terrain;
    if (!A || !T) return;
    const { camera } = this.core;
    const [tx, ty] = [camera.target[0], camera.target[1]];
    let pile: { x: number; y: number; n: number } | null = null;
    for (let r = 0; r <= 60 && !pile; r += 3) {
      for (let k = 0; k < Math.max(1, Math.round(r * 2)); k++) {
        const a = (k / Math.max(1, Math.round(r * 2))) * Math.PI * 2;
        const x = tx + Math.cos(a) * r;
        const y = ty + Math.sin(a) * r;
        const m = T.materialAt(x, y);
        if (m === 'brick' || m === 'log') {
          pile = { x, y, n: 1 };
          break;
        }
      }
    }
    if (!pile) {
      this.hud.say('No pile of bricks or logs near: lay some with ▲ Build (brick) first.', 4);
      return;
    }
    this.buildCrew?.stop();
    if (this.builders) A.remove(this.builders);
    this.builders = A.spawn(6, pile.x + 2, pile.y + 2, { kind: 'worker', group: 10, spread: 0.8 });
    this.buildCrew = api.buildCrew({ units: this.builders, groups: [10, 11, 12], fields: [0, 1], town: this.town, pile: { x: pile.x, y: pile.y, radius: 2.5 }, materials: ['brick', 'log'] });
    this.hud.say(`Six workers build the plan from the pile (${this.town.delta().length} blocks to do).`, 4);
    const tick = async () => {
      const crew = this.buildCrew;
      if (!crew || this.abort.signal.aborted) return;
      try {
        const { units } = await A.sync();
        if (this.buildCrew === crew) crew.update(units);
      } catch (e) {
        ignoreTeardown(e);
        return;
      }
      requestAnimationFrame(() => void tick());
    };
    void tick();
  }

  /** Town tool: find the block under the cursor for the outline (one pick in flight at a time). */
  private pickTown(sx: number, sy: number): void {
    if (this.townPicking) return;
    this.townPicking = true;
    this.townPick(sx, sy).then(
      (b) => {
        this.townPicking = false;
        this.townHover = b ?? undefined;
      },
      (e) => {
        this.townPicking = false;
        ignoreTeardown(e);
      },
    );
  }

  /** Town tool: the plan's difference from what stands, outlined — green to build, red to take down (the blocks a crew is on, brighter). */
  private drawPlan(svg: SVGSVGElement): void {
    const mk = (cls: string) => {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('class', cls);
      svg.appendChild(p);
      return p;
    };
    this.planAdd ??= mk('plan-add');
    this.planDel ??= mk('plan-del');
    const t = this.town;
    const g = t.grid;
    const { camera } = this.core;
    let add = '';
    let del = '';
    for (const d of t.delta()) {
      const z0 = t.floorZ(d.cell, d.level) + 0.05;
      const z1 = z0 + LEVEL_H;
      const lo: string[] = [];
      const hi: string[] = [];
      for (let k = 0; k < 4; k++) {
        const [x, y] = g.corner(d.cell, k);
        const a = camera.project(x, y, z0);
        const c = camera.project(x, y, z1);
        lo.push(`${a[0].toFixed(1)},${a[1].toFixed(1)}`);
        hi.push(`${c[0].toFixed(1)},${c[1].toFixed(1)}`);
      }
      let path = `M${lo.join('L')}ZM${hi.join('L')}Z`;
      for (let k = 0; k < 4; k++) path += `M${lo[k]}L${hi[k]}`;
      if (d.add) add += path;
      else del += path;
    }
    this.planAdd.setAttribute('d', add);
    this.planDel.setAttribute('d', del);
  }

  /** Sandbox: outline the brush on the ground (follows the terrain); Break: the sphere it smashes, round the voxel picked. */
  private drawRing(): void {
    const ed = this.editor;
    const ring = this.ring;
    if (!ed || !ring) return;
    const { camera } = this.core;
    const ring2 = this.ring2!;
    if (ed.tool !== 'town' && this.planAdd) {
      this.planAdd.setAttribute('d', '');
      this.planDel!.setAttribute('d', '');
    }
    if (ed.tool === 'town') {
      // the cell's outline at the floor of the block a press would add (or take)
      const b = this.townHover;
      ring2.setAttribute('points', '');
      const t = this.town;
      const g = t.grid;
      this.drawPlan(ring.parentElement as unknown as SVGSVGElement);
      ring.parentElement!.style.display = b || this.planAdd?.getAttribute('d') || this.planDel?.getAttribute('d') ? '' : 'none';
      if (!b) return ring.setAttribute('points', '');
      const floor = Number.isNaN(t.base[b.cell]) ? Math.max(...g.columns[b.cell].map((col) => this.heightAt(...cellPos(col % this.core.dims.w, Math.floor(col / this.core.dims.w))))) : t.floorZ(b.cell, b.level);
      const pts: string[] = [];
      for (const z of [floor + 0.1, floor + LEVEL_H]) {
        for (let k = 0; k <= 4; k++) {
          const [x, y] = g.corner(b.cell, k);
          const [px, py] = camera.project(x, y, z);
          pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
        }
      }
      ring.setAttribute('points', pts.join(' '));
      return;
    }
    if (ed.tool === 'smash') {
      const c = this.smashHover;
      ring.parentElement!.style.display = c ? '' : 'none';
      if (!c) return;
      // a sphere seen from any side is a circle: its outline, plus its
      // equator so it reads as a ball sitting in the world
      const [cx, cy] = camera.project(c[0], c[1], c[2]);
      const r = ed.radius * camera.zoom;
      const out: string[] = [];
      const eq: string[] = [];
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        out.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
        const [ex, ey] = camera.project(c[0] + Math.cos(a) * ed.radius, c[1] + Math.sin(a) * ed.radius, c[2]);
        eq.push(`${ex.toFixed(1)},${ey.toFixed(1)}`);
      }
      ring.setAttribute('points', out.join(' '));
      ring2.setAttribute('points', eq.join(' '));
      return;
    }
    ring2.setAttribute('points', '');
    const at = this.brushAt ?? this.hoverWorld;
    const on = !!at && (!!EDIT_OP[ed.tool] || ed.tool === 'place' || ed.tool === 'range' || ed.tool === 'mesa');
    ring.parentElement!.style.display = on ? '' : 'none';
    if (!on) return;
    const pts: string[] = [];
    if (ed.tool === 'place') {
      // the model's footprint where it would land
      const [fw, fd] = this.placeRect(at[0], at[1]);
      const c: [number, number][] = [[fw[0], fd[0]], [fw[1], fd[0]], [fw[1], fd[1]], [fw[0], fd[1]], [fw[0], fd[0]]];
      for (const [x, y] of c) {
        const [sx, sy] = camera.project(x, y, this.heightAt(Math.min(x, fw[1] - 0.5), Math.min(y, fd[1] - 0.5)) + 0.1);
        pts.push(`${sx.toFixed(1)},${sy.toFixed(1)}`);
      }
      ring.setAttribute('points', pts.join(' '));
      return;
    }
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const x = at[0] + Math.cos(a) * ed.radius;
      const y = at[1] + Math.sin(a) * ed.radius;
      const [sx, sy] = camera.project(x, y, this.heightAt(x, y) + 0.1);
      pts.push(`${sx.toFixed(1)},${sy.toFixed(1)}`);
    }
    ring.setAttribute('points', pts.join(' '));
  }

  /** Sandbox place tool: the footprint [x0, x1], [y0, y1] centred on (wx, wy). */
  private placeRect(wx: number, wy: number): [[number, number], [number, number]] {
    const ed = this.editor!;
    const m = modelById(ed.model)!;
    const fw = ed.rot % 2 ? m.size[1] : m.size[0];
    const fd = ed.rot % 2 ? m.size[0] : m.size[1];
    const x0 = Math.round(wx - fw / 2);
    const y0 = Math.round(wy - fd / 2);
    return [[x0, x0 + fw], [y0, y0 + fd]];
  }

  /**
   * Sandbox: stamp the chosen model into the live world. Reads the layers
   * back, merges the model's runs into the footprint's columns on the CPU
   * (models.ts mergeColumn: it replaces what it overlaps) and writes those
   * columns back. Refused (nothing changes) if a column would need more slots
   * than its chunk has.
   */
  /** wakes take turns: each reads the layers the one before wrote */
  private waker?: Waker;

  /**
   * The map's structures near a point come alive as physics bodies
   * (docs/PHYSICS.md; round 44: ruins stay terrain until something touches
   * them). Every structure cell within r of (x, y) (and of z, if z ≥ 0)
   * seeds a flood through the cells it touches (the 26 around); what it finds
   * leaves the layers, one body per connected piece, its voxels starting
   * where the cells stood (the hex rows half a cell apart: rest positions are
   * world positions). A cell resting on the ground is a foundation, pinned
   * until its bonds break; so is a cell at the edge of a piece cut off at
   * WAKE_MAX (it holds on to the rest, which stays terrain).
   */
  wake(x: number, y: number, z: number, r: number): Promise<void> {
    if (!this.waker) return Promise.resolve();
    return this.waker.wake(x, y, z, r).then(({ full }) => {
      if (full) this.hud.say('No room for more bodies.', 2);
    }, ignoreTeardown);
  }

  /** A meteor at what's under the pointer: it comes in from the sky, smoking (stepMeteors). */
  private meteorAtPick(sx: number, sy: number): void {
    const { core } = this;
    const [rx, ry] = [(sx / core.camera.viewportW) * this.renderW, (sy / core.camera.viewportH) * this.renderH];
    core.renderer.pick(rx, ry).then((hit) => {
      if (!hit) return;
      const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
      const to: [number, number, number] = [x, y, hit.z + 0.5];
      this.meteors.push({ from: [x - 45, y + 35, to[2] + 110], to, t: 0, dur: 1.6 });
    }, ignoreTeardown);
  }

  /**
   * Meteors in flight: a burning head (embers) and a trail of smoke; on
   * arrival the impact (round 48): a crater blown out of everything there
   * (edit.wgsl OP_CRATER: it's gone to dust, ejecta round it), the ruins
   * there woken and crumbled by the blast, the bodies near thrown, a ring of
   * wind out every way (ripples) that lifts the loose ground, a flash, a
   * cloud of dust and debris, and a molten pool in the bowl.
   */
  private stepMeteors(dt: number): void {
    const { core } = this;
    const parts = core.sim.particles;
    for (let k = this.meteors.length - 1; k >= 0; k--) {
      const m = this.meteors[k];
      m.t += dt;
      const f = Math.min(m.t / m.dur, 1);
      const at = [0, 1, 2].map((i) => m.from[i] + (m.to[i] - m.from[i]) * f) as [number, number, number];
      if (f < 1) {
        parts.burst({ kind: PK.Ember, x: at[0], y: at[1], z: at[2], count: 10, speed: 1.5, spread: 0.7 });
        parts.burst({ kind: PK.Smoke, x: at[0], y: at[1], z: at[2], count: 6, speed: 0.4, spread: 1 });
        continue;
      }
      this.meteors.splice(k, 1);
      this.impact(m.to);
    }
  }

  private impact([x, y, z]: [number, number, number]): void {
    const { core } = this;
    const g = core.globals;
    const BOWL = 12;
    g.events.push({ kind: EventKind.Edit, x, y, z: 13 * 32 + 512, radius: BOWL * 2.5, strength: z });
    for (let k = 0; k < 6; k++) g.events.push({ kind: EventKind.Ripple, x, y, radius: 55, strength: 16 });
    g.flash = 1;
    const parts = core.sim.particles;
    const dust = MAT.Drift;
    parts.burst({ kind: PK.Haze, x, y, z: z + 1, count: 500, speed: 16, spread: BOWL, payload: dust });
    parts.burst({ kind: PK.Haze, x, y, z: z + 4, count: 400, speed: 9, spread: BOWL * 0.6, payload: MAT.Ash });
    parts.burst({ kind: PK.Haze, x, y, z: z + 10, count: 300, speed: 4, spread: BOWL * 0.4, payload: MAT.Ash });
    parts.burst({ kind: PK.Dust, x, y, z: z + 1, count: 300, speed: 14, spread: BOWL * 0.7 });
    parts.burst({ kind: PK.Chip, x, y, z: z + 1, count: 160, speed: 22, spread: BOWL * 0.5 });
    parts.burst({ kind: PK.Ember, x, y, z: z + 1, count: 90, speed: 18, spread: BOWL * 0.4 });
    parts.burst({ kind: PK.Smoke, x, y, z: z + 2, count: 150, speed: 5, spread: BOWL * 0.5 });
    // a molten pool in the bowl (no cone)
    this.lava?.addVent(x, y, 2.5, 12, 3, 0);
    const phys = this.physics;
    if (phys) void this.wake(x, y, -1, BOWL + 2).then(() => phys.blast([x, y, z], BOWL, 28));
  }

  /** Open a volcano vent where the pointer is (sim/lava.ts). */
  private ventAtPick(sx: number, sy: number): void {
    const { core } = this;
    if (!this.lava) return;
    const [rx, ry] = [(sx / core.camera.viewportW) * this.renderW, (sy / core.camera.viewportH) * this.renderH];
    core.renderer.pick(rx, ry).then((hit) => {
      if (!hit || !this.lava) return;
      const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
      this.lava.addVent(x, y);
      core.sim.particles.burst({ kind: PK.Ember, x, y, z: hit.z + 1, count: 12, speed: 6, spread: 0.6 });
    }, ignoreTeardown);
  }

  /** Drop the chosen physics body over what's under the cursor (docs/PHYSICS.md). */
  private dropAtPick(sx: number, sy: number): void {
    const { core } = this;
    const ed = this.editor!;
    const kind = BODIES.find((b) => b.id === ed.body);
    if (!kind || !this.physics) return;
    const [rx, ry] = [(sx / core.camera.viewportW) * this.renderW, (sy / core.camera.viewportH) * this.renderH];
    core.renderer.pick(rx, ry).then(async (hit) => {
      if (!hit) return;
      const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
      // (over a body already there: above it)
      const api = (window as unknown as { reclaimed: { phys: { spawn: (m: VoxelModel, x: number, y: number, above: number, yaw: number, pitch: number, roll: number, vel: [number, number, number], floor: number) => Promise<unknown> } } }).reclaimed;
      const b = await api.phys.spawn(kind.make(), x, y, ed.dropHeight, Math.random() * 360, 0, 0, [0, 0, 0], hit.z + 1);
      if (!b) this.hud.say('No room for more bodies.', 2);
    }, ignoreTeardown);
  }

  /** Where the beam aims for a pointer at (sx, sy): on a touch screen a little above the finger, so it can be seen. */
  private beamAim(sx: number, sy: number): [number, number] {
    const touch = window.matchMedia('(pointer: coarse)').matches;
    return [sx, sy - (touch ? 80 : 0)];
  }

  /** Aim the heat beam at what's under the pointer: down the camera's view, into the surface hit. */
  private aimBeam([sx, sy]: [number, number]): void {
    const { core } = this;
    const { camera } = core;
    // drawn from the top of the screen, leaning a little, to the aim point
    const flick = 2 + Math.random() * 1.5;
    this.beamLine?.setAttribute('x1', String(sx + 120));
    this.beamLine?.setAttribute('y1', '-20');
    this.beamLine?.setAttribute('x2', String(sx));
    this.beamLine?.setAttribute('y2', String(sy));
    this.beamLine?.setAttribute('stroke-width', String(flick));
    this.beamDot?.setAttribute('cx', String(sx));
    this.beamDot?.setAttribute('cy', String(sy));
    this.beamDot?.setAttribute('r', String(4 + flick));
    this.beamPicking = true;
    const [rx, ry] = [(sx / camera.viewportW) * this.renderW, (sy / camera.viewportH) * this.renderH];
    core.renderer.pick(rx, ry).then((hit) => {
      this.beamPicking = false;
      if (!this.beamAt || !this.physics) return;
      if (!hit) {
        this.physics.beam = null;
        if (this.lava) this.lava.beam = null;
        return;
      }
      const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
      // (camera.eye is the unit direction toward the eye: the view runs down -eye)
      const z = hit.z + 0.5;
      this.physics.beam = { at: [x, y, z], dir: [-camera.eye[0], -camera.eye[1], -camera.eye[2]], radius: 1.6, power: 9000 };
      // on the ground (not a body): it melts it (lava.wgsl)
      if (this.lava) this.lava.beam = hit.flags & 0x8000 ? null : { at: [x, y, hit.z + 1], radius: 1.6, power: 9000 };
      // a ruin of the map's it touches comes alive
      // (at most a few times a second: each wake reads the layers back)
      if (!(hit.flags & 0x8000) && performance.now() - this.beamWoke > 300) {
        this.beamWoke = performance.now();
        void this.wake(x, y, z, 2);
      }
      core.sim.particles.burst({ kind: PK.Ember, x, y, z: z + 0.3, count: 2, speed: 2.5, spread: 0.3 });
    }, ignoreTeardown);
  }

  /**
   * Place the chosen model on whatever is under the cursor: the picked column
   * and its surface height (round 14: "spawn those voxels at the height of
   * the mouse pick") — on the ground, a roof, another wreck.
   */
  private placeAtPick(sx: number, sy: number): void {
    const { core } = this;
    const { camera } = core;
    const rx = (sx / camera.viewportW) * this.renderW;
    const ry = (sy / camera.viewportH) * this.renderH;
    core.renderer.pick(rx, ry).then((hit) => {
      if (!hit) return;
      const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
      void this.placeModel(x, y, hit.z);
    }, ignoreTeardown);
  }

  /** @param atZ the height to sit on (a pick); otherwise the mean ground under the footprint */
  private async placeModel(wx: number, wy: number, atZ?: number): Promise<void> {
    const ed = this.editor!;
    const m = modelById(ed.model)!;
    const { core } = this;
    if (ed.tilt > 0) {
      // a tilted model is its own grid (docs/GRIDS.md): toppled over its
      // quarter turn, with a little roll so no face lines up with the hexes
      const r = Math.PI / 180;
      const q = qYawPitchRoll(ed.rot * 90 * r + 0.3, ed.tilt * r, (ed.tilt / 9) * r);
      // (heightAt is the loose run's base: the pick's height says how deep
      // the sand lies over it here, and that depth is taken to hold under the
      // whole footprint — otherwise it rests sunk into the drift)
      const over = atZ === undefined ? 0 : Math.max(0, atZ - this.heightAt(wx, wy));
      const ground = (x: number, y: number) => this.heightAt(x, y) + over;
      if (!core.structures.place(m, wx, wy, q, ground, ed.bury)) this.hud.say('No room for more tilted structures (8 at most).', 3);
      return;
    }
    const { dims, packed } = core;
    const { fw, fd, cols } = modelColumns(m, ed.rot);
    const [[x0], [y0]] = this.placeRect(wx, wy);
    core.snapshot();
    const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
    const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < dims.w && y < dims.h;
    const topAt = (x: number, y: number) => {
      if (!inMap(x, y)) return 0;
      const c = readColumn(packed, slots, x, y);
      return c.length ? c[c.length - 1].z1 : 0;
    };
    const base = atZ !== undefined ? Math.max(1, atZ - ed.bury) : restingBase(topAt, x0, y0, fw, fd, ed.bury);
    if (base + m.size[2] >= dims.zMax - 1) {
      this.hud.say('Too high to place that here.', 2);
      return;
    }
    const writes: { at: number; data: Uint32Array }[] = [];
    for (let fy = 0; fy < fd; fy++)
      for (let fx = 0; fx < fw; fx++) {
        const x = x0 + fx;
        const y = y0 + fy;
        const runs = cols[fx + fw * fy];
        if (!runs.length || !inMap(x, y)) continue;
        const merged = seatColumn(
          readColumn(packed, slots, x, y),
          runs.map((r) => ({ z0: r.z0 + base, z1: r.z1 + base, mat: r.mat })),
          base,
          // placed at full support: the structure system bleeds it away only
          // where something is really unsupported (starting at 0, every
          // overhang would collapse before support could spread to it)
          15 << 4,
        );
        const { base: at, k } = columnSlots(packed, x, y);
        if (merged.length > k) {
          this.hud.say('Too many layers here to fit that model.', 2);
          return;
        }
        writes.push({ at, data: packColumn(merged, k) });
      }
    const { device } = this.host.gpu;
    for (const w of writes) device.queue.writeBuffer(core.world.layers, w.at * SLOT_WORDS * 4, w.data);
    core.sleep?.wake(x0 + fw / 2, (y0 + fd / 2) * ROW_H, Math.max(fw, fd) + 16, Sleep.EVENT_S, performance.now() / 1000);
    // (the loose ground under it stays in the layers, under the model)
    if (!this.physics) this.integrity?.markBox(x0 - 2, y0 - 2, x0 + fw + 2, y0 + fd + 2);
  }

  /**
   * Sandbox smash (F7): knock a hole in whatever structure is under the
   * cursor — at the exact point picked, so a pylon's leg can be cut at its
   * foot — with a spray of chips. `press` starts an undo step.
   */
  private smashAt(sx: number, sy: number, press: boolean): void {
    const ed = this.editor!;
    const { core } = this;
    const { camera } = core;
    if (press) core.snapshot();
    const rx = (sx / camera.viewportW) * this.renderW;
    const ry = (sy / camera.viewportH) * this.renderH;
    core.renderer.pick(rx, ry).then((hit) => {
      if (!hit) return;
      const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
      const at: [number, number, number] = [x, y, hit.z + 0.5];
      // physics (docs/PHYSICS.md): a ruin hit comes alive first, then a blast
      // where it hit — what's inside crumbles, what's near is thrown — and the
      // ground there is smashed as before
      if (this.physics) {
        const phys = this.physics;
        const body = (hit.flags & 0x8000) !== 0;
        void (body ? Promise.resolve() : this.wake(x, y, at[2], ed.radius + 2)).then(() => {
          phys.blast(at, Math.max(1, ed.radius * 0.5), 6);
          if (!body) core.globals.events.push({ kind: EventKind.Edit, x, y, z: 12 * 32, radius: ed.radius, strength: hit.z });
          core.sim.particles.burst({ kind: PK.Chip, x, y, z: hit.z, count: 6 + ed.radius * 3, speed: 4, spread: ed.radius * 0.5 });
        });
        return;
      }
      // a fallen body under the cursor: break it in its own frame (round 18)
      if (hit.flags & 0x8000) {
        this.integrity?.breakBodies(at, ed.radius);
        return;
      }
      core.globals.events.push({ kind: EventKind.Edit, x, y, z: 12 * 32, radius: ed.radius, strength: hit.z });
      this.integrity?.markDirty(x, y, ed.radius + 14);
      core.sim.particles.burst({ kind: PK.Chip, x, y, z: hit.z, count: 6 + ed.radius * 3, speed: 4, spread: ed.radius * 0.5 });
    }, ignoreTeardown);
  }

  /** Sandbox: put the world back as it was before the last brush press. */
  private undo(): void {
    this.brushAt = undefined;
    this.integrity?.clear();
    if (!this.core.undo()) this.hud.say('Nothing to undo.', 2);
  }

  /** One frame of the brush: an EV_EDIT event for edit.wgsl. */
  private brush(x: number, y: number): void {
    const ed = this.editor!;
    if (this.raising) return void this.raising.to(x, y);
    const op = EDIT_OP[ed.tool];
    if (!op) return;
    const layered = LAYER_TOOLS.has(ed.tool);
    const z = op * 32 + ed.material + (this.strokeStart ? 512 : 0);
    this.strokeStart = false;
    this.core.globals.events.push({ kind: EventKind.Edit, x, y, z, radius: ed.radius, strength: layered ? ed.layers : ed.strength });
    // digging under a ruin of the map's wakes it (round 48: it fell, rather
    // than hanging over the hole); a few times a second, each wake reads the layers back
    if (this.physics && ed.tool === 'dig' && performance.now() - this.digWoke > 300) {
      this.digWoke = performance.now();
      void this.wake(x, y, -1, ed.radius + 1);
    }
  }

  /** How many columns within r of (x, y) have this top material (surface cache, ~1 s old). */
  private countSurface(x: number, y: number, r: number, mat: number): number {
    const { dims } = this.core;
    let n = 0;
    for (let yy = Math.floor(y - r); yy <= y + r; yy++)
      for (let xx = Math.floor(x - r); xx <= x + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= dims.w || yy >= dims.h || Math.hypot(xx - x, yy - y) > r) continue;
        if (sfMat(this.surfaceCache[yy * dims.w + xx]) === mat) n++;
      }
    return n;
  }

  /** CPU guess at whether a tapped spot is hostile ground (polluted or littered/trashed). */
  private hostileAt([x, y]: [number, number]): boolean {
    const { dims, map } = this.core;
    const i = Math.floor(y) * dims.w + Math.floor(x);
    const top = sfMat(this.surfaceCache[i]);
    return top === 12 || top === 18 || map.contam[i * 2] > 0.2;
  }

  private showComplete(): void {
    const el = document.createElement('div');
    el.className = 'complete';
    el.innerHTML = `<div class="card">
      <h2>THE VALLEY BREATHES</h2>
      <p>Life has taken back the land. The ruins are still here — they are part of it now.</p>
      <button data-a="stay">Keep watching</button><button data-a="menu">Return</button>
    </div>`;
    this.host.ui.appendChild(el);
    this.audio.flutter();
    el.querySelector('[data-a="stay"]')!.addEventListener('click', () => el.remove());
    el.querySelector('[data-a="menu"]')!.addEventListener('click', () => {
      el.remove();
      this.onExit();
    });
  }

  dispose(): void {
    this.abort.abort();
    this.atlasCtl?.remove();
    this.far?.dispose();
    this.worldApi?.dispose();
    this.controls.dispose();
    this.editor?.dispose();
    this.ring?.parentElement?.remove();
    this.hud.dispose();
    this.core.destroy();
    for (const el of this.host.ui.querySelectorAll('.complete')) el.remove();
  }
}
