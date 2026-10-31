// The physics experiment's controls (round 120, the user: "test each approach side by side … so I can see what is
// improved vs the cost"): in the lab's tuning panel, a solver picker (solver/variant.ts: ?solver=) and a judge picker
// (game/judge.ts JUDGES: ?judge=) — a pick reloads the page with it — and "compare": the last cut pressed, played again
// under every solver × judge in turn (a reload each, the level made fresh: the same start every time), `?run=station/
// button` pressing it once the level has settled, `?compare=` the pairs still to go (solver:judge, comma separated).

import { VARIANTS, type SolverVariant } from '../solver/variant';
import { JUDGES, type JudgeId } from '../game/judge';

export interface ExperimentHooks {
  variant: SolverVariant;
  judge: JudgeId;
  /** the station and button last pressed (for compare) */
  lastRun(): string | null;
}

/** the page again with these parameters changed (null: removed) */
export function reloadWith(changes: Record<string, string | null>): void {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  location.href = u.toString();
}

/** every solver × judge pair, in order */
export function comparePairs(): string[] {
  const out: string[] = [];
  for (const v of VARIANTS) for (const j of Object.keys(JUDGES)) out.push(`${v}:${j}`);
  return out;
}

const openPair = (pair: string, run: string | null, rest: string[]) => {
  const [solver, judge] = pair.split(':');
  reloadWith({ solver, judge, run, compare: rest.length ? rest.join(',') : null });
};

export function experimentControls(h: ExperimentHooks): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tune-experiment';
  el.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 8px';
  const pick = (label: string, options: [string, string][], value: string, on: (v: string) => void) => {
    const l = document.createElement('label');
    l.textContent = `${label} `;
    const s = document.createElement('select');
    for (const [v, text] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = text;
      s.append(o);
    }
    s.value = value;
    s.addEventListener('change', () => on(s.value));
    l.append(s);
    el.append(l);
  };
  pick('solver', VARIANTS.map((v) => [v, v]), h.variant, (v) => reloadWith({ solver: v, run: null, compare: null }));
  pick('judge', Object.entries(JUDGES).map(([j, d]) => [j, d.label]), h.judge, (j) => reloadWith({ judge: j, run: null, compare: null }));
  const b = document.createElement('button');
  b.textContent = 'compare';
  b.title = 'the last cut you pressed, again under every solver × judge in turn (a fresh level each)';
  b.addEventListener('click', () => {
    const run = h.lastRun();
    if (!run) {
      b.textContent = 'press a cut first';
      setTimeout(() => (b.textContent = 'compare'), 1500);
      return;
    }
    const [first, ...rest] = comparePairs();
    openPair(first, run, rest);
  });
  el.append(b);
  const now = document.createElement('span');
  now.style.cssText = 'opacity:.7;font-size:90%';
  now.textContent = `now: ${h.variant} × ${h.judge}`;
  el.append(now);
  return el;
}

/**
 * `?run=station/button` (and `?compare=` the pairs still to go): once the level has settled, that station's button is
 * pressed; with pairs left, the next is loaded after `secs`.
 */
export function startRun(params: URLSearchParams, press: (station: string, button: string) => boolean, secs = 14): void {
  const run = params.get('run');
  if (!run) return;
  const [station, button] = run.split('/');
  setTimeout(() => {
    if (!press(station, decodeURIComponent(button ?? ''))) throw new Error(`?run=${run}: no such station or button`);
    const left = (params.get('compare') ?? '').split(',').filter(Boolean);
    if (left.length) setTimeout(() => openPair(left[0], run, left.slice(1)), secs * 1000);
  }, 6000);
}
