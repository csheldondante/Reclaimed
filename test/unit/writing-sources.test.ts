// (round 128o, DA-G4) The writing lint (docs/WRITING.md) over every source of the player's words, not only where a
// test opts in. Every file under src/ that writes text to the page, the HUD or a canvas is in SOURCES as the player's
// (linted) or a developer's (a viewer, a bench, a debug panel: not linted, and why); a new such file fails until it is
// placed. In a player's file, the literals its sinks and label helpers are given are linted; a words module (its job is
// the player's lines) is linted whole (test/support/player-text.ts says how text is told from code). What fails today is
// in KNOWN with its BACKLOG row; a new failure fails, and a known one that's fixed must be dropped. Text built from data
// at run time (cards dealt, templates filled, the fortress's cards) is linted as produced by writing.test.ts and the
// fortress tests.

import { describe, expect, it } from 'vitest';
import { hasSink, keyText, type LabelHelper, moduleText, sinkText, type TextLine } from '../support/player-text';
import { readSrc, srcFiles } from '../support/source-scan';
import { lint } from '../support/writing';

type Source = { who: 'player'; helpers?: LabelHelper[]; keys?: string[] } | { who: 'words' } | { who: 'dev'; why: string };

/** every file that shows text, and whose text it is */
const SOURCES: Record<string, Source> = {
  // ---- the player's: the fortress, runs, levels, the menu, the HUD ----
  'fortress/ui.ts': { who: 'player', helpers: [{ name: 'toggle', arg: 0 }], keys: ['text'] },
  'fortress/raiders.ts': { who: 'player' },
  'fortress/words.ts': { who: 'words' },
  'opps/words.ts': { who: 'words' },
  'season/words.ts': { who: 'words' },
  'season/ui.ts': { who: 'player', helpers: [{ name: 'el', arg: 2 }] },
  'opps/level-opps.ts': { who: 'player', helpers: [{ name: 'h', arg: 1 }, { name: 'btn', arg: 0 }] },
  'dialog/dialog.ts': { who: 'player' },
  'api/atlas-map.ts': { who: 'player' },
  'game/powers.ts': { who: 'player' },
  'gpu/device.ts': { who: 'player' },
  'hero/touchpad.ts': { who: 'player' },
  'play/input/controls.ts': { who: 'player' },
  'play/sandbox/sandbox.ts': { who: 'player', helpers: [{ name: 'tool', arg: 1 }, { name: 'btn', arg: 0 }] },
  'play/session.ts': { who: 'player' },
  'run/hud.ts': { who: 'player' },
  'runplan/level-run.ts': { who: 'player', helpers: [{ name: 'h', arg: 1 }, { name: 'btn', arg: 0 }] },
  'runplay/stage.ts': { who: 'player' },
  'runsit/area.ts': { who: 'player', helpers: [{ name: 'btn', arg: 0 }] },
  'runsit/level-sit.ts': { who: 'player', helpers: [{ name: 'h', arg: 1 }, { name: 'btn', arg: 0 }] },
  'scenes/level.ts': { who: 'player' },
  'scenes/level/atlas-controls.ts': { who: 'player', helpers: [{ name: 'btn', arg: 0 }, { name: 'btn', arg: 1 }, { name: 'mv', arg: 0 }, { name: 'mv', arg: 2 }] },
  'scenes/level/attach-tools.ts': { who: 'player' },
  'scenes/level/camera-moves.ts': { who: 'player', helpers: [{ name: 'btn', arg: 0 }, { name: 'btn', arg: 1 }] },
  'scenes/level/impacts.ts': { who: 'player' },
  'scenes/level/input-wiring.ts': { who: 'player' },
  'scenes/level/runs.ts': { who: 'player' },
  'scenes/level/sandbox-tools.ts': { who: 'player' },
  'scenes/level/town-tools.ts': { who: 'player' },
  'scenes/level/valley.ts': { who: 'player' },
  'scenes/menu.ts': { who: 'player' },
  'story/hero-run.ts': { who: 'player' },
  'story/play.ts': { who: 'player' },
  'story/waypoint.ts': { who: 'player' },
  'ui/compass.ts': { who: 'player' },
  'ui/hud.ts': { who: 'player' },
  'ui/stations.ts': { who: 'player' },
  // ---- a developer's ----
  'cardlab/main.ts': { who: 'dev', why: 'the card lab page' },
  'citygen/panel.ts': { who: 'dev', why: 'citygen’s time-lapse and districts debug panel (?timelapse=1, ?citypanel=1)' },
  'perf/citygenbench.ts': { who: 'dev', why: 'a bench' },
  'perf/livingbench.ts': { who: 'dev', why: 'a bench' },
  'streetlab/control.ts': { who: 'dev', why: 'the street lab’s panel' },
  'citylife/towns.ts': { who: 'dev', why: 'the living town’s debug panel (?living=1)' },
  'flora/bench.ts': { who: 'dev', why: 'a bench' },
  'flora/viewer.ts': { who: 'dev', why: 'the flora viewer page' },
  'inhabitants/viewer.ts': { who: 'dev', why: 'the inhabitants viewer page' },
  'noiselab/control.ts': { who: 'dev', why: 'the noise lab\'s sliders' },
  'perf/bench.ts': { who: 'dev', why: 'the bench' },
  'perf/bench/ab.ts': { who: 'dev', why: 'the bench' },
  'perf/bench/pace.ts': { who: 'dev', why: 'the bench' },
  'perf/bench/page.ts': { who: 'dev', why: 'the bench' },
  'perf/bench/pages.ts': { who: 'dev', why: 'the bench' },
  'perf/bench/sweeps.ts': { who: 'dev', why: 'the bench' },
  'perf/hitch-hud.ts': { who: 'dev', why: 'the hitch HUD (?hitch=1)' },
  'perf/pagebench.ts': { who: 'dev', why: 'a bench' },
  'perf/physbench.ts': { who: 'dev', why: 'a bench' },
  'perf/placebench.ts': { who: 'dev', why: 'a bench' },
  'perf/townbench.ts': { who: 'dev', why: 'a bench' },
  'perf/speedbench.ts': { who: 'dev', why: 'a bench (the 16x toggle diff)' },
  'perf/flowbench.ts': { who: 'dev', why: 'a bench (the liquid toggle diff)' },
  'runplan/viewer.ts': { who: 'dev', why: 'the run plan viewer page' },
  'scenes/atlas-view.ts': { who: 'dev', why: 'the atlas generator view and its sliders (?atlas)' },
  'settle/debug.ts': { who: 'dev', why: 'the settlements\' debug overlay' },
  'structures/viewer/main.ts': { who: 'dev', why: 'the structures viewer page' },
  'terrain/viewer.ts': { who: 'dev', why: 'the terrain viewer page' },
  'ui/audio-debug.ts': { who: 'dev', why: 'the audio debug panel' },
  'ui/bugreport.ts': { who: 'dev', why: 'the bug report form, for the user testing builds' },
  'ui/editor.ts': { who: 'dev', why: 'the map editor' },
  'ui/experiment.ts': { who: 'dev', why: 'the experiment panel' },
  'ui/perf-overlay.ts': { who: 'dev', why: 'the perf overlay (?perf=1)' },
  'ui/tunepanel.ts': { who: 'dev', why: 'the tuning panel' },
};

