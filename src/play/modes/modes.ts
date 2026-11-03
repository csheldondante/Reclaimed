// ---- play/modes/modes.ts ----------------------------------------------------------------------------------------
// (round 128b, `playmodes`; api/contracts/playmode.ts) The course's play modes, the switch between them and what the
// stick means in each. Pure: Node tests (modes.test.ts) step the switch and the controls.
//
//   open    today's chase, the pull-out and the lead made stronger (experiment 1)
//   canyon  close behind the bike, the canyon steering it round; the stick across rides it up a wall (experiment 2;
//           the bike's run: canyon.ts)
//   woods   side-on, a 2D plane through the trees (experiment 3)
//   climb   near-profile, facing the cliff (experiment 4)
//   under   the chase, drawn in under the canopy, the stumps cut and faded (experiment 5: the forest's other option)

import type { V2 } from '../../api/contracts/camera';
import type { PresentationProfile } from '../../api/contracts/presentation';
import type { PlayMode, RouteHere } from '../../api/contracts/playmode';

/** a view: the chase's own unless set */
function view(id: string, cam: Partial<PresentationProfile['camera']>, seconds = 0.8, cut: number | null = null): PresentationProfile {
  return {
    id,
    name: id,
    camera: { zoom: null, elevation: null, azimuth: null, routeFacing: false, lookAhead: 0, speedOut: 0, ...cam },
    // (a cut: the trees between the eye and the hero cut down too — the presentation's foreground cut)
    canopy: { dither: false, cutaway: cut !== null, stipple: false, radius: 60, cutHeight: cut ?? 0, stippleShare: 0 },
    light: { dapple: 0 },
    transition: { style: 'zoom', seconds },
    scale: { hero: 1, trees: 1, thin: 0 },
  };
}

export type ModeId = 'open' | 'canyon' | 'woods' | 'climb' | 'under';

export const MODES: Record<ModeId, PlayMode> = {
  open: {
    id: 'open',
    name: 'Open ride',
    icon: '🏍',
    // (the chase's own zoom and lead, then a further 0.25 s of lead: further off-centre toward the way ahead)
    view: view('open', { lookAhead: 0.25 }),
    facing: null,
    cut: null,
    controls: 'free',
    assists: { autoRun: false, speed: 1, laneHalf: 0 },
    entry: { autoSeconds: 0 },
  },
  canyon: {
    id: 'canyon',
    name: 'Canyon run',
    icon: '🏜',
    // (round 128b, the user: "zoomed in so far the canyon walls were only in the background and the camera followed as
    // the bike auto steers around". Close: ~8 cells across a phone, the floor filling the screen and the walls at its
    // edges and rising out of it; behind the way ahead (the facing), the bike low (HeroCourse: ModeCamera.low), a
    // little out with speed. Was zoom 26 (~16 cells across: the walls filled the frame) with a 0.45 s lead)
    // (the cut: the rock between the eye and the bike sliced off 3 cells over its floor — in a hairpin the eye looks
    // across the rock it turns round, and at this zoom the rock was the whole screen)
    view: view('canyon', { zoom: 50, elevation: 45, lookAhead: 0, speedOut: 0.12 }, 1, 3),
    facing: 'behind',
    cut: 3,
    controls: 'lane',
    assists: { autoRun: true, speed: 0.55, laneHalf: 3.2 },
    entry: { autoSeconds: 1.5 },
  },
  woods: {
    id: 'woods',
    name: 'Woods run',
    icon: '🏃',
    // (side-on and low: the trees in front and behind as layers sliding past at their own speeds)
    view: view('woods', { zoom: 17, elevation: 20, lookAhead: 0.4, speedOut: 0.25 }, 1, 0.3),
    // (the eye on the loop's inside: the woods go on behind the hero, not the map's edge)
    facing: 'left',
    cut: 0.3,
    controls: 'profile',
    assists: { autoRun: false, speed: 0.6, laneHalf: 0 },
    entry: { autoSeconds: 1.5 },
  },
  climb: {
    id: 'climb',
    name: 'Cliff climb',
    icon: '🧗',
    // (near-profile: low, square to the face; the azimuth set from the route's way, the face on its left)
    view: view('climb', { zoom: 20, elevation: 14, lookAhead: 0.2 }, 1, 0.3),
    // (the eye on the way's right, outside the loop: the massif is on its left)
    facing: 'right',
    cut: 0.3,
    controls: 'free',
    assists: { autoRun: false, speed: 0.5, laneHalf: 0 },
    entry: { autoSeconds: 1.2 },
  },
  under: {
    id: 'under',
    name: 'Under the trees',
    icon: '🌳',
    // (the chase; the understory's driver draws the view in under the canopy and cuts the stumps: forest/driver.ts)
    view: view('under', { lookAhead: 0.25 }),
    facing: null,
    cut: null,
    controls: 'free',
    assists: { autoRun: false, speed: 1, laneHalf: 0 },
    entry: { autoSeconds: 0 },
  },
};

