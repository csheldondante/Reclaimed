// (round 117, runplan) The one Node API the Node-only fixture (fixture.ts) uses, typed here so the project's tsc (which
// has no @types/node: the game is browser code) checks the tests too. Merges with @types/node if testkit adds it.
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
}
