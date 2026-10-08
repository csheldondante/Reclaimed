// Persistent progression shown by the menu scene (design doc §4): the best
// reclamation the player has reached, 0..1 (1 = a level completed).
// Browser storage is a per-viewer convenience; it may be unavailable
// (private mode, blocked storage) — then progress simply starts at 0.

const KEY = 'reclaimed.progress.v1';

export function loadProgress(): number {
  try {
    const v = Number(localStorage.getItem(KEY) ?? 0);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  } catch {
    return 0;
  }
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
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: nothing to forget */
  }
}

/** Keeps the maximum ever reached. */
export function saveProgress(p: number): void {
  try {
    if (p > loadProgress()) localStorage.setItem(KEY, String(Math.min(1, p)));
  } catch {
    /* storage unavailable: progress lasts for this session only */
  }
}

/** Reclamation (clean land + staged life, game/nature.ts) at which a level counts as reclaimed. */
export const LEVEL_GOAL = 0.55;
