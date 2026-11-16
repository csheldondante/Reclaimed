// (loop-skeleton; docs/design/LOOP_SKELETON.md) The main loop's walk-through at phone size (412x915), a still a moment:
// pick a leader, the town with what people ask over their places, a petition as a dialog with its presenter, the cost
// committed, seasons passing with their news, the raiders' arc, the attack (the camera down the road, the march, the
// fight, a spell cast), its result, the end of the run read from the history, and a new run in the same saved world.
// Drives the page by its own buttons: a tap on a name over the map, the dialog's choices, Next season.
//   node scripts/loopwalk.mjs [--out <dir>] [--leader ysolt] [--agree build:walls,tower-lens] [--runlen 5] [--gif 0]
// `--agree`: the templates to say yes to when they are offered and can be paid, in that order of preference; everything
// else is left to run out. The default prepares (walls: soldiers gather; the tower's heat ray); `--agree none` prepares
// nothing. It fails unless the raid arrives (LS-16).
// On the shared runner (scripts/lib/runner.mjs): this worktree's build, the GPU leased as a behaviour check; it fails on
// a page error, the fatal overlay, or a step that never comes.
import fs from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run } from './lib/runner.mjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'loopwalk', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf(`--${k}`);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const out = opt('out', 'loopwalk');
  const leader = opt('leader', 'ysolt');
  const agree = opt('agree', 'build:walls,tower-lens,build:houses').split(',');
  const runlen = opt('runlen', '5');
  const query = opt('query', `skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&runlen=${runlen}`);
  fs.mkdirSync(out, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => R.log(...a);
  const page = await R.page();
  page.on('console', (m) => {
    const t = m.text();
    if (/^\[(loop|forces)\]/.test(t)) log(t.slice(0, 300));
  });
  const shot = async (name) => {
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    log(`shot ${name}: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.run-sheet h3, .run-full h2, .run-top .r-title, .dlg-name, .dlg-title')].map((e) => e.textContent)))}`);
  };
  const phase = (p, ms = 240000) => page.waitForFunction((q) => q.split('|').includes(window.rungame?.phase), { timeout: ms, polling: 200 }, p);
  const tap = (sel, text) =>
    page.evaluate(
      (s, t) => {
        const b = [...document.querySelectorAll(s)].find((e) => !t || e.textContent.includes(t));
        if (!b) throw new Error(`no ${s} with "${t}"`);
        b.click();
      },
      sel,
      text,
    );
  const state = () =>
    page.evaluate(() => {
      const g = window.rungame;
      const r = g.realm;
      const p = (l) => Object.fromEntries(['magic', 'might', 'labor', 'materials', 'intel', 'unrest'].map((k) => [k, k === 'might' || k === 'labor' ? l.holdings.agents.filter((a) => a.kind === (k === 'might' ? 'army' : 'workers')).length : (l.holdings.goods[k] ?? 0)]));
      return { phase: g.phase, season: r?.season, asking: r ? r.offers().filter((o) => o.status === 'offered').map((o) => o.template) : [], working: g.working(), pools: r ? p(g.ledger) : null, income: r ? g.ledger.income : null, built: r ? g.ledger.built : null, raid: r?.raid ?? null };
    });

  // (BACKLOG LS-12: a boot whose first town make trips the watchdog is thrown away and counted — none since the fix)
  let stalls = 0;
  for (;;) {
    await page.goto(`${R.url}/?${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 200 });
    const fatal = await page.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (!fatal) break;
    stalls++;
    log(`boot ${stalls} stalled (LS-12): ${fatal.slice(0, 200)}`);
    if (stalls >= 3) throw new Error('three boots in a row stalled');
  }
  log(`boots stalled before this one: ${stalls}`);
  await wait(1500);
  await shot('loop-1-leader');

  // 2: the town under the chosen leader, what people ask over their places
  await page.evaluate((who) => {
    const box = [...document.querySelectorAll('.run-full .leader')].find((e) => e.textContent.toLowerCase().includes(who));
    box.querySelector('button').click();
  }, leader);
  await phase('city');
  await wait(2500);
  await shot('loop-2-city');
  log(JSON.stringify(await state()));

  // 3 + 4: go to a name over the map, hear the petition, agree: its cost committed
  let first = true;
  /** the dialog answered: `yes` the agree line if it can be said, else "Not now." */
  const talk = async (template, yes) => {
    const id = await page.evaluate((t) => window.rungame.realm.offers().find((o) => o.template === t && o.status === 'offered')?.id ?? null, template);
    if (!id) return false;
    // (a real tap on the middle of the name over the map; a name the camera doesn't show: the list's row)
    const m = await page.evaluate((oid) => {
      const g = window.rungame.markers().find((x) => x.id === oid);
      const b = g && [...document.querySelectorAll('.run-marks button')].find((e) => e.textContent === g.label);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return document.elementFromPoint(x, y) === b ? { x, y } : null;
    }, id);
    if (m) await page.mouse.click(m.x, m.y);
    else await page.evaluate((oid) => window.rungame.open(oid), id);
    log(`${template}: ${m ? 'tapped on the map' : 'opened from the list (its name is covered or off screen)'}`);
    await phase('petition', 10000);
    await page.waitForFunction(() => document.querySelectorAll('.dlg-choice').length > 0, { timeout: 20000, polling: 200 });
    await wait(600);
    if (first) await shot('loop-3-petition');
    const can = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.dlg-choice')].find((e) => e.textContent.includes('Agree.'));
      return !!b && !b.disabled && !b.classList.contains('disabled');
    });
    await tap('.dlg-choice', yes && can ? 'Agree.' : 'Not now.');
    // (their answer, then a tap to close it)
    for (let k = 0; k < 40; k++) {
      if (!(await page.evaluate(() => window.rungame.talking))) break;
      await wait(500);
      // (the dialog goes on at a press on its panel, not a click)
      const at = await page.evaluate(() => {
        const r = document.querySelector('.dlg-text')?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      });
      if (at) await page.mouse.click(at.x, at.y);
    }
    await phase('city|event', 20000);
    // (the live event: the dead are up at the burial ground — Fire pressed, a tap on one of them, until none is left)
    if ((await state()).phase === 'event') {
      await wait(3500);
      await shot('loop-6-event-dead');
      const frames = [];
      let casts = 0;
      for (let k = 0; k < 14 && (await state()).phase === 'event'; k++) {
        const at = (await page.evaluate(() => window.rungame.deadAt()))[0];
        if (!at) {
          await wait(500);
          continue;
        }
        await tap('.run-sheet .go button', 'Fire');
        await wait(250);
        await page.mouse.click(at[0], at[1]);
        casts++;
        await wait(300);
        if (casts === 1) await shot('loop-6-event-cast');
        frames.push(await page.screenshot({ type: 'png' }));
        await wait(1100);
        frames.push(await page.screenshot({ type: 'png' }));
      }
      const left = await page.evaluate(() => window.rungame.deadAt().length);
      log(`the dead: ${casts} casts, ${left} left, phase ${(await state()).phase}`);
      R.check('the live event was played: Fire cast on the dead until none was left', casts > 0 && (await state()).phase !== 'event', { casts, left });
      if (opt('gif', '1') !== '0' && frames.length) {
        const enc = GIFEncoder();
        for (const b of frames) {
          const png = PNG.sync.read(Buffer.from(b));
          const pal = quantize(png.data, 256);
          enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 450 });
        }
        enc.finish();
        fs.writeFileSync(path.join(out, 'loop-6-event.gif'), enc.bytes());
      }
      await phase('city', 20000);
    }
    await wait(1000);
    if (first) await shot('loop-4-allocated');
    first = false;
    return yes && can;
  };
  const playSeason = async () => {
    for (const t of agree) {
      if (await talk(t, true)) log(`agreed: ${t} → ${JSON.stringify((await state()).pools)}`);
    }
  };
  await playSeason();

  // 5: seasons pass until the attack (or the end)
  let n = 0;
  const decisions = [];
  const t0 = Date.now();
  for (;;) {
    decisions.push((await state()).asking.length);
    await wait(400);
    await tap('.run-sheet .go button', 'Next season');
    await phase('season', 10000);
    await wait(n === 0 ? 6000 : 1500);
    if (n < 2) await shot(`loop-5-season${n + 1}`);
    // (the rest of the time-lapse skipped: a season is a few seconds)
    await page.evaluate(() => window.rungame.canSkip && window.rungame.skip());
    n++;
    await phase('city|attack|result|end', 120000);
    const s = await state();
    log(JSON.stringify(s));
    const news = await page.evaluate(() => window.rungame.notes);
    log(`news: ${JSON.stringify(news)}`);
    // (a change in the land this season: the camera on it, a still)
    if (s.phase === 'city' && /flooded|burned|buried|Lava|founded/.test(news.join(' '))) {
      const seen = await page.evaluate(() => window.rungame.showLast());
      await wait(2600);
      await shot(`loop-6-change-s${s.season}-${seen ?? 'none'}`);
      await page.evaluate(() => window.rungame.showTown());
      await wait(1500);
    }
    if (s.phase !== 'city') break;
    if (n % 4 === 0) await shot(`loop-5-city-s${s.season}`);
    await playSeason();
    if (n > 40) throw new Error('the attack never came');
  }
  log(`decisions a season: ${decisions.join(', ')}`);
  log(`${n} seasons in ${((Date.now() - t0) / 1000).toFixed(0)} s of wall time, the time-lapse skipped after 1.5 s: ${((Date.now() - t0) / 1000 / n).toFixed(1)} s a season with its petitions`);
  R.check('the decisions a season stay few', Math.max(...decisions) <= 5, decisions);

  // 7: the attack: the camera down the road, the raid called, the march, the fight, a spell cast, the result
  if (['attack', 'result'].includes((await state()).phase)) {
    await wait(2500);
    await shot('loop-7-attack-road');
    // (arrived: raiders stand in the world, their places read — not only a group asked for)
    await page.waitForFunction(() => !!window.rungame.raidAt() || window.rungame.phase === 'result', { timeout: 120000, polling: 200 });
    const fight0 = await page.evaluate(() => (window.rungame.raidAt() ? window.war?.fight : null) ?? null);
    R.check('the raid arrived', !!fight0 && fight0.alive > 0 && !fight0.failed, fight0);
    log(`raid: ${JSON.stringify(fight0)}`);
    fs.mkdirSync(path.join(out, 'frames'), { recursive: true });
    // (who died of what, as the units' own events say)
    await page.evaluate(() => {
      const u = window.reclaimed.units;
      u.died.push((v, by) => console.log(`[loop] died: ${v.kind} by ${typeof by === 'number' ? (u.get(by)?.kind ?? `unit ${by}`) : by}`));
    });
    // (frames for the GIF all the way through; named stills at the march, the raiders in the town, the spell, the fight)
    const frames = [];
    const seen = new Set();
    let cast = false;
    let soldiers0 = 0;
    for (let k = 0; k < 400; k++) {
      const st = await page.evaluate(() => ({ phase: window.rungame.phase, f: window.war?.fight ?? null, at: window.rungame.raidAt(), spell: window.rungame.run.spells[0] ?? null, zoom: window.reclaimed.camera.zoom }));
      if (st.phase !== 'attack') break;
      soldiers0 = Math.max(soldiers0, st.f?.soldiers ?? 0);
      if (frames.length < 120) frames.push(await page.screenshot({ type: 'png' }));
      if (k % 5 === 0) {
        fs.writeFileSync(path.join(out, 'frames', `f-${String(k).padStart(3, '0')}.png`), frames[frames.length - 1]);
        log(`attack ${k}: ${st.f?.stage} raiders ${st.f?.alive} soldiers ${st.f?.soldiers} at ${st.at?.map((v) => Math.round(v))} zoom ${st.zoom.toFixed(1)}`);
      }
      const still = async (name) => {
        if (seen.has(name)) return;
        seen.add(name);
        await shot(name);
        log(`${name}: ${JSON.stringify(st.f)} zoom ${st.zoom.toFixed(1)}`);
      };
      if (st.f?.stage === 'coming' && st.at && k > 6) await still('loop-7-attack-march');
      if (st.f?.stage === 'there' && st.zoom > 12) await still('loop-7-attack-there');
      if (st.f?.stage === 'fighting' && st.zoom > 12) await still('loop-7-attack-fight');
      // (a spell if one is unlocked: once the raiders are in the town, its button, then a tap on the raiders)
      if (!cast && st.spell && st.f && st.f.stage !== 'coming' && st.at && st.zoom > 12) {
        cast = true;
        await tap('.run-sheet .go button', 'Heat ray');
        await wait(250);
        await shot('loop-7-attack-spell-armed');
        const at = await page.evaluate(() => window.rungame.raidAt());
        const before = await page.evaluate(() => window.war.fight.alive);
        await page.mouse.click(at[0], at[1]);
        await wait(350);
        await shot('loop-7-attack-spell');
        frames.push(await page.screenshot({ type: 'png' }));
        await wait(1200);
        const after = await page.evaluate(() => window.war?.fight?.alive ?? 0);
        log(`heat ray: raiders alive ${before} -> ${after}`);
        R.check('the heat ray was cast and hit', after < before, { before, after });
      }
      await wait(600);
    }
    if (opt('gif', '1') !== '0' && frames.length) {
      const enc = GIFEncoder();
      for (const b of frames) {
        const png = PNG.sync.read(Buffer.from(b));
        const pal = quantize(png.data, 256);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 300 });
      }
      enc.finish();
      fs.writeFileSync(path.join(out, 'loop-7-attack.gif'), enc.bytes());
      log(`gif: ${frames.length} frames`);
    }
    log(`soldiers at the fight: ${soldiers0}`);
    await phase('result', 200000);
    await wait(800);
    await shot('loop-7-result');
    // (the camera pulls back over where the raiders stood: broken through, that district is burned)
    await wait(3500);
    await shot('loop-7-result-district');
    log(`war: ${JSON.stringify(await page.evaluate(() => window.rungame.resultLines))}`);
    await tap('.run-sheet .go button', 'Continue');
  }
  await phase('end', 60000);
  await wait(800);
  await shot('loop-8-end');
  const ended = await page.evaluate(() => ({ history: window.rungame.history(), land: window.rungame.land() }));
  log(`history: ${JSON.stringify(ended.history)}`);
  log(`land (the mutators' entries this run caused): ${JSON.stringify(ended.land)}`);
  log(`mutators: ${JSON.stringify(await page.evaluate(() => ({ list: window.mutators.record().list.map((m) => `${m.kind}@${m.place ?? m.cell.join(',')} r${Math.round(m.radius)} fact ${m.fact}`), signs: window.mutators.signs().map((s) => `${s.kind} ${s.strength} until ${s.until}`) })))}`);
  R.check('the end of the run reads the history', ended.history.length > 0, ended.history.length);
  // the saved world: the store holds the fact layer; a reload reads it (the leader screen lists what is remembered)
  await wait(1500);
  const u = new URL(page.url());
  u.searchParams.delete('fresh');
  await page.goto(u.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 200 });
  await wait(1200);
  await shot('loop-8-reload-leader');
  const kept = await page.evaluate(() => window.rungame.before());
  log(`after a reload the world remembers: ${JSON.stringify(kept)}`);
  R.check('the fact layer survives a reload', kept.length >= ended.history.length, { kept: kept.length, had: ended.history.length });
  // a new run in the same world
  await page.evaluate(() => [...document.querySelectorAll('.run-full .leader')].find((e) => e.textContent.includes('Dunstan')).querySelector('button').click());
  await phase('city', 10000);
  await wait(2500);
  await shot('loop-8-newrun-city');
  const again = await page.evaluate(() => ({ run: window.rungame.run.n, before: window.rungame.before().length }));
  log(`new run: ${JSON.stringify(again)} ${JSON.stringify(await state())}`);
  R.check('the new run is run 2 of the same world', again.run === 2 && again.before >= ended.history.length, again);
});
