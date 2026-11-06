// (round 128o, DA-G1/G2/G4) A small TypeScript source scanner for the architecture gates — Node only (reads files).
// TypeScript 7 ships no JS compiler API, so this is a lexer, not a parser: it separates code from comments and string
// literals (template literals included, their `${…}` code kept as code; regex literals skipped), so a gate can ask
// "where does `mapAsync(` appear in code", "what does this file import" and "which literals does it hold" without a
// comment or a string fooling it. What it can't do: types, scopes, data flow. The gates say so where it matters.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SRC = join(ROOT, 'src');

/** every file under src/ with one of these extensions, as a posix path relative to src/ (tests left out) */
export function srcFiles(exts = ['.ts']): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (exts.some((x) => e.name.endsWith(x)) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(relative(SRC, f).split(sep).join('/'));
    }
  };
  walk(SRC);
  return out.sort();
}

export const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

export interface Literal {
  /** the quote: ' " or ` */
  q: string;
  /** the literal's text; a template's `${…}` parts are replaced by `hole` */
  text: string;
  /** offsets in the source of the opening and past the closing quote */
  start: number;
  end: number;
  /** 1-based line of the opening quote */
  line: number;
}

export interface Lexed {
  /** the source with comments and the insides of literals turned to spaces (newlines kept, so offsets and lines match) */
  code: string;
  literals: Literal[];
}

const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|throw|yield|await|else)$/;

/** Split code from comments and literals. `hole` stands in for each `${…}` of a template literal. */
export function lex(src: string, hole = 'X'): Lexed {
  const code = src.split('');
  const literals: Literal[] = [];
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (code[k] !== '\n') code[k] = ' ';
  };
  const lineAt = (() => {
    const starts = [0];
    for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1);
    return (o: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (starts[m] <= o) lo = m;
        else hi = m - 1;
      }
      return lo + 1;
    };
  })();
  /** the last non-space code character before i, and the code text before it (for the regex-or-divide question) */
  const prevSig = (i: number) => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(code[k])) k--;
    return k;
  };
  // a template literal's state: after its closing `}` of a hole, scanning resumes inside the template
  const tplStack: { start: number; text: string; braces: number }[] = [];
  let braces = 0;
  let i = 0;
  const n = src.length;
  const scanTemplate = (from: number, tpl: { start: number; text: string; braces: number }): number => {
    // scan template chars from `from` until the closing backtick (returns past it) or a `${` (returns past it, pushing)
    let k = from;
    while (k < n) {
      const c = src[k];
      if (c === '\\') {
        tpl.text += src.slice(k, k + 2);
        k += 2;
        continue;
      }
      if (c === '`') {
        blank(from, k);
        literals.push({ q: '`', text: tpl.text, start: tpl.start, end: k + 1, line: lineAt(tpl.start) });
        return k + 1;
      }
      if (c === '$' && src[k + 1] === '{') {
        blank(from, k);
        tpl.text += hole;
        tpl.braces = braces;
        tplStack.push(tpl);
        braces++;
        return k + 2;
      }
      tpl.text += c;
      k++;
    }
    blank(from, n);
    return n;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let k = i;
      while (k < n && src[k] !== '\n') k++;
      blank(i, k);
      i = k;
      continue;
    }
    if (c === '/' && d === '*') {
      const k = src.indexOf('*/', i + 2);
      const e = k < 0 ? n : k + 2;
      blank(i, e);
      i = e;
      continue;
    }
    if (c === "'" || c === '"') {
      let k = i + 1;
      let text = '';
      while (k < n && src[k] !== c && src[k] !== '\n') {
        if (src[k] === '\\') {
          text += src.slice(k, k + 2);
          k += 2;
        } else text += src[k++];
      }
      blank(i + 1, k);
      literals.push({ q: c, text, start: i, end: k + 1, line: lineAt(i) });
      i = k + 1;
      continue;
    }
    if (c === '`') {
      i = scanTemplate(i + 1, { start: i, text: '', braces: 0 });
      continue;
    }
    if (c === '{') {
      braces++;
      i++;
      continue;
    }
    if (c === '}') {
      braces--;
      const top = tplStack[tplStack.length - 1];
      if (top && top.braces === braces) {
        tplStack.pop();
        i = scanTemplate(i + 1, top);
        continue;
      }
      i++;
      continue;
    }
    if (c === '/') {
      const k = prevSig(i);
      const before = k < 0 ? '' : code.slice(Math.max(0, k - 12), k + 1).join('');
      const isRegex = k < 0 || REGEX_AFTER.has(code[k]) || REGEX_KEYWORDS.test(before);
      if (isRegex) {
        let e = i + 1;
        let cls = false;
        while (e < n && src[e] !== '\n') {
          const x = src[e];
          if (x === '\\') {
            e += 2;
            continue;
          }
          if (x === '[') cls = true;
          else if (x === ']') cls = false;
          else if (x === '/' && !cls) break;
          e++;
        }
        blank(i + 1, e);
        i = e + 1;
        while (i < n && /[a-z]/.test(src[i])) i++;
        continue;
      }
    }
    i++;
  }
  return { code: code.join(''), literals };
}

