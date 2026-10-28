// The hero, the units and the stage generator through their interfaces, in Node (round 88, `runstory`): no
// browser, a flat stand-in ground. Checks the Bell story's briefs lay out (every room, lock and person placed,
// rooms apart, in the window) and that the fight is fair: the Walker, swinging at the nearest, beats the
// Bellwarden and its four dead, and dies standing still among them.
//   node scripts/herotest.mjs
import { createServer } from 'vite';
import fs from 'node:fs';

const v = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) fails++;
  return cond;
};
try {
  const { stageStory } = await v.ssrLoadModule('/src/story/stage-gen.ts');
  const { SimpleUnits } = await v.ssrLoadModule('/src/units/simple.ts');
  const { Walker } = await v.ssrLoadModule('/src/hero/walker.ts');
  const story = JSON.parse(fs.readFileSync('data/stories/the-bell-under-kaudru.json', 'utf8'));
  // (flat ground, a wall wherever something was built: what the stage generator and the walkers read)
  const built = [];
  const terrain = {
    // (as edit.wgsl lays a build: full over the inner half, soft at the rim — on hex-ish columns, a cell apart)
    heightAt: (x, y) => {
      if (x < 0 || y < 0 || x > 256 || y > 222) return null;
      const cx = Math.round(x);
      const cy = Math.round(y);
      let h = 0;
      for (const b of built) {
        const d = Math.hypot(b.x - cx, b.y - cy) / b.r;
        if (d >= 1) continue;
        const s = Math.min(1, Math.max(0, (1 - d) / 0.5));
        h = Math.max(h, 6 * s * s * (3 - 2 * s));
      }
      return 100 + h;
    },
    build: (x, y, m, o) => built.push({ x, y, m, r: o.radius ?? 3 }),
    dig: (x, y, o) => {
      for (let i = built.length - 1; i >= 0; i--) if (Math.hypot(built[i].x - x, built[i].y - y) <= (o.radius ?? 3)) built.splice(i, 1);
    },
  };
  const spots = { 'loc-ford': [128, 111], 'loc-mebe': [348, -533], 'loc-barrow': [622, -323] };
  const { stage, pieces } = stageStory(story, { terrain, spawn: [128, 111], spot: (l) => spots[l.id], size: [256, 222] });
  // (round 99: the generator hands back pieces; built here as the world API's edits would lay them)
  for (const p of pieces) if (!p.grow) terrain.build(p.at[0], p.at[1], p.material, { radius: p.radius, layers: p.layers });
  ok(Object.keys(stage.locations).length === 3 && Object.keys(stage.cast).length === 5, `three places and five people staged (${pieces.length} pieces)`);
  ok(stage.locks.every((k) => pieces.some((p) => p.tag === `lock:${k.id}`)), "each lock's plug is a piece tagged with it");
  ok(stage.locks.map((l) => l.id).sort().join() === 'bone-door,sluice-wheel', 'the two locks are doors');
  const rooms = Object.entries(stage.rooms).flatMap(([l, rs]) => Object.entries(rs).map(([id, r]) => ({ id: `${l}/${id}`, ...r })));
  let apart = true;
  for (const a of rooms) for (const b of rooms) if (a !== b && Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]) < a.radius + b.radius + 1) apart = (console.log(`     ${a.id} overlaps ${b.id}`), false);
  ok(apart, `${rooms.length} rooms, none overlapping`);
  ok(rooms.every((r) => r.at[0] > 10 && r.at[0] < 246 && r.at[1] > 10 && r.at[1] < 212), 'every room in the window');
  for (const [l, v] of Object.entries(stage.locations)) console.log(`     ${l} at ${v.at.map((x) => x.toFixed(0))} (r ${v.radius.toFixed(0)}, ${Math.hypot(v.at[0] - 128, v.at[1] - 111).toFixed(0)} from the spawn)`);

  // walking the stage: through doorways, room to room, as a tap on the ground sends the hero
  {
    const units = new SimpleUnits(terrain);
    const R = stage.rooms;
    const route = [
      ['loc-mebe', 'reeve-hall'],
      ['loc-barrow', 'cairn-gate'],
      ['loc-barrow', 'ossuary'],
      ['open', 'bone-door'],
      ['loc-barrow', 'bell-chamber'],
      ['loc-mebe', 'reeve-hall'],
      ['loc-mebe', 'mill'],
      ['loc-ford', 'sapling-ring'],
    ];
    const hero = new Walker({ ground: terrain, units }, [128, 111]);
    for (const [l, r] of route) {
      if (l === 'open') {
        // (the lock opened, as the run does with the key)
        const k = stage.locks.find((x) => x.id === r);
        terrain.dig(k.at[0], k.at[1], { radius: 2.9 });
        continue;
      }
      const to = R[l][r].at;
      let t = 0;
      const t0 = performance.now();
      for (; t < 90; t += 1 / 30) {
        const p = hero.position();
        if (Math.hypot(to[0] - p[0], to[1] - p[1]) < 3.5) break;
        hero.update(1 / 30, { move: [0, 0], goTo: t === 0 ? to : undefined });
      }
      if (!ok(t < 90, `walked into ${l}/${r} in ${t.toFixed(1)} s of play (${(performance.now() - t0).toFixed(0)} ms to run)`)) {
        const { findPath } = await v.ssrLoadModule('/src/hero/path.ts');
        const p = hero.position();
        console.log(`     stopped at ${p.map((x) => x.toFixed(1))}, the room at ${to.map((x) => x.toFixed(1))}; a path: ${JSON.stringify(findPath(terrain, [p[0], p[1]], to, { step: 2.5 }))}`);
        for (const ll of Object.keys(R)) console.log(`     rooms ${ll}: ${JSON.stringify(Object.fromEntries(Object.entries(R[ll]).map(([k, v]) => [k, v.at.map((x) => +x.toFixed(0))])))}`);
      }
    }
  }

  // (round 99, runstream) the stage in world cells, stamped into the land as it arrives (story/stage-land.ts)
  {
    const { StageLand } = await v.ssrLoadModule('/src/story/stage-land.ts');
    const { ROW_H } = await v.ssrLoadModule('/src/world/lattice.ts');
    const { StampOps, applyStamps } = await v.ssrLoadModule('/src/atlas/stamps.ts');
    const atlas = { p: { cols: 1024, rows: 1024 }, stampHooks: [] };
    const land = new StageLand(atlas);
    // (round 102: the hook says what it builds as stamps — atlas/stamps.ts — laid here on the CPU as Atlas.regionLand
    // lays them; the GPU's finish.wgsl runs the same operations, scripts/gpugentest.mjs)
    const stampInto = async (l) => {
      const ops = new StampOps(64, 64);
      for (const f of atlas.stampHooks) await f(ops, l.x0, l.y0, 64, 64, false);
      const marks = new Float32Array(ops.marks);
      applyStamps(ops, l, marks);
      ops.tell(marks);
    };
    // (the window's origin at (1000, 500): the stage straddles the world's x seam)
    const ox = 1000;
    const oy = 500;
    const wrap = (x, n) => ((x % n) + n) % n;
    land.add(pieces.map((p) => ({ ...p, at: [wrap(ox + p.at[0], 1024), wrap(oy * ROW_H + p.at[1], 1024 * ROW_H)] })));
    ok(atlas.stampHooks.length === 1 && typeof atlas.stampHooks[0] === 'function', 'the stage land is an Atlas.stampHooks hook');
    // a region of flat land (ground at 100), as the atlas hands one over
    const region = (x0, y0) => {
      const w = 64;
      const cols = Array.from({ length: w * w }, () => [{ z0: 0, z1: 100, mat: 1 }]);
      return { x0, y0, w, h: w, cols, surface: new Float32Array(w * w).fill(100), water: new Float32Array(w * w), moisture: new Float32Array(w * w), vegetation: new Float32Array(w * w), contam: new Float32Array(w * w * 2) };
    };
    // (every region of the window: the seam crossed with x0 past the world's edge, as a slide's origin runs on)
    let raised = 0;
    const lands = [];
    for (let ry = 0; ry < 256; ry += 64)
      for (let rx = 0; rx < 256; rx += 64) {
        const l = region(ox + rx, oy + ry);
        await stampInto(l);
        raised += [...l.surface].filter((z) => z > 100.5).length;
        lands.push(l);
      }
    const walls = land.pieces.filter((p) => p.tag === 'wall');
    ok(raised > 500 && walls.every((p) => p.base === 100), `the window's regions stamped: ${raised} columns raised, every wall's base the ground's (${land.stats.regions} regions)`);
    // the same piece's column in the region it lies in: raised by its layers
    const k = stage.locks.find((x) => x.id === 'bone-door');
    const at = [k.at[0], k.at[1]];
    const topAt = (ls, x, y) => {
      const cy = Math.floor(y / ROW_H);
      const cx = Math.floor(x - 0.5 * (cy & 1));
      const l = ls.find((r) => cx >= r.x0 - ox && cx < r.x0 - ox + 64 && cy >= r.y0 - oy && cy < r.y0 - oy + 64);
      return l.surface[(cy - (l.y0 - oy)) * 64 + (cx - (l.x0 - ox))];
    };
    ok(topAt(lands, ...at) > 105, `the bone door's plug stands (${topAt(lands, ...at).toFixed(1)})`);
    // opened in play: the next stamp leaves it out; the walls stay
    land.open('lock:bone-door');
    const again = [];
    for (let ry = 0; ry < 256; ry += 64)
      for (let rx = 0; rx < 256; rx += 64) {
        const l = region(ox + rx, oy + ry);
        await stampInto(l);
        again.push(l);
      }
    const w0 = walls[0];
    const wAt = [wrap(w0.at[0] - ox + 1024 / 2, 1024) - 1024 / 2, w0.at[1] - oy * ROW_H];
    ok(topAt(again, ...at) < 101 && topAt(again, ...wAt) > 104, `after the door's opened, its land stamped again: the plug gone (${topAt(again, ...at).toFixed(1)}), a wall still up (${topAt(again, ...wAt).toFixed(1)})`);
    // a wall seen standing, then found down: gone from the next stamp
    const toWin = (p) => [wrap(p[0] - ox + 512, 1024) - 512, p[1] - oy * ROW_H];
    let down = false;
    const hz = (x, y) => (down && Math.hypot(x - wAt[0], y - wAt[1]) < 0.01 ? 100 : 106);
    land.watch(hz, toWin, 0);
    const seen = w0.seen;
    down = true;
    land.watch(hz, toWin, 0);
    ok(seen === true && w0.gone === true && land.stats.broken === 1, `a wall seen standing then down is gone (broken ${land.stats.broken})`);
    land.dispose();
    ok(atlas.stampHooks.length === 0, 'disposed: the hook is out');
  }

  // the fight: on open ground
  const flat = { heightAt: () => 100 };
  const fight = (swing) => {
    const units = new SimpleUnits(flat);
    const hero = new Walker({ ground: flat, units }, [50, 50]);
    units.watch(hero.actor);
    const w = units.spawn('lich steward', [53, 50], 'f-hollow-court', { character: 'bellwarden', hostile: true, health: 12, damage: 2, sight: 12, speed: 2.6 });
    for (let k = 0; k < 4; k++) units.spawn('walking dead', [53 + 3 * Math.cos(k * 1.6), 50 + 3 * Math.sin(k * 1.6)], 'f-hollow-court', { hostile: true, health: 2, sight: 11, speed: 2.4 });
    let t = 0;
    for (; t < 120 && hero.alive && units.get(w)?.alive; t += 1 / 60) {
      const p = hero.position();
      const foes = units.query([p[0], p[1]], 40, { hostile: true });
      const tg = foes.length <= 2 ? units.get(w) : foes[0];
      const dx = tg.at[0] - p[0];
      const dy = tg.at[1] - p[1];
      const d = Math.hypot(dx, dy);
      hero.update(1 / 60, { move: swing && d > 1.8 ? [dx / d, dy / d] : [0, 0], attack: swing && d < 3 });
      units.update(1 / 60);
    }
    return { t: +t.toFixed(1), hp: hero.health, warden: units.get(w)?.alive ?? false, left: units.query([50, 50], 60, { hostile: true }).length };
  };
  const a = fight(true);
  ok(a.hp > 0 && !a.warden, `swinging: the Bellwarden falls in ${a.t} s, the hero at ${a.hp} hp (${a.left} foes left)`);
  const b = fight(false);
  ok(b.hp === 0, `standing still: the hero falls in ${b.t} s`);

  // (round 97, heroapi) dialog as an event: sightings and deaths fire barks and talks through the run's own
  // happenings; and a world kept between runs (MemoryWorldState.restore) carries the first run's changes
  const { StoryRun } = await v.ssrLoadModule('/src/run/run.ts');
  const { MemoryWorldState } = await v.ssrLoadModule('/src/api/contracts/world-state.ts');
  const wiki = JSON.parse(fs.readFileSync('data/wiki/seed1.run.json', 'utf8'));
  const world = new MemoryWorldState(wiki.seed, wiki.regions, wiki.factions);
  const run = new StoryRun(story, world, { hero: 'hover bike' });
  const said = [];
  const talks = [];
  const spawned = [];
  run.onOutcome.push((o) => {
    for (const s of o.say ?? []) said.push(`${s.by ?? 'narrator'}: ${s.line}`);
    if (o.talk) talks.push(o.talk.character);
    for (const sp of o.spawn ?? []) spawned.push(sp);
  });
  run.update(9);
  ok(spawned.some((s) => s.toward === 'loc-mebe') && said.some((s) => /walking toward Mebe/.test(s)), `t 9 s: the dead set off toward Mebe, and it's said (${said.at(-1)})`);
  run.note({ kind: 'saw', character: 'ilsa' });
  ok(said.some((s) => s.startsWith('ilsa:')), `saw Ilsa: her bark (${said.at(-1)})`);
  run.note({ kind: 'saw', location: 'loc-barrow' });
  ok(said.some((s) => /bell tolls/.test(s)), "saw the barrow: the narrator's line");
  const n = said.length;
  run.note({ kind: 'saw', character: 'ilsa' });
  ok(said.length === n, 'a happening fires once: seeing Ilsa again says nothing');
  run.note({ kind: 'killed', character: 'bellwarden', unitKind: 'lich steward' });
  ok(said.some((s) => s.startsWith('bellwarden:')) && run.flag('dead-stopped'), 'the Bellwarden killed: its dying line, dead-stopped set');
  ok(talks.includes('hesk'), 'the dead stopped: a talk with Hesk opens as an event (Outcome.talk)');
  const rec = run.end('won');
  const snap = JSON.parse(JSON.stringify(world.snapshot()));
  const again = MemoryWorldState.restore(snap);
  ok(again.run === 1 && again.runs.length === 1 && again.runs[0].end === 'won', `restored: the next run is ${again.run}, the last ${again.runs[0]?.end}`);
  ok(again.history().length === rec.events.length && again.region(2159).marks.some((m) => m.name === "The Bellwarden's Grave"), `restored: ${again.history().length} events, the grave in region 2159`);
  ok(again.region(2159).undead === world.region(2159).undead, 'restored: the region states as they were');
} catch (e) {
  console.log('FAIL', e.stack ?? e);
  fails++;
} finally {
  await v.close();
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
