// The collapse judges (the experiment, round 120): what decides what lets go. The column judge (fracture.ts:
// analyseRock for rock, analyse for what's built) is the one here; branch `judge` builds the user's method of sections
// on the GPU and adds itself to JUDGES as `sections`. `?judge=` picks one for the page; the lab's panel picks and
// reloads. A name this build doesn't have is an error, not a quiet fall back to the columns.

export interface JudgeInfo {
  id: string;
  name: string;
  /** one line: how it decides */
  about: string;
}

export const JUDGES: Record<string, JudgeInfo> = {
  columns: { id: 'columns', name: 'columns', about: 'the column judge (fracture.ts): runs, flood fills from what holds, loads handed in from the far ends, bend/shear/buckle/tip' },
};

/** judges named but built on another branch (shown, not pickable here) */
export const JUDGES_ELSEWHERE: Record<string, string> = {
  sections: 'the method of sections on the GPU — branch `judge`',
};

export function judgeName(params: URLSearchParams = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search)): string {
  const j = params.get('judge') ?? 'columns';
  if (JUDGES[j]) return j;
  if (JUDGES_ELSEWHERE[j]) throw new Error(`?judge=${j}: ${JUDGES_ELSEWHERE[j]} — not in this build`);
  throw new Error(`?judge=${j}: one of ${Object.keys(JUDGES).join(', ')}`);
}
