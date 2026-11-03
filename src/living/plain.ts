// ---- living/plain.ts ----------------------------------------------------------------------------------------------
// (dialog2) Small helpers for player-facing text (docs/WRITING.md), shared by the engine, the petitions and the run's
// screens.

/** sentences start with a capital letter (a filled name or role may not) */
export function capitalise(s: string): string {
  return s.replace(/(^|[.!?]\s+)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
}