export const MODE_IDS = Object.keys(MODES) as ModeId[];

export function isModeId(s: string): s is ModeId {
  return s in MODES;
}

// ---- the switch -------------------------------------------------------------------------------------------------

export interface SwitchStep {
  mode: ModeId;
  /** the game is steering (the brief auto on the way in) */
  auto: boolean;
  /** the mode changed this step */
  changed: boolean;
}

/**
 * Which mode is on, and who steers. The game picks the mode from where the hero is (`pick`); on a change it steers for
 * the mode's entry seconds (the brief auto), and hands back at once when the player touches the screen.
 */
export class ModeSwitcher {
  mode: ModeId;
  /** seconds of the brief auto left (0: the player's) */
  autoLeft = 0;
  /** a mode forced from the settings (null: the game picks) */
  forced: ModeId | null = null;

  constructor(
    private pick: (at: V2) => ModeId,
    at: V2,
  ) {
    this.mode = pick(at);
  }

  /** `touched`: the player touched the screen (the stick, a drag, a button) since the last step */
  step(dt: number, at: V2, touched: boolean): SwitchStep {
    const want = this.forced ?? this.pick(at);
    let changed = false;
    if (want !== this.mode) {
      this.mode = want;
      this.autoLeft = MODES[want].entry.autoSeconds;
      changed = true;
    }
    if (touched) this.autoLeft = 0;
    else this.autoLeft = Math.max(0, this.autoLeft - dt);
    return { mode: this.mode, auto: this.autoLeft > 0, changed };
  }

  /** a teleport: the mode there, no brief auto */
  reset(at: V2): void {
    this.mode = this.forced ?? this.pick(at);
    this.autoLeft = 0;
  }
}

// ---- the controls -----------------------------------------------------------------------------------------------

const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * The stick a mode's controls make from the player's (world xy, length ≤ 1) and the route at the hero. `auto`: the
 * brief auto on the way in (the player's stick ignored: the route is taken at the mode's speed).
 */
export function modeStick(mode: PlayMode, stick: V2, here: RouteHere, auto: boolean): V2 {
  const a = mode.assists;
  const s: V2 = auto ? [0, 0] : stick;
  const { tan, nrm, off } = here;
  switch (mode.controls) {
    case 'free':
      return s;
    case 'lane': {
      // (forward: the route's speed, a little more or less with the stick; across: the stick's sideways part at once,
      // and back toward the lane when the hero is past its edge)
      const fwd = clamp(a.speed + dot(s, tan) * 0.35, 0.15, 1);
      let side = dot(s, nrm);
      if (Math.abs(side) < 0.15) side = 0;
      const over = Math.abs(off) - a.laneHalf;
      if (over > 0) side -= Math.sign(off) * clamp(over * 0.6, 0, 1);
      return norm([tan[0] * fwd + nrm[0] * side, tan[1] * fwd + nrm[1] * side]);
    }
    case 'profile': {
      // (along: the stick's part along the route, or the route's speed when it runs on by itself; across: held on the
      // route's line)
      let along = dot(s, tan);
      if (auto || (a.autoRun && Math.abs(along) < 0.15)) along = a.speed;
      const back = -clamp(off * 0.5, -0.8, 0.8);
      return norm([tan[0] * along + nrm[0] * back, tan[1] * along + nrm[1] * back]);
    }
  }
}

function norm(v: V2): V2 {
  const l = Math.hypot(v[0], v[1]);
  return l > 1 ? [v[0] / l, v[1] / l] : v;
}

/** The camera's azimuth (radians: where the eye is from the hero) for a facing, from the route's way. */
export function facingAzimuth(f: 'behind' | 'left' | 'right', tan: V2): number {
  const way = Math.atan2(tan[1], tan[0]);
  // (behind: the eye back along the way, so it runs up the screen; left / right: the eye on that side of the way, so
  // the way runs across the screen — right to left seen from its left)
  return f === 'behind' ? way + Math.PI : f === 'left' ? way + Math.PI / 2 : way - Math.PI / 2;
}
