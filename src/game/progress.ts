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

/** Keeps the maximum ever reached. */
export function saveProgress(p: number): void {
  try {
    if (p > loadProgress()) localStorage.setItem(KEY, String(Math.min(1, p)));
  } catch {
    /* storage unavailable: progress lasts for this session only */
  }
}

/** Living fraction of the map at which a level counts as reclaimed. */
export const LEVEL_GOAL = 0.6;
