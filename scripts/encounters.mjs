// Round 126 (`encounters`): one player card of the living-world run played headless, as the deployed page runs it (the
// atlas level, every system, 1x): ?skipmenu=1&level=atlas&run=opps&hero=<hero>. The run is skipped (won) to the first
// edge that offers the card, the card committed from the map like a player would, its leg travelled, and its encounter
// played by an autopilot through the real controls:
//   --mode win    fight: at the nearest foe, swinging (the bike's slash and lance, the lich's float, fling and slam);
//                 flee: away from the pursuers; chase: at the quarry; escort: the people told to follow, then away;
//                 scene: the dialog answered with --answer (fight | yield | bargain), then the encounter it leads to
//   --mode lose   the hero idles where it stands (stick still, no blows): every encounter must have a way to lose
// Each quarter second it samples what is on screen round the hero: the hostiles within 20 / 40 cells, the nearest, how
// many are chasing or swinging at it, its health, whether a goal flag is drawn, the banner. The report says, for the
// card: when the first foe came within 20 cells, whether they engaged (chase/swing, the hero hurt), the closest they
// came, the result tier, and whether a flag was the objective. Shots at 4 s, at the first engagement and the end;
// --gif 1 a GIF of the engagement.
//
//   node scripts/encounters.mjs --card outriders|ride|muster|warn|lead-out|rescue|scout|chase [--hero hoverbike|lich]
//        [--mode win|lose] [--answer fight|yield|bargain] [--out C:/Projects/shots88/encounters] [--gif 1] [--settle 25000]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const hero = arg('hero', 'hoverbike');
const card = arg('card', 'outriders');
const mode = arg('mode', 'win');
const answer = arg('answer', 'fight');
// (--play trader: the card whose area plays so — a way on is a 'ride' whatever it rides to)
const playKind = arg('play', '');