/** 1-based line of an offset */
export const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length;

const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'typeof', 'new', 'super', 'function', 'else', 'do', 'with', 'yield', 'void', 'delete', 'throw', 'import']);
const METHOD = /^(\s*)(?:(?:public|private|protected|static|async|readonly|override|get|set|export|default)\s+)*(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\(/;
const ARROW = /^(\s*)(?:export\s+)?(?:(?:const|let|var)\s+)?(?:(?:public|private|protected|static|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]*)?[=:]\s*(?:async\s+)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/;
const CLASS = /^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;

/** Is the `(` at `open` (in blanked code) a declaration's parameter list: its `)` followed by `{` or a `:` return type? */
function declParams(code: string, open: number): boolean {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    const c = code[k];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      const rest = code.slice(k + 1).match(/^\s*(\S)(\S)?/);
      if (!rest) return false;
      if (rest[1] === '{') return true;
      if (rest[1] === ':') return true;
      return false;
    }
  }
  return false;
}

/**
 * The named function a code offset sits in, as `Class.method`, `function`, `Class` or `<module>`: the nearest
 * declaration (method, function, `const f = (…) =>`) at a lower indentation, walking up. Anonymous callbacks
 * (`.then(() => {…})`) are passed over, so a read in a callback belongs to the function that set it up. Relies on the
 * code being formatted (one indent level per block), as the repo's prettier style keeps it; lines that start inside a
 * multi-line literal (a WGSL template) are passed over.
 */
export function enclosing(lexed: Lexed, at: number): string {
  const { code, literals } = lexed;
  const lines = code.split('\n');
  const offs: number[] = [];
  let o = 0;
  for (const l of lines) {
    offs.push(o);
    o += l.length + 1;
  }
  const multi = literals.filter((l) => code.slice(l.start, l.end).includes('\n'));
  const inLiteral = (off: number) => multi.some((l) => l.start < off && off < l.end);
  const li = code.slice(0, at).split('\n').length - 1;
  const indent = (s: string) => s.match(/^\s*/)![0].length;
  let threshold = indent(lines[li]);
  let fn = '';
  for (let k = li - 1; k >= 0; k--) {
    const l = lines[k];
    if (!l.trim() || inLiteral(offs[k])) continue;
    const ind = indent(l);
    if (ind >= threshold) continue;
    // (the close of a multi-line parameter list, `): T {`: its opener is at this same indentation, above)
    if (/^\s*\)/.test(l)) {
      threshold = ind + 1;
      continue;
    }
    threshold = ind;
    const cm = l.match(CLASS);
    if (cm) return fn ? `${cm[2]}.${fn}` : cm[2];
    if (fn) continue;
    const mm = l.match(METHOD);
    if (mm && !NOT_NAMES.has(mm[2]) && declParams(code, offs[k] + mm[0].length - 1)) {
      fn = mm[2];
      continue;
    }
    const am = l.match(ARROW);
    if (am && !NOT_NAMES.has(am[2]) && /=>/.test(code.slice(offs[k], offs[k] + 400).split(/[{;]/)[0])) fn = am[2];
  }
  return fn || '<module>';
}

