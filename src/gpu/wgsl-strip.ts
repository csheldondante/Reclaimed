// (round 112, testspeed) A module cut to what its entry points reach: every kernel is compiled with common.wgsl,
// layers.wgsl and materials.wgsl prepended whole (an atlas boot: 125 modules, 9.56 MB of WGSL to parse and validate),
// most of which a kernel never calls. A pure transform: the top-level declarations no entry point reaches — directly
// or through what it reaches — are left out; what's kept is byte for byte as written, in its order, so every kept
// function, constant, struct and binding means what it meant. `?wgslstrip=1` turns it on (gpu/pipeline.ts makeModule),
// for an A/B of the boot's compile.
//
// The scan: comments out, then the text split into top-level items at depth 0 — up to a `;` or a balanced `{…}`
// (a struct's optional `;` with it). Each item's name is the identifier after its keyword (fn, struct, const, var,
// override, alias, let at module scope is invalid WGSL); directives (enable, requires, diagnostic) are always kept.
// An item reaches every identifier its text names.

const KEYWORDS = /^(fn|struct|const|var|override|alias|const_assert)$/;
const DIRECTIVE = /^\s*(enable|requires|diagnostic)\b/;

/** the text with its comments blanked (line and block, block comments nest in WGSL), lengths kept */
function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' ';
    } else if (src[i] === '/' && src[i + 1] === '*') {
      let depth = 0;
      do {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth++;
          out[i] = out[i + 1] = ' ';
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          out[i] = out[i + 1] = ' ';
          i += 2;
        } else {
          if (src[i] !== '\n') out[i] = ' ';
          i++;
        }
      } while (depth > 0 && i < src.length);
    } else i++;
  }
  return out.join('');
}

interface Item {
  start: number;
  end: number;
  name: string | null;
  entry: boolean;
  directive: boolean;
  uses: Set<string>;
}

/** Cuts `code` to what its entry points (@compute, @vertex, @fragment functions) reach. */
export function stripWgsl(code: string): string {
  const text = blankComments(code);
  const items: Item[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const start = i;
    let depth = 0;
    let end = -1;
    for (; i < n; i++) {
      const c = text[i];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') {
        depth--;
        if (depth === 0 && c === '}') {
          // (a fn's body or a struct's: the item ends here, a struct's `;` with it)
          let j = i + 1;
          while (j < n && /\s/.test(text[j])) j++;
          end = text[j] === ';' ? j + 1 : i + 1;
          // (`var x = T{...};`-like isn't WGSL; a `{` at depth 0 opens a fn or a struct body only)
          break;
        }
      } else if (c === ';' && depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) throw new Error('wgsl-strip: an unterminated top-level declaration');
    i = end;
    const body = text.slice(start, end);
    const idents = body.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    // (attributes first — @group(0) @binding(3), @compute @workgroup_size(64) — then the keyword and the name)
    const stripped = body.replace(/@[A-Za-z_]+(\s*\([^)]*\))?/g, ' ').trim();
    const m = /^([A-Za-z_]+)(\s*<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(stripped);
    const directive = DIRECTIVE.test(body);
    let name: string | null = null;
    if (m && KEYWORDS.test(m[1]) && m[1] !== 'const_assert') name = m[3];
    else if (!directive && !(m && m[1] === 'const_assert')) throw new Error(`wgsl-strip: can't read the declaration "${stripped.slice(0, 60)}"`);
    // (overrides always kept: a pipeline may set one by name whether or not its entry point reads it)
    items.push({ start, end, name, entry: /@(compute|vertex|fragment)\b/.test(body), directive: directive || m?.[1] === 'const_assert' || m?.[1] === 'override', uses: new Set(idents) });
  }
  const byName = new Map<string, Item[]>();
  for (const it of items) if (it.name) byName.set(it.name, [...(byName.get(it.name) ?? []), it]);
  const keep = new Set<Item>();
  const stack = items.filter((it) => it.entry || it.directive);
  if (!items.some((it) => it.entry)) return code;
  while (stack.length) {
    const it = stack.pop()!;
    if (keep.has(it)) continue;
    keep.add(it);
    for (const u of it.uses) for (const d of byName.get(u) ?? []) if (!keep.has(d)) stack.push(d);
  }
  // (the kept items' own text, comments and all, in their order)
  let out = '';
  for (const it of items) if (keep.has(it)) out += code.slice(it.start, it.end) + '\n';
  return out;
}
