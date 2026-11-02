// (dialog2) The petition dialogs in the living run, headless, as the deployed page runs it (the atlas level, every
// system, 1x): ?skipmenu=1&level=atlas&run=opps. Phone size 412x915. What it does and shoots:
//   1  the forced outriders: their presenter's petition opens by itself (greeting, ask, the summary panel)
//   2  "What's in it for me?" answered in their voice
//   3  the first edge's map; the muster's petition; asking for more, and their answer (a GIF of the talk typing)
//   4  the hold's edge: the harvest's petition, "What if I say no?", "No." and the signal said back
//   5  the watchtower's petition agreed: their thanks and the signal; the crew running on the map
// The areas between are resolved by the run's own calls (play, areaDone): this checks the talk, not the riding.
//
//   node scripts/dialog.mjs [--out C:/Projects/shots88/dialog2] [--settle 30000]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'dialog2-petitions', kind: 'behaviour', size: '412x915' }, async (R) => {
  const dir = R.opt('out', 'C:/Projects/shots88/dialog2');
  fs.mkdirSync(dir, { recursive: true });
  const settle = Number(R.opt('settle', 30000));
  const p = await R.level({ level: 'atlas', run: 'opps', hero: 'hoverbike', tod: '0.35' });
  await p.waitForFunction(() => (window.reclaimed?.opps && window.reclaimed.runhero?.hero) || document.querySelector('.fatal'), { timeout: 180000, polling: 250 });
  await R.fatal(p);
  const shot = async (name) => {
    const f = path.join(dir, `${name}.png`);
    await p.screenshot({ path: f });
    R.log(`saved ${f}`);
  };
  const gif = async (name, frames, every, during) => {
    const enc = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      if (during) await during(i);
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 128);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
      await sleep(every);
    }
    enc.finish();
    const f = path.join(dir, `${name}.gif`);
    fs.writeFileSync(f, enc.bytes());
    R.log(`saved ${f}`);
  };
  /** the talk as shown: who, the line, the aside, the panel, the answers */
  const talk = () =>
    p.evaluate(() => {
      const L = window.reclaimed.opps;
      const q = (s) => document.querySelector(`.dlg.petition ${s}`);
      return {
        open: L.talk.isOpen,
        name: q('.dlg-name')?.textContent ?? '',
        title: q('.dlg-title')?.textContent ?? '',
        portrait: !!q('.dlg-portrait')?.style.backgroundImage,
        aside: q('.dlg-aside')?.textContent ?? '',
        text: q('.dlg-text')?.textContent ?? '',
        facts: [...document.querySelectorAll('.dlg.petition .dlg-fact')].map((r) => r.textContent),
        choices: [...document.querySelectorAll('.dlg.petition .dlg-choice')].map((b) => b.querySelector('.dlg-say').textContent),
      };
    });
  /** the line typed out (a tap shows it all), then the answers */
  const typed = async () => {
    // (a tap on a line still typing shows it all; on a finished line with no answers it would close the talk: wait)
    await sleep(3500);
  };
  const answer = async (text) => {
    const ok = await p.evaluate((t) => {
      const b = [...document.querySelectorAll('.dlg.petition .dlg-choice')].find((x) => x.querySelector('.dlg-say').textContent.startsWith(t));
      if (!b) return false;
      b.click();
      return true;
    }, text);
    R.check(`the answer "${text}" is offered`, ok, await talk());
    await sleep(300);
  };
  const offerOf = (template) => p.evaluate((t) => window.reclaimed.opps.opps.offered.find((o) => o.template === t)?.id ?? null, template);

  // the roster, the intro, then play: the forced outriders' petition opens by itself
  await p.evaluate(() => window.reclaimed.opps.pickHero('hoverbike'));
  await sleep(1500);
  await shot('0-intro');
  await p.evaluate(() => {
    const L = window.reclaimed.opps;
    L.stage = 'play';
    L.render();
  });
  R.log(`settling ${settle / 1000} s`);
  await sleep(settle);
  await R.fatal(p);
  await typed();
  let t = await talk();
  R.log(`outriders: ${JSON.stringify(t)}`);
  R.check('the forced card opens as a talk with its presenter, a portrait and the summary panel', t.open && t.name.length > 0 && t.portrait && t.facts.length === 4, t);
  R.check('the forced card cannot be refused', !t.choices.some((c) => c === 'No.' || c === 'Not now.'), t.choices);
  await shot('1-outriders-petition');
  await answer("What's in it for me?");
  await typed();
  await shot('2-outriders-gain');
  // (the script answers by closing; the run's own calls play the area)
  await p.evaluate(() => {
    const L = window.reclaimed.opps;
    L.talk.close();
    const O = L.opps;
    O.play(O.offered.find((o) => o.forced).id);
    O.areaDone({ seconds: 150, won: true, pursuers: 1 });
    L.selected = null;
    L.render();
  });
  await sleep(2500);
  await shot('3-edge-map');

  // the muster: ask for more
  const muster = await offerOf('muster');
  R.check('the muster is offered at the first edge', !!muster);
  await p.evaluate((id) => void window.reclaimed.opps.petition(id), muster);
  await gif('3-muster-talk', 14, 220, async (i) => {
    if (i === 8) await p.evaluate(() => document.querySelector('.dlg.petition .dlg-text')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  });
  await typed();
  t = await talk();
  R.log(`muster: ${JSON.stringify(t)}`);
  R.check('the muster can be haggled', t.choices.includes('Can you give a little more?'), t.choices);
  await shot('3-muster-petition');
  await answer('Can you give a little more?');
  await sleep(800);
  await typed();
  t = await talk();
  R.log(`haggle: ${JSON.stringify(t)}`);
  R.check('the talk opens again at their answer', t.open && t.choices.length > 0, t);
  await shot('3-muster-haggle');
  await p.evaluate(() => {
    const L = window.reclaimed.opps;
    L.talk.close();
  });
  await sleep(300);
  await p.evaluate((id) => {
    const L = window.reclaimed.opps;
    const O = L.opps;
    O.play(id);
    O.arrive();
    O.areaDone({ seconds: 170, won: true });
    L.selected = null;
    L.render();
  }, muster);
  await sleep(2500);
  await shot('4-hold-edge-map');

  // the harvest: what if I say no, then no
  const harvest = await offerOf('harvest');
  R.check('the harvest is offered at the hold', !!harvest);
  await p.evaluate((id) => void window.reclaimed.opps.petition(id), harvest);
  await typed();
  t = await talk();
  R.log(`harvest: ${JSON.stringify(t)}`);
  await shot('4-harvest-petition');
  await answer('What if I say no?');
  await typed();
  await shot('4-harvest-ifno');
  await answer('No.');
  await typed();
  t = await talk();
  R.log(`refused: ${JSON.stringify(t)}`);
  R.check('saying no: their reaction and the signal', t.facts.some((f) => /hold it against you/.test(f)), t);
  await shot('4-harvest-refused');
  await p.evaluate(() => window.reclaimed.opps.talk.close());
  await sleep(1200);
  const rot = await p.evaluate(() => window.reclaimed.opps.opps.harvest);
  R.check('refused, the grain rots now', rot === 'rotted', rot);

  // the watchtower: agreed
  const tower = await offerOf('watchtower');
  if (tower) {
    await p.evaluate((id) => void window.reclaimed.opps.petition(id), tower);
    await typed();
    await shot('5-watchtower-petition');
    t = await talk();
    await answer(t.choices[0]);
    await typed();
    t = await talk();
    R.log(`agreed: ${JSON.stringify(t)}`);
    R.check('agreeing: their thanks and the signal', t.facts.some((f) => /owe you a favour/.test(f)), t);
    await shot('5-watchtower-thanks');
    await p.evaluate(() => window.reclaimed.opps.talk.close());
    await sleep(2000);
    const running = await p.evaluate(() => window.reclaimed.opps.opps.running().map(({ c, turnsLeft }) => ({ title: c.opp.title, turnsLeft })));
    R.check('the crew is running', running.length > 0, running);
    await shot('5-running-map');
  }
  const logs = await p.evaluate(() => window.reclaimed.runsit.log.slice(-20));
  for (const l of logs) R.log(`log: ${l}`);
});
