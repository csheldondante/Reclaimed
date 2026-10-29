// (round 112, herosandbox) The hero sandbox's pure parts in Node (no browser): the basin a fill finds (a walled
// vessel, a vessel with a notch, a slope, a plain), the contract version check, the registry, and a hero's
// tunables as a tuning registry (a slider moved sets the Walker's own value).
//   node scripts/herosandboxunit.mjs
import { createServer } from 'vite';

const v = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) fails++;
  return cond;
};
try {
  const { findBasin, pour } = await v.ssrLoadModule('/src/hero/fill.ts');
  const { cellPos } = await v.ssrLoadModule('/src/world/lattice.ts');
  const W = 128;
  // a vessel: floor 10, a ring wall 16 high from r 6 to 8 round (64, 64), ground 10 outside
  const wall = (notch) => (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= W || cy >= W) return null;
    const [x, y] = cellPos(cx, cy);
    const [ox, oy] = cellPos(64, 64);
    const r = Math.hypot(x - ox, y - oy);
    if (r >= 6 && r <= 8) return notch && x > ox + 5 && Math.abs(y - oy) < 1.2 ? 13 : 16;
    return 10;
  };
  {
    const b = findBasin(wall(false), [64, 64], { limit: 3000 });
    ok(!('error' in b) && Math.abs(b.level - 16) < 1e-6, `a walled vessel spills at its rim (16): ${'error' in b ? b.error : b.level}`);
    if (!('error' in b)) {
      ok(b.cells.length > 80 && b.cells.length < 140, `its inside only: ${b.cells.length} cells (π·6² / ROW_H ≈ 130)`);
      ok(Math.abs(b.volume - b.cells.length * (b.fillTo - 10)) < 1e-6, `volume ${b.volume.toFixed(1)} = cells × depth ${(b.fillTo - 10).toFixed(2)}`);
      const calls = [];
      const api = { water: { flood: (x, y, o) => calls.push(['w', o]), oil: () => {}, depthAt: () => 0 }, terrain: { deposit: (x, y, m, o) => calls.push([m, o]) } };
      const r = pour(api, b, 'water');
      ok(r.commands === b.cells.length && calls.every((c) => c[1].radius < 1 && Math.abs(c[1].depth - (b.fillTo - 10)) < 1e-6), `poured one column a command at its depth (${r.commands})`);
      calls.length = 0;
      pour(api, b, 'sand');
      ok(calls.length === b.cells.length && calls.every((c) => c[0] === 'sand' && c[1].layers > 0), 'sand: deposits, layers its depth');
    }
  }
  {
    const b = findBasin(wall(true), [64, 64], { limit: 3000 });
    ok(!('error' in b) && Math.abs(b.level - 13) < 1e-6, `a notched vessel spills at its notch (13): ${'error' in b ? b.error : b.level}`);
  }
  {
    // a slope: no basin
    const slope = (cx, cy) => (cx < 0 || cy < 0 || cx >= W || cy >= W ? null : 40 - cx * 0.3);
    const b = findBasin(slope, [64, 64], { limit: 3000 });
    ok('error' in b, `a slope is not a vessel: ${b.error}`);
    // a plain: never encloses
    const flat = (cx, cy) => (cx < 0 || cy < 0 || cx >= W || cy >= W ? null : 10);
    const p = findBasin(flat, [64, 64], { limit: 500 });
    ok('error' in p && /not enclosed|nothing to fill/.test(p.error), `a plain is not a vessel: ${p.error}`);
    // a pit dug in a plain: the plain is its rim
    const pit = (cx, cy) => (cx < 0 || cy < 0 || cx >= W || cy >= W ? null : Math.hypot(cx - 64, cy - 64) < 5 ? 6 : 10);
    const q = findBasin(pit, [64, 64], { limit: 3000 });
    ok(!('error' in q) && Math.abs(q.level - 10) < 1e-6 && q.cells.length < 100, `a pit in a plain fills to the plain (${'error' in q ? q.error : `${q.level}, ${q.cells.length} cells`})`);
    // a seed on the vessel's wall finds the vessel (down to its bottom first)
    const c = findBasin(wall(false), [70, 64], { limit: 3000 });
    ok(!('error' in c) && Math.abs(c.level - 16) < 1e-6, 'a tap on the inner wall fills the vessel');
  }
  const R = await v.ssrLoadModule('/src/hero/registry.ts');
  ok(R.contractMismatch('1.1') === null && R.contractMismatch('1.0') === null, 'a module of 1.0 or 1.1 loads on 1.1');
  ok(/major/.test(R.contractMismatch('2.0') ?? '') && /newer/.test(R.contractMismatch('1.2') ?? '') && /declares no/.test(R.contractMismatch(undefined) ?? ''), `2.0, 1.2 and none are refused, saying why ("${R.contractMismatch('2.0')}")`);
  ok(R.heroRoles().includes('wanderer'), 'the Walker is registered built-in');
  let threw = '';
  try {
    R.registerHero({ role: 'wanderer', name: 'x', makeHero: () => null }, 'http://elsewhere/heroes.js');
  } catch (e) {
    threw = e.message;
  }
  ok(/taken/.test(threw), `a second game's hero can't take a role silently: ${threw}`);
  // tunables: a slider moved sets the hero's own value
  const { heroTuning } = await v.ssrLoadModule('/src/hero/tunables.ts');
  const { Walker } = await v.ssrLoadModule('/src/hero/walker.ts');
  const units = { query: () => [], watch() {}, hit() {} };
  const w = new Walker({ ground: { heightAt: () => 5 }, units }, [10, 10]);
  const t = heroTuning(w);
  ok(t.registry.get('hero.speed') === 8 && t.registry.get('camera.zoom') === 14 && Math.round(t.registry.get('camera.behind')) === 35, 'the Walker\'s numbers and its camera as a registry (speed 8, zoom 14, behind 35°)');
  t.registry.set('hero.speed', 12);
  t.registry.set('camera.behind', 50);
  ok(w.tune.speed === 12 && Math.abs(w.camera.behind - (50 * Math.PI) / 180) < 1e-9, 'a slider moved sets the hero\'s value (speed 12, behind 50° in radians)');
  t.registry.reset();
  ok(w.tune.speed === 8, 'reset puts it back');
  w.update(1 / 60, { move: [1, 0] });
  ok(w.position()[0] > 10.1, `it walks at its speed (${w.position()[0].toFixed(3)})`);
} finally {
  await v.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
