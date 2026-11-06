// (round 128o, DA-G2) The import-boundary gate: modules cross the boundaries DESIGN.md draws only where this table
// allows, so a parallel system can't be built unnoticed again. The user (2026-11-05): "the fact that it implemented 2
// agent systems, opportunities but then a parallel system for raids is a huge huge red flag." Each rule names folders
// under src/ that may not import other folders; every import that breaks a rule today is a known exception below, with
// the BACKLOG row that removes it. A new breach fails, and so does an exception that no longer happens (drop it).
// Imports are read by test/support/source-scan.ts (static, dynamic and `export … from`; type-only imports count too:
// a type is still a dependency on the module's shape).

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importsOf, readSrc, ROOT, srcFiles } from '../support/source-scan';

/** the run layer: opportunities, the living world, the GM, run plans and situations, dialog (DESIGN.md §21) */
const RUN = ['opps', 'living', 'gm', 'runplan', 'runsit', 'runplay', 'dialog'];
/** the engine: the world's systems and their public API (§1-§16); `api` is ruled separately below */
const ENGINE = ['sim', 'gpu', 'world', 'shaders', 'agents', 'physics', 'solver', 'flow', 'atlas', 'terrain', 'grids', 'render', 'weather', 'traits', 'inhabitants', 'flora', 'structures', 'build', 'tune', 'audio', 'input', 'units'];
/** what sits on the engine: scenes (the wiring), game rules, the town, the run layer, UI, pages, benches, tests */
const ABOVE = ['scenes', 'game', 'levels', 'fortress', 'settle', ...RUN, 'story', 'play', 'run', 'ui', 'lab', 'perf', 'noiselab', 'cardlab', 'inspector', 'test', 'main.ts', 'phone-flags.ts', 'phone-flags-boot.ts', 'fresh-start.ts'];
/** pages that live beside an engine module (a viewer or a bench is a page, not the engine) */
const PAGES = ['terrain/viewer.ts', 'inhabitants/viewer.ts', 'flora/viewer.ts', 'flora/bench.ts', 'structures/viewer/'];

interface Rule {
  id: string;
  /** the folders (or files) under src/ the rule binds */
  from: string[];
  /** files under `from` the rule doesn't bind */
  except?: string[];
  /** what they may not import */
  not?: string[];
  /** or: the only things they may import */
  only?: string[];
  /** where DESIGN.md draws the line */
  why: string;
}

export const RULES: Rule[] = [
  { id: 'run-not-town', from: RUN, not: ['fortress'], why: '§21: one opportunity contract and one dealer; a raid is a card the town executes through an adapter in the scene wiring, so the run layer never reaches into the fortress' },
  { id: 'town-not-run', from: ['fortress'], not: [...RUN, 'ui', 'scenes', 'story', 'play', 'game', 'levels', 'lab', 'perf'], why: '§18: the economy is pure, testable logic touching the world only through its channels; §21: holdings go to the run layer through an adapter the scene wires' },
  { id: 'contracts-alone', from: ['api/contracts'], only: ['api/contracts'], why: '§1: systems talk only through contracts; a contract is types and pure reference code, depending on nothing but contracts' },
  { id: 'engine-not-game', from: ENGINE, except: PAGES, not: ABOVE, why: '§1: the engine is the world and its systems; game layers sit on it through its API and contracts, never the other way' },
  { id: 'api-not-game', from: ['api'], except: ['api/contracts'], not: ABOVE, why: 'the world API is the engine\'s face to games (docs/WORLD_API.md); it may not depend on a game or a scene' },
  { id: 'run-not-ui', from: RUN, not: ['ui', 'scenes'], why: '§22: UI reads game state through the same contracts as everything else; the run layer is pure and Node-testable' },
  { id: 'no-kernels-above', from: [...RUN, 'ui', 'scenes', 'story', 'play'], not: ['shaders'], why: '§1: kernels belong to the engine systems that own their buffers' },
];

