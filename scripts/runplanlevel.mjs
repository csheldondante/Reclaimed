// (round 117, runplan; RP5) A planned run in the level, as a player plays it: ?level=atlas&runplan=<hero> at the phone
// proxy's size — the stage card, a stage's outcome picked, a leg travelled on the atlas map (GIF) while the streamer
// makes the destination's land, the warp on arrival, the land there looked at. Every system in play, 1x speed.
//   node scripts/runplanlevel.mjs [--hero bike] [--out C:/Projects/shots88/runplan]
import fs from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, log, sleep } from './lib/runner.mjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'runplanlevel', kind: 'behaviour' }, async (R) => {
  const hero = R.opt('hero', 'bike');
  const out = R.opt('out', 'C:/Projects/shots88/runplan');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.level({ level: 'atlas', runplan: hero }, { dpr: Number(R.opt('dpr', '1')) });
  await p.waitForFunction(() => window.reclaimed?.runplan?.plan, { timeout: 60000, polling: 250 });
  // (the first load after a start is slow: judge the land after 30 s)
  await sleep(30000);
  await R.fatal(p);
  await p.screenshot({ path: path.join(out, `level-${hero}-1-start.png`) });
  const plan = await p.evaluate(() => ({ log: window.reclaimed.runplan.log, stages: window.reclaimed.runplan.plan.stages.map((s) => s.name) }));
  console.log(JSON.stringify(plan));
  await p.evaluate(() => {
    const r = window.reclaimed.runplan;
    r.choose(r.plan.stages[0].outcomes[0].id);
  });
  await sleep(300);
  await p.screenshot({ path: path.join(out, `level-${hero}-2-legs.png`) });
  const t0 = Date.now();
  await p.evaluate(() => {
    const r = window.reclaimed.runplan;
    // (the leg out with the most on the road: the events are what's looked at)
    const legs = r.plan.stages[0].next.map((id) => r.plan.legs.find((l) => l.id === id));
    legs.sort((a, b) => b.events.length - a.events.length);
    r.travel(legs[0].id);
  });
  const enc = GIFEncoder();
  let shotEvent = false;
  let arrived = false;
  for (let i = 0; i < 160; i++) {
    const st = await p.evaluate(() => ({ phase: window.reclaimed.runplan.jstate?.phase ?? null, travelling: !!window.reclaimed.runplan.journey }));
    if (i === 12) await p.screenshot({ path: path.join(out, `level-${hero}-3-travel.png`) });
    if (i % 2 === 0) {
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 300 });
    }
    if (st.phase === 'event') {
      if (!shotEvent) await p.screenshot({ path: path.join(out, `level-${hero}-3-event.png`) });
      shotEvent = true;
      await sleep(800);
      await p.evaluate(() => window.reclaimed.runplan.answer(false));
    }
    if (!st.travelling) {
      arrived = true;
      break;
    }
    await sleep(150);
  }
  enc.finish();
  fs.writeFileSync(path.join(out, `level-${hero}-travel.gif`), enc.bytes());
  const after = await p.evaluate(() => ({ at: window.reclaimed.runplan.at, log: window.reclaimed.runplan.log.slice(-3) }));
  R.check('arrived and warped', arrived && after.at !== 'st0', { wallS: (Date.now() - t0) / 1000, ...after });
  await sleep(8000);
  await R.fatal(p);
  await p.screenshot({ path: path.join(out, `level-${hero}-4-arrived.png`) });
  log('done');
});
