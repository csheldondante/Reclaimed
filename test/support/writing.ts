// (dialog2) The style lint for player-facing text: the rules of docs/WRITING.md a machine can check. A line is one
// string the player reads (a title, a pitch, a dialog line, a summary row). Each problem is a short reason.

/** words from the code that never reach the player (docs/WRITING.md rule 6); whole words, case-insensitive */
export const JARGON = ['record', 'records', 'tier', 'tiers', 'binding', 'bindings', 'template', 'templates', 'entity', 'entities', 'cohort', 'cohorts', 'pawn', 'pawns', 'agent', 'agents', 'stage', 'locus', 'presenter', 'helper', 'var', 'vars', 'odds', 'commit', 'committed', 'opportunity', 'opportunities'];
/** phrases from the gibberish the user quoted, and our shorthand (case-sensitive where a proper name may match) */
export const PHRASES: RegExp[] = [/levy stays/i, /yours to command/i, /comes with its record/i, /\bthe host\b/, /\bregion \d+/i, /\{[$\w.]+\}/, /\bundefined\b/, /\bNaN\b/, /\bnull\b/];
/** the longest sentence allowed (words) */
export const MAX_WORDS = 20;

export function lint(line: string): string[] {
  const out: string[] = [];
  const s = line.trim();
  if (!s) return out;
  if (/[()]/.test(s)) out.push('a parenthesis (give it its own sentence, or cut it)');
  if (/;/.test(s)) out.push('a semicolon (split the sentence)');
  if (/ — | -- /.test(s)) out.push('a dash joining two ideas (split the sentence)');
  for (const w of JARGON) if (new RegExp(`\\b${w}\\b`, 'i').test(s)) out.push(`the code's word "${w}"`);
  for (const p of PHRASES) if (p.test(s)) out.push(`"${s.match(p)![0]}"`);
  for (const sentence of s.split(/(?<=[.!?])\s+/)) {
    const n = sentence.split(/\s+/).filter((x) => /[a-z0-9]/i.test(x)).length;
    if (n > MAX_WORDS) out.push(`a sentence of ${n} words (at most ${MAX_WORDS}): "${sentence.slice(0, 60)}…"`);
  }
  return out;
}

/** every problem of many lines, as "where: problem — the line" */
export function lintAll(lines: { where: string; text: string }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const k = `${l.where}|${l.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const p of lint(l.text)) out.push(`${l.where}: ${p} — ${l.text}`);
  }
  return out;
}
