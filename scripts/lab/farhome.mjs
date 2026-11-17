// (loop round 10, LS-93) A run played from a far town in the 3D game, at phone size. Run 1 (frontier pack, 2 seasons)
// is played from the start town; a far town the town generator builds is made yours by a fixture (the frontier card
// path that swears one takes many seasons: the fixture is a `controls` relation, what the relief card leaves); the run
// is played to its end. The leader screen then shows the frontier's steward ("Rules from <town>") and the locked
// corsair with her hint; picking the steward opens the page on that town, the run begins there with "The world now"
// ("You rule from …"), and opening the old URL again goes back to the run's town.
//   node scripts/lab/farhome.mjs [--out dir]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'farhome', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'farhome');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(loop|season)\]/.test(t)) R.log(t.slice(0, 300));
  });
  const shot = async (name) => {
    await p.screenshot({ path: path.join(out, `${name}.png`) });
    R.log(`shot ${name}`);
  };
  const until = (fn, ms = 300000) => p.waitForFunction(fn, { timeout: ms, polling: 250 });
  const base = `${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&q=low&warmcache=0&runlen=2&packs=frontier`;
  await p.goto(`${base}&fresh=1`, { waitUntil: 'load' });
  await until(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'));
  await R.fatal(p);
  await p.evaluate(() => (window.rungame.pick('ysolt'), window.rungame.closePanel()));
  await until(() => window.rungame.phase === 'city', 60000);
  const home1 = await p.evaluate(() => window.season.town);
  // (run 1 played to its end: each season passed, an event settled or left, the raid's result taken)
  for (let k = 0; k < 200; k++) {
    const ph = await p.evaluate(() => window.rungame.phase);
    if (ph === 'end') break;
    await p.evaluate(() => {
      const g = window.rungame;
      if (g.phase === 'city' && !g.canSkip) g.next();
      else if (g.phase === 'season' && g.canSkip) g.skip();
      else if (g.phase === 'result') g.proceed();
      else if (g.phase === 'event' && g.liveNow?.canSettle) g.settle(g.liveNow.id);
      else if (g.phase === 'event' && g.liveNow?.canLeave) g.leave();
    });
    await R.sleep(1500);
  }
  R.check('run 1 ended', (await p.evaluate(() => window.rungame.phase)) === 'end');
  await shot('far-1-end');
  // (the fixture, once run 1 is over: the nearest far town still standing that the town generator builds made yours,
  // and the world saved)
  const far = await p.evaluate(async () => {
    const r = window.rungame.realm;
    const grid = new Set(window.reclaimed.scene.opts.atlas.fieldTowns);
    const id = r.selectTowns('far:nearest:60').find((x) => grid.has(x));
    r.w.facts.relate({ type: 'controls', from: 'player', to: id, cause: 'farhome-fixture' });
    await window.rungame.save();
    return { id, name: r.w.name(id) };
  });
  R.log(`run 1 at ${home1}; after it, ${far.name} (${far.id}) made yours`);
  await p.evaluate(() => window.rungame.again());
  await until(() => window.rungame.phase === 'leader', 10000);
  await R.sleep(800);
  await shot('far-2-leaders');
  const leaders = await p.evaluate(() => window.rungame.leaders());
  R.log(`leaders: ${JSON.stringify(leaders)}`);
  const steward = leaders.find((l) => l.id === 'frontier-steward');
  const corsair = leaders.find((l) => l.id === 'frontier-corsair');
  R.check('the steward is offered, playing from the far town', !!steward && steward.locked === null && steward.note === `Rules from ${far.name}. The game opens there.`, steward);
  R.check('the corsair is shown locked, with her hint', !!corsair && corsair.locked === 'Find out where the black sails come from.', corsair);
  // (the steward picked by the screen's own button: the page opens on the far town and the run begins there)
  await p.evaluate(() => {
    const box = [...document.querySelectorAll('.run-full .leader')].find((e) => e.textContent.includes('Steward Hal Brook'));
    box.querySelector('button').click();
  });
  await R.sleep(3000);
  await until(() => window.rungame?.phase === 'city' || document.querySelector('.fatal'));
  await R.fatal(p);
  await R.sleep(1500);
  const now = await p.evaluate(() => ({ url: location.search, town: window.season.town, home: window.rungame.realm.home, leader: window.rungame.leader.name, start: document.querySelector('.run-full')?.innerText ?? null }));
  R.log(`run 2: ${JSON.stringify(now)}`);
  await shot('far-3-start');
  R.check('run 2 is played from the far town', now.town === far.id && now.home === far.id && now.leader === 'Steward Hal Brook', now);
  R.check('"The world now" says the run moved', !!now.start && now.start.includes(`You rule from ${far.name}.`) && now.start.includes('is a far town now'), now.start);
  await p.evaluate(() => window.rungame.closePanel());
  await R.sleep(4000);
  await shot('far-4-town');
  const marks = await p.evaluate(() => window.rungame.markers().map((m) => m.label));
  R.log(`names over the town: ${JSON.stringify(marks)}`);
  R.check('the far town is made and its places carry names', marks.length > 0, marks);
  // (the old URL again: the run under way is the far town's, so the page goes back there)
  await p.goto(base, { waitUntil: 'load' });
  await R.sleep(3000);
  await until(() => window.rungame?.phase === 'city' || document.querySelector('.fatal'));
  await R.fatal(p);
  const back = await p.evaluate(() => ({ url: location.search, town: window.season.town, season: window.rungame.realm.season }));
  R.log(`the old URL again: ${JSON.stringify(back)}`);
  R.check('the old URL takes the run up at its own town', back.town === far.id, back);
  await R.sleep(2500);
  await shot('far-5-resumed');
});