/** Today's breaches, each with the BACKLOG row that removes it: rule, importing file, imported module (no extension). */
export const KNOWN: { rule: string; file: string; imports: string; backlog: string }[] = [
  // WorldCore, the Streamer and Integrity are the engine's live world but live in scenes/ and game/ (DA-P9)
  ...['agents/install.ts', 'flow/install.ts', 'inhabitants/install.ts', 'physics/install.ts', 'physics/wake.ts', 'traits/install.ts'].map((file) => ({ rule: 'engine-not-game', file, imports: 'scenes/world-core', backlog: 'DA-P9' })),
  { rule: 'engine-not-game', file: 'atlas/atlas.ts', imports: 'scenes/streamer', backlog: 'DA-P9' },
  { rule: 'engine-not-game', file: 'atlas/atlas/columns.ts', imports: 'scenes/streamer', backlog: 'DA-P9' },
  { rule: 'engine-not-game', file: 'sim/static-claims.ts', imports: 'game/colapply', backlog: 'DA-P9' },
  ...['api/atlas-world.ts', 'api/fire.ts', 'api/fx.ts', 'api/plants.ts', 'api/terrain.ts', 'api/water.ts', 'api/wind.ts', 'api/world.ts'].map((file) => ({ rule: 'api-not-game', file, imports: 'scenes/world-core', backlog: 'DA-P9' })),
  { rule: 'api-not-game', file: 'api/atlas-world.ts', imports: 'scenes/streamer', backlog: 'DA-P9' },
  { rule: 'api-not-game', file: 'api/atlas-world.ts', imports: 'game/integrity', backlog: 'DA-P9' },
  // the fortress keeps its box in the window through the streamer's KeepRect (the residency planner replaces it)
  { rule: 'town-not-run', file: 'fortress/host.ts', imports: 'scenes/streamer/keep', backlog: 'DA-P2' },
  // scene wiring and a page that live in the run layer's folders
  { rule: 'run-not-ui', file: 'opps/level-opps.ts', imports: 'ui/tunepanel', backlog: 'DA-L9' },
  { rule: 'run-not-ui', file: 'runplan/viewer.ts', imports: 'scenes/world-core', backlog: 'DA-L9' },
];

const under = (f: string, paths: string[]) => paths.some((p) => (p.endsWith('.ts') ? f === p || f === p.replace(/\.ts$/, '') : p.endsWith('/') ? f.startsWith(p) : f === p || f.startsWith(`${p}/`)));

interface Breach {
  rule: string;
  file: string;
  imports: string;
  line: number;
}

function breaches(): Breach[] {
  const out: Breach[] = [];
  for (const file of srcFiles(['.ts'])) {
    for (const im of importsOf(readSrc(file))) {
      if (!im.spec.startsWith('.')) continue;
      const to = posix.normalize(posix.join(posix.dirname(file), im.spec.replace(/\?raw$/, ''))).replace(/\.ts$/, '');
      for (const r of RULES) {
        if (!under(file, r.from) || (r.except && under(file, r.except))) continue;
        if (r.only ? !under(to, r.only) : under(to, r.not!)) out.push({ rule: r.id, file, imports: to, line: im.line });
      }
    }
  }
  return out;
}

describe('the import-boundary gate (DESIGN.md; docs/ARCHITECTURE.md "Module boundaries")', () => {
  const found = breaches();
  const known = new Set(KNOWN.map((k) => `${k.rule} ${k.file} -> ${k.imports}`));
  const seen = new Set(found.map((b) => `${b.rule} ${b.file} -> ${b.imports}`));

  it('no import crosses a boundary except the known breaches', () => {
    const fresh = found.filter((b) => !known.has(`${b.rule} ${b.file} -> ${b.imports}`)).map((b) => `${b.rule}: src/${b.file}:${b.line} imports ${b.imports} — ${RULES.find((r) => r.id === b.rule)!.why}`);
    expect(fresh).toEqual([]);
  });

  it('every known breach still happens (a fixed one is dropped from the list)', () => {
    expect([...known].filter((k) => !seen.has(k))).toEqual([]);
  });

  it('every known breach names a BACKLOG row, and every rule a file exists for', () => {
    const backlog = readFileSync(`${ROOT}docs/BACKLOG.md`, 'utf8');
    expect([...new Set(KNOWN.map((k) => k.backlog))].filter((id) => !new RegExp(`^\\| ${id} \\|`, 'm').test(backlog))).toEqual([]);
    const files = srcFiles(['.ts', '.wgsl']);
    for (const r of RULES) for (const p of r.from) expect(files.some((f) => under(f, [p])), `${r.id}: ${p}`).toBe(true);
  });

  it('the rules catch what they say: a fortress import from opps fails', () => {
    const r = RULES.find((x) => x.id === 'run-not-town')!;
    expect(under('opps/run.ts', r.from) && under('fortress/fortress', r.not!)).toBe(true);
    expect(under('opps/run.ts', ['opp'])).toBe(false);
  });
});
