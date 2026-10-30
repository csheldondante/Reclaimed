// Terrain track: the terrain viewer's smoke (?terrain=view): a region graph over a river and a cliff, a room picked, two
// exits asked for, a basin flooded with sand and one with water, the GPU's flood checked against the CPU's.
//   node scripts/terrain/viewer.mjs [--server URL] [--out C:/Projects/shots88/terrain/viewer] [--at 6108,12131] [--span 1600]
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-viewer', kind: 'behaviour', size: '1200x800', strictConsole: true }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/terrain/viewer');
  const [x, y] = R.opt('at', '6108,12131').split(',').map(Number);
  const span = Number(R.opt('span', '1600'));
  const p = await R.page();
  await p.goto(`${R.url}/?terrain=view&mode=ground&view=${x},${y},${(span / 1200).toFixed(3)}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.viewer || document.querySelector('.fatal'), { timeout: 240000, polling: 250 });
  await R.fatal(p);
  await sleep(1500);
  await p.screenshot({ path: `${out}-0-ground.png` });
  const g = await p.evaluate(async () => {
    const v = window.reclaimed.viewer;
    const t0 = performance.now();
    const g = await v.makeGraph();
    const ms = performance.now() - t0;
    const kinds = {};
    for (const b of g.borders()) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
    const rooms = g.rooms();
    const sizes = rooms.map((r) => r.screens).sort((a, b) => a - b);
    return { ms: +ms.toFixed(0), features: g.features().length, rooms: rooms.length, borders: g.borders().length, kinds, screens: [sizes[0], sizes[sizes.length >> 1], sizes[sizes.length - 1]] };
  });
  R.check('graph made', g.rooms > 0, g);
  await sleep(600);
  await p.screenshot({ path: `${out}-1-graph.png` });
  // a room with a barrier out of it: picked, two exits asked for the walker
  const req = await p.evaluate(() => {
    const v = window.reclaimed.viewer;
    const g = v.graph;
    const W = { id: 'walker', step: 1.5, slope: 1, drop: 6, deep: 1.2, veg: 0.75, vegCost: 4, speed: 8 };
    let best = null;
    for (const r of g.rooms()) {
      const shut = g.borders(r.id).filter((b) => g.cost(b.id, W, r.id) === Infinity).length;
      if (shut && (!best || r.screens > best.screens)) best = r;
    }
    if (!best) return null;
    v.pickRoom(best.id);
    const before = g.exits(best.id, W).length;
    v.exits(before + 1);
    return { room: best.id, before, after: g.exits(best.id, W).length, edits: window.reclaimed.terrain.edits().map((e) => e.kind), info: v.info.textContent.slice(0, 400) };
  });
  R.check('an exit opened', !req || req.after > req.before, req);
  await sleep(600);
  await p.screenshot({ path: `${out}-2-exits.png` });
  const fc = await p.evaluate(async (at) => window.reclaimed.terrain.floodTool.check(at, 1024), [x, y]);
  R.check('GPU flood = CPU flood', fc.differ === 0 && Math.abs(fc.gpuLevel - fc.cpuLevel) < 1e-3, fc);
  const fl = await p.evaluate(async (at) => {
    const v = window.reclaimed.viewer;
    const r = await v.flood(at[0], at[1], 'water');
    return r;
  }, [x, y]);
  R.check('flooded', !!fl && fl.area > 0, fl);
  await sleep(800);
  await p.screenshot({ path: `${out}-3-flood.png` });
});
