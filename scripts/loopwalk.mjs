// (loop-skeleton; docs/design/LOOP_SKELETON.md) The main loop's walk-through at phone size (412x915), a still a moment:
// pick a leader, the town with what people ask over their places, a petition as a dialog with its presenter, the cost
// committed, seasons passing with their news, the raiders' arc, the attack (the camera down the road, the march, the
// fight, a spell cast), its result, the end of the run read from the history, and a new run in the same saved world.
// Drives the page by its own buttons: a tap on a name over the map, the dialog's choices, Next season.
//   node scripts/loopwalk.mjs [--out <dir>] [--leader ysolt] [--agree build:walls,tower-lens] [--runlen 5] [--gif 0] [--touch]
// `--touch`: the whole walk by a finger (pointerType touch): see `touch` below.
// `--fast`: each petition is opened within 300 ms of a camera move (the camera sent back over the town, as the season's
// end does) and answered as fast as the dialog allows, so its camera frame waits behind that move (BACKLOG LS-54, once
// a dead end: the attack's camera never went down the road). A dialog takes a finger about 2.5 s and one move 1.2 s, so
// after one move the frame has begun by the answer; every other petition is opened after three moves in a row (3.6 s
// of them), and its frame is still waiting when it is let go. The walk fails unless both were met, and then goes on to
// the attack as any walk.
// (round 6) live events are played as they come (`playEvent`: the dead, a fire, a parade, refugees; `--leave` leaves a
// parade running), the growth rune is drawn each season once farms are built (`--norune`: not), and `--need a,b`
// fails unless the walk met each (a template's id, `rune`, `rule`).
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
  // (--touch: every press is a finger's — CDP Input.dispatchTouchEvent, which the page hears as pointer events of
  // pointerType 'touch', with no hover before the press — and nothing is driven by a script's click or the game's
  // own calls: what a thumb cannot reach fails the walk)
  const touch = R.argv.includes('--touch');
  const fast = R.argv.includes('--fast');
  /** (--fast) what each release of the story camera found: its frame holding the view, waiting in the queue, or none */
  const releases = () => page.evaluate(() => window.__releases ?? []);
  const found = [];
  let talks = 0;
  const watchReleases = () =>
    page.evaluate(() => {
      const cam = window.rungame.cam;
      if (cam.__watched) return;
      cam.__watched = true;
      window.__releases = [];
      const release = cam.release.bind(cam);
      cam.release = (s) => {
        window.__releases.push(cam.held ? 'held' : cam.queue.some((q) => q.frame) ? 'waiting' : 'none');
        return release(s);
      };
    });
  const page = await R.page();
  if (touch) await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  /** a press at a screen point: a finger's tap, or the mouse's click */
  const press = (x, y) => (touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
  /** controls pressed that a thumb could not: smaller than THUMB px, covered, or off the screen */
  const THUMB = 40;
  const unreachable = [];
  const pans = [];
  const camAt = () => page.evaluate(() => [...window.reclaimed.camera.target, window.reclaimed.camera.zoom]);
  page.on('console', (m) => {
    const t = m.text();
    if (/^\[(loop|forces)\]/.test(t)) log(t.slice(0, 300));
  });
  const shot = async (name) => {
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    log(`shot ${name}: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.run-sheet h3, .run-full h2, .run-top .r-title, .dlg-name, .dlg-title')].map((e) => e.textContent)))}`);
  };
  const phase = (p, ms = 240000) => page.waitForFunction((q) => q.split('|').includes(window.rungame?.phase), { timeout: ms, polling: 200 }, p);
  /** press a control of the page found by its selector and words. With the mouse: the element's click, as before.
   *  By touch: a tap at its middle, after checking a thumb can reach it (on the screen, not covered, THUMB px tall;
   *  a control in the full screen's scrolling list is scrolled to first, as a finger would) */
  const tap = async (sel, text) => {
    const at = await page.evaluate(
      (s, t, byTouch) => {
        const b = [...document.querySelectorAll(s)].find((e) => !t || e.textContent.includes(t));
        if (!b) throw new Error(`no ${s} with "${t}"`);
        if (!byTouch) return void b.click();
        if (b.closest('.run-full')) b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        return { x, y, w: Math.round(r.width), h: Math.round(r.height), hit: !!top && (top === b || b.contains(top)), on: x > 0 && y > 0 && x < innerWidth && y < innerHeight, over: top && top !== b ? top.className || top.tagName : null };
      },
      sel,
      text,
      touch,
    );
    if (!touch) return;
    if (!at.hit || !at.on || at.h < THUMB) unreachable.push(`${sel} "${text ?? ''}" ${at.w}x${at.h}${at.on ? '' : ' off the screen'}${at.hit ? '' : ` covered by ${at.over}`}`);
    await press(at.x, at.y);
  };
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
  const pickLeader = async (who) => {
    const k = await page.evaluate((w) => [...document.querySelectorAll('.run-full .leader')].findIndex((e) => e.textContent.toLowerCase().includes(w)), who);
    if (k < 0) throw new Error(`no leader ${who}`);
    await page.evaluate((i) => document.querySelectorAll('.run-full .leader')[i].querySelector('button').setAttribute('data-walk', 'pick'), k);
    await tap('.run-full .leader button[data-walk=pick]');
  };
  await pickLeader(leader);
  await phase('city');
  await wait(2500);
  await shot('loop-2-city');
  log(JSON.stringify(await state()));

  /** the live events met, by template, and what the season's news said of rules that fired */
  const RULE_LINE = /doubled the crop|prayed there|stopped \d+ (more )?raider|bucket lines|fewer people came|more people to the parade|counted the scouts|sold at|worked the/;
  const met = new Set();
  const fired = [];
  /**
   * (round 6) A live event the player is at, played by a finger: the dead burned with Fire, a fire fought with Rain, a
   * parade or refugees watched to their end (or left, with --leave: it goes on without the player and the season's end
   * resolves it). The raid has its own part below. A still of each moment.
   */
  const playEvent = async () => {
    if ((await state()).phase !== 'event') return;
    const live = () => page.evaluate(() => window.rungame.liveDebug());
    const tpl = (await live()).focus;
    if (!tpl || tpl === 'raid') return;
    met.add(tpl);
    log(`live event: ${tpl}`);
    const view = () => page.evaluate(() => ({ top: document.querySelector('.run-top')?.getBoundingClientRect().bottom ?? 0, sheet: document.querySelector('.run-sheet')?.getBoundingClientRect().top ?? innerHeight }));
    if (tpl === 'dead-rise') {
      await wait(3500);
      await shot('loop-6-event-dead');
      {
        const v = { ...(await view()), dead: await page.evaluate(() => window.rungame.deadAt()) };
        const seen = v.dead.filter(([x, y]) => x > 12 && x < 400 && y > v.top + 12 && y < v.sheet - 8).length;
        R.check('the live event: every one of the dead is in view, between the top bar and the sheet', v.dead.length > 0 && seen === v.dead.length, { seen, of: v.dead.length, top: Math.round(v.top), sheet: Math.round(v.sheet), at: v.dead.map((q) => q.map(Math.round)) });
      }
      let casts = 0;
      for (let k = 0; k < 14 && (await state()).phase === 'event'; k++) {
        const at = (await page.evaluate(() => window.rungame.deadAt()))[0];
        if (!at) {
          await wait(500);
          continue;
        }
        await tap('.run-sheet .go button', 'Fire');
        await wait(250);
        await press(at[0], at[1]);
        casts++;
        await wait(300);
        if (casts === 1) await shot('loop-6-event-cast');
        await wait(1100);
      }
      const left = await page.evaluate(() => window.rungame.deadAt().length);
      log(`the dead: ${casts} casts, ${left} left, phase ${(await state()).phase}`);
      R.check('the live event was played: Fire cast on the dead until none was left', casts > 0 && (await state()).phase !== 'event', { casts, left });
    } else if (tpl === 'market-fire') {
      await wait(6000);
      await shot('loop-ev-fire-1-alight');
      log(`fire: ${JSON.stringify((await live()).runs.find((r) => r.template === tpl)?.numbers)}`);
      // (Rain pressed, then a tap on the flames: the middle of the view above the sheet, and to each side of it)
      const v = await view();
      const mid = [206, v.top + (v.sheet - v.top) * 0.5];
      let casts = 0;
      for (const [dx, dy] of [[0, 0], [-70, -30], [70, 30]]) {
        if ((await state()).phase !== 'event' || (await state()).pools.magic < 1) break;
        await tap('.run-sheet .go button', 'Rain');
        await wait(250);
        await press(mid[0] + dx, mid[1] + dy);
        casts++;
        await wait(2500);
        if (casts === 1) await shot('loop-ev-fire-2-rain');
      }
      await wait(6000);
      await shot('loop-ev-fire-3-later');
      log(`fire after ${casts} casts of Rain: ${JSON.stringify((await live()).runs.find((r) => r.template === tpl)?.numbers)}`);
      R.check('the fire was fought: Rain was cast on it', casts > 0, { casts });
      await page.waitForFunction(() => window.rungame.phase !== 'event', { timeout: 120000, polling: 300 });
    } else {
      // (a parade, refugees: in by a road — the camera down it, then on the column)
      await wait(2500);
      await shot(`loop-ev-${tpl}-1-road`);
      await page.waitForFunction(() => !!window.rungame.raidAt() || window.rungame.phase !== 'event', { timeout: 150000, polling: 300 });
      await wait(5000);
      await shot(`loop-ev-${tpl}-2-march`);
      {
        const v = { ...(await view()), at: await page.evaluate(() => window.rungame.raidAt()) };
        if (v.at) R.check(`${tpl}: the column is in view, between the top bar and the sheet`, v.at[1] > v.top + 12 && v.at[1] < v.sheet - 8 && v.at[0] > 12 && v.at[0] < 400, { at: v.at.map(Math.round), top: Math.round(v.top), sheet: Math.round(v.sheet) });
      }
      log(`${tpl}: ${JSON.stringify((await live()).runs.find((r) => r.template === tpl)?.numbers)}`);
      if (R.argv.includes('--leave') && (await page.evaluate(() => window.rungame.liveNow?.canLeave))) {
        await tap('.run-sheet .go button', 'Back to the town');
        await phase('city', 10000);
        await wait(1500);
        await shot(`loop-ev-${tpl}-3-left`);
        R.check(`${tpl}: left, it goes on without the player, its name over the map`, (await live()).runs.some((r) => r.template === tpl) && (await page.evaluate(() => window.rungame.markers().some((m) => m.id.startsWith('live:')))));
        return;
      }
      for (let k = 0; k < 30 && (await state()).phase === 'event'; k++) {
        await wait(8000);
        if (k === 2) await shot(`loop-ev-${tpl}-3-on`);
      }
      R.check(`${tpl}: it ended by itself`, (await state()).phase !== 'event', (await live()).runs.find((r) => r.template === tpl)?.numbers);
      // (still going: left, so the walk goes on — the season's end resolves it)
      if ((await state()).phase === 'event') {
        await tap('.run-sheet .go button', 'Back to the town');
        await phase('city', 10000);
        return;
      }
    }
    await phase('city|event|result|end', 30000);
    await wait(1500);
    await shot(`loop-ev-${tpl}-end`);
    const notes = await page.evaluate(() => window.rungame.notes);
    log(`after ${tpl}: ${JSON.stringify(notes)}`);
    fired.push(...notes.filter((t) => RULE_LINE.test(t) && !fired.includes(t)));
  };

  /** (round 6) the growth rune, by a finger: its button on the town's sheet, then a tap on the east fields */
  let runes = 0;
  const rune = async () => {
    const s0 = await state();
    // (each season once farms are built — the rule that doubles their crop then fires; before that, once, to see it)
    if (s0.phase !== 'city' || s0.pools.magic < 2 || (!s0.built.includes('farms') && runes > 0) || R.argv.includes('--norune')) return;
    await page.evaluate(() => window.rungame.showTown());
    await wait(1800);
    const at = await page.evaluate(() => window.rungame.siteAt('fields'));
    const v = await page.evaluate(() => ({ top: document.querySelector('.run-top')?.getBoundingClientRect().bottom ?? 0, sheet: document.querySelector('.run-sheet')?.getBoundingClientRect().top ?? innerHeight }));
    if (!at || at[1] < v.top + 8 || at[1] > v.sheet - 8) return log(`rune: the east fields are not in view (${at})`);
    // (not on a name over the map: a little below the fields' own point if one lies there)
    const free = await page.evaluate(([x, y]) => [0, 14, -14, 28].map((d) => [x, y + d]).find(([px, py]) => !document.elementFromPoint(px, py)?.closest('.run-marks button, .run-sheet, .run-top')) ?? null, at);
    if (!free) return log('rune: a name lies over the east fields');
    await tap('.run-sheet .go button', 'Growth rune');
    await wait(250);
    await press(free[0], free[1]);
    await wait(900);
    runes++;
    const s1 = await state();
    if (runes === 1) {
      await shot('loop-rune-1-cast');
      await page.evaluate(() => window.rungame.lookAt('fields', 9));
      await wait(4000);
      await shot('loop-rune-2-fields');
      await page.evaluate(() => window.rungame.showTown());
      await wait(1500);
    }
    R.check('the growth rune was drawn over the east fields by a tap: 1 Magic spent', s1.pools.magic === s0.pools.magic - 1, { before: s0.pools.magic, after: s1.pools.magic, notes: await page.evaluate(() => window.rungame.notes) });
  };

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
      return document.elementFromPoint(x, y) === b ? { x, y, label: g.label } : null;
    }, id);
    let moved = 0;
    if (fast) {
      await watchReleases();
      await page.evaluate((n) => {
        for (let k = 0; k < n; k++) window.rungame.showTown();
      }, talks++ % 2 ? 1 : 3);
      moved = Date.now();
    }
    if (m) {
      // (the name's own height is the text's; what a thumb needs is the area that takes the press)
      if (touch) {
        const hitH = await page.evaluate(
          (x, y, label) => {
            const is = (dy) => document.elementFromPoint(x, y + dy)?.textContent === label;
            let up = 0;
            let down = 0;
            while (up < 40 && is(-up - 1)) up++;
            while (down < 40 && is(down + 1)) down++;
            return up + down + 1;
          },
          m.x,
          m.y,
          m.label,
        );
        if (hitH < THUMB) unreachable.push(`a name over the map takes a press over ${hitH} px`);
      }
      await press(m.x, m.y);
      if (fast) log(`fast: the name pressed ${Date.now() - moved} ms after the camera moved`);
    } else if (touch) {
      // (a name the map does not show, or covered: the sheet's row for it, by a finger)
      const who = await page.evaluate((oid) => window.rungame.asking().find((a) => a.id === oid)?.who, id);
      await tap('.run-sheet button.item', who);
    } else await page.evaluate((oid) => window.rungame.open(oid), id);
    log(`${template}: ${m ? 'tapped on the map' : 'opened from the list (its name is covered or off screen)'}`);
    await phase('petition', 10000);
    await page.waitForFunction(() => document.querySelectorAll('.dlg-choice').length > 0, { timeout: 20000, polling: 200 });
    if (!fast) await wait(600);
    if (first && !fast) await shot('loop-3-petition');
    const can = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.dlg-choice')].find((e) => e.textContent.includes('Agree.'));
      return !!b && !b.disabled && !b.classList.contains('disabled');
    });
    await tap('.dlg-choice', yes && can ? 'Agree.' : 'Not now.');
    if (first && !fast) {
      await wait(700);
      await shot('loop-3-answer');
      log(`after the answer: ${JSON.stringify(await page.evaluate(() => ({ talking: window.rungame.talking, phase: window.rungame.phase, choices: document.querySelectorAll('.dlg-choice').length, text: document.querySelector('.dlg-text')?.textContent?.slice(0, 60) })))} unreachable so far: ${JSON.stringify(unreachable)}`);
    }
    // (their answer, then a tap to close it)
    for (let k = 0; k < 40; k++) {
      if (!(await page.evaluate(() => window.rungame.talking))) break;
      await wait(fast ? 60 : 500);
      // (the dialog goes on at a press on its panel, not a click)
      const at = await page.evaluate(() => {
        const r = document.querySelector('.dlg-text')?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      });
      if (at) await press(at.x, at.y);
    }
    await phase('city|event', 20000);
    if (fast) {
      const rel = await releases();
      found.push(...rel);
      await page.evaluate(() => (window.__releases = []));
      log(`fast: answered ${Date.now() - moved} ms after the camera moved; its releases found the frame: ${JSON.stringify(rel)}`);
    }
    await playEvent();
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
  // (round 8) `--cards`: the card world in the 3D game — run with `--query '...&packs=laws,glitter,arena'
  // --leader ilveth --runlen 8`: a law card taken and the law in the list with a changed number, a chained arena bout
  // settled now, the glitter spire left to overload (the ending), run 2 in that world with the remains and the
  // salvage card. Stills `cards-*.png`.
  if (R.argv.includes('--cards')) {
    // (the first petition's stills kept: the guild's card shows the portrait slot when local/art has its picture)
    const cs = () =>
      page.evaluate(() => {
        const g = window.rungame;
        const r = g.realm;
        return { phase: g.phase, season: r?.season, run: g.run?.n, asking: r ? r.offers().filter((o) => o.status === 'offered').map((o) => o.template) : [], laws: r ? r.lawsInForce().map((x) => x.def.id) : [], ended: r?.ended ?? null, over: r?.over, focus: g.liveDebug().focus, marks: g.markers().filter((m) => m.kind === 'thing' || m.kind === 'done').map((m) => m.label), notes: g.notes };
      });
    const panel = async (label, name) => {
      await tap('.run-sheet .views button', label);
      await wait(500);
      await shot(name);
      const text = await page.evaluate(() => document.querySelector('.run-full')?.innerText ?? '');
      await tap('.run-full .acts button', 'Close');
      await wait(300);
      return text;
    };
    const want = ['laws-guild-rates', 'arena-dig-the-pit', 'glitter-raise-the-spire', 'glitter-salvage-hoverbikes', 'build:quarry'];
    const leave = ['glitter-overload'];
    let lawSeen = false;
    let changed = null;
    let bouts = 0;
    let settled = 0;
    let ended = null;
    let run2 = false;
    let remains = [];
    let salvage = false;
    for (let step = 0; step < 40; step++) {
      const s = await cs();
      log(`cards: ${JSON.stringify({ ...s, notes: s.notes.slice(-6) })}`);
      if (s.phase === 'end') {
        ended = await page.evaluate(() => ({ title: document.querySelector('.run-full h2')?.textContent, text: document.querySelector('.run-full')?.innerText?.slice(0, 600) }));
        await shot(run2 ? 'cards-9-end-2' : 'cards-6-end');
        if (run2) break;
        await tap('.run-full button.big', 'Start a new run');
        await phase('leader');
        await wait(800);
        await shot('cards-7-world-now');
        await pickLeader(leader);
        await phase('city|event');
        run2 = true;
        await wait(3000);
        await shot('cards-8-run2-town');
        continue;
      }
      if (s.phase === 'event') {
        const tpl = s.focus;
        log(`cards: event ${tpl}`);
        // (the arena's open bouts come back each time one is won — a loop the pack means: after three settled, the walk
        // leaves the bout running and lets the season's end settle it)
        if (settled >= 3) {
          for (let k = 0; k < 40; k++) {
            if (await page.evaluate(() => !!window.rungame.liveNow?.canLeave)) {
              await tap('.run-sheet .go button', 'Back to the town');
              break;
            }
            if ((await cs()).phase !== 'event') break;
            await wait(2000);
          }
          await phase('city|end|season', 120000).catch(() => {});
          continue;
        }
        await wait(9000);
        await shot(`cards-4-bout-${++bouts}`);
        let can = false;
        for (let k = 0; k < 30 && !can; k++) {
          can = await page.evaluate(() => !!window.rungame.liveNow?.canSettle);
          if (!can) await wait(2000);
        }
        if (bouts === 1) await shot('cards-4-bout-1b');
        if (can) {
          await tap('.run-sheet .views button', 'Settle it now');
          settled++;
          await phase('city|event|end', 30000);
          await wait(1500);
          await shot(`cards-5-settled-${settled}`);
        } else await phase('city|end', 200000);
        continue;
      }
      if (s.phase !== 'city') {
        if (s.phase === 'season') await page.evaluate(() => window.rungame.skip());
        await wait(1000);
        continue;
      }
      // (the city: remains and the salvage card in run 2)
      if (run2) {
        remains = s.marks.filter((m) => m.startsWith('remains of'));
        if (s.asking.includes('glitter-salvage-hoverbikes')) salvage = true;
      }
      for (const t of want) if (s.asking.includes(t)) await talk(t, true);
      for (const t of leave) if (s.asking.includes(t)) await talk(t, false);
      const after = await cs();
      if (after.phase !== 'city') continue;
      if (!lawSeen && after.laws.includes('laws-cheap-building')) {
        lawSeen = true;
        await wait(1200);
        await shot('cards-2-thing-marker');
        const t = await panel('Laws', 'cards-3-laws');
        log(`laws page: ${t.slice(0, 400)}`);
        // (the changed number: a building card's cost by law and as printed)
        changed = await page.evaluate(() => {
          const r = window.rungame.realm;
          return r
            .offers()
            .filter((o) => o.status === 'offered')
            .map((o) => ({ t: o.template, now: r.terms(o).costs, printed: o.opp.costs }))
            .find((x) => JSON.stringify(x.now) !== JSON.stringify(x.printed)) ?? null;
        });
        log(`a cost changed by law: ${JSON.stringify(changed)}`);
      }
      if (step === 6) {
        const t = await panel('Rules', 'cards-3-rules');
        log(`rules page: ${t.slice(0, 600)}`);
      }
      if (run2 && remains.length) {
        await shot('cards-8-run2-remains');
        const t = await panel('Remembered', 'cards-8-remembered');
        log(`remembered: ${t.slice(0, 600)}`);
        if (salvage) break;
      }
      await tap('.run-sheet .go button', 'Next season');
      await phase('season|event|end', 30000).catch(() => {});
      await shot(`cards-s${s.run ?? 1}-${s.season}-season`);
    }
    R.check('cards: a law card taken and its law in the list', lawSeen);
    R.check('cards: a number changed by a law (a cost)', !!changed, changed);
    R.check('cards: an arena bout played and settled now', settled > 0, { bouts, settled });
    R.check('cards: the run ended by the glitter spire', !!ended && /glitter|glass/i.test(ended.title + ended.text), ended);
    R.check('cards: run 2 shows the remains', remains.length > 0, remains);
    R.check('cards: run 2 deals the salvage card', salvage);
    return;
  }
  await playSeason();

  // (touch) a finger on the loop's own screens must not move the map: a tap and a swipe on the sheet, a tap on the top
  // bar; and a drag on the map itself still pans it (the player can look round)
  if (touch) {
    await wait(2500);
    const swipe = async (x0, y0, x1, y1) => {
      await page.touchscreen.touchStart(x0, y0);
      for (let k = 1; k <= 6; k++) {
        await page.touchscreen.touchMove(x0 + ((x1 - x0) * k) / 6, y0 + ((y1 - y0) * k) / 6);
        await wait(30);
      }
      await page.touchscreen.touchEnd();
      await wait(600);
    };
    const moved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.5 || Math.abs(a[3] - b[3]) > 0.01;
    const sheet = await page.evaluate(() => {
      const r = document.querySelector('.run-sheet h3').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    let c0 = await camAt();
    await press(sheet.x, sheet.y);
    await wait(500);
    if (moved(c0, await camAt())) pans.push('a tap on the sheet');
    c0 = await camAt();
    await swipe(sheet.x, sheet.y + 30, sheet.x + 40, sheet.y - 30);
    if (moved(c0, await camAt())) pans.push('a swipe on the sheet');
    c0 = await camAt();
    await press(200, 20);
    await wait(500);
    if (moved(c0, await camAt())) pans.push('a tap on the top bar');
    // (the map itself: a spot with no name under it)
    const free = await page.evaluate(() => {
      for (let y = 140; y < 420; y += 20)
        for (let x = 60; x < 300; x += 30) {
          const e = document.elementFromPoint(x, y);
          if (e && !e.closest('.run-marks button, .run-sheet, .run-top')) return { x, y };
        }
      return null;
    });
    c0 = await camAt();
    if (free) await swipe(free.x, free.y, free.x + 70, free.y + 50);
    const c1 = await camAt();
    const panned = free ? moved(c0, c1) : false;
    log(`touch: a drag on the map ${panned ? 'pans it' : 'does not pan it'} (${JSON.stringify({ free, from: c0.map(Math.round), to: c1.map(Math.round) })})`);
    R.check("touch: nothing on the loop's own screens moves the map", pans.length === 0, pans);
    R.check('touch: a drag on the map pans it', panned, { free });
    await page.evaluate(() => window.rungame.showTown());
    await wait(1800);
  }

  // 5: seasons pass until the attack (or the end)
  let n = 0;
  let mapped = false;
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
    if (touch) {
      if (await page.evaluate(() => window.rungame.phase === 'season' && window.rungame.canSkip)) await tap('.run-sheet .go button', 'Skip');
    } else await page.evaluate(() => window.rungame.canSkip && window.rungame.skip());
    n++;
    await phase('city|event|result|end', 120000);
    // (an event nobody asks about: refugees on the road)
    await playEvent();
    const s = await state();
    log(JSON.stringify(s));
    const news = await page.evaluate(() => window.rungame.notes);
    log(`news: ${JSON.stringify(news)}`);
    fired.push(...news.filter((t) => RULE_LINE.test(t) && !fired.includes(t)));
    // (a change in the land this season: the camera on it, a still)
    if (s.phase === 'city' && /flooded|burned|buried|Lava|founded/.test(news.join(' '))) {
      const seen = await page.evaluate(() => window.rungame.showLast());
      await wait(2600);
      await shot(`loop-6-change-s${s.season}-${seen ?? 'none'}`);
      await page.evaluate(() => window.rungame.showTown());
      await wait(1500);
    }
    // (--reload N: the tab closed in season N and opened again without fresh=1 — the same season, pools, board, cards
    // under way and land changes; LS-8)
    if (s.phase === 'city' && String(s.season) === opt('reload', '')) {
      const snap = () => page.evaluate(() => ({ land: window.rungame.land(), list: window.mutators.record().list.length, spells: window.rungame.run.spells, threatIn: window.rungame.run.threatIn, history: window.rungame.history().length }));
      await wait(1500);
      const before = { ...(await state()), ...(await snap()) };
      const u = new URL(page.url());
      u.searchParams.delete('fresh');
      await page.goto('about:blank');
      await page.goto(u.toString(), { waitUntil: 'load' });
      await page.waitForFunction(() => ['leader', 'city', 'event'].includes(window.rungame?.phase) || document.querySelector('.fatal'), { timeout: 300000, polling: 200 });
      await wait(3000);
      const after = { ...(await state()), ...(await snap()) };
      await shot(`loop-reload-s${s.season}`);
      log(`reload in season ${s.season}:
  before ${JSON.stringify(before)}
  after  ${JSON.stringify(after)}`);
      R.check('a reload mid-run comes back to the same season, pools, board and world changes', JSON.stringify(before) === JSON.stringify(after), { season: [before.season, after.season], phase: after.phase });
    }
    // (the world's map, once two things have changed: the mutators' badges for this run's changes)
    if (s.phase === 'city' && !mapped && (await page.evaluate(() => window.rungame.land().length)) >= 2) {
      mapped = true;
      await tap('.run-sheet .go button', 'Map');
      await wait(2500);
      await shot(`loop-9-map-s${s.season}`);
      log(`map: open ${await page.evaluate(() => window.reclaimed.scene.atlasMap.isOpen)}; this run's changes: ${JSON.stringify(await page.evaluate(() => window.rungame.land()))}`);
      const x = await page.evaluate(() => {
        const b = [...window.reclaimed.scene.atlasMap.el.querySelectorAll('button')].find((e) => e.textContent === '×');
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await press(x.x, x.y);
      await wait(600);
      R.check('the map opens from the sheet and closes by its own button', !(await page.evaluate(() => window.reclaimed.scene.atlasMap.isOpen)));
    }
    if (s.phase !== 'city') break;
    // (LS-45's bisect: the camera away from the town and back — the window slides off it — in one chosen season)
    if (String(s.season) === opt('trip', '')) {
      const watch = R.argv.includes('--watch');
      const dbg = async (what) => log(`${what}: ${JSON.stringify(await page.evaluate((w) => window.rungame.liveDebug(w), watch))}`);
      await dbg('before the trip');
      await wait(1500);
      await dbg('before the trip');
      await page.evaluate((d) => window.rungame.lookOff(d, 0), Number(opt('tripfar', '520')));
      await wait(5000);
      await shot(`loop-trip-s${s.season}`);
      await dbg('away');
      await page.evaluate(() => window.rungame.showTown());
      await wait(4000);
      await dbg('back');
      await wait(4000);
      await dbg('back, 4 s on');
      log(`trip: away and back in season ${s.season}`);
      if (opt('stop', '') === 'trip') return;
    }
    if (n % 4 === 0) await shot(`loop-5-city-s${s.season}`);
    await rune();
    await playSeason();
    if (n > 40) throw new Error('the attack never came');
  }
  log(`decisions a season: ${decisions.join(', ')}`);
  if (fast) {
    R.check('fast: petitions were answered with their camera frame still waiting behind camera moves, and begun after one (LS-54)', found.includes('waiting') && found.includes('held'), found.join(' '));
  }
  log(`${n} seasons in ${((Date.now() - t0) / 1000).toFixed(0)} s of wall time, the time-lapse skipped after 1.5 s: ${((Date.now() - t0) / 1000 / n).toFixed(1)} s a season with its petitions`);
  R.check('the decisions a season stay few', Math.max(...decisions) <= 5, decisions);

  // 7: the attack: the camera down the road, the raid called, the march, the fight, a spell cast, the result
  if ((await state()).phase === 'result' || (await page.evaluate(() => window.rungame.liveDebug().focus)) === 'raid') {
    met.add('raid');
    await wait(2500);
    await shot('loop-7-attack-road');
    // (arrived: raiders stand in the world, their places read — not only a group asked for)
    await page.waitForFunction(() => !!window.rungame.raidAt() || window.rungame.phase === 'result', { timeout: 120000, polling: 200 });
    const fight0 = await page.evaluate(() => (window.rungame.raidAt() ? window.rungame.fightView() : null) ?? null);
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
      const st = await page.evaluate(() => ({ phase: window.rungame.phase, f: window.rungame.fightView(), at: window.rungame.raidAt(), spell: window.rungame.run.spells[0] ?? null, zoom: window.reclaimed.camera.zoom }));
      if (st.phase !== 'event') break;
      soldiers0 = Math.max(soldiers0, st.f?.soldiers ?? 0);
      if (frames.length < 120) frames.push(await page.screenshot({ type: 'png' }));
      if (k % 5 === 0) {
        fs.writeFileSync(path.join(out, 'frames', `f-${String(k).padStart(3, '0')}.png`), frames[frames.length - 1]);
        log(`attack ${k}: ${st.f?.stage} raiders ${st.f?.alive} soldiers ${st.f?.soldiers} at ${st.at?.map((v) => Math.round(v))} zoom ${st.zoom.toFixed(1)}`);
        if (k % 10 === 0) log(`who is where: ${JSON.stringify(await page.evaluate(() => window.rungame.liveDebug()))}`);
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
        const before = await page.evaluate(() => window.rungame.fightView().alive);
        {
          const v = await page.evaluate(() => ({ top: document.querySelector('.run-top')?.getBoundingClientRect().bottom ?? 0, sheet: document.querySelector('.run-sheet')?.getBoundingClientRect().top ?? innerHeight }));
          R.check('the fight: the raiders are in view, between the top bar and the sheet', at[1] > v.top + 12 && at[1] < v.sheet - 8 && at[0] > 12 && at[0] < 400, { at: at.map(Math.round), top: Math.round(v.top), sheet: Math.round(v.sheet) });
        }
        await press(at[0], at[1]);
        await wait(350);
        await shot('loop-7-attack-spell');
        frames.push(await page.screenshot({ type: 'png' }));
        await wait(1200);
        const after = await page.evaluate(() => window.rungame.fightView()?.alive ?? 0);
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
    fired.push(...(await page.evaluate(() => window.rungame.resultLines)).filter((t) => RULE_LINE.test(t)));
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
  // (touch) the end screen's own way on: its button, by a finger, to the leader screen
  if (touch) {
    await tap('.run-full button.big', 'Start a new run');
    await phase('leader', 10000);
  }
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
  await pickLeader('dunstan');
  await phase('city', 10000);
  await wait(2500);
  await shot('loop-8-newrun-city');
  const again = await page.evaluate(() => ({ run: window.rungame.run.n, before: window.rungame.before().length }));
  log(`new run: ${JSON.stringify(again)} ${JSON.stringify(await state())}`);
  R.check('the new run is run 2 of the same world', again.run === 2 && again.before >= ended.history.length, again);
  if (touch) R.check(`touch: every control pressed was on the screen, not covered, and at least ${THUMB} px tall`, unreachable.length === 0, [...new Set(unreachable)]);
  // (round 6) what this walk met: `--need gate-parade,market-fire,rune,rule` fails unless it met each
  log(`live events met: ${[...met].join(', ') || 'none'}; growth runes drawn: ${runes}; rules that fired: ${JSON.stringify(fired)}`);
  for (const what of opt('need', '').split(',').filter(Boolean)) R.check(`this walk met: ${what}`, what === 'rune' ? runes > 0 : what === 'rule' ? fired.length > 0 : met.has(what), { met: [...met], runes, fired });
});