/** The arguments of the call whose `(` is at `open`, as source text (split at top-level commas). */
export function callArgs(src: string, code: string, open: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let k = open; k < code.length; k++) {
    const c = code[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        const last = src.slice(from, k).trim();
        if (last) out.push(last);
        return out;
      }
    } else if (c === ',' && depth === 1) {
      out.push(src.slice(from, k).trim());
      from = k + 1;
    }
  }
  return out;
}

/**
 * A file's numeric constants (`const NAME = <number expression>;`, at any depth), evaluated where they can be. A name
 * bound more than once keeps the largest value, and is dropped if any of its bindings can't be evaluated (so a size is
 * only ever over-estimated, never under).
 */
export function fileConsts(src: string): Map<string, number> {
  const out = new Map<string, number>();
  const unknown = new Set<string>();
  for (const m of src.matchAll(/^\s*(?:export\s+)?(?:static\s+)?(?:readonly\s+)?(?:const\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*([^;\n]+);/gm)) {
    if (!/^\s*(?:export\s+)?(?:const|static|readonly)\b/.test(m[0])) continue;
    const v = evalSize(m[2], out);
    if (v === null) unknown.add(m[1]);
    else out.set(m[1], Math.max(v, out.get(m[1]) ?? -Infinity));
  }
  for (const u of unknown) out.delete(u);
  return out;
}

/**
 * The bytes a data argument holds when the file shows it: a typed array built in place, or a name (`p`, `this.params`)
 * whose every binding in the file is `= new XArray(…)` of a known size (the largest is taken). Else null.
 */
export function dataBytes(expr: string, src: string, consts: Map<string, number>): number | null {
  const direct = typedArrayBytes(expr, consts);
  if (direct !== null) return direct;
  const name = expr.match(/^(?:this\.)?([A-Za-z_$][\w$]*)$/)?.[1];
  if (!name) return null;
  const binds = [...src.matchAll(new RegExp(`(?:\\b(?:const|let|var)\\s+|\\bthis\\.|^\\s*(?:private\\s+|readonly\\s+|public\\s+)*)${name.replace(/\$/g, '\\$')}\\s*(?::[^=;\\n]+)?=(?!=)\\s*([^;\\n]+)`, 'gm'))];
  if (!binds.length) return null;
  let most = 0;
  for (const b of binds) {
    const v = typedArrayBytes(b[1].trim().replace(/\s+as\s+[\w<>[\]]+$/, ''), consts);
    if (v === null) return null;
    most = Math.max(most, v);
  }
  return most;
}

/** A number expression of literals and known constants (+ - * / % << >> parentheses), or null when it holds anything else. */
export function evalSize(expr: string, consts: Map<string, number>): number | null {
  const e = expr.replace(/_/g, '').trim();
  if (!e) return null;
  let bad = false;
  const js = e.replace(/[A-Za-z$][\w$]*/g, (id) => {
    const v = consts.get(id);
    if (v === undefined) bad = true;
    return String(v);
  });
  if (bad || !/^[\d\s+\-*/%()<>.xXa-fA-F]*$/.test(js)) return null;
  try {
    const v = Function(`"use strict"; return (${js});`)() as unknown;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

const TYPED_BYTES: Record<string, number> = { Uint8Array: 1, Int8Array: 1, Uint8ClampedArray: 1, Uint16Array: 2, Int16Array: 2, Uint32Array: 4, Int32Array: 4, Float32Array: 4, Float64Array: 8, BigUint64Array: 8, BigInt64Array: 8 };

/** The bytes a typed-array expression holds when the source shows it: `new Float32Array([…])` or `new Uint32Array(N)`. */
export function typedArrayBytes(expr: string, consts: Map<string, number>): number | null {
  const m = expr.match(/^new\s+([A-Za-z0-9]+Array)\s*\(([\s\S]*)\)$/);
  if (!m || !TYPED_BYTES[m[1]]) return null;
  const inner = m[2].trim();
  if (inner.startsWith('[')) {
    if (!inner.endsWith(']')) return null;
    const body = inner.slice(1, -1).trim();
    if (body.includes('...')) return null;
    const n = body ? callArgs(`(${body})`, `(${body.replace(/'[^']*'|"[^"]*"/g, (s) => ' '.repeat(s.length))})`, 0).length : 0;
    return n * TYPED_BYTES[m[1]];
  }
  const n = evalSize(inner, consts);
  return n === null ? null : n * TYPED_BYTES[m[1]];
}

export type TransferKind = 'copy' | 'upload';

export interface Transfer {
  kind: TransferKind;
  /** the method: copyBufferToBuffer, writeBuffer, … */
  method: string;
  /** offset of the method name in the source */
  at: number;
  /** the bytes it moves when the source shows them, else null */
  bytes: number | null;
}

/** the texel size assumed for a texture copy or write whose format isn't in the call: rgba32float, the largest in use */
export const TEXEL_BYTES = 16;

/**
 * Every GPU→GPU copy (`copyBufferToBuffer`, `copyTextureTo*`, `copyBufferToTexture`) and CPU→GPU upload
 * (`writeBuffer`, `writeTexture`) in a file, with its size when the call shows it as a constant (a literal, a file
 * constant, a typed array built in place); `bytes: null` means the source doesn't say.
 */
export function transfersOf(src: string, lexed: Lexed = lex(src)): Transfer[] {
  const { code } = lexed;
  const consts = fileConsts(src);
  const out: Transfer[] = [];
  const re = /\.(copyBufferToBuffer|copyTextureToBuffer|copyBufferToTexture|copyTextureToTexture|writeBuffer|writeTexture)\s*\(/g;
  for (const m of code.matchAll(re)) {
    const method = m[1];
    const open = m.index! + m[0].length - 1;
    const args = callArgs(src, code, open);
    let bytes: number | null = null;
    if (method === 'copyBufferToBuffer') {
      // (source, sourceOffset, destination, destinationOffset, size), or the newer (source, destination, size?)
      const size = args.length >= 5 ? args[4] : args.length === 3 ? args[2] : null;
      bytes = size === null ? null : evalSize(size, consts);
    } else if (method === 'writeBuffer') {
      // (buffer, offset, data, dataOffset?, size?) — size in elements of data; data a typed array or ArrayBuffer
      if (args.length >= 5) {
        const n = evalSize(args[4], consts);
        const per = args[2].match(/^new\s+([A-Za-z0-9]+Array)/)?.[1];
        bytes = n === null ? null : n * (per ? TYPED_BYTES[per] ?? 4 : 4);
      } else if (args[2]) bytes = dataBytes(args[2], src, consts);
    } else {
      // texture copies and writeTexture: the extent is the last argument, [w, h, d?] or { width, height }
      const ext = args[args.length - 1] ?? '';
      const parts = ext.startsWith('[') ? callArgs(ext.replace(/^\[/, '(').replace(/\]$/, ')'), ext.replace(/^\[/, '(').replace(/\]$/, ')'), 0) : ext.startsWith('{') ? [...ext.matchAll(/(?:width|height|depthOrArrayLayers)\s*:\s*([^,}]+)/g)].map((x) => x[1]) : [];
      const vals = parts.map((p) => evalSize(p, consts));
      bytes = parts.length && vals.every((v) => v !== null) ? (vals as number[]).reduce((a, b) => a * b, 1) * TEXEL_BYTES : null;
    }
    out.push({ kind: method.startsWith('copy') ? 'copy' : 'upload', method, at: m.index! + 1, bytes });
  }
  return out;
}

export interface Import {
  /** the specifier as written */
  spec: string;
  /** the line it's on */
  line: number;
  /** `import type …` / `export type … from` */
  typeOnly: boolean;
}

/** Every static and dynamic import or re-export in a file. */
export function importsOf(src: string): Import[] {
  const { code, literals } = lex(src);
  const out: Import[] = [];
  for (const lit of literals) {
    if (lit.q === '`') continue;
    const before = code.slice(Math.max(0, lit.start - 400), lit.start);
    const from = before.match(/(?:^|[;\s}])(import|export)(\s+type)?\b[^;]*?\bfrom\s*$/);
    const bare = /(?:^|[;\s])import\s*$/.test(before);
    const dyn = /\bimport\s*\(\s*$/.test(before);
    if (from || bare || dyn) out.push({ spec: lit.text, line: lit.line, typeOnly: !!from?.[2] });
  }
  return out;
}