await run({ name: `encounter-${card}-${hero}-${mode}`, kind: 'behaviour', size: arg('size', '412x915') }, async (R) => {
  const dir = R.opt('out', 'C:/Projects/shots88/encounters');
  fs.mkdirSync(dir, { recursive: true });
  const tag = `${card}${playKind ? `-${playKind}` : ''}-${hero}-${mode}${mode === 'win' && answer !== 'fight' ? `-${answer}` : ''}`;
  const shot = async (name) => {
    const f = path.join(dir, `${tag}-${name}.png`);
    await p.screenshot({ path: f });
    R.log(`saved ${f}`);
  };
  const p = await R.level({ level: 'atlas', run: 'opps', hero, tod: R.opt('tod', '0.35'), perf: R.opt('perf', '0') });
  await p.waitForFunction(() => (window.reclaimed?.opps && window.reclaimed.runhero?.hero) || document.querySelector('.fatal'), { timeout: 180000, polling: 250 });
  await R.fatal(p);
  await p.evaluate((h) => {
    const L = window.reclaimed.opps;
    L.pickHero(h);
    L.stage = 'play';
    L.render();
  }, hero);
  await sleep(Number(R.opt('settle', 25000)));
  await R.fatal(p);
  const state = () =>
    p.evaluate(() => {
      const L = window.reclaimed.opps;
      const r = L.run;
      return {
        at: r.at,
        phase: r.phase,
        playing: L.playing,
        journey: !!L.journey,
        offers: r.offers,
        oplaying: L.opps.playing ? L.opps.playing.opp?.template ?? true : null,
        offered: L.opps.offered.map((o) => ({ id: o.id, template: o.template, affordable: o.affordable, forced: !!o.forced, player: o.requires.some((q) => q.kind === 'player'), kind: o.challenge?.encounter?.kind ?? null, toPlay: o.challenge?.play ?? null })),
        end: r.end,
      };
    });

  // ---- to the card: areas skipped (won), the card committed where it is offered ---------------------------------------
  const t0 = Date.now();
  let s = await state();
  let committed = null;
  while (!committed && Date.now() - t0 < 600000) {
    if (s.end) throw new Error(`the run ended (${s.end}) before ${card} was offered`);
    if (s.phase === 'area' && !s.playing && !s.journey) {
      const f = s.offered.find((o) => o.forced);
      if (f && f.template === card) {
        committed = f;
        await p.evaluate((id) => window.reclaimed.opps.commit(id), f.id);
        break;
      }
      // (the area the hero is at, skipped as won: to the edge and its deal)
      await p.evaluate(() => window.reclaimed.opps.skipArea(true));
      await sleep(500);
      s = await state();
      continue;
    }
    if (s.phase === 'edge' && !s.journey) {
      if (s.offers.length) {
        await p.evaluate(() => window.reclaimed.opps.take(null));
        s = await state();
        continue;
      }
      R.log(`edge at ${s.at}: offered ${s.offered.map((o) => `${o.template}${o.kind ? `(${o.kind})` : ''}${o.affordable ? '' : ' x'}`).join(', ')}`);
      const o = s.offered.find((x) => x.template === card && x.affordable && (!playKind || x.toPlay === playKind));
      if (o) {
        committed = o;
        await p.evaluate((id) => window.reclaimed.opps.commit(id), o.id);
        break;
      }
      // (not here yet: on by a way on that isn't the climax)
      const way = s.offered.find((x) => x.player && x.affordable && x.template === 'ride' && x.toPlay !== 'town') ?? s.offered.find((x) => x.player && x.affordable && ['ride', 'muster'].includes(x.template)) ?? s.offered.find((x) => x.player && x.affordable && !['warn', 'lead-out'].includes(x.template));
      if (!way) throw new Error(`${card} never offered before the climax (last deal: ${s.offered.map((x) => x.template).join(', ')})`);
      R.log(`  on by ${way.template}`);
      await p.evaluate((id) => window.reclaimed.opps.commit(id), way.id);
      for (let i = 0; i < 400 && (await state()).journey; i++) await sleep(400);
      await sleep(3000);
      s = await state();
      continue;
    }
    await sleep(400);
    s = await state();
  }
  if (!committed) throw new Error(`${card}: never committed`);
  R.log(`committed ${committed.template} (${committed.kind})`);
  // the leg there, then the area played
  for (let i = 0; i < 500 && (await state()).journey; i++) await sleep(400);
  await sleep(2500);
  s = await state();
  if (!s.playing) await p.evaluate(() => void window.reclaimed.opps.playArea());
  await sleep(300);

  // ---- the encounter, piloted and sampled ------------------------------------------------------------------------------
  const pilot = () =>
    p.evaluate(
      (mode, answer) => {
        const R = window.reclaimed;
        const S = R.runhero;
        const A = R.opps.area;
        const C = S.controls;
        if (!A || A.done) {
          C.script = { stick: [0, 0], buttons: [false] };
          return null;
        }
        // (a scene's talk open: its answer by id — the encounter's `shown` order — else the only button, the reply's)
        const dlg = document.querySelector('.dlg.on');
        if (dlg) {
          const bs = [...dlg.querySelectorAll('.dlg-choices button, button')];
          if (!bs.length) {
            dlg.click();
            return 'skipping the line';
          }
          const shown = A.enc?.shown ?? [];
          const i = bs.length === shown.length ? shown.indexOf(mode === 'lose' ? 'fight' : answer) : -1;
          const b = bs[i >= 0 ? i : 0];
          b.click();
          return `answered ${b.textContent}`;
        }
        if (mode === 'lose') {
          C.script = { stick: [0, 0], buttons: [false] };
          return 'idle';
        }
        const H = S.hero;
        const at = H.position();
        const E = A.enc ?? null;
        // what to go at: the encounter's own aim (fight: the nearest foe; flee: away; chase: the quarry), else the goal
        const aim = E?.aim ? E.aim([at[0], at[1]]) : { at: A.goal, fight: A.area.play.kind === 'town' };
        let tgt = aim?.at ?? A.goal;
        const fight = !!aim?.fight;
        if (!tgt) {
          C.script = { stick: [0, 0], buttons: [false] };
          return 'no aim';
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
          if (n % 3 === 0 && !(aim?.slow && dist < 6)) C.inject({ kind: 'tap', at: dist < 12 ? g : [a[0] + (gx / gl) * Math.min(gl, 140), a[1] + (gy / gl) * Math.min(gl, 140)] });
          const slam = fight && dist < 5;
          C.script = { stick: [0, 0], buttons: [slam && n % 2 === 0] };
          return `lich ${dist.toFixed(1)}${slam ? ' slam' : ''}`;
        }
        const m = aim?.slow ? 0.25 : fight && dist < 10 ? 0.55 : 1;
        C.script = { stick: [(dx / l) * m, (dy / l) * m], buttons: [!fight && !aim?.slow && dist > 25] };
        if (fight && dist < 7 && n % 2 === 0) C.inject({ kind: 'flick', from: [b[0] - 30, b[1]], to: [b[0] + 30, b[1]], dir: [1, 0], speed: 2200 });
        return `bike ${dist.toFixed(0)}${fight ? ' fight' : ''}`;
      },
      mode,
      answer,
    );
  const sample = () =>
    p.evaluate(() => {
      const R = window.reclaimed;
      const A = R.opps.area;
      if (!A) return null;
      const H = R.runhero.hero;
      const me = H.position();
      const hs = A.d.units.query([me[0], me[1]], 200, { hostile: true }).filter((u) => u.alive !== false);
      const d = (u) => Math.hypot(u.at[0] - me[0], u.at[1] - me[1]);
      const near = hs.length ? Math.min(...hs.map(d)) : null;
      const goalFlag = A.parts().length > 0;
      const banner = A.banner?.textContent ?? '';
      return {
        t: +A.t.toFixed(1),
        done: A.done,
        kind: A.enc?.spec?.kind ?? A.area.play.kind,
        hp: +H.health.toFixed(2),
        max: H.maxHealth,
        near: near === null ? null : +near.toFixed(1),
        in20: hs.filter((u) => d(u) < 20).length,
        in40: hs.filter((u) => d(u) < 40).length,
        engaging: hs.filter((u) => d(u) < 40 && (u.state === 'chase' || u.state === 'swing')).length,
        swinging: hs.filter((u) => d(u) < 6 && u.state === 'swing').length,
        total: hs.length,
        flag: goalFlag,
        goalD: A.goal ? +Math.hypot(A.goal[0] - me[0], A.goal[1] - me[1]).toFixed(0) : null,
        banner,
        talk: !!document.querySelector('.dlg.on'),
      };
    });
  const samples = [];
  let shot4 = false;
  let shotEngage = false;
  let gifDone = R.opt('gif', '0') !== '1';
  let lastLog = 0;
  const tA = Date.now();
  while (Date.now() - tA < 300000) {
    const st = await state();
    if (!st.playing) break;
    const r = await pilot();
    const smp = await sample();
    if (smp) {
      samples.push(smp);
      if (!shot4 && smp.t > 4) {
        shot4 = true;
        await shot('a-4s');
      }
      if (!shotEngage && (smp.swinging > 0 || (smp.in20 > 0 && smp.engaging > 0))) {
        shotEngage = true;
        await shot('b-engaged');
        if (!gifDone) {
          gifDone = true;
          const enc = GIFEncoder();
          for (let i = 0; i < 24; i++) {
            await pilot();
            const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
            const pal = quantize(png.data, 128);
            enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 250 });
            await sleep(120);
          }
          enc.finish();
          const f = path.join(dir, `${tag}-engaged.gif`);
          fs.writeFileSync(f, enc.bytes());
          R.log(`saved ${f}`);
        }
      }
      if (Date.now() - lastLog > 4000) {
        lastLog = Date.now();
        R.log(`  ${r} · ${JSON.stringify(smp)}`);
      }
    }
    await sleep(200);
  }
  await sleep(400);
  await shot('c-end');
  const out = await p.evaluate(() => {
    const L = window.reclaimed.opps;
    const res = L.opps.resolutions.at(-1);
    return { last: L.last, tier: res?.tier ?? null, outcome: res?.outcome?.text ?? null, log: L.log.slice(-30), end: L.run.end };
  });
  for (const l of out.log) R.log(`run: ${l}`);
  // ---- the report -------------------------------------------------------------------------------------------------------
  const first20 = samples.find((x) => x.in20 > 0);
  const firstEngage = samples.find((x) => x.engaging > 0);
  const hurt = samples.length ? samples[0].hp - Math.min(...samples.map((x) => x.hp)) : 0;
  const minNear = Math.min(...samples.map((x) => x.near ?? Infinity));
  const flagShare = samples.filter((x) => x.flag).length / Math.max(1, samples.length);
  const rep = {
    card,
    hero,
    mode,
    kind: samples[0]?.kind,
    seconds: samples.at(-1)?.t,
    firstFoeWithin20s: first20?.t ?? null,
    firstEngagedS: firstEngage?.t ?? null,
    closest: Number.isFinite(minNear) ? +minNear.toFixed(1) : null,
    heroHurt: +hurt.toFixed(2),
    flagShownShare: +flagShare.toFixed(2),
    result: out.last,
    tier: out.tier,
    outcome: out.outcome,
    runEnd: out.end,
  };
  R.log(`REPORT ${JSON.stringify(rep)}`);
  fs.writeFileSync(path.join(dir, `${tag}.json`), JSON.stringify({ rep, samples }, null, 1));
  R.check(`${card}: a foe within 20 cells inside 6 s`, !!first20 && first20.t <= 6, first20);
  R.check(`${card}: the foes engage (chase or swing at the hero)`, !!firstEngage, firstEngage);
  R.check(`${card}: a result tier reported`, !!out.tier, out.tier);
  if (mode === 'lose') R.check(`${card}: idling loses`, out.tier === 'failure' || out.tier === 'disaster', out.tier);
  else R.check(`${card}: the autopilot wins`, ['triumph', 'success', 'cost'].includes(out.tier), out.tier);
  await R.fatal(p);
});
