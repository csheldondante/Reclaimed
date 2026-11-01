// ---- play/camera/rig.ts -----------------------------------------------------------------------------------------
// (round 121, herolab) The camera rig: the modes picked (the chase always, as the base framing; any of rotate, tilt,
// cutaway, edge, dither over it), the interest sources (the way ahead; more plug in), one frame stepped a frame.
// `?cam=` names the modes: `?cam=rotate+dither`, `?cam=chase` today's camera. Pure: the session and the lab apply
// the frame to the renderer's camera (apply.ts); the metrics read it in Node.

import { MAX_SEE, type CamFrame, type CamIntent, type CameraMode, type CamModeId, type CamPose, type CamSignal, type Interest, type InterestSource, type SightWorld } from '../../api/contracts/camera';
import type { ChaseFraming } from '../../api/contracts/hero';
import { heroInterest, WayAheadSource } from './interests';
import { ChaseMode, CutawayMode, DitherMode, EdgeMode, RotateMode, TiltMode } from './modes';
import { CAM, type CamParams } from './params';

export const CAM_MODES: readonly { id: CamModeId; label: string; icon: string; hint: string }[] = [
  { id: 'chase', label: 'chase', icon: '🎥', hint: "today's chase: a fixed angle, the zoom and lead from the hero's speed" },
  { id: 'rotate', label: 'rotate', icon: '🔄', hint: 'the view turns to the nearest angle the hero and the way ahead are seen from' },
  { id: 'tilt', label: 'tilt', icon: '⤒', hint: 'the view tilts toward top-down as what hides the hero rises' },
  { id: 'dither', label: 'dither', icon: '░', hint: 'what hides the hero and the way ahead is dithered out round them' },
  { id: 'cutaway', label: 'cut', icon: '✂', hint: 'anything taller than a short height over the hero\'s ground is cut down round it, a rim lit' },
  { id: 'edge', label: 'edge', icon: '▣', hint: 'the centre and the way ahead kept clear; occluders only at the screen\'s edges' },
];

/** `?cam=` → the modes (the chase always first); an unknown name throws (no silent default) */
export function parseCam(s: string | null | undefined): CamModeId[] {
  const out: CamModeId[] = ['chase'];
  if (!s) return out;
  for (const raw of s.split(/[+, ]+/)) {
    const id = raw.trim().toLowerCase();
    if (!id) continue;
    const m = CAM_MODES.find((x) => x.id === id || x.label === id);
    if (!m) throw new Error(`?cam=${s}: no camera mode "${raw}" (${CAM_MODES.map((x) => x.id).join(', ')})`);
    if (!out.includes(m.id)) out.push(m.id);
  }
  return out;
}

/** the modes as `?cam=` writes them (chase alone: "chase") */
export function camString(ids: readonly CamModeId[]): string {
  const rest = ids.filter((i) => i !== 'chase');
  return rest.length ? rest.join('+') : 'chase';
}

/** seconds the way ahead must say otherwise before the signal changes (round 121: it flickered at a wall) */
export const SIGNAL_HOLD = 0.3;

export interface RigScreen {
  w: number;
  h: number;
  margin: number;
}

export class CameraRig {
  readonly chase: ChaseMode;
  readonly ahead: WayAheadSource;
  /** more interest sources (enemies, objectives, pickups) */
  readonly sources: InterestSource[] = [];
  modes: CameraMode[] = [];
  readonly frame: CamFrame = { view: { target: [0, 0, 0], zoom: 30, azimuth: Math.PI / 4, elevation: (30 * Math.PI) / 180, w: 1, h: 1, margin: 56 }, cut: { slice: null, see: [] }, signals: [] };
  /** this frame's interests (the hero first) */
  interests: Interest[] = [];
  private all: Record<CamModeId, CameraMode>;
  private fresh = true;

  constructor(
    ids: readonly CamModeId[],
    readonly p: CamParams = CAM,
  ) {
    this.chase = new ChaseMode(p);
    this.ahead = new WayAheadSource(p);
    this.all = { chase: this.chase, rotate: new RotateMode(p), tilt: new TiltMode(p), cutaway: new CutawayMode(p), edge: new EdgeMode(p), dither: new DitherMode(p) };
    this.use(ids);
  }

