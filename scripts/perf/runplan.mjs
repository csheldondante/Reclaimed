// (round 117, runplan) The run manager's perf test: < 2 min, alone. In the viewer page (the atlas made for seed 1 on
// the GPU, its facts and wiki read from it): the time to plan a run for every hero (20 plans each, median and worst),
// to play one to the end and apply its consequences, and the frame interval while a leg's travel animates on the map.
// Writes data/perf/runplan-<adapter>.json.
//   node scripts/perf/runplan.mjs [--seed 1] [--size 412x915 --dpr 2.6]
import fs from 'node:fs';
import path from 'node:path';
import { run, log, sleep, ROOT } from '../lib/runner.mjs';

await run({ name: 'perf-runplan', kind: 'timing', size: '412x915', dpr: 2.6 }, async (R) => {
  const seed = R.opt('seed', '1');
  const p = await R.page();
  const t0 = Date.now();
  await p.goto(`${R.url}/?runplan=view&seed=${seed}&hero=bike&q=low`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.runplan || document.querySelector('.fatal'), { timeout: 240000, polling: 100 });
  await R.fatal(p);
  const upMs = Date.now() - t0;
  log(`viewer up in ${(upMs / 1000).toFixed(1)} s`);
  await sleep(1000);
  const res = await p.evaluate(async () => {
    const v = window.reclaimed.runplan;
    const adapter = await navigator.gpu.requestAdapter().then((a) => a?.info ? `${a.info.vendor} ${a.info.architecture} ${a.info.description}`.trim() : 'unknown');
    const heroes = ['bike', 'lich', 'knight', 'wanderer', 'gorilla', 'tank', 'mech'];
    const plans = {};
    for (const h of heroes) {
      const ms = [];
      for (let i = 0; i < 20; i++) {
        const t = performance.now();
        v.setHero(h);
        ms.push(performance.now() - t);
      }
      ms.sort((a, b) => a - b);
      plans[h] = { medianMs: +ms[10].toFixed(2), worstMs: +ms[19].toFixed(2), stages: v.plan.stages.length, legs: v.plan.legs.length, minutes: v.plan.minutes };
    }
    v.setHero('bike');
    const t = performance.now();
    const rec = v.autoplay(0);
    const playMs = performance.now() - t;
    v.newPlan();
    // a leg's travel, the frame interval while the map animates
    v.choose(v.plan.stages[0].outcomes[0].id);
    v.travel(v.plan.stages[0].next[0]);
    const frames = [];
    await new Promise((done) => {
      let last = performance.now();
      const step = (now) => {
        frames.push(now - last);
        last = now;
        if (v.jstate?.phase === 'event') v.answer(false);
        if (v.journey && frames.length < 600) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    // (the first two intervals span the synchronous work before the animation started: not frames)
    frames.splice(0, 2);
    const sorted = [...frames].sort((a, b) => a - b);
    return {
      adapter,
      plans,
      playToEnd: { ms: +playMs.toFixed(2), events: rec.events.length, end: rec.end },
      travel: { slow: frames.map((f, i) => [i, +f.toFixed(1)]).filter(([, f]) => f > 40), frames: frames.length, medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2), p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2), worstMs: +sorted.at(-1).toFixed(2) },
    };
  });
  const out = { when: new Date().toISOString(), seed: Number(seed), size: `${R.W}x${R.H}`, dpr: R.dpr, viewerUpMs: upMs, ...res };
  console.log(JSON.stringify(out, null, 1));
  const name = res.adapter.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'unknown';
  const dir = path.join(ROOT, 'data/perf');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `runplan-${name}.json`), JSON.stringify(out, null, 1));
  R.check('plans under 250 ms (once a run)', Object.values(res.plans).every((x) => x.worstMs < 250), res.plans);
  R.check('travel animates at a frame a vsync or so', res.travel.p95Ms < 40, res.travel);
});
