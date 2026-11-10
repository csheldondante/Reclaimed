// (living town) works.wgsl repeats routes.wgsl's state-word layout, counters and struct P (it is appended to the world
// prelude, so it can't include routes.wgsl's bindings): every constant both declare has the same value, the struct is the
// same, and living.ts's LT_WORDS covers the layout.
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { LT_WORDS, L_C, L_Q, L_F } from '../../src/citylife/living';

const read = (f: string) => readFileSync(new URL(`../../src/citylife/${f}`, import.meta.url), 'utf8');
const consts = (s: string) => new Map([...s.matchAll(/^const (\w+): \w+ = ([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
const struct = (s: string) => /struct P \{([^}]*)\}/.exec(s)![1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('/**') && !l.startsWith('*'));

test('works.wgsl agrees with routes.wgsl', () => {
  const r = read('routes.wgsl');
  const w = read('works.wgsl');
  const rc = consts(r);
  const wc = consts(w);
  let shared = 0;
  for (const [k, v] of wc) {
    if (!rc.has(k)) continue;
    shared++;
    expect(`${k} = ${v}`).toBe(`${k} = ${rc.get(k)}`);
  }
  expect(shared).toBeGreaterThan(30);
  expect(struct(w)).toEqual(struct(r));
  const n = (k: string) => parseInt(rc.get(k)!, 10);
  // (season life: the wall's block after the regrow list)
  expect(n('L_WALL')).toBe(n('L_REGROW') + n('REGROW_ROOM') * 2);
  expect(LT_WORDS).toBe(n('L_WALL') + n('WL_WORDS'));
  expect(n('L_RH') + n('ROUTES') * 4).toBeLessThanOrEqual(n('L_REGROW'));
  expect([L_C, L_Q, L_F]).toEqual([n('L_C'), n('L_Q'), n('L_F')]);
});
