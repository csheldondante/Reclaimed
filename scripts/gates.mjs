// Gate validator (docs/LEVELS.md, "The tools"): for each ability, a fresh
// world of the level in headless Chrome (real GPU) applies it to every gate
// at once (src/game/trial.ts), fast-forwards, and measures each gate (story
// rules: green spreads only by seeds, as the player plays it). Prints a
// matrix — gate × ability → % of the gate cleared / % of its stuff removed —
// and flags gates that open to the weather alone, or that nothing opens.
//
//   node scripts/gates.mjs [level-id] [--url http://localhost:5173]
//        [--abilities ambient,wind,gale,cyclone,rain,lightning,flood,chip]
//        [--seconds 60] [--settle 20] [--speed 2] [--parallel 2]
//        [--json out.json]        save the raw results
//        [--from out.json]        re-report saved results (no browser)
//
// Needs the dev server (npm run dev) or a preview serving the build.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
/** a gate counts as opened by an ability when this much of it is cleared (or its stuff removed) */
const OPENS = 0.5;
/** a wall is open once this share of it is down: a breach is enough */
const BREACH = 0.15;
/** the weather alone may wear a gate down (a gate only slows the player,
 *  DECISIONS round 31) but must not open it within a run */
const LEAK = OPENS;

let run;
const from = opt('from');
if (from) run = JSON.parse(fs.readFileSync(from, 'utf8'));
else {
  const level = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? 'trials';
  const base = opt('url', 'http://localhost:5173');
  const abilities = opt('abilities', 'ambient,wind,gale,cyclone,rain,lightning,flood,chip').split(',');
  const seconds = Number(opt('seconds', 60));
  const settle = Number(opt('settle', 20));
  const speed = Number(opt('speed', 2));
  const parallel = Number(opt('parallel', 2));
  const browser = await puppeteer.launch({
    executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
    headless: 'new',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=960,600'],
    defaultViewport: { width: 960, height: 600, deviceScaleFactor: 1 },
    protocolTimeout: 30 * 60 * 1000,
  });
  const results = {};
  const errors = [];
  let ids = [];
  /** abilities a player applies one place at a time: a fresh world per gate */
  const SERIAL = new Set(['wind', 'gale', 'cyclone', 'rain']);
  const one = async ([ab, gate]) => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(`${ab}: ${e.message}`));
    const t0 = Date.now();
    await page.goto(`${base}/?skipmenu=1&level=${level}&tutorial=0&mode=story&speed=${speed}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.reclaimed?.trial, { timeout: 90000 });
    const fatal = await page.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (fatal) throw new Error(`fatal overlay: ${fatal}`);
    const r = await page.evaluate((a, s, st, g) => window.reclaimed.trial.run(a, s, st, g ? [g] : undefined), ab, seconds, settle, gate);
    // (serial runs: keep only the gate the ability went to)
    results[ab] = gate ? [...(results[ab] ?? []), r.find((q) => q.id === gate)] : r;
    console.log(`${ab.padEnd(9)} ${gate ?? ''} done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    await page.close();
  };
  try {
    // the gate ids (from a first, quick look at the level)
    const probe = await browser.newPage();
    await probe.goto(`${base}/?skipmenu=1&level=${level}&tutorial=0&mode=story`, { waitUntil: 'load' });
    await probe.waitForFunction(() => window.reclaimed?.trial, { timeout: 90000 });
    ids = await probe.evaluate(() => window.reclaimed.trial.gates.map((g) => g.id));
    await probe.close();
    const queue = abilities.flatMap((a) => (SERIAL.has(a) ? ids.map((g) => [a, g]) : [[a, undefined]]));
    await Promise.all(Array.from({ length: parallel }, async () => {
      while (queue.length) await one(queue.shift());
    }));
  } finally {
    await browser.close();
  }
  run = { level, seconds, settle, speed, abilities, ids, results, errors };
  const json = opt('json');
  if (json) fs.writeFileSync(json, JSON.stringify(run, null, 2));
}

const { level, seconds, settle, speed, abilities, results, errors = [] } = run;
// each gate's spec (id, kind, soft) from whichever run measured it
const first = run.ids.map((id) => Object.values(results).flat().find((g) => g.id === id));
const cell = (r) => ({
  cleared: r.closed0 > 0 ? (r.closed0 - r.closed1) / r.closed0 : 0,
  removed: r.amount0 > 0 ? (r.amount0 - r.amount1) / r.amount0 : 0,
});
const opens = (kind, c) => (kind === 'wall' ? c.cleared >= BREACH : Math.max(c.cleared, c.removed) >= OPENS);
console.log(`\n${level}: % of each gate cleared / % of its stuff removed — ${seconds} s of the ability + ${settle} s, speed ${speed}`);
console.log(['gate'.padEnd(10), 'kind'.padEnd(7), ...abilities.map((a) => a.padStart(10))].join(' '));
const flags = [];
for (const g of first) {
  const at = (a) => cell(results[a].find((q) => q.id === g.id));
  console.log([g.id.padEnd(10), g.kind.padEnd(7), ...abilities.map((a) => `${Math.round(at(a).cleared * 100)}/${Math.round(at(a).removed * 100)}`.padStart(10))].join(' '));
  if (results.ambient && !g.soft) {
    const amb = at('ambient');
    if (Math.max(amb.cleared, amb.removed) > LEAK) flags.push(`${g.id}: the weather alone clears ${Math.round(Math.max(amb.cleared, amb.removed) * 100)}% — it leaks`);
  }
  const openers = abilities.filter((a) => a !== 'ambient' && opens(g.kind, at(a)));
  if (!openers.length) flags.push(`${g.id}: no ability opens it`);
  else console.log(`${''.padEnd(18)}opened by: ${openers.join(', ')}`);
}
if (flags.length) console.log(`\nflags:\n  ${flags.join('\n  ')}`);
if (errors.length) console.log(`\npage errors:\n  ${errors.join('\n  ')}`);
process.exit(errors.length ? 1 : 0);
