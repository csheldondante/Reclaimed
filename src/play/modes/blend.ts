// ---- play/modes/blend.ts ----------------------------------------------------------------------------------------
// (round 128b, `playmodes`) The play modes' camera: the presentation's mode (present/mode.ts) for the mode on, and
// the one before it easing out, so a switch is a blend both ways (the old view out while the new one comes in), not
// a snap back to the chase. Given to the rig as its `present` mode (CameraRig.setPresent).

import type { CamContext, CameraMode, CamFrame } from '../../api/contracts/camera';
import type { PresentationProfile } from '../../api/contracts/presentation';
import { PresentMode } from '../../present/mode';

export class ModeCamera implements CameraMode {
  readonly id = 'present' as const;
  readonly stage = 2.5;
  private now: PresentMode | null = null;
  private out: PresentMode[] = [];
  /** cells over the hero's floor the near side is cut down to (side views); null: none */
  cut: number | null = null;

  /** the view on now (its own transition eases it in; the one before eases out over its own) */
  set(profile: PresentationProfile, instant = false): void {
    if (this.now) {
      this.now.hold = 'out';
      this.out.push(this.now);
    }
    this.now = new PresentMode(profile, null);
    this.now.hold = 'in';
    if (instant) {
      this.now.w = 1;
      this.out.length = 0;
    }
  }

  /** the view on now (the driver sets its azimuth from the route each frame) */
  get profile(): PresentationProfile | null {
    return this.now?.profile ?? null;
  }

  reset(frame: CamFrame): void {
    this.now?.reset(frame);
    for (const m of this.out) m.reset(frame);
  }

  shift(): void {}

  step(ctx: CamContext, frame: CamFrame): void {
    for (const m of this.out) m.step(ctx, frame);
    this.out = this.out.filter((m) => m.w > 0);
    this.now?.step(ctx, frame);
    // (the side views: the land between the eye and the hero sliced off over the floor, the whole view)
    // (its near-side plane set 2 cells in front of the hero toward the eye: through the hero itself, the hero's own body —
    // over the cut — was dithered away)
    if (this.cut !== null && this.now && this.now.w > 0.05) {
      const az = frame.view.azimuth;
      const at: [number, number] = [ctx.pose.at[0] + Math.cos(az) * 2, ctx.pose.at[1] + Math.sin(az) * 2];
      frame.cut.slice = { z: ctx.pose.floor + this.cut, at, radius: 0, rim: 0.25, fade: 0, fadeR: 0, bowl: 0, nearOnly: true, occluders: false };
    }
    // (the side views: the hero low on the screen — under the floor's line is only the cut's dark section — the land
    // behind it filling the rest: the view's centre moved away from the eye along the ground, a tenth of the screen up.
    // Along the ground, not up: the chase eases the target's height from frame to frame, so a lift there piled up)
    if (this.cut !== null && this.now) {
      const v = frame.view;
      const d = ((0.1 * v.h) / Math.max(v.zoom, 1) / Math.max(Math.sin(v.elevation), 0.1)) * this.now.w;
      v.target[0] -= Math.cos(v.azimuth) * d;
      v.target[1] -= Math.sin(v.azimuth) * d;
    }
  }
}
