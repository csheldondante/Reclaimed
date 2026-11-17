// The perf gate's comparison (scripts/lib/perfgate-compare.mjs; docs/TESTING.md "The perf gate").
import { expect, test } from 'vitest';
// @ts-expect-error a plain .mjs module of the scripts (no types)
import { compare, judgeCounter, judgeTiming } from '../../scripts/lib/perfgate-compare.mjs';

const scen = (o: Record<string, unknown> = {}) => ({ counters: { computePasses: 40, readKB: 0.5 }, timings: { coverMs: 2000, gpuMedMs: 4 }, awake: ['water', 'units'], cover: { 'load cover': { reached: true, ms: 2000, best: 1 } }, ...o });
const base = { scenarios: { 'loop-phone': scen() } };

test('the same numbers pass', () => {
  expect(compare(base, base)).toEqual({ fails: [], warns: [] });
});

test('a counter past its allowance fails, naming the scenario, metric, baseline and value', () => {
  const r = compare(base, { scenarios: { 'loop-phone': scen({ counters: { computePasses: 60, readKB: 0.5 } }) } });
  expect(r.fails).toHaveLength(1);
  expect(r.fails[0]).toMatch(/^loop-phone: computePasses: baseline 40, now 60/);
});

test('a counter within the allowance (30 % + 1) passes; a loose scenario allows a doubling + 5', () => {
  expect(judgeCounter('x', 40, 53)).toBeNull();
  expect(judgeCounter('x', 40, 54)).not.toBeNull();
  const loose = (v: number) => compare(base, { scenarios: { 'loop-phone': scen({ loose: true, counters: { computePasses: v, readKB: 0.5 } }) } }).fails;
  expect(loose(85)).toEqual([]);
  expect(loose(86)).toHaveLength(1);
  expect(judgeCounter('x', 0, 1)).toBeNull();
  expect(judgeCounter('x', 0, 1.5)).not.toBeNull();
});

test('a system awake that was not, and a quiet system awake, fail', () => {
  const r = compare(base, { scenarios: { 'loop-phone': scen({ awake: ['water', 'units', 'ecology'], mustSleep: ['ecology'] }) } });
  expect(r.fails.some((f: string) => /ecology must be asleep/.test(f))).toBe(true);
  expect(r.fails.some((f: string) => /ecology is awake at idle/.test(f))).toBe(true);
});

test('a screen that never fills fails even without a baseline', () => {
  const r = compare(null, { scenarios: { 'jump-phone': scen({ cover: { 'jump cover': { reached: false, ms: 60000, best: 0.8 } } }) } });
  expect(r.fails[0]).toMatch(/jump-phone: jump cover never reached 99 %/);
  expect(r.warns[0]).toMatch(/no baseline/);
});

test('a pan that pops in or hitches clearly more fails; within the allowance it passes', () => {
  const b = { scenarios: { 'pan-loop-phone': scen({ pan: { 'std.undrawnMeanPct': 1, 'std.over33': 2 } }) } };
  const ok = compare(b, { scenarios: { 'pan-loop-phone': scen({ pan: { 'std.undrawnMeanPct': 1.9, 'std.over33': 14 } }) } });
  expect(ok.fails).toEqual([]);
  const bad = compare(b, { scenarios: { 'pan-loop-phone': scen({ pan: { 'std.undrawnMeanPct': 2.5, 'std.over33': 15 } }) } });
  expect(bad.fails).toHaveLength(2);
  expect(bad.fails[0]).toMatch(/pan-loop-phone: std.undrawnMeanPct: baseline 1, now 2.5/);
});

test('timings warn when slower, fail only when far out', () => {
  expect(judgeTiming('t', 4, 5)).toBeNull();
  expect(judgeTiming('t', 4, 9)?.level).toBe('warn');
  expect(judgeTiming('t', 4, 18)?.level).toBe('fail');
  const r = compare(base, { scenarios: { 'loop-phone': scen({ timings: { coverMs: 5000, gpuMedMs: 4 } }) } });
  expect(r.fails).toEqual([]);
  expect(r.warns[0]).toMatch(/coverMs: baseline 2000 ms, now 5000 ms/);
});
