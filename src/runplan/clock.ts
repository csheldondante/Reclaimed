// ---- runplan/clock.ts -------------------------------------------------------------------------------------------
// (round 119, runplay) The run's clock: the plan's deadline (RunPlan.deadline, minutes) is the GM's timeline — the
// user's "failure to meet a timeline" (round 117). Played stages and travelled legs count on it; past it the run ends
// 'late' (consequences.ts failureRules 'late').

/**
 * The run's clock (the plan's deadline, minutes: the GM's timeline — the user's "failure to meet a timeline"). A stage
 * counts its planned minutes, more if it was played slower than par; a leg its travel minutes. Past the deadline the
 * run ends 'late'.
 */
export class RunClock {
  minutes = 0;
  constructor(readonly deadline: number) {}
  stage(planned: number, seconds: number, par: number): void {
    this.minutes += planned * Math.max(1, seconds / Math.max(par, 1));
  }
  leg(minutes: number): void {
    this.minutes += minutes;
  }
  get late(): boolean {
    return this.minutes > this.deadline;
  }
}
