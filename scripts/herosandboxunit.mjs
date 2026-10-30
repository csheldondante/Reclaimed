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
    // a vessel whose floor ripples (loose ground, a tenth or three of a cell): the ripples are no rim
    const rip = (cx, cy) => {
      const h = wall(false)(cx, cy);
      return h === 10 ? 10 + 0.3 * (((cx * 7 + cy * 13) % 5) / 4) : h;
    };
    const b = findBasin(rip, [64, 64], { limit: 3000 });
    ok(!('error' in b) && Math.abs(b.level - 16) < 1e-6 && b.cells.length > 80, `a rippled floor fills to the rim: ${'error' in b ? b.error : `${b.level}, ${b.cells.length} cells`}`);
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
  {
    // (round 112, the user: "it walks me a few steps them stops almost like it walks to the displacement of the stick
    // and not targets that velocity") the stick held 5 s: a velocity held, speed × 5 cells along it
    const w2 = new Walker({ ground: { heightAt: (x, y) => (x < -500 || x > 500 ? null : 5) }, units }, [0, 0]);
    for (let k = 0; k < 300; k++) w2.update(1 / 60, { move: [0, -0.9] });
    const d = Math.hypot(...w2.position().slice(0, 2));
    ok(Math.abs(d - 8 * 0.9 * 5) < 2, `the stick held 5 s at 0.9: ${d.toFixed(1)} cells (speed 8 × 0.9 × 5 = 36)`);
  }
  // traversal fields: a wall across the way with a gap; a pool too deep to wade; a jump
  {
    const { CpuTraversal } = await v.ssrLoadModule('/src/hero/traversal.ts');
    const { Pilot } = await v.ssrLoadModule('/src/hero/pilot.ts');
    // ground 10; a wall at x 60..62 (height 20) from y 0 to 200 except a gap at y 100..106
    const wallH = (x, y) => (x >= 60 && x <= 62 && !(y >= 100 && y <= 106) ? 20 : 10);
    const ground = { heightAt: (x, y) => (x < 0 || y < 0 || x > 200 || y > 200 ? null : wallH(x, y)) };
    const tr = new CpuTraversal(ground);
    const f = tr.field([80, 40], { step: 2.5, drop: 2.5 }, { radius: 96 });
    const c = f.cost([40, 40]);
    ok(c !== null && c > 2 * Math.hypot(40, 0) && c < 200, `round the wall through the gap: cost ${c?.toFixed(1)} (straight 40) in ${f.ms.toFixed(1)} ms`);
    const r = f.route([40, 40]);
    ok(r.some((p) => p[0] > 59 && p[0] < 63 && p[1] >= 99 && p[1] <= 107), 'its route goes through the gap');
    const j = tr.field([80, 40], { step: 2.5, drop: 12, jump: 10 }, { radius: 96 }).cost([40, 40]);
    ok(j !== null && j < c, `a body that jumps 10 goes over (cost ${j?.toFixed(1)})`);
    const water = { depthAt: (x, y) => (Math.hypot(x - 120, y - 120) < 15 ? 3 : 0) };
    const tw = new CpuTraversal({ heightAt: (x, y) => (x < 0 || y < 0 || x > 200 || y > 200 ? null : 10) }, water);
    const fw = tw.field([120, 120], { step: 2.5, deep: 1.2 }, { radius: 60 });
    ok(!fw.reachable([120, 160]), 'a goal in water deeper than it wades is out of its reach from the shore');
    const fw2 = tw.field([120, 150], { step: 2.5, deep: 1.2 }, { radius: 80 });
    const rr = fw2.route([120, 90]);
    ok(rr && rr.every((p) => Math.hypot(p[0] - 120, p[1] - 120) >= 14), `round a pool deeper than it wades (${rr?.length} cells)`);
    // the pilot drives the Walker round the wall to the goal
    const units = { query: () => [], watch() {}, hit() {} };
    const w = new Walker({ ground, units }, [40, 40]);
    const pl = new Pilot(w, tr, units);
    pl.to([80, 40]);
    let k = 0;
    for (; k < 60 * 40 && pl.state === 'going'; k++) w.update(1 / 60, pl.intent());
    const p = w.position();
    ok(pl.state === 'there' && Math.hypot(p[0] - 80, p[1] - 40) <= 1.6, `the pilot walked the Walker round the wall to the goal: ${pl.state} at ${p[0].toFixed(1)}, ${p[1].toFixed(1)} in ${(k / 60).toFixed(1)} s, ${pl.fields} field(s)`);
  }
  // a ring laid a column at a time (hero/gauntlet.ts perColumn): every point of the ring's circle is in a column of it
  {
    const { perColumn } = await v.ssrLoadModule('/src/hero/gauntlet.ts');
    const { cellAt } = await v.ssrLoadModule('/src/world/lattice.ts');
    const c = [120.3, 80.7];
    const ring = [];
    for (let a = 0; a < 48; a++) ring.push({ kind: 'build', at: [c[0] + Math.cos((a * Math.PI) / 24) * 5.8, c[1] + Math.sin((a * Math.PI) / 24) * 5.8], material: 'concrete', radius: 1.1, layers: 6 });
    const cols = perColumn(ring);
    const set = new Set(cols.map((q) => cellAt(q.at[0], q.at[1]).join()));
    let hit = 0;
    for (let a = 0; a < 24; a++) if (set.has(cellAt(c[0] + Math.cos((a * Math.PI) / 12) * 5.8, c[1] + Math.sin((a * Math.PI) / 12) * 5.8).join())) hit++;
    ok(hit === 24 && cols.length === set.size && cols.every((q) => q.layers === 6), `a ring as ${cols.length} columns, one build each, covering its circle (${hit}/24)`);
  }
  {
    // (round 117, revive) a raider the spawn tool puts down a screen's half away (past its sight) idles; ordered to
    // attack the hero (the tool does now) it comes for it
    const { SimpleUnits } = await v.ssrLoadModule('/src/units/simple.ts');
    const { UNIT_KINDS } = await v.ssrLoadModule('/src/hero/sandbox.ts');
    const run = (order) => {
      const u = new SimpleUnits({ heightAt: () => 10 });
      const hero = { id: 'hero', faction: 'player', position: () => [10, 10, 10], alive: () => true, hurt: () => {} };
      u.watch(hero);
      const id = u.spawn('raider', [40, 10], 'raiders', UNIT_KINDS.raider.opts);
      if (order) u.order(id, { kind: 'attack', target: 'hero' });
      for (let k = 0; k < 120; k++) u.update(1 / 20);
      return u.get(id).at[0];
    };
    const idle = run(false), sent = run(true);
    ok(Math.abs(idle - 40) < 0.5 && sent < 30, `a raider 30 cells off (sight ${UNIT_KINDS.raider.opts.sight}) idles at x ${idle.toFixed(1)}; ordered to attack it comes: x ${sent.toFixed(1)}`);
  }
} finally {
  await v.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
