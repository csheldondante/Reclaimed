// ---- runplay/player.ts ------------------------------------------------------------------------------------------
// (round 119, `runplay`) The run's stages played by play's hero in the level (contracts/run.ts StagePlayer): a
// PlaySession (the same hero, controls and camera as the play sandbox — tuned there, played here) and, per stage, a
// StagePlay; its result turned into the stage's planned outcome by the rules (rules.ts outcomeFor).

import type { PlayedStage, RunStage, StagePlayer } from '../api/contracts/run';
import type { Units } from '../api/contracts/units';
import type { Sim } from '../api/world';
import type { PlaySession } from '../play/session';
import { library } from '../play/library';
import { outcomeFor, stageSpec } from './rules';
import { StagePlay } from './stage';

export interface PlayerDeps {
  ui: HTMLElement;
  api: Sim;
  units: Units;
  session: PlaySession;
  bounds: [number, number];
}

export class RunPlayer implements StagePlayer {
  /** the stage being played (scripts read it: window.reclaimed.runplay) */
  current: StagePlay | null = null;
  readonly log: string[] = [];

  constructor(private d: PlayerDeps) {
    d.session.extraParts = () => this.current?.parts() ?? [];
  }

  private get profile() {
    const h = this.d.session.hero;
    return library.get(h.role === 'lich' ? 'lich' : 'hoverbike')!.profile(h.params);
  }

  preview(stage: RunStage): { goal: string; note?: string } {
    const s = stageSpec(stage, this.profile);
    return { goal: s.goal, note: s.standIn };
  }

  async play(stage: RunStage): Promise<PlayedStage> {
    const S = this.d.session;
    // (whole again for each stage: a run's wounds are its statuses, not the health bar)
    S.respawn();
    S.paused = false;
    const st = new StagePlay({ ui: this.d.ui, api: this.d.api, units: this.d.units, session: S, bounds: this.d.bounds, profile: () => this.profile }, stage);
    this.current = st;
    S.statusLine = null;
    const r = await st.result;
    // (a moment on the result before the card)
    await new Promise((res) => setTimeout(res, 1600));
    st.dispose();
    this.current = null;
    const { outcome, runEnd } = outcomeFor(stage, r.status);
    this.log.push(`${stage.id} ${r.spec.kind}: ${r.status.state}${r.status.state !== 'playing' ? ` (${r.status.how})` : ''} in ${r.seconds.toFixed(1)} s, ${r.summary} → ${outcome.id}${runEnd ? `, run ${runEnd}` : ''}`);
    return { outcome: outcome.id, runEnd, won: r.status.state === 'won', line: r.summary, seconds: r.seconds, par: r.spec.par };
  }

  hold(on: boolean): void {
    this.d.session.paused = on;
  }

  arrived(): void {
    const S = this.d.session;
    const c = S.d.camera.target;
    S.warped(S.dryNear([c[0], c[1]]));
  }

  /** each frame, after the session */
  update(dt: number): void {
    this.current?.update(dt);
  }

  /** the window slid */
  shift(dx: number, dy: number, dz: number): void {
    this.current?.shift(dx, dy, dz);
  }

  dispose(): void {
    this.current?.dispose();
    this.current = null;
  }
}