/** What fails the lint today: file → the text as the gate reads it (fill-ins as "Muru") → its BACKLOG row. */
const KNOWN: Record<string, Record<string, string>> = {
  'hero/touchpad.ts': {
    'Run (Shift)': 'DA-G6',
    'Swing (Space)': 'DA-G6',
  },
  'opps/level-opps.ts': {
    'why? (the dealer)': 'DA-G6',
  },
  'play/sandbox/sandbox.ts': {
    'a rival rider (tap it to hook on and pull up alongside)': 'DA-G6',
  },
  'runplan/level-run.ts': {
    '(stand-in: Muru)': 'DA-G6',
    'How it went (no hero in this level: pick):': 'DA-G6',
    'Muru Muru (Muru on the road)': 'DA-G6',
    'Muru — Muru': 'DA-G6',
    'The hero is dead: the next run needs another (the world remembers).': 'DA-G6',
    'The land ahead is being shaped for the stage (terrain’s requests).': 'DA-G6',
    'Where next — travel on the map:': 'DA-G6',
    '▶ Another run — the world as you left it': 'DA-G6',
  },
  'runsit/area.ts': {
    'Muru Muru (Muru)': 'DA-G6',
  },
  'runsit/level-sit.ts': {
    '(your mount: the roads take Muru% of the time)': 'DA-G6',
    'Muru Muru — Muru': 'DA-G6',
    'Muru Muru: Muru (Muru s)': 'DA-G6',
    'Take the Muru (MuruMuru)': 'DA-G6',
    'The hero is dead: the next run needs another (the world remembers).': 'DA-G6',
    'Where now — the map shows the dead on the march:': 'DA-G6',
    'the template, filled from this world': 'DA-G6',
    '▶ Another run — the world as you left it': 'DA-G6',
  },
  'scenes/level.ts': {
    'Free camera — WASD or ⇧⇩▲▼ to fly (Q/E down/up, Shift faster), drag to turn, wheel or pinch to move along the view; F or ✈ back': 'DA-G6',
  },
  'scenes/level/atlas-controls.ts': {
    'a great meteor at the middle of the screen (M at the pointer)': 'DA-G6',
    'an eruption at the middle of the screen (V at the pointer)': 'DA-G6',
    'back (S)': 'DA-G6',
    'down (Q)': 'DA-G6',
    'forward (W)': 'DA-G6',
    'free camera (F)': 'DA-G6',
    'the atlas map: where you are; tap a place to warp there': 'DA-G6',
    'up (E)': 'DA-G6',
  },
  'scenes/level/camera-moves.ts': {
    'range: how far out the land is built in detail (cells across; reloads)': 'DA-G6',
    'turn the view (E; hold to turn on)': 'DA-G6',
    'turn the view (Q; hold to turn on)': 'DA-G6',
  },
  'scenes/level/impacts.ts': {
    'Drop all needs a level with the solvers (the playground, the rock lab).': 'DA-G6',
    'No room for more tilted structures (8 at most).': 'DA-G6',
  },
  'scenes/level/input-wiring.ts': {
    'Life lens — green: growing · magenta: toxic · grey: sealed · amber: too dry · blue: ready for life': 'DA-G6',
  },
  'scenes/level/town-tools.ts': {
    'No pile of bricks or logs near: lay some with ▲ Build (brick) first.': 'DA-G6',
    'Six workers build the plan from the pile (Muru blocks to do).': 'DA-G6',
  },
  'scenes/level/valley.ts': {
    'Fire leaves ash — and ash rides the wind. Blow it away.': 'DA-G6',
    'Life clings on by the pond. Tap the green to loose its seeds; drag to make wind and carry them to ground that is ready (Muru: blue). Muru': 'DA-G6',
    'Life has taken back the land. The ruins are still here — they are part of it now.': 'DA-G6',
    'Life keeps trying — but the dust and waste smother it.': 'DA-G6',
    'Sandbox: pick a tool on the right. Try 💥 Break on the towers and overhangs in the physics garden (bottom left), or on a wall of the sand basin.': 'DA-G6',
    'The valley is quiet. Touch things; drag to make wind. Swirl over water to raise a storm. Muru': 'DA-G6',
    'Thunder. A storm is coming — wait for it, or lean on it with the wind.': 'DA-G6',
    'Your turn. Touch the green — again, and again.': 'DA-G6',
  },
  'scenes/menu.ts': {
    'Build, pour, place and break things; summon weather — the physics playground': 'DA-G6',
    'Something lies buried here. Blow the dust away — or reclaim Muru.': 'DA-G6',
  },
  'story/hero-run.ts': {
    '(needs the Muru)': 'DA-G6',
  },
  'ui/compass.ts': {
    'compass: the way the view faces (the map’s north); tap to face north': 'DA-G6',
  },
  'ui/hud.ts': {
    'Hold to see what keeps life out (Space)': 'DA-G6',
    'Living land — the valley is reclaimed when it reaches the mark': 'DA-G6',
  },
};

