// Persistent progression shown by the menu scene (design doc §4): the best
// reclamation the player has reached, 0..1 (1 = a level completed).
// Browser storage is a per-viewer convenience; it may be unavailable
// (private mode, blocked storage) — then progress simply starts at 0.

const KEY = 'reclaimed.progress.v1';
/** Per level (the valley keeps the original key so old saves carry over). */
const keyFor = (level: string) => (level === 'valley' ? KEY : `${KEY}.${level}`);
/** Levels whose progress the title diorama reflects (the sandbox doesn't count). */
const REAL_LEVELS = ['valley', 'highway', 'city', 'port'];

/** Best reclamation reached in one level, 0..1 (1 = completed). */
export function loadLevelProgress(level: string): number {
  try {
    const v = Number(localStorage.getItem(keyFor(level)) ?? 0);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  } catch {
    return 0;
  }
}

/** Overall progress (the title diorama): the best of any level so far. */
export function loadProgress(): number {
  return Math.max(...REAL_LEVELS.map(loadLevelProgress));
}

const DIFF_KEY = 'reclaimed.difficulty.v1';
export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTY_LEVEL: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 };

/** The chosen difficulty (title screen; default medium). */
export function loadDifficulty(): Difficulty {
  try {
    const v = localStorage.getItem(DIFF_KEY);
    return v === 'easy' || v === 'hard' ? v : 'medium';
  } catch {
    return 'medium';
  }
}

export function saveDifficulty(d: Difficulty): void {
  try {
    localStorage.setItem(DIFF_KEY, d);
  } catch {
    /* storage unavailable: lasts for this session only */
  }
}

/** Forget all progress (the title screen's reset). */
export function resetProgress(): void {
  try {
    for (const l of REAL_LEVELS) localStorage.removeItem(keyFor(l));
    localStorage.removeItem(UNCOVER_KEY);
  } catch {
    /* storage unavailable: nothing to forget */
  }
}

/** Keeps the maximum ever reached in that level. */
export function saveProgress(level: string, p: number): void {
  try {
    if (p > loadLevelProgress(level)) localStorage.setItem(keyFor(level), String(Math.min(1, p)));
  } catch {
    /* storage unavailable: progress lasts for this session only */
  }
}


// ---- the title screen's buried level models (round 13, F11) ----------------
// Only the first level's model starts uncovered. The next one is uncovered
// by finishing the level before it — or by the player blowing the dust off it
// on the title screen (to encourage exploring), which is remembered.

const UNCOVER_KEY = 'reclaimed.uncovered.v1';

function uncoveredSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(UNCOVER_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** The player blew the dust off this level's model. */
export function saveUncovered(level: string): void {
  try {
    const s = uncoveredSet();
    s.add(level);
    localStorage.setItem(UNCOVER_KEY, JSON.stringify([...s]));
  } catch {
    /* storage unavailable: lasts for this visit only */
  }
}

/** Is this level's model uncovered on the title screen? */
export function levelUncovered(level: string): boolean {
  const k = REAL_LEVELS.indexOf(level);
  if (k < 0) return true; // not part of the chain (the sandbox)
  if (k === 0) return true;
  return uncoveredSet().has(level) || loadLevelProgress(REAL_LEVELS[k - 1]) >= 1;
}

/** The level before this one in the chain (whose completion uncovers it). */
export function previousLevel(level: string): string | undefined {
  const k = REAL_LEVELS.indexOf(level);
  return k > 0 ? REAL_LEVELS[k - 1] : undefined;
}
