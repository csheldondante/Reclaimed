// (round 128o, DA-G4) Where the player's words are in the source, for the writing lint (docs/WRITING.md). Node only.
// Text reaches the player through a sink: the page (`textContent`, `innerText`, `innerHTML`, `title`, `placeholder`,
// `alert`, `confirm`), the HUD (`say`, `hint`), a canvas (`fillText`). The literals in what a sink is given are the
// player's text, as are the literals a file's own label helpers are given (named per file in the gate's table: e.g.
// fortress/ui.ts `toggle(label, …)`), and every literal of a words module (a file whose job is the player's lines,
// e.g. fortress/words.ts). Within those, code is left out by where it sits (a comparison, a key, a class name, a
// selector, a style) and HTML is read for its text and tooltips; a stylesheet or CSS declaration list is skipped.
// What this can't see: text built from data at run time (cards dealt, templates filled); writing.test.ts and the
// fortress tests lint those as produced.

import { lex, type Lexed } from './source-scan';

/** a write of text the player sees */
export const SINK = /\.(?:textContent|innerText|innerHTML|title|placeholder)\s*=(?!=)|\.(?:say|hint)\s*\(|\balert\s*\(|\bconfirm\s*\(|\.fillText\s*\(/g;

/** the code just before a literal that makes it code, not text */
const CODE_BEFORE = new RegExp(
  `(?:${[
    String.raw`\bimport\b[^;]*\bfrom`,
    String.raw`\bimport\s*\(?`,
    String.raw`\bexport\b[^;]*\bfrom`,
    String.raw`(?:createElement|createElementNS|querySelector|querySelectorAll|getElementById|closest|matches|matchMedia|addEventListener|removeEventListener|setAttribute|getAttribute|removeAttribute|setProperty)\(`,
    String.raw`classList\.\w+\(`,
    String.raw`console\.\w+\(`,
    String.raw`(?:Error|Unsupported\w*)\(`,
    String.raw`\.(?:get|has|delete|startsWith|endsWith|includes|split|replace|indexOf|join|toFixed|padStart)\(`,
    String.raw`\b(?:className|cssText|id|type|name|rel|href|src|key|code|cursor|display|tagName)\s*\+?=`,
    String.raw`style\.[\w$]+\s*=`,
    String.raw`[!=]==?`,
    String.raw`\bcase`,
    String.raw`\b(?:kind|type|id|icon|class|key|tag|css|style|font|color|mode|side|role|voice)\s*:`,
  ]
    .map((p) => `(?:${p})`)
    .join('|')})\s*$`,
);

/** a CSS declaration list (`font:600 16px serif;color:#fff`), `${…}` holes allowed as whole parts */
const isDecls = (t: string, hole: string) => t.includes(':') && t.split(';').every((p) => !p.trim() || p.trim() === hole || /^[a-z-]+\s*:\s*\S/.test(p.trim()));
/** a stylesheet: a rule `selector{prop:value;…}` */
const isSheet = (t: string) => /\{\s*[a-z-]+\s*:[^{}]*\}/.test(t);
/** words: two letter-words with space between, or one capitalised word (a button's label) */
const isWords = (t: string) => /[A-Za-z]{2,}[^\n]*\s[^\n]*[A-Za-z]/.test(t) || /^[A-Z][a-z]+[.!?]?$/.test(t.trim());

export interface TextLine {
  line: number;
  text: string;
}

/** a label helper of a file: calls of `name(…)` whose argument `arg` (0-based) is text */
export interface LabelHelper {
  name: string;
  arg: number;
}

/** The [start, end) ranges of a call's arguments, the call's `(` at `open` (in blanked code). */
function argRanges(code: string, open: number): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let from = open + 1;
  for (let k = open; k < code.length; k++) {
    const c = code[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) {
        if (code.slice(from, k).trim()) out.push([from, k]);
        return out;
      }
    } else if (c === ',' && depth === 1) {
      out.push([from, k]);
      from = k + 1;
    }
  }
  return out;
}

/** The end of an assignment's right side starting at `from`: its `;`, or a closing bracket it doesn't open. */
function rhsEnd(code: string, from: number): number {
  let depth = 0;
  for (let k = from; k < code.length; k++) {
    const c = code[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth < 0) return k;
    } else if (c === ';' && depth === 0) return k;
  }
  return code.length;
}

/** The literals' text in the given ranges (or every literal, ranges null), split into lines, code left out. */
function textIn(lx: Lexed, ranges: [number, number][] | null, hole: string): TextLine[] {
  const out: TextLine[] = [];
  for (const l of lx.literals) {
    if (ranges && !ranges.some(([a, b]) => l.start >= a && l.start < b)) continue;
    if (CODE_BEFORE.test(lx.code.slice(Math.max(0, l.start - 160), l.start))) continue;
    const raw = l.text.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`');
    let parts: string[];
    if (/<[a-z][^>]*>/i.test(raw)) parts = [...raw.replace(/<[^>]*>/g, '\n').split('\n'), ...[...raw.matchAll(/\b(?:title|placeholder|aria-label|alt)="([^"]*)"/g)].map((m) => m[1])];
    else if (isSheet(raw) || isDecls(raw, hole)) continue;
    else parts = raw.split('\n');
    for (const p of parts) {
      const t = p.replace(/\s+/g, ' ').trim();
      if (t && isWords(t)) out.push({ line: l.line, text: t });
    }
  }
  return out;
}

/** The player's text in a UI file: what its sinks and its label helpers are given. */
export function sinkText(src: string, helpers: LabelHelper[] = [], hole = 'Muru'): TextLine[] {
  const lx = lex(src, hole);
  const { code } = lx;
  const ranges: [number, number][] = [];
  for (const m of code.matchAll(SINK)) {
    const end = m.index! + m[0].length;
    if (m[0].endsWith('(')) ranges.push(...argRanges(code, end - 1));
    else ranges.push([end, rhsEnd(code, end)]);
  }
  for (const h of helpers) {
    for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${h.name}\\s*\\(`, 'g'))) {
      const r = argRanges(code, m.index! + m[0].length - 1)[h.arg];
      // (a declaration of the helper, `const toggle = (label: string, …) =>`, has no literal there)
      if (r) ranges.push(r);
    }
  }
  return textIn(lx, ranges, hole);
}

/** The player's text a file gives as the value of an object key (fortress/ui.ts `{ text: '…' }`). */
export function keyText(src: string, keys: string[], hole = 'Muru'): TextLine[] {
  const lx = lex(src, hole);
  const at = new RegExp(String.raw`\b(?:${keys.join('|')})\s*:\s*$`);
  const ranges: [number, number][] = lx.literals.filter((l) => at.test(lx.code.slice(Math.max(0, l.start - 40), l.start))).map((l) => [l.start, l.end]);
  return textIn(lx, ranges, hole);
}

/** The player's text in a words module: every literal shaped like words, code left out. */
export function moduleText(src: string, hole = 'Muru'): TextLine[] {
  return textIn(lex(src, hole), null, hole);
}

/** Every file that writes to a sink. */
export function hasSink(src: string): boolean {
  return [...lex(src).code.matchAll(SINK)].length > 0;
}