/** the text of a source: its sinks' and helpers' literals, or every literal of a words module */
function textOf(file: string, s: Source): TextLine[] {
  const src = readSrc(file);
  if (s.who === 'words') return moduleText(src);
  if (s.who !== 'player') return [];
  return [...sinkText(src, s.helpers), ...(s.keys ? keyText(src, s.keys) : [])];
}

describe('the writing lint over every source of the player\'s words (docs/WRITING.md)', () => {
  it('every file that shows text is placed: the player\'s, a words module, or a developer\'s', () => {
    const unplaced = srcFiles().filter((f) => hasSink(readSrc(f)) && !SOURCES[f]);
    expect(unplaced.map((f) => `src/${f}: shows text — add it to SOURCES (player, words or dev)`)).toEqual([]);
    expect(Object.keys(SOURCES).filter((f) => !srcFiles().includes(f))).toEqual([]);
  });

  it('every line of the player\'s passes the lint, except the known ones', () => {
    const fresh: string[] = [];
    for (const [file, s] of Object.entries(SOURCES)) {
      for (const l of textOf(file, s)) {
        const problems = lint(l.text);
        if (problems.length && !KNOWN[file]?.[l.text]) fresh.push(`src/${file}:${l.line}: ${problems.join('; ')} — ${l.text}`);
      }
    }
    expect(fresh).toEqual([]);
  });

  it('every known failure still fails (a fixed one is dropped from KNOWN)', () => {
    const stale: string[] = [];
    for (const [file, lines] of Object.entries(KNOWN)) {
      const now = new Set(textOf(file, SOURCES[file]).map((l) => l.text));
      for (const text of Object.keys(lines)) if (!now.has(text) || !lint(text).length) stale.push(`${file}: ${text}`);
    }
    expect(stale).toEqual([]);
  });

  it('the reader finds the fortress bar\'s labels and lines', () => {
    const texts = textOf('fortress/ui.ts', SOURCES['fortress/ui.ts']).map((l) => l.text);
    for (const t of ['Erase', 'Inspect', 'Skip to done', 'Call raiders now', 'Tap a block to take it away.', 'Press Plan to stop time and plan more.']) expect(texts).toContain(t);
    expect(texts.some((t) => t.includes('fort-bar') || t.includes('pointer-events'))).toBe(false);
  });
});
