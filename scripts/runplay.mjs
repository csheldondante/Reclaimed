// Round 119 (runplay): a generated run played through headless, as the deployed page runs it (the atlas level, every
// system, 1x): ?skipmenu=1&level=atlas&runplan=<hero>&runminutes=6-12 (a short run). The hero is driven through the real
// controls (Controls.script for the stick and buttons, Controls.inject for taps and swipes) by an autopilot that steers
// at what the stage says is next (StagePlay.objective: the next gate, the quarry, the nearest raider, a standing
// tower) — the bike boosts, hooks the quarry, swipes at raiders beside it; the lich glides by taps and slams. Each
// stage played to its end (won or lost), the first leg out travelled on the atlas map (en-route events passed by),
// to the run's end card. Screenshots of each card and stage, a GIF of the first stage; the run's logs printed.
//
//   node scripts/runplay.mjs [--hero hoverbike|lich] [--out C:/Projects/shots88/runplay] [--size 412x915] [--dpr 1]
//                            [--settle 30000] [--minutes 6-12] [--gif 1]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const [w, h] = arg('size', '412x915').split('x').map(Number);

await run({ name: `runplay-${arg('hero', 'hoverbike')}`, kind: 'behaviour', size: `${w}x${h}`, dpr: Number(arg('dpr', '1')) }, async (R) => {
  const hero = R.opt('hero', 'hoverbike');
  const dir = R.opt('out', 'C:/Projects/shots88/runplay');
  fs.mkdirSync(dir, { recursive: true });
  const settle = Number(R.opt('settle', 30000));
  const p = await R.level({ level: 'atlas', runplan: hero, runminutes: R.opt('minutes', '6-12') });
  await p.waitForFunction(() => window.reclaimed?.runplan && (window.reclaimed.runhero?.hero || !window.reclaimed.runplay), { timeout: 180000, polling: 250 });
  R.log(`run up; settling ${settle / 1000} s (a first load's terrain)`);
  await sleep(settle);
  await R.fatal(p);
  const shot = async (name) => {
    const f = path.join(dir, `${hero}-${name}.png`);
    await p.screenshot({ path: f });
    R.log(`saved ${f}`);
  };
  const state = () =>
    p.evaluate(() => {
      const L = window.reclaimed.runplan;
      const P = window.reclaimed.runplay;
      const st = P?.current;
      return {
        at: L.at,
        playing: L.playing,
        journey: !!L.journey,
        phase: L.jstate?.phase ?? null,
        record: L.record ? { end: L.record.end, events: L.record.events.length, deeds: L.record.deeds } : null,
        done: L.path.at(-1)?.stage === L.at,
        stage: st ? { kind: st.spec.kind, t: +st.t.toFixed(1), status: st.status } : null,
        legs: L.plan.stages.find((s) => s.id === L.at)?.next ?? [],
      };
    });
  // the autopilot: one step (called ~6 times a second while a stage plays)
  const pilot = () =>
    p.evaluate(() => {
      const R = window.reclaimed;
      const S = R.runhero;
      const st = R.runplay?.current;
      const C = S.controls;
      if (!st || st.status.state !== 'playing' || st.t < 0) {
        C.script = { stick: [0, 0], buttons: [false] };
        return null;
      }
      const H = S.hero;
      const at = H.position();
      const tgt = st.objective();
      if (!tgt) {
        C.script = { stick: [0, 0], buttons: [false] };
        return 'no objective';
      }
      const cam = R.camera;
      const z = S.world.top(tgt[0], tgt[1]);
      const a = cam.project(at[0], at[1], at[2]);
      const b = cam.project(tgt[0], tgt[1], z);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      const dist = Math.hypot(tgt[0] - at[0], tgt[1] - at[1]);
      const kind = st.spec.kind;
      window.__pilotN = (window.__pilotN ?? 0) + 1;
      const n = window.__pilotN;
      if (H.role === 'lich') {
        // glide by taps toward it (every other step); over a tower or by raiders, slam (a press: down, then up)
        if (n % 3 === 0) C.inject({ kind: 'tap', at: [a[0] + (dx / l) * Math.min(l, 140), a[1] + (dy / l) * Math.min(l, 140)] });
        const slam = (kind === 'smash' && dist < 2.5) || (kind === 'fight' && dist < 4);
        C.script = { stick: [0, 0], buttons: [slam && n % 2 === 0] };
        return `${kind} ${dist.toFixed(0)}${slam ? ' slam' : ''}`;
      }
      // the bike: the stick at it, boost when far; hook the quarry when in reach; swipe at a raider beside
      C.script = { stick: [dx / l, dy / l], buttons: [dist > 20 && kind !== 'fight'] };
      if (kind === 'chase' && dist < 22 && n % 4 === 0) C.inject({ kind: 'tap', at: b });
      if (kind === 'fight' && dist < 6 && n % 2 === 0) C.inject({ kind: 'flick', from: [b[0] - 30, b[1]], to: [b[0] + 30, b[1]], dir: [1, 0], speed: 2200 });
      return `${kind} ${dist.toFixed(0)}`;
    });
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
    const f = path.join(dir, `${hero}-${name}.gif`);
    fs.writeFileSync(f, enc.bytes());
    R.log(`saved ${f}`);
  };

  const tStart = Date.now();
  let k = 0;
  let s = await state();
  await shot('0-plan');
  while (!s.record && Date.now() - tStart < 900000) {
    if (!s.done && !s.playing && !s.journey) {
      k++;
      await shot(`${k}a-card`);
      await p.evaluate(() => void window.reclaimed.runplan.playStage());
      await sleep(500);
      s = await state();
      R.log(`stage ${k}: ${JSON.stringify(s.stage)}`);
      // a GIF of the first stage's start (the 3-2-1 and the ride off)
      if (k === 1 && R.opt('gif', '1') === '1') await gif('stage1', 24, 250, () => pilot());
      let lastLog = 0;
      while ((await state()).playing) {
        const r = await pilot();
        if (Date.now() - lastLog > 5000) {
          lastLog = Date.now();
          const st = await state();
          R.log(`  ${r} · ${JSON.stringify(st.stage)}`);
          if (st.stage && st.stage.t > 6 && st.stage.t < 8) await shot(`${k}b-play`);
        }
        await sleep(160);
      }
      s = await state();
      await shot(`${k}c-result`);
      continue;
    }
    if (s.done && !s.journey && !s.record) {
      if (!s.legs.length) break;
      R.log(`travel ${s.legs[0]}`);
      await p.evaluate((l) => void window.reclaimed.runplan.travel(l), s.legs[0]);
      let shotMap = false;
      for (;;) {
        await sleep(400);
        const t = await state();
        if (t.phase === 'event') await p.evaluate(() => window.reclaimed.runplan.answer(false));
        if (t.journey && !shotMap && t.phase === 'moving') {
          shotMap = true;
          await sleep(1500);
          await shot(`${k}d-travel`);
        }
        if (!t.journey && !t.playing && (await p.evaluate(() => !window.reclaimed.runplan.asking))) break;
      }
      R.log('arrived');
      await sleep(4000);
    }
    s = await state();
  }
  s = await state();
  await shot('9-end');
  const logs = await p.evaluate(() => ({ run: window.reclaimed.runplan.log, play: window.reclaimed.runplay?.log ?? [], fps: window.reclaimed.perf?.fps ?? null }));
  for (const l of logs.run) R.log(`run: ${l}`);
  for (const l of logs.play) R.log(`play: ${l}`);
  R.check('the run ended with an end card', !!s.record, s.record);
  R.check('every stage was played (not picked)', logs.play.length >= 1 && logs.play.length === k, { stages: k, played: logs.play.length });
  await R.fatal(p);
});
