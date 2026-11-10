// (round 128r, Track A "Next season") What the player reads of a season (docs/WRITING.md: plain, concrete, short).
// A words module: test/unit/season.test.ts lints every line it makes.

/** what a project did this season, for the summary */
export type SeasonWords =
  | { kind: 'raise'; name: string; storeys: number; done: boolean }
  | { kind: 'raided' | 'ruined' | 'overgrown'; name: string }
  | { kind: 'flood' | 'flood-holds' | 'drain'; name: string };

const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** one sentence for what a project did */
export function wordsLine(w: SeasonWords): string {
  switch (w.kind) {
    case 'raise':
      if (w.done) return `${cap(w.name)} is finished.`;
      return `${cap(w.name)} rose ${NUM[w.storeys] ?? w.storeys} ${w.storeys === 1 ? 'storey' : 'storeys'}.`;
    case 'raided':
      return `Raiders broke into ${w.name}.`;
    case 'ruined':
      return `${cap(w.name)} lies in ruins.`;
    case 'overgrown':
      return `Green grows over ${w.name}.`;
    case 'flood':
      return `Floodwater fills ${w.name}.`;
    case 'flood-holds':
      return `The water still stands in ${w.name}.`;
    case 'drain':
      return `The flood in ${w.name} went down.`;
  }
}

/** the season's line: which season, then what happened */
export function cardLines(season: number, words: SeasonWords[]): string {
  const said = words.map(wordsLine);
  return [`Season ${season}.`, ...(said.length ? said : ['Nothing changed.'])].join(' ');
}

/** the button that ends the season */
export const NEXT_SEASON = 'Next season';
/** the button that jumps to the end of the season's replay */
export const SKIP_SEASON = 'Skip';
/** shown while the season plays */
export const SEASON_PLAYING = 'The season passes.';
