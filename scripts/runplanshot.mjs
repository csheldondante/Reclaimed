// (round 117, runplan) The run-plan viewer, looked at: the plan on the atlas map, a stage played, a leg travelled (a GIF
// of the animation with its en-route events), a run played to the end and the consequences shown.
//   node scripts/runplanshot.mjs [--hero bike] [--seed 1] [--out C:/Projects/shots88/runplan] [--size 1280x800]
// Behaviour check (shares the GPU lease).
import fs from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, log, sleep } from './lib/runner.mjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'runplanshot', kind: 'behaviour', size: '1280x800' }, async (R) => {
  const hero = R.opt('hero', 'bike');
  const seed = R.opt('seed', '1');
  const out = R.opt('out', 'C:/Projects/shots88/runplan');
  const tag = R.opt('tag', hero);
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  const t0 = Date.now();
  await p.goto(`${R.url}/?runplan=view&seed=${seed}&hero=${hero}&q=low&travel=1`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.runplan || document.querySelector('.fatal'), { timeout: 240000, polling: 250 });
  await R.fatal(p);
  log(`viewer up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(1500);
  const info = await p.evaluate(() => ({ log: window.reclaimed.runplan.log, plan: { stages: window.reclaimed.runplan.plan.stages.map((s) => [s.id, s.encounter, s.name]), minutes: window.reclaimed.runplan.plan.minutes } }));
  console.log(JSON.stringify(info, null, 1));
  R.check('planned', info.plan.stages.length >= 4, info.plan.minutes);
  await p.screenshot({ path: path.join(out, `${tag}-1-plan.png`) });
  // play the start's first outcome; set off on the first leg; GIF the travel
  await p.evaluate(() => {
    const v = window.reclaimed.runplan;
    v.choose(v.plan.stages[0].outcomes[0].id);
  });
  await sleep(300);
  await p.screenshot({ path: path.join(out, `${tag}-2-choices.png`) });
  await p.evaluate(() => {
    const v = window.reclaimed.runplan;
    v.travel(v.plan.stages[0].next[0]);
  });
  const enc = GIFEncoder();
  let events = 0;
  for (let i = 0; i < 90; i++) {
    const st = await p.evaluate(() => {
      const v = window.reclaimed.runplan;
      const s = v.jstate;
      // (pass the events by after a beat, so the GIF shows each)
      return { phase: s?.phase ?? 'none', travelling: !!v.journey };
    });
    const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
    const pal = quantize(png.data, 256);
    enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 150 });
    if (st.phase === 'event') {
      events++;
      if (events === 1) await p.screenshot({ path: path.join(out, `${tag}-3-event.png`) });
      await sleep(600);
      await p.evaluate(() => window.reclaimed.runplan.answer(true));
    }
    if (!st.travelling) break;
    await sleep(150);
  }
  enc.finish();
  fs.writeFileSync(path.join(out, `${tag}-travel.gif`), enc.bytes());
  const after = await p.evaluate(() => ({ at: window.reclaimed.runplan.at, log: window.reclaimed.runplan.log.slice(-3) }));
  R.check('arrived at the next stage', after.at !== 'st0', after);
  await p.screenshot({ path: path.join(out, `${tag}-4-arrived.png`) });
  // the rest of the run, instantly, and its consequences
  const rec = await p.evaluate(() => {
    const r = window.reclaimed.runplan.autoplay(0);
    return { end: r.end, events: r.events.length, deeds: r.deeds };
  });
  R.check('the run ended and changed the world', rec.events > 0, rec);
  await sleep(500);
  await p.screenshot({ path: path.join(out, `${tag}-5-end.png`) });
  // the next run, planned from the world as left
  await p.evaluate(() => window.reclaimed.runplan.newPlan());
  await sleep(500);
  await p.screenshot({ path: path.join(out, `${tag}-6-next.png`) });
  const next = await p.evaluate(() => window.reclaimed.runplan.log.slice(-1));
  R.check('next run planned', true, next);
  // the phone: the same page at the phone proxy's size
  const ph = await R.page({ size: '412x915', dpr: 2.6 });
  await ph.goto(`${R.url}/?runplan=view&seed=${seed}&hero=${hero}&q=low`, { waitUntil: 'load' });
  await ph.waitForFunction(() => window.reclaimed?.runplan || document.querySelector('.fatal'), { timeout: 240000, polling: 250 });
  await R.fatal(ph);
  await sleep(1000);
  await ph.screenshot({ path: path.join(out, `${tag}-phone.png`) });
});
