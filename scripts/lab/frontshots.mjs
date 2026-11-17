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
      if (f) window.__frontTarget = f.target;
      return run && f ? { t: Math.round(run.t), src: f.src?.map((v) => Math.round(v)), town: f.points.filter((x) => x.reached).length, way: f.way.filter((x) => x.reached).length, zoom: +c.zoom.toFixed(1), shields: window.reclaimed.scene.worldApi.shields.list.length, line: window.rungame.fightLine } : { phase: window.rungame.phase };
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
    // (the ward over the town as the front comes: the camera to the market, the ward's button, a tap on the market)
    if (mode === 'shield' && !cast && (s.way >= Number(R.opt('castway', '3')) || s.t >= 20)) {
      cast = true;
      await p.evaluate(() => {
        const f = window.rungame.live.focus.front;
        window.rungame.cam.follow(null);
        return window.rungame.cam.look([f.target[0], f.target[1], window.reclaimed.scene.heightAt(f.target[0], f.target[1]) ?? 0], { zoom: 6, ease: 0.4, place: [0.5, 0.45] });
      });
      await R.sleep(1500);
      const at = await p.evaluate(() => {
        const f = window.rungame.live.focus.front;
        return window.reclaimed.camera.project(f.target[0], f.target[1], window.reclaimed.scene.heightAt(f.target[0], f.target[1]) ?? 0);
      });
      await p.evaluate(() => {
        const b = [...document.querySelectorAll('.run-sheet .go button')].find((e) => e.textContent.startsWith('Fire ward'));
        if (!b) throw new Error(`no Fire ward button: ${[...document.querySelectorAll('.run-sheet button')].map((e) => e.textContent).join(' | ')}`);
        b.click();
      });
      await R.sleep(300);
      await p.mouse.click(at[0], at[1]);
      await R.sleep(1200);
      R.log(`cast at ${at.map((v) => Math.round(v))}: ${JSON.stringify(await state())}`);
      await shot('3-ward');
      // (the camera back on the front)
      await p.evaluate(() => window.rungame.live.goTo && (window.rungame.live.focus = null, window.rungame.live.goTo(window.rungame.live.runs[0])));
    }
    if (!shotAt.has('meets') && s.town + s.way >= 9 && s.t > 20) (shotAt.add('meets'), await shot('4-meets'));
    if (s.t >= 25 + shots * 15 && shots < 4) await shot(`5-t${s.t}`), shots++;
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
  const lookTarget = (zoom) =>
    p.evaluate((z) => {
      const t = window.rungame.spot('market');
      window.rungame.cam.follow(null);
      return window.rungame.cam.look([t[0], t[1], window.reclaimed.scene.heightAt(t[0], t[1]) ?? 100], { zoom: z, ease: 0.3, place: [0.5, 0.3] });
    }, zoom);
  await lookTarget(6);
  await R.sleep(2500);
  await shot('6-after');
  await lookTarget(3.5);
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
  for (const [name, zoom] of [['9-run2-land', 6], ['9-run2-land-wide', 3.5]]) {
    await p.evaluate((z) => {
      const m = window.rungame.spot('market');
      return window.rungame.cam.look([m[0], m[1], window.reclaimed.scene.heightAt(m[0], m[1]) ?? 100], { zoom: z, ease: 0.3, place: [0.5, 0.3] });
    }, zoom);
    await R.sleep(3000);
    await shot(name);
  }
});
