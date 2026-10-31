// Round 120 (runsit): a situation run played through headless, as the deployed page runs it (the atlas level, every
// system, 1x): ?skipmenu=1&level=atlas&runplan=<hero>. The hero is driven through the real controls (Controls.script
// for the stick and buttons, Controls.inject for taps and swipes) by an autopilot that steers at what the area points
// at (AreaPlay.goal: the way on, the hall, the trader; in the town the nearest of the dead, or the refuge with people
// following). The ways on are picked for the outcome asked for:
//   --want saved      warn the town and hold it (fight)
//   --want burned     ride for the hold's levy (late), then stand aside in the town: the dead fire it
//   --want evacuated  warn the town and lead its people into the hills (Follow me, then the refuge)
// Screenshots of each card, area and the map; a GIF of the finale; the run's logs; the frame time while the horde and
// the fire are live (perf overlay's fps, the session's main-thread cost).
//
//   node scripts/runsit.mjs [--hero hoverbike|lich] [--want saved|burned|evacuated] [--out C:/Projects/shots88/runsit]
//                           [--size 412x915] [--settle 30000] [--gm 0] [--gif 1]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const hero = arg('hero', 'hoverbike');
const want = arg('want', 'saved');

await run({ name: `runsit-${hero}-${want}`, kind: 'behaviour', size: arg('size', '412x915') }, async (R) => {
  const dir = R.opt('out', 'C:/Projects/shots88/runsit');
  fs.mkdirSync(dir, { recursive: true });
  const tag = `${hero}-${want}`;
  const settle = Number(R.opt('settle', 30000));
  const p = await R.level({ level: 'atlas', runplan: hero, perf: 1, ...(R.opt('gm', '1') === '0' ? { runsitgm: 0 } : {}) });
  await p.waitForFunction(() => window.reclaimed?.runsit && window.reclaimed.runhero?.hero, { timeout: 180000, polling: 250 });
  R.log(`run up; settling ${settle / 1000} s (a first load's terrain)`);
  await sleep(settle);
  await R.fatal(p);
  const shot = async (name) => {
    const f = path.join(dir, `${tag}-${name}.png`);
    await p.screenshot({ path: f });
    R.log(`saved ${f}`);
  };
  const state = () =>
    p.evaluate(() => {
      const L = window.reclaimed.runsit;
      const r = L.run;
      const A = L.area;
      return {
        sit: r.sit.id,
        by: L.by,
        at: r.at,
        phase: r.phase,
        clock: +r.clock.toFixed(2),
        playing: L.playing,
        journey: !!L.journey,
        jphase: L.jstate?.phase ?? null,
        offers: r.offers,
        options: r.phase === 'edge' && !r.offers.length ? r.options().map((o) => ({ id: o.choice.id, to: o.to.id, kinds: o.choice.effects.map((e) => e.kind), toPlay: o.to.play.kind, note: o.note })) : [],
        end: r.end,
        record: L.record ? { end: L.record.end, events: L.record.events.length, deeds: L.record.deeds } : null,
        area: A ? { kind: A.area.play.kind, t: +A.t.toFixed(1), done: A.done, fires: A.rules?.fires ?? null, town: !!A.town } : null,
      };
    });
  // the autopilot: one step (~6 a second while an area plays)
  const pilot = (mode) =>
    p.evaluate((mode) => {
      const R = window.reclaimed;
      const S = R.runhero;
      const A = R.runsit.area;
      const C = S.controls;
      if (!A || A.done) {
        C.script = { stick: [0, 0], buttons: [false] };
        return null;
      }
      const H = S.hero;
      const at = H.position();
      const town = A.area.play.kind === 'town';
      let tgt = A.goal;
      let slow = 1;
      let fight = false;
      if (town) {
        if (mode === 'burned') {
          // stand aside: away from the town's middle, still
          C.script = { stick: [0, 0], buttons: [false] };
          return `standing aside; fires ${A.rules?.fires}`;
        }
        if (mode === 'evacuated' && A.refuge) {
          const F = A.d.followers.members();
          window.__asked = window.__asked ?? 0;
          if (F.length < 4 && window.__asked < 12) {
            // to the nearest townsman not following, and tell them
            const sid = A.area.settlement;
            const folk = A.d.townsfolk(sid).map((id) => A.d.units.get(id)).filter((u) => u && !F.some((f) => f.unit.id === u.id));
            folk.sort((a, b) => Math.hypot(a.at[0] - at[0], a.at[1] - at[1]) - Math.hypot(b.at[0] - at[0], b.at[1] - at[1]));
            const u = folk[0];
            if (u) {
              tgt = [u.at[0], u.at[1]];
              if (Math.hypot(tgt[0] - at[0], tgt[1] - at[1]) < 14) {
                const n = A.orderFollow();
                window.__asked++;
                return `follow me: ${n}`;
              }
            }
          } else {
            tgt = A.refuge;
            // (not too far ahead of them: they walk)
            const cx = F.reduce((s, f) => s + f.unit.at[0], 0) / Math.max(1, F.length);
            const cy = F.reduce((s, f) => s + f.unit.at[1], 0) / Math.max(1, F.length);
            const ahead = Math.hypot(cx - at[0], cy - at[1]);
            slow = ahead > 10 ? 0 : 0.25;
          }
        } else fight = true;
      }
      if (!tgt) {
        C.script = { stick: [0, 0], buttons: [false] };
        return 'no goal';
      }
      const cam = R.camera;
      const a = cam.project(at[0], at[1], at[2]);
      const b = cam.project(tgt[0], tgt[1], S.world.top(tgt[0], tgt[1]));
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      const dist = Math.hypot(tgt[0] - at[0], tgt[1] - at[1]);
      window.__pilotN = (window.__pilotN ?? 0) + 1;
      const n = window.__pilotN;
      if (H.role === 'lich') {
        let g = b;
        if (Math.hypot(g[0] - a[0], g[1] - a[1]) < 45 && dist > 3) {
          const q = [tgt[0] + ((tgt[0] - at[0]) / (dist || 1)) * 4, tgt[1] + ((tgt[1] - at[1]) / (dist || 1)) * 4];
          g = cam.project(q[0], q[1], S.world.floor(q[0], q[1]));
        }
        const gx = g[0] - a[0];
        const gy = g[1] - a[1];
        const gl = Math.hypot(gx, gy) || 1;
        if (slow > 0 && n % 3 === 0) C.inject({ kind: 'tap', at: dist < 12 ? g : [a[0] + (gx / gl) * Math.min(gl, 140), a[1] + (gy / gl) * Math.min(gl, 140)] });
        const slam = fight && dist < 4;
        C.script = { stick: [0, 0], buttons: [slam && n % 2 === 0] };
        return `lich ${A.area.play.kind} ${dist.toFixed(1)}${slam ? ' slam' : ''}`;
      }
      const m = slow * (fight && dist < 12 ? 0.5 : 1);
      C.script = { stick: [(dx / l) * m, (dy / l) * m], buttons: [dist > 40 && !fight && slow === 1] };
      if (fight && dist < 6 && n % 2 === 0) C.inject({ kind: 'flick', from: [b[0] - 30, b[1]], to: [b[0] + 30, b[1]], dir: [1, 0], speed: 2200 });
      return `bike ${A.area.play.kind} ${dist.toFixed(0)}`;
    }, mode);
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
    const f = path.join(dir, `${tag}-${name}.gif`);
    fs.writeFileSync(f, enc.bytes());
    R.log(`saved ${f}`);
  };
  // which way on, for the outcome asked for
  const pick = (opts) => {
    const toTown = opts.filter((o) => o.toPlay === 'town');
    if (want === 'burned') return opts.find((o) => o.toPlay === 'deliver') ?? toTown.find((o) => !o.kinds.includes('evacuate')) ?? opts[0];
    if (want === 'evacuated') return toTown.find((o) => o.kinds.includes('evacuate')) ?? opts.find((o) => o.toPlay === 'ambush') ?? opts.find((o) => o.toPlay !== 'deliver') ?? opts[0];
    return toTown.find((o) => !o.kinds.includes('evacuate') && o.kinds.includes('warn')) ?? opts.find((o) => o.toPlay === 'ambush') ?? opts.find((o) => o.toPlay !== 'deliver') ?? opts[0];
  };

  const t0 = Date.now();
  let k = 0;
  const frames = [];
  let s = await state();
  R.log(`situation ${s.sit} (${s.by})`);
  await shot('0-premise');
  while (!s.record && Date.now() - t0 < 1500000) {
    if (s.phase === 'area' && !s.playing && !s.journey) {
      k++;
      await p.evaluate(() => void window.reclaimed.runsit.playArea());
      await sleep(600);
      s = await state();
      R.log(`area ${k} ${s.at}: ${JSON.stringify(s.area)}`);
      const finale = s.area?.kind === 'town';
      let shotPlay = false;
      let lastLog = 0;
      let gifDone = false;
      const tA = Date.now();
      while ((await state()).playing && Date.now() - tA < 600000) {
        const r = await pilot(want);
        const st = await state();
        if (!shotPlay && st.area && st.area.t > 8) {
          shotPlay = true;
          await shot(`${k}-${st.area.kind}`);
        }
        if (finale && !gifDone && st.area?.town && st.area.t > 15) {
          gifDone = true;
          if (R.opt('gif', '1') === '1') await gif('finale', 40, 300, () => pilot(want));
        }
        if (finale && st.area?.town && !frames.length) {
          frames.push(1);
          // (every frame's time from here: the horde, the fires, the town's people all live)
          await p.evaluate(() => {
            window.__ft = [];
            window.__gpu = [];
            const tick = () => {
              window.__ft.push(performance.now());
              const g = window.reclaimed.core.host.profiler?.gpuFrameMs;
              if (g) window.__gpu.push(g);
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
        }
        if (Date.now() - lastLog > 5000) {
          lastLog = Date.now();
          R.log(`  ${r} · ${JSON.stringify(st.area)}`);
        }
        await sleep(160);
      }
      s = await state();
      await shot(`${k}-done`);
      continue;
    }
    if (s.phase === 'edge' && !s.journey) {
      if (s.offers.length) {
        R.log(`offers ${s.offers.join(', ')}: taking ${s.offers[0]}`);
        await p.evaluate((id) => window.reclaimed.runsit.take(id), s.offers[0]);
        s = await state();
        continue;
      }
      await shot(`${k}-edge`);
      const o = pick(s.options);
      R.log(`ways on: ${s.options.map((x) => `${x.id} (${x.note})`).join(' | ')} → ${o.id}`);
      await p.evaluate((id) => window.reclaimed.runsit.choose(id), o.id);
      let shotMap = false;
      for (;;) {
        await sleep(400);
        const t = await state();
        if (t.journey && !shotMap && t.jphase === 'moving') {
          shotMap = true;
          await sleep(1500);
          await shot(`${k}-map`);
        }
        if (!t.journey) break;
      }
      await sleep(4000);
    }
    s = await state();
    if (s.phase === 'ended' && !s.record) await sleep(500);
  }
  s = await state();
  await sleep(8000);
  await shot('9-end');
  const logs = await p.evaluate(() => ({ run: window.reclaimed.runsit.log, cpu: (() => { const s = window.reclaimed.runhero?.stats; return s ? { frames: s.frames, msMean: +(s.ms / Math.max(1, s.frames)).toFixed(3), msMax: +s.max.toFixed(2) } : null; })() }));
  for (const l of logs.run) R.log(`run: ${l}`);
  const ft = await p.evaluate(() => {
    const t = window.__ft ?? [];
    const d = [];
    for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
    const f = [...d].sort((a, b) => a - b);
    const q = (x) => (f.length ? +f[Math.min(f.length - 1, Math.floor(x * f.length))].toFixed(1) : null);
    const g = window.__gpu ?? [];
    return { frames: d.length, fps: d.length ? +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1) : null, p50: q(0.5), p95: q(0.95), worst: f.length ? +f[f.length - 1].toFixed(0) : null, gpuMean: g.length ? +(g.reduce((a, b) => a + b, 0) / g.length).toFixed(2) : null };
  });
  R.log(`finale frames (horde + fire live): ${JSON.stringify(ft)}; the hero's main-thread cost ${JSON.stringify(logs.cpu)}`);
  R.check('the run ended with an end card', !!s.record, s.record);
  R.check(`it ended ${want}`, s.end === want, { end: s.end });
  await R.fatal(p);
});
