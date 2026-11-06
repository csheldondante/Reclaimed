// (round 128o) Every source file is UTF-8 with LF line endings. lava.wgsl was the last stray (UTF-8 but for a latin-1
// ×): a tool that had to open it as latin-1 truncated it to nothing on a failed write. A file that isn't UTF-8 or has
// CRLF fails here, before any tool has to special-case it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, srcFiles } from '../support/source-scan';

describe('source encoding', () => {
  it('every .ts and .wgsl under src/ is UTF-8 with LF line endings', () => {
    const bad: string[] = [];
    for (const f of srcFiles(['.ts', '.wgsl'])) {
      const b = readFileSync(join(SRC, f));
      let ok = true;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(b);
      } catch {
        ok = false;
      }
      if (!ok || b.includes(13)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});
