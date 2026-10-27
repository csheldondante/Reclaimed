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
    heightAt: (x, y) => (x < 0 || y < 0 || x > 256 || y > 222 ? null : built.some((b) => Math.hypot(b.x - x, b.y - y) <= b.r) ? 104 : 100),
    build: (x, y, m, o) => built.push({ x, y, m, r: o.radius ?? 3 }),
    dig: (x, y, o) => {
      for (let i = built.length - 1; i >= 0; i--) if (Math.hypot(built[i].x - x, built[i].y - y) <= (o.radius ?? 3)) built.splice(i, 1);
    },
  };
  const spots = { 'loc-ford': [128, 111], 'loc-mebe': [348, -533], 'loc-barrow': [622, -323] };
  const { stage, edits } = stageStory(story, { terrain, spawn: [128, 111], spot: (l) => spots[l.id], size: [256, 222] });
  ok(Object.keys(stage.locations).length === 3 && Object.keys(stage.cast).length === 5, `three places and five people staged (${edits} edits)`);
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
      ['loc-mebe', 'mill'],
      ['loc-ford', 'sapling-ring'],
    ];
    const hero = new Walker({ ground: terrain, units }, [128, 111]);
    for (const [l, r] of route) {
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
} catch (e) {
  console.log('FAIL', e.stack ?? e);
  fails++;
} finally {
  await v.close();
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
