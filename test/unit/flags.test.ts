// (DA-B17) The page's URL flags are resolved in one place (src/flags.ts) and read only through it. Until DA-B17 the
// phone's set was written into the URL by main.ts's first import and ~140 module-level reads took `location.search`
// as they loaded: the vite dev server ran main's import first, the production build (GitHub Pages, the lab) ran the
// chunk holding those modules before main's own code — so the phone ran without the shadow cache, in-place columns,
// settle=0 and sleepmore. This gate fails on that code: any read of `location.search` outside src/flags.ts (setting
// it to navigate is fine). scripts/flagcheck.mjs checks what a built page actually runs with.

import { describe, expect, it } from 'vitest';
import { LITE_SET, resolveFlags, SIM_SET } from '../../src/flags';
import { lex, lineOf, readSrc, srcFiles } from '../support/source-scan';

describe('the URL flags', () => {
  it('are read only through src/flags.ts', () => {
    const reads: string[] = [];
    for (const file of srcFiles()) {
      if (file === 'flags.ts') continue;
      const src = readSrc(file);
      const { code } = lex(src);
      for (const m of code.matchAll(/\blocation\s*\.\s*search\b(?!\s*=[^=])/g)) reads.push(`${file}:${lineOf(src, m.index!)}`);
    }
    expect(reads).toEqual([]);
  });

  it('give the low tier the phone\'s set', () => {
    for (const search of ['', '?q=low', '?skipmenu=1&level=atlas&town=1&fortress=1&fresh=1&q=low']) {
      const q = resolveFlags(search);
      for (const [k, v] of Object.entries({ ...LITE_SET, ...SIM_SET })) expect(q.get(k), `${search} ${k}`).toBe(v);
    }
  });

  it('let the URL turn one back, and leave the other tiers alone', () => {
    expect(resolveFlags('?q=low&settle=1').get('settle')).toBe('1');
    expect(resolveFlags('?q=low&phone=0').get('inplace')).toBeNull();
    expect(resolveFlags('?q=high').get('shadowcache')).toBeNull();
    const lite = resolveFlags('?q=high&lite=1');
    expect(lite.get('shadowcache')).toBe(LITE_SET.shadowcache);
    expect(lite.get('inplace')).toBeNull();
  });
});
