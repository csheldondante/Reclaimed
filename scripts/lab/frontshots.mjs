// (loop round 12, docs/design/FRONTS.md) A lava front on the home town in the real game, at phone size, from the
// ages pack: the wizards' first working (its card started by the pack's rule at the season's end) pours lava uphill of
// the market; with `--mode shield` the Fire ward is cast over the town as the front comes, as a player does (its button
// on the sheet, then a tap on the town); with `--mode none` nothing is cast. Stills as it comes, as it meets the town,
// after; then (with --run2) the run played out and run 2 begun in the changed world: "The world now", the land.
// Fixtures (the cards' own effects, written as the record would): the wizards' college at the tower, the ward learned.
//   node scripts/lab/frontshots.mjs [--out dir] [--mode shield|none] [--run2] [--params "&x=1"]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'frontshots', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'frontshots');
  const mode = R.opt('mode', 'shield');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(live|loop|realm)\]/.test(t) || m.type() === 'error') R.log(t.slice(0, 400));
  });
  const shot = async (name) => {
    await p.screenshot({ path: path.join(out, `${mode}-${name}.png`) });
    R.log(`shot ${mode}-${name}`);
  };
  const until = (fn, ms = 300000) => p.waitForFunction(fn, { timeout: ms, polling: 250 });
  const base = `${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&q=low&warmcache=0&runlen=3&packs=ages${R.opt('params', '')}`;
  await p.goto(`${base}&fresh=1`, { waitUntil: 'load' });
  await until(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'));
  await R.fatal(p);
  await p.evaluate(() => (window.rungame.pick('ysolt'), window.rungame.closePanel()));
  await until(() => window.rungame.phase === 'city', 60000);
  await R.sleep(3000);
  // (the fixtures: the college in play at the tower — what "Invite the court wizards" puts — and the ward learned, as
  // its card's `unlock` writes; Magic for the cast)
  await p.evaluate(() => {
    const r = window.rungame.realm;
    const home = r.w.settlement(r.home);
    r.w.facts.add({ id: 'thing:ages-college', kind: 'building', name: "The wizards' college", at: { region: home.region, settlement: r.home, site: `site:${r.home}:tower` }, attrs: { thing: 'ages-college', what: 'building' }, cause: 'frontshots-fixture' });
    r.w.facts.record({ kind: 'ability-unlocked:ages-ward', by: ['player'], to: [r.home], note: 'you learned the Fire ward (fixture)' });
  });
  // (tuning: --far, --rate, --pour, --spread override the pack's numbers for this run)
  const tune = Object.fromEntries(['far', 'rate', 'pour', 'spread'].filter((k) => R.opt(k, '') !== '').map((k) => [k, Number(R.opt(k, '0'))]));
  if (Object.keys(tune).length)
    R.log(`tuned: ${JSON.stringify(await p.evaluate((tn) => {
      const t = window.rungame.realm.engine.templates.find((x) => x.id === 'ages-mountain-stirs');
      Object.assign(t.play.event.hazard, tn);
      return t.play.event.hazard;
    }, tune))}`);
  // (the season's end: the pack's rule starts the eruption, which begins as the season turns)
  await p.evaluate(() => window.rungame.next());
  for (let k = 0; k < 120; k++) {
    const ph = await p.evaluate(() => {
      const g = window.rungame;
      if (g.phase === 'season' && g.canSkip) g.skip();
      return g.phase;
    });
    if (ph === 'event') break;
    await R.sleep(1000);
  }
  const begun = await p.evaluate(() => window.rungame.live.focus?.template ?? null);
  R.check('the eruption begun by its rule', begun === 'ages-mountain-stirs', begun);
  if (begun !== 'ages-mountain-stirs') return;
  const state = () =>
    p.evaluate(() => {
      const run = window.rungame.live.focus;
      const f = run?.front;
      const c = window.reclaimed.camera;
      // (where the front ran, with the window's origin it was read in: the aftermath frames it after slides)
      if (f?.src) window.__front = { src: [f.src[0], f.src[1]], target: [f.target[0], f.target[1]], origin: [...(window.reclaimed.scene.stream?.origin ?? [0, 0])] };
      const L = window.rungame.live;
      const fr = f ? L.frontFrame(f) : null;
      const r = (v) => v?.map((x) => Math.round(x));
      const st = window.reclaimed.scene.stream;
      // (loop round 14: the town's points as the front reads them — where, the depth first read, the depth now)
      const api = window.reclaimed.scene.worldApi;
      const pts = f ? f.points.map((q) => [Math.round(q.at[0]), Math.round(q.at[1]), q.base === null ? null : +q.base.toFixed(2), +(api.fire.flowLavaAt(q.at[0], q.at[1]) ?? -1).toFixed(2)]) : [];
      return run && f ? { t: Math.round(run.t), pts, origin: st && [...st.origin], held: st?.holds.size ?? 0, aim: r(f.aim), src: r(f.src), target: r(f.target), frame: fr && { at: r(fr.at), span: Math.round(fr.span) }, cam: r(c.target), busy: window.rungame.cam.busy, town: f.points.filter((x) => x.reached).length, way: f.way.filter((x) => x.reached).length, zoom: +c.zoom.toFixed(1), shields: window.reclaimed.scene.worldApi.shields.list.length, ward: window.reclaimed.scene.worldApi.shields.list.map((s) => ({ energy: Math.round(s.energy), max: s.max, left: Math.round(s.left), drain: +s.press.drain.toFixed(1), lava: Math.round(s.press.lava) })), line: window.rungame.fightLine } : { phase: window.rungame.phase };
    });
  let cast = false;
  let shots = 0;
  const shotAt = new Set();
  for (let k = 0; k < 150; k++) {
    await R.sleep(1000);
    await R.fatal(p);
    const s = await state();
    if (k % 3 === 0) R.log(`${k}: ${JSON.stringify(s)}`);
    if (s.phase) break;
    if (!shotAt.has('source') && s.src && s.t >= 4) (shotAt.add('source'), await shot('1-source'));
    if (!shotAt.has('coming') && s.way >= 4) (shotAt.add('coming'), await shot('2-coming'));
    // (the ward over the town as the front comes, from the event's own camera as a player sees it: the ward's button,
    // then a tap on the town's middle (the front's target) where it shows on the screen — loop round 13; round 12 moved
    // the camera off the event to cast)
    if (mode === 'shield' && !cast && (s.way >= Number(R.opt('castway', '3')) || s.t >= 20)) {
      cast = true;
      const target = () =>
        p.evaluate(() => {
          const f = window.rungame.live.focus.front;
          // (the ground's height there, as the game reads it: null until its page is read — then the view's own, as
          // loop.ts z does. Round 12 put 0 there: the tap landed 55 cells off the town and its shield stood in a field)
          return window.reclaimed.camera.project(f.target[0], f.target[1], window.reclaimed.scene.heightAt(f.target[0], f.target[1]) ?? window.reclaimed.camera.target[2]);
        });
      let at = await target();
      // (the sheet's top: a tap under it is the sheet's)
      const sheetTop = await p.evaluate(() => document.querySelector('.run-sheet')?.getBoundingClientRect().top ?? 915);
      const onScreen = (q) => q && q[0] > 20 && q[0] < 392 && q[1] > 110 && q[1] < sheetTop - 10;
      R.log(`the town's middle on the event's screen at ${at?.map((v) => Math.round(v))} (the sheet from ${Math.round(sheetTop)})`);
      R.check("the town's middle is on the event's screen to cast at", onScreen(at), at);
      if (!onScreen(at)) return;
      await p.evaluate(() => {
        const b = [...document.querySelectorAll('.run-sheet .go button')].find((e) => e.textContent.startsWith('Fire ward'));
        if (!b) throw new Error(`no Fire ward button: ${[...document.querySelectorAll('.run-sheet button')].map((e) => e.textContent).join(' | ')}`);
        b.click();
      });
      await R.sleep(300);
      at = await target();
      await p.mouse.click(at[0], at[1]);
      // (the cast as it happens: the ring spreading out, then the wall standing)
      await R.sleep(350);
      await shot('3-cast-a');
      await R.sleep(700);
      await shot('3-cast-b');
      R.log(`cast at ${at.map((v) => Math.round(v))}: ${JSON.stringify(await state())}`);
    }
    if (!shotAt.has('meets') && s.town + s.way >= 9 && s.t > 20) (shotAt.add('meets'), await shot('4-meets'));
    // (loop round 15, LS-141: the ward's life under the press — holding with lava at its rim, flickering below a quarter,
    // the collapse the moment it goes while the event runs, the told line)
    if (cast) {
      const w = s.ward?.[0];
      if (w && !shotAt.has('hold') && w.lava > 20) (shotAt.add('hold'), await shot('w1-holding'), R.log(`holding: ${JSON.stringify(w)}`));
      if (w && !shotAt.has('flicker') && w.energy < w.max / 4) (shotAt.add('flicker'), await shot('w2-flicker'), R.log(`flicker: ${JSON.stringify(w)}`));
      if (!w && shotAt.has('hold') && !shotAt.has('collapse')) {
        shotAt.add('collapse');
        await R.sleep(150);
        await shot('w3-collapse');
        R.log(`gone at t ${s.t}: line ${JSON.stringify(s.line)} notes ${JSON.stringify(await p.evaluate(() => window.rungame.notes))}`);
        await R.sleep(4000);
        await shot('w4-after');
      }
    }
    // (loop round 14: --every n, a still each n seconds from the pour's start — the front coming from afar)
    const every = Number(R.opt('every', '0'));
    if (every > 0 && s.src && s.t >= 4 + shots * every && shots < 12) await shot(`5-t${String(s.t).padStart(2, '0')}`), shots++;
    else if (!every && s.t >= 25 + shots * 15 && shots < 4) await shot(`5-t${s.t}`), shots++;
  }
  // (the event over: the town as it stands, from above its target — in the top of the screen, over the sheet — before
  // the next event takes the camera; the window points as they stand now)
  // (the refugees of a far town fallen this season may come in first: their event is played out, then the market)
  for (let k = 0; k < 200; k++) {
    const ph = await p.evaluate(() => {
      const g = window.rungame;
      if (g.phase === 'event' && g.liveNow?.canSettle) g.settle(g.liveNow.id);
      return g.phase;
    });
    if (ph === 'city') break;
    await R.sleep(1000);
  }
  // (loop round 13: the town's sheet and the names folded away — the land itself in the frame)
  const fold = async () => {
    await p.evaluate(() => document.querySelector('.run-sheet button.fold')?.click());
    await R.sleep(300);
  };
  await fold();
  // (the front's way as a window point now: its middle, from where it was read, moved by the slides since)
  const lookWay = (zoom) =>
    p.evaluate((z) => {
      const F = window.__front;
      const o = window.reclaimed.scene.stream?.origin ?? [0, 0];
      const RH = Math.sqrt(3) / 2;
      const dx = F.origin[0] - o[0];
      const dy = (F.origin[1] - o[1]) * RH;
      const m = [(F.src[0] + F.target[0]) / 2 + dx, (F.src[1] + F.target[1]) / 2 + dy];
      window.rungame.cam.follow(null);
      return window.rungame.cam.look([m[0], m[1], window.reclaimed.scene.heightAt(m[0], m[1]) ?? window.reclaimed.camera.target[2]], { zoom: z, ease: 0.3, place: [0.5, 0.5] });
    }, zoom);
  // (the shield, if it is still up: its last seconds and its end)
  const left = await p.evaluate(() => window.reclaimed.scene.worldApi.shields.list.map((s) => s.left));
  R.log(`after the event: shields ${JSON.stringify(left)}`);
  if (left.length && left[0] < 60) {
    // (the view put on the way only shortly before: the window may slide meanwhile, and the way's point with it)
    await R.sleep(Math.max(0, left[0] - 4.5) * 1000);
    await lookWay(6);
    await R.sleep(2500);
    R.log(`shield before its end: ${JSON.stringify(await p.evaluate(() => window.reclaimed.scene.worldApi.shields.list.map((s) => s.left)))}`);
    await shot('6-shield-last');
    // (its end on the sim's clock: the frame 0.3 s after it is gone — the streaks thrown off the rim)
    await until(() => window.reclaimed.scene.worldApi.shields.list.length === 0, 30000);
    await R.sleep(300);
    await shot('6-shield-end');
  }
  await lookWay(6);
  await R.sleep(2500);
  await shot('6-after');
  await lookWay(3.5);
  await R.sleep(2500);
  await shot('7-after-wide');
  R.log(`after: notes ${JSON.stringify(await p.evaluate(() => window.rungame.notes))}`);
  R.log(`land: ${JSON.stringify(await p.evaluate(() => window.rungame.land()))}`);
  if (!R.flag('run2')) return;
  for (let k = 0; k < 200; k++) {
    const ph = await p.evaluate(() => window.rungame.phase);
    if (ph === 'end') break;
    await p.evaluate(() => {
      const g = window.rungame;
      if (g.phase === 'city' && !g.canSkip) g.next();
      else if (g.phase === 'season' && g.canSkip) g.skip();
      else if (g.phase === 'result') g.proceed();
      else if (g.phase === 'event' && g.liveNow?.canSettle) g.settle(g.liveNow.id);
      else if (g.phase === 'event' && g.liveNow?.canLeave) g.leave();
    });
    await R.sleep(1500);
  }
  R.check('run 1 ended', (await p.evaluate(() => window.rungame.phase)) === 'end');
  await p.evaluate(() => window.rungame.again());
  await until(() => window.rungame.phase === 'leader', 10000);
  await p.evaluate(() => window.rungame.pick('ysolt'));
  await until(() => window.rungame.phase === 'city' || document.querySelector('.fatal'));
  await R.sleep(2500);
  R.log(`run 2 world now: ${JSON.stringify(await p.evaluate(() => window.rungame.worldNow()))}`);
  await shot('8-run2-worldnow');
  await p.evaluate(() => window.rungame.closePanel());
  await R.sleep(500);
  await fold();
  for (const [name, zoom] of [['9-run2-land', 6], ['9-run2-land-wide', 3.5]]) {
    await lookWay(zoom);
    await R.sleep(3000);
    await shot(name);
  }
});