  get ids(): CamModeId[] {
    return this.modes.map((m) => m.id);
  }

  /** the modes on (the chase always); the others start from the frame as it is */
  use(ids: readonly CamModeId[]): void {
    const set = new Set<CamModeId>(['chase', ...ids]);
    const was = new Set(this.modes.map((m) => m.id));
    this.modes = [...set].map((id) => this.all[id]).sort((a, b) => a.stage - b.stage);
    for (const m of this.modes) if (!was.has(m.id)) m.reset(this.frame);
    // (a mode turned off gives back what it held: the fixed angle, the fixed tilt, no cut)
    if (!set.has('rotate') && was.has('rotate')) this.frame.view.azimuth = this.restAz;
    if (!set.has('tilt') && was.has('tilt')) this.frame.view.elevation = (30 * Math.PI) / 180;
  }

  /** the azimuth the view rests at when nothing turns it (the level's own, or the player's turn) */
  restAz = Math.PI / 4;

  /** a new hero: its framing and zoom; the next step starts on it at rest */
  setHero(f: ChaseFraming | undefined, zoom: number): void {
    this.chase.setHero(f, zoom);
    this.fresh = true;
  }

  /** a jump (a respawn, a warp): framed at once */
  jump(): void {
    this.fresh = true;
  }

  /** the streamed window slid by (dx, dy, dz) (what's kept in window coordinates moves by it) */
  shift(dx: number, dy: number, dz: number): void {
    const t = this.frame.view.target;
    t[0] += dx;
    t[1] += dy;
    t[2] += dz;
    for (const m of Object.values(this.all)) m.shift?.(dx, dy, dz);
  }

  step(dt: number, pose: CamPose, intent: CamIntent, world: SightWorld, screen: RigScreen): CamFrame {
    const f = this.frame;
    f.view.w = screen.w;
    f.view.h = screen.h;
    f.view.margin = screen.margin;
    if (this.fresh) {
      f.view.target = [pose.at[0], pose.at[1], pose.at[2]];
      for (const m of this.modes) m.reset(f);
      this.fresh = false;
    }
    this.interests = [heroInterest(pose), ...this.ahead.interests(pose, world), ...this.sources.flatMap((s) => s.interests(pose, world))];
    f.cut.slice = null;
    f.cut.see = [];
    const ctx = { dt, pose, intent, interests: this.interests, world };
    for (const m of this.modes) m.step(ctx, f);
    // (the renderer keeps MAX_SEE holes: the hero's first, then as the interests rank)
    if (f.cut.see.length > MAX_SEE) {
      const rank = (id: string) => {
        const i = this.interests.findIndex((x) => x.id === id);
        return i < 0 ? 99 : i;
      };
      f.cut.see.sort((a, b) => rank(a.id) - rank(b.id));
      f.cut.see.length = MAX_SEE;
    }
    f.signals = this.signals(dt);
    return f;
  }

  /** what the signal says now, and how long the walk has said otherwise (a kind changes only once it's held) */
  private said: { kind: 'open' | 'dead' | null; other: number } = { kind: null, other: 0 };

  /** the way ahead on screen: a dead end always (when signalled at all), a way on at a turn (or always); a change of kind held SIGNAL_HOLD first */
  private signals(dt: number): CamSignal[] {
    const a = this.p.ahead;
    const w = this.ahead.last;
    if (a.signal < 1 || !w) return [];
    const now: 'open' | 'dead' | null = !w.open ? 'dead' : a.signal >= 2 || this.ahead.turned(a.turnAt) ? 'open' : null;
    if (now === this.said.kind) this.said.other = 0;
    else if ((this.said.other += dt) >= SIGNAL_HOLD || this.said.kind === null) {
      this.said = { kind: now, other: 0 };
    }
    return this.said.kind ? [{ id: 'ahead', kind: this.said.kind, at: w.end }] : [];
  }
}

export type { SightWorld };
