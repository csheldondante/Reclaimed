// Round 124 (opportunities): the card lab page (cardlab.html) headless — a few turns played by its own commit and
// next-turn calls, then shots of the world, the board and the simulator's report, at the phone size.
//   node scripts/cardlab.mjs [--out C:/Projects/shots88/opportunities/cardlab] [--size 412x785]
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'cardlab', kind: 'behaviour', size: '412x785' }, async (R) => {
  const dir = R.opt('out', 'C:/Projects/shots88/opportunities/cardlab');
  fs.mkdirSync(dir, { recursive: true });
  const p = await R.page();
  await p.goto(`${R.url}/cardlab.html?deck=1&seed=1`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.cardlab || document.querySelector('.fatal'), { timeout: 30000 });
  await R.fatal(p);
  const shot = async (name, full = false) => {
    const f = path.join(dir, `${name}.png`);
    await p.screenshot({ path: f, fullPage: full });
    R.log(`saved ${f}`);
  };
  await sleep(500);
  await shot('0-start');
  // a few turns: commit what the dealer ranks first (forced first), the next turn
  const turn = () => p.evaluate(() => {
    const L = window.cardlab;
    const r = L.run;
    const can = r.affordable();
    const c = can.find((x) => x.forced) ?? can[0];
    if (c) r.commit(c.id);
    const more = r.affordable().find((x) => !x.requires.some((q) => q.kind === 'player'));
    if (more) r.commit(more.id);
    r.nextTurn();
    L.render();
    return { turn: r.turn, doom: r.doom, end: r.end, offered: r.offered.length, can: r.affordable().length, built: r.holdings.buildings.length, world: r.world.history().length };
  });
  for (let i = 0; i < 6; i++) R.log(`turn: ${JSON.stringify(await turn())}`);
  await shot('1-turn6');
  await shot('1-turn6-full', true);
  for (let i = 0; i < 6; i++) R.log(`turn: ${JSON.stringify(await turn())}`);
  await shot('2-turn12-full', true);
  // (round 124, RN3) EV on the cards, a place tapped (its cards under the world), the bots on eight kingdoms
  await p.evaluate(() => {
    const L = window.cardlab;
    L.ev(true);
    const busy = L.run.offered[0];
    if (busy) L.focus(L.run.card(busy.template).place);
    L.render();
  });
  await sleep(400);
  await shot('2b-place-tapped-ev');
  const tour = await p.evaluate(() => {
    const L = window.cardlab;
    const t = L.tournament(8);
    for (const d of document.querySelectorAll('details')) if (/^(The simulator|Lab tools)/.test(d.querySelector('summary').textContent)) d.open = true;
    L.render();
    for (const d of document.querySelectorAll('details')) if (/^(The simulator|Lab tools)/.test(d.querySelector('summary').textContent)) (d.open = true), d.scrollIntoView();
    return t.map((r) => `${r.kingdom}: ${r.results.map((x) => `${x.policy} ${Math.round(x.winRate * 100)}%/${x.meanScore}`).join(' ')} -> ${r.viable.join(',')}`);
  });
  for (const l of tour) R.log(`bots: ${l}`);
  await sleep(300);
  await shot('4-bots-x-kingdoms');
  const s = await p.evaluate(() => {
    const L = window.cardlab;
    const r = L.simulate(200, 'random');
    for (const d of document.querySelectorAll('details')) d.open = /^(The simulator|Lab tools)/.test(d.querySelector('summary').textContent) || d.open;
    L.render();
    for (const d of document.querySelectorAll('details')) if (/^(The simulator|Lab tools)/.test(d.querySelector('summary').textContent)) (d.open = true), d.scrollIntoView();
    return { win: r.winRate, turns: r.meanTurns, choices: r.meanChoices, never: r.never, always: r.always, relics: r.relics, world: r.world, ms: r.ms };
  });
  R.log(`simulator (random, 200): ${JSON.stringify(s)}`);
  await sleep(300);
  await shot('3-simulator');
  R.check('the card lab plays: several on the board, the world changed, the simulator reported', s.choices > 1 && s.world.meanEvents > 0, s);
  await R.fatal(p);
});
