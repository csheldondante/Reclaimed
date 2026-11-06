// (round 128o, DA-G1) The transfer gate: every GPU→CPU read, and every GPU→GPU copy or CPU→GPU upload not shown to be
// small, is in src/gpu/transfers.ts with what moves, why, its rate and whether it runs in play. It scans the code
// (comments and strings left out, test/support/source-scan.ts), keyed by kind, file and enclosing function. A transfer
// not in the table fails; so does an entry whose transfer is gone. A read every frame or on a timer in play, and a large
// copy or upload every frame or on a timer in play, must name the rule it breaks and the BACKLOG row that removes it
// (DESIGN.md §24; docs/AGENT_RULES.md §1b). The user (2026-11-05): "It also makes terrible choices for CPU readback";
// "flag and scrutinize any large data readbacks or copies and try to come up with a way to avoid them".

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SMALL_BYTES, TRANSFERS, type TransferSite } from '../../src/gpu/transfers';
import { enclosing, lex, lineOf, readSrc, ROOT, srcFiles, transfersOf } from '../support/source-scan';

const key = (kind: string, file: string, fn: string, via?: string) => `${kind} ${file}#${fn}${via ? ` via ${via}` : ''}`;
const keyOf = (r: TransferSite) => key(r.kind ?? 'read', r.file, r.fn, r.via);

