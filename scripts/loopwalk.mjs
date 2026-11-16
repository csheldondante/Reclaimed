// (loop-skeleton; docs/design/LOOP_SKELETON.md) The main loop's walk-through at phone size (412x915), a still a moment:
// pick a leader, the town, a petition, the cost committed, the season passing, the threat, the attack, its result, a
// world change, the end of the run, and a new run in the same world. Drives the page by its own buttons.
//   node scripts/loopwalk.mjs [--out <dir>] [--leader ysolt] [--agree barracks,mine] [--query ...]
// On the shared runner (scripts/lib/runner.mjs): this worktree's build, the GPU leased as a behaviour check; it fails on
// a page error, the fatal overlay, or a step that never comes.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './lib/runner.mjs';

await run({ name: 'loopwalk', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf(`--${k}`);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const out = opt('out', 'loopwalk');
  const leader = opt('leader', 'ysolt');
  const agree = opt('agree', 'barracks,mine').split(',');
  const query = opt('query', 'skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low');
  fs.mkdirSync(out, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => R.log(...a);
  const page = await R.page();
  page.on('console', (m) => {
    const t = m.text();
    if (/^\[(loop|forces)\]/.test(t)) log(t.slice(0, 300));
  });
  const shot = async (name) => {
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    log(`shot ${name}: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.run-sheet h3, .run-full h2, .run-top .r-title')].map((e) => e.textContent)))}`);
  };
  const phase = (p, ms = 240000) => page.waitForFunction((q) => q.split('|').includes(window.rungame?.phase), { timeout: ms, polling: 200 }, p);
  const tap = (sel, text) =>
    page.evaluate(
      (s, t) => {
        const b = [...document.querySelectorAll(s)].find((e) => !t || e.textContent.includes(t));
        if (!b) throw new Error(`no ${s} with "${t}"`);
        b.click();
      },
      sel,
      text,
    );
  const state = () => page.evaluate(() => ({ phase: window.rungame.phase, season: window.rungame.run?.season, hand: window.rungame.run?.hand, due: window.rungame.run?.due.length, changes: window.rungame.world.changes.map((c) => c.id), places: window.rungame.world.places.map((p) => `${p.id}:${p.status}`) }));

  await page.goto(`${R.url}/?${query}`, { waitUntil: 'load' });
  await phase('leader', 300000);
  await wait(1500);
  await shot('loop-1-leader');

  // 2: the town under the chosen leader
  await tap('.run-full .leader', { ysolt: 'Ysolt', dunstan: 'Dunstan', ilveth: 'Ilveth' }[leader]).catch(() => null);
  await page.evaluate((who) => {
    const box = [...document.querySelectorAll('.run-full .leader')].find((e) => e.textContent.toLowerCase().includes(who));
    box.querySelector('button').click();
  }, leader);
  await phase('city');
  await wait(2500);
  await shot('loop-2-city');
  log(JSON.stringify(await state()));

  // 3 + 4: a named character's petition, and its cost committed
  let first = true;
  const playSeason = async () => {
    const s = await state();
    for (const id of agree) {
      if (!s.hand.some((h) => h.id === id)) continue;
      // (the first one by its name over the map; the rest by the list)
      const viaMarker = first && (await page.evaluate((pid) => !!window.rungame.markers().find((m) => m.id === pid), id));
      if (viaMarker) {
        const m = await page.evaluate((pid) => window.rungame.markers().find((x) => x.id === pid), id);
        await page.mouse.click(m.x, m.y - 10);
      } else await page.evaluate((pid) => window.rungame.open(pid), id);
      await phase('petition', 10000);
      await wait(1600);
      if (first) await shot('loop-3-petition');
      const can = await page.evaluate(() => !document.querySelector('.run-sheet .go button').disabled);
      await tap('.run-sheet .go button', can ? 'Agree' : 'Not now');
      await phase('city|mutation', 10000);
      await phase('city', 30000);
      await wait(1200);
      if (first) await shot('loop-4-allocated');
      first = false;
    }
  };
  await playSeason();

  // 6: the threat, visible from the first season with its countdown
  await page.evaluate(() => window.rungame.open('raiders'));
  await phase('petition', 10000);
  await wait(1600);
  await shot('loop-6-threat');
  await tap('.run-sheet .go button', 'Not now');
  await phase('city');

  // 5: seasons pass until the attack (or the end)
  let n = 0;
  let mut = 0;
  for (;;) {
    await wait(600);
    await tap('.run-sheet .go button', 'Next season');
    await phase('season', 10000);
    await wait(n === 0 ? 9000 : 3000);
    if (n === 0) await shot('loop-5-season');
    else await shot(`loop-5-season${n + 1}`);
    n++;
    // (the rest of the time-lapse, then any reveal)
    for (;;) {
      await phase('city|attack|result|end|mutation', 120000);
      const s = await state();
      if (s.phase !== 'mutation') break;
      await wait(2800);
      await shot(mut === 0 ? 'loop-8-mutation' : `loop-8-mutation${mut + 1}`);
      mut++;
      await page.waitForFunction(() => window.rungame.phase !== 'mutation', { timeout: 60000, polling: 200 });
    }
    const s = await state();
    log(JSON.stringify(s));
    if (s.phase !== 'city') break;
    await playSeason();
    if (n > 8) throw new Error('the attack never came');
  }

  // 7: the attack
  if (['attack', 'result'].includes((await state()).phase)) {
    await page.waitForFunction(() => !!window.rungame.fightLine || window.rungame.phase === 'result', { timeout: 60000, polling: 200 });
    await wait(6000);
    await shot('loop-7-attack');
    // (a spell if one is unlocked: tap it, then the middle of the map)
    const spell = await page.evaluate(() => window.rungame.run.spells[0] ?? null);
    if (spell) {
      await tap('.run-sheet .go button', 'Heat ray');
      await wait(300);
      await page.mouse.click(206, 360);
      await wait(1500);
      await shot('loop-7-attack-spell');
    }
    for (let k = 0; k < 6; k++) {
      const done = await page.evaluate(() => window.rungame.phase !== 'attack');
      if (done) break;
      await wait(20000);
      await shot(`loop-7-attack-${k + 2}`);
    }
    await phase('result', 200000);
    await wait(800);
    await shot('loop-7-result');
    log(`war: ${JSON.stringify(await page.evaluate(() => window.rungame.resultLines))}`);
    await tap('.run-sheet .go button', 'Continue');
    for (;;) {
      await phase('end|mutation', 60000);
      if ((await state()).phase !== 'mutation') break;
      await wait(2800);
      await shot(mut === 0 ? 'loop-8-mutation' : `loop-8-mutation${mut + 1}`);
      mut++;
      await page.waitForFunction(() => window.rungame.phase !== 'mutation', { timeout: 60000, polling: 200 });
    }
  }
  await phase('end', 60000);
  await wait(800);
  await shot('loop-8-end');
  log(JSON.stringify(await state()));
  // (jump to a change in the town from the list, if there is one)
  const show = await page.evaluate(() => !!document.querySelector('.run-full button.small'));
  if (show) {
    await tap('.run-full button.small', 'Show');
    await wait(2500);
    await shot('loop-8-end-show');
    await tap('.run-sheet .go button', 'Back to the list');
  }
  // a new run in the same world: the leader screen remembers, the town still carries the tags
  await tap('.run-full button.big', 'Start a new run');
  await phase('leader', 10000);
  await wait(500);
  await shot('loop-8-newrun-leader');
  await page.evaluate(() => [...document.querySelectorAll('.run-full .leader')].find((e) => e.textContent.includes('Dunstan')).querySelector('button').click());
  await phase('city', 10000);
  await wait(2500);
  await shot('loop-8-newrun-city');
  log(JSON.stringify(await state()));
  // the saved world: the store holds the record
  log(`saved: ${JSON.stringify(await page.evaluate(() => ({ world: !!window.reclaimed.stream?.store?.has('loop:world'), mutators: !!window.reclaimed.stream?.store?.has('loop:mutators') })))}`);
});
