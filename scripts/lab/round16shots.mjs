// (loop round 16) The loop at phone size, before and after the round: the run's opening, the town view (the bottom bar,
// the names over the town, the edge markers), a close look at the fields (the quiet world: no pollen, seeds, petals),
// Next season and the news that follows (the messenger, after). Writes <out>/<tag>-*.png and prints what it read.
//   node scripts/lab/round16shots.mjs --tag before|after [--out local/round16] [--leader dunstan] [--packs frontier,ages,arena]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'round16shots', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'local/round16');
  const tag = R.opt('tag', 'after');
  const packs = R.opt('packs', '');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /\[messenger\]|\[quiet\]/.test(t)) R.log(t.slice(0, 300));
  });
  const shot = async (name) => {
    await p.screenshot({ path: path.join(out, `${tag}-${name}.png`) });
    R.log(`shot ${tag}-${name}`);
  };
  const pk = packs ? `&packs=${packs}` : '';
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0${pk}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate((who) => window.rungame.pick(who), R.opt('leader', 'dunstan'));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(1500);
  await shot('open-1');
  await R.sleep(2500);
  await shot('open-2');
  // (the opening dismissed: the panel closed, the messenger skipped)
  await p.evaluate(() => (window.rungame.closePanel(), window.rungame.messenger?.skip()));
  await R.sleep(6000);
  await shot('town');
  const marks = await p.evaluate(() => [...document.querySelectorAll('.run-marks button')].map((b) => ({ t: b.textContent, c: b.className, r: b.getBoundingClientRect().toJSON() })));
  R.log(`markers: ${JSON.stringify(marks.map((m) => [m.t, m.c, Math.round(m.r.x), Math.round(m.r.y)]))}`);
  const sheetH = await p.evaluate(() => {
    const s = document.querySelector('.run-sheet')?.getBoundingClientRect();
    const t = document.querySelector('.run-top')?.getBoundingClientRect();
    return { sheet: s ? Math.round(s.height) : 0, top: t ? Math.round(t.height) : 0, h: innerHeight };
  });
  R.log(`bars: ${JSON.stringify(sheetH)} (town shown on ${(100 * (1 - (sheetH.sheet + sheetH.top) / sheetH.h)).toFixed(0)}% of the screen)`);
  // (overlapping markers: any two whose boxes cross)
  let overlaps = 0;
  for (let i = 0; i < marks.length; i++)
    for (let j = i + 1; j < marks.length; j++) {
      const a = marks[i].r;
      const b = marks[j].r;
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) overlaps++;
    }
  R.log(`marker overlaps: ${overlaps}`);
  const asks = await p.evaluate(() => window.rungame.asking().map((a) => a.id));
  const shown = new Set(marks.map((m) => m.t));
  R.log(`asks ${asks.length}, markers ${marks.length}`);
  // (the full list as an overlay, if there is a button for it)
  const listed = await p.evaluate(() => {
    const b = document.querySelector('.run-sheet button.asks');
    if (!b) return false;
    b.click();
    return true;
  });
  if (listed) {
    await R.sleep(500);
    await shot('list');
    await p.evaluate(() => [...document.querySelectorAll('.run-full button')].find((b) => b.textContent === 'Close')?.click());
  }
  void shown;
  // (closer on the town's middle: the townspeople — three frames half a second apart, to see them move)
  const people = await p.evaluate(() => {
    const L = window.reclaimed.scene.livingTowns;
    const t = window.citygen.live.get(window.season.town);
    const c = t.centreInWindow();
    window.rungame.cam.follow(null);
    window.rungame.cam.look([c[0], c[1], window.reclaimed.scene.heightAt(c[0], c[1]) ?? 0], { zoom: 7, ease: 0.3, place: [0.5, 0.48] });
    const one = L && [...(L.live?.values?.() ?? [])][0];
    return one ? { riders: one.riders ?? null } : null;
  });
  R.log(`living: ${JSON.stringify(people)}`);
  await R.sleep(3000);
  for (let k = 1; k <= 3; k++) {
    await shot(`close-${k}`);
    await R.sleep(500);
  }
  await p.evaluate(() => window.rungame.showTown());
  await R.sleep(2500);
  // (a close look at the fields round the town: pollen, seeds, petals, grow sparkles — or none)
  await p.evaluate(() => {
    const g = window.rungame;
    const t = window.citygen.live.get(window.season.town);
    const c = t.centreInWindow();
    g.cam.follow(null);
    g.cam.look([c[0] + t.box.R * 0.9, c[1] + t.box.R * 0.3, window.reclaimed.scene.heightAt(c[0] + t.box.R * 0.9, c[1] + t.box.R * 0.3) ?? 0], { zoom: 9, ease: 0.3, place: [0.5, 0.45] });
  });
  await R.sleep(5000);
  await shot('fields');
  const parts = await p.evaluate(() => {
    const s = window.reclaimed.sim;
    return { paused: [...(s.paused ?? [])], plants: s.particles?.plants };
  });
  R.log(`sim: ${JSON.stringify(parts)}`);
  await p.evaluate(() => window.rungame.showTown());
  await R.sleep(2500);
  // (Next season: the time-lapse, then the news)
  await p.evaluate(() => window.rungame.next());
  await R.sleep(2500);
  await shot('season');
  await p.waitForFunction(() => window.rungame.phase !== 'season', { timeout: 120000, polling: 200 });
  await R.sleep(800);
  await shot('news-1');
  await R.sleep(2200);
  await shot('news-2');
  await R.sleep(2500);
  await shot('news-3');
  await R.sleep(2000);
  await shot('news-4');
  R.log(`messenger: ${await p.evaluate(() => window.rungame.messenger?.state)}`);
  R.log(`phase ${await p.evaluate(() => window.rungame.phase)}; notes ${JSON.stringify(await p.evaluate(() => window.rungame.notes))}`);
});