/** what the code holds: key → count, first line */
function scan(): Map<string, { n: number; line: number }> {
  const found = new Map<string, { n: number; line: number }>();
  const add = (k: string, line: number) => {
    const f = found.get(k);
    if (f) f.n++;
    else found.set(k, { n: 1, line });
  };
  const wrappers = TRANSFERS.filter((r) => r.wrapper);
  for (const file of srcFiles()) {
    if (file === 'gpu/transfers.ts') continue;
    const src = readSrc(file);
    const lx = lex(src);
    const readFns = new Set<string>();
    for (const m of lx.code.matchAll(/\.mapAsync\s*\(/g)) {
      const fn = enclosing(lx, m.index!);
      readFns.add(fn);
      add(key('read', file, fn), lineOf(lx.code, m.index!));
    }
    for (const w of wrappers) {
      for (const m of lx.code.matchAll(new RegExp(w.wrapper!.source, 'g'))) {
        // (a declaration of the wrapper's name is not a call: `function attachSim(`)
        const lineStart = lx.code.lastIndexOf('\n', m.index!) + 1;
        if (/^\s*(?:export\s+)?(?:async\s+)?function\s*$/.test(lx.code.slice(lineStart, m.index!))) continue;
        add(key('read', file, enclosing(lx, m.index!), `${w.file}#${w.fn}`), lineOf(lx.code, m.index!));
      }
    }
    for (const t of transfersOf(src, lx)) {
      if (t.bytes !== null && t.bytes <= SMALL_BYTES) continue;
      const fn = enclosing(lx, t.at);
      // (a read's staging copy, in the function that maps it, is that read's entry)
      if (t.kind === 'copy' && readFns.has(fn)) continue;
      add(key(t.kind, file, fn), lineOf(lx.code, t.at));
    }
  }
  return found;
}

const listed = new Map<string, TransferSite>();
for (const r of TRANSFERS) listed.set(keyOf(r), r);
const inPlay = (r: TransferSite) => r.play === 'yes' || r.play === 'flag';
const often = (r: TransferSite) => r.rate === 'frame' || r.rate === 'timed';

describe('the transfer gate (src/gpu/transfers.ts, DESIGN.md §24, AGENT_RULES §1b)', () => {
  const found = scan();

  it('every read, and every copy or upload not shown to be small, is listed', () => {
    const missing = [...found].filter(([k]) => !listed.has(k)).map(([k, f]) => `${k} (line ${f.line}, ${f.n} call${f.n > 1 ? 's' : ''}) — add it to src/gpu/transfers.ts (docs/TESTING.md)`);
    expect(missing).toEqual([]);
  });

  it('every listed transfer is still there, as many times as listed', () => {
    const wrong = [...listed].filter(([k, r]) => found.get(k)?.n !== (r.n ?? 1)).map(([k, r]) => `${k}: listed ${r.n ?? 1}, found ${found.get(k)?.n ?? 0}`);
    expect(wrong).toEqual([]);
  });

  it('each entry is listed once, and each via names a listed wrapper', () => {
    expect(TRANSFERS.length).toBe(listed.size);
    const wrappers = new Set(TRANSFERS.filter((r) => r.wrapper || r.rate === 'via').map((r) => `${r.file}#${r.fn}`));
    expect(TRANSFERS.filter((r) => r.via && !wrappers.has(r.via)).map(keyOf)).toEqual([]);
  });

  it('a frame or timed read in play, or a large frame or timed copy or upload in play, names the rule it breaks and its BACKLOG row', () => {
    const reads = TRANSFERS.filter((r) => (r.kind ?? 'read') === 'read' && inPlay(r) && often(r) && !(r.violates && r.backlog));
    const moves = TRANSFERS.filter((r) => r.kind !== undefined && r.kind !== 'read' && r.size === 'large' && inPlay(r) && often(r) && !(r.violates && r.backlog));
    expect([...reads, ...moves].map(keyOf)).toEqual([]);
  });

  it('a copy or upload says whether it is small or large; a timed one how often; a flagged one its flag', () => {
    expect(TRANSFERS.filter((r) => (r.kind === 'copy' || r.kind === 'upload') !== !!r.size).map(keyOf)).toEqual([]);
    expect(TRANSFERS.filter((r) => r.rate === 'timed' && !r.every).map(keyOf)).toEqual([]);
    expect(TRANSFERS.filter((r) => (r.play === 'flag' || r.play === 'debug') && !r.flag).map(keyOf)).toEqual([]);
  });

  it('every backlog id named is a row in docs/BACKLOG.md, and only rule breaks name one', () => {
    const backlog = readFileSync(`${ROOT}docs/BACKLOG.md`, 'utf8');
    const ids = [...new Set(TRANSFERS.flatMap((r) => (r.backlog ? [r.backlog] : [])))];
    expect(ids.filter((id) => !new RegExp(`^\\| ${id} \\|`, 'm').test(backlog))).toEqual([]);
    expect(TRANSFERS.filter((r) => !!r.violates !== !!r.backlog).map(keyOf)).toEqual([]);
  });

  it('the scanner sees through comments, strings and callbacks, and sizes what the call shows', () => {
    const src = [
      'const N = 16;',
      'export class A {',
      '  private p = new Float32Array(8);',
      '  async read(buf: GPUBuffer, big: Float32Array): Promise<{ a: number; b: number }> {',
      '    // buf.mapAsync(GPUMapMode.READ) in a comment',
      "    const s = 'x.mapAsync(';",
      '    void buf.mapAsync(GPUMapMode.READ).then(() => {',
      '      return 1;',
      '    });',
      '    q.writeBuffer(buf, 0, this.p);',
      '    q.writeBuffer(buf, 0, new Uint32Array([1, 2, 3]));',
      '    q.writeBuffer(buf, 0, big);',
      '    e.copyBufferToBuffer(buf, 0, buf, 0, N * 4);',
      '    e.copyBufferToBuffer(buf, 0, buf, 0, buf.size);',
      '    e.copyTextureToTexture({ texture: t }, { texture: u }, [4096, 4096]);',
      '  }',
      '}',
    ].join('\n');
    const lx = lex(src);
    const hits = [...lx.code.matchAll(/\.mapAsync\s*\(/g)].map((m) => [lineOf(lx.code, m.index!), enclosing(lx, m.index!)]);
    expect(hits).toEqual([[7, 'A.read']]);
    expect(transfersOf(src, lx).map((t) => [t.method, t.bytes])).toEqual([
      ['writeBuffer', 32],
      ['writeBuffer', 12],
      ['writeBuffer', null],
      ['copyBufferToBuffer', 64],
      ['copyBufferToBuffer', null],
      ['copyTextureToTexture', 4096 * 4096 * 16],
    ]);
  });
});
