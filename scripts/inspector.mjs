// merge124: the world inspector (cardlab.html) headless — the living engine on Briar Hollow: a card committed, turns
// advanced, the one oppcheck clean on every deal; shots at the phone size.
//   node scripts/inspector.mjs [--out C:/Projects/shots88/merge124] [--size 412x915]
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'inspector', kind: 'behaviour', size: '412x915' }, async (R) => {
  const dir = R.opt('out', 'C:/Projects/shots88/merge124');
  fs.mkdirSync(dir, { recursive: true });
  const p = await R.page();
  await p.goto(`${R.url}/cardlab.html`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.inspector || document.querySelector('.fatal'), { timeout: 30000 });
  await R.fatal(p);
  const shot = async (name, full = false) => {
    const f = path.join(dir, `inspector-${name}.png`);
    await p.screenshot({ path: f, fullPage: full });
    R.log(`saved ${f}`);
  };
  await sleep(500);
  await shot('0-start');
  const state = () => p.evaluate(() => ({ problems: document.getElementById('problems')?.textContent ?? '', turn: window.inspector().turn, offered: window.inspector().offers.filter((o) => o.status === 'offered').length, presented: window.inspector().offers.every((o) => o.opp.pitch.startsWith(window.inspector().w.name(o.presenter))) }));
  let s = await state();
  R.check('dealt with no problems, every card presented by a named person', !s.problems && s.offered > 0 && s.presented, s);
  // (the page's own buttons: a card's Commit, then Next turn)
  const click = (label) => p.evaluate((label) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent === label && !x.disabled);
    b?.click();
    return !!b;
  }, label);
  for (let t = 0; t < 4; t++) {
    const did = await click('Commit');
    await sleep(200);
    await click('Next turn');
    await sleep(300);
    s = await state();
    R.check(`turn ${s.turn}${did ? ' (a card committed before it)' : ''}: the one oppcheck clean`, !s.problems, s);
  }
  await shot('1-later');
  await shot('2-full', true);
  await R.fatal(p);
});
