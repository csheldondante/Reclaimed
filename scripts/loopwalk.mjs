// (loop-skeleton; docs/design/LOOP_SKELETON.md) The main loop's walk-through at phone size (412x915), a still a moment:
// pick a leader, the town, a petition, the cost committed, the season passing, the threat, the attack, its result, a
// world change, the end of the run, and a new run in the same world. Drives the page by its own buttons.
//   node scripts/loopwalk.mjs [--out <dir>] [--leader ilveth] [--agree tower,mine,barracks] [--query ...] [--gif 0]
// The default walk prepares (a barracks, the tower's heat ray) and should hold the town; `--leader dunstan --agree forge`
// prepares nothing and should be sacked. It fails unless the raid arrives (LS-16).
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
  const leader = opt('leader', 'ilveth');
  const agree = opt('agree', 'tower,mine,barracks').split(',');
  const query = opt('query', 'skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low');
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
    log(`shot ${name}: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.run-sheet h3, .run-full h2, .run-top .r-title')].map((e) => e.textContent)))}`);
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
  const state = () => page.evaluate(() => ({ phase: window.rungame.phase, season: window.rungame.run?.season, hand: window.rungame.run?.hand, due: window.rungame.run?.due.length, changes: window.rungame.world.changes.map((c) => c.id), places: window.rungame.world.places.map((p) => `${p.id}:${p.status}`) }));

  // (BACKLOG LS-12: in some headless boots the town's first make holds the GPU for about 30 s and the page's 20 s
  // watchdog puts the fatal overlay up. That boot is thrown away and counted, never walked)
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

  // 2: the town under the chosen leader
  await tap('.run-full .leader', { ysolt: 'Ysolt', dunstan: 'Dunstan', ilveth: 'Ilveth' }[leader]).catch(() => null);
  await page.evaluate((who) => {
    const box = [...document.querySelectorAll('.run-full .leader')].find((e) => e.textContent.toLowerCase().includes(who));
    box.querySelector('button').click();
  }, leader);
  await phase('city');
  await wait(2500);
  await shot('loop-2-city');
  log(JSON.stringify(await state()));

  // 3 + 4: a named character's petition, and its cost committed
  let first = true;
  const playSeason = async () => {
    const s = await state();
    for (const id of agree) {
      if (!s.hand.some((h) => h.id === id)) continue;
      // (the first one by its name over the map; the rest by the list)
      const viaMarker = first && (await page.evaluate((pid) => !!window.rungame.markers().find((m) => m.id === pid), id));
      if (viaMarker) {
        // (a real tap on the middle of the name over the map)
        const m = await page.evaluate((pid) => {
          const g = window.rungame.markers().find((x) => x.id === pid);
          const b = [...document.querySelectorAll('.run-marks button')].find((e) => e.textContent === g.label);
          const r = b.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, id);
        await page.mouse.click(m.x, m.y);
      } else await page.evaluate((pid) => window.rungame.open(pid), id);
      await phase('petition', 10000);
      const got = await page.evaluate(() => window.rungame.selected?.id);
      if (got !== id) throw new Error(`tapped ${id}, the card shown is ${got}`);
      await wait(1600);
      if (first) await shot('loop-3-petition');
      const can = await page.evaluate(() => !document.querySelector('.run-sheet .go button').disabled);
      await tap('.run-sheet .go button', can ? 'Agree' : 'Not now');
      await phase('city|mutation', 10000);
      await phase('city', 30000);
      await wait(1200);
      if (first) await shot('loop-4-allocated');
      first = false;
    }
  };
  await playSeason();

  // 6: the threat, visible from the first season with its countdown
  await page.evaluate(() => window.rungame.open('raiders'));
  await phase('petition', 10000);
  await wait(1600);
  await shot('loop-6-threat');
  await tap('.run-sheet .go button', 'Not now');
  await phase('city');

  // 5: seasons pass until the attack (or the end)
  let n = 0;
  let mut = 0;
  for (;;) {
    await wait(600);
    await tap('.run-sheet .go button', 'Next season');
    await phase('season', 10000);
    await wait(n === 0 ? 9000 : 3000);
    if (n === 0) await shot('loop-5-season');
    else await shot(`loop-5-season${n + 1}`);
    n++;
    // (the rest of the time-lapse, then any reveal)
    for (;;) {
      await phase('city|attack|result|end|mutation', 120000);
      const s = await state();
      if (s.phase !== 'mutation') break;
      await wait(2800);
      await shot(mut === 0 ? 'loop-8-mutation' : `loop-8-mutation${mut + 1}`);
      mut++;
      await page.waitForFunction(() => window.rungame.phase !== 'mutation', { timeout: 60000, polling: 200 });
    }
    const s = await state();
    log(JSON.stringify(s));
    if (s.phase !== 'city') break;
    await playSeason();
    if (n > 8) throw new Error('the attack never came');
  }

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
    log(`war: ${JSON.stringify(await page.evaluate(() => window.rungame.resultLines))}`);
    await tap('.run-sheet .go button', 'Continue');
    for (;;) {
      await phase('end|mutation', 60000);
      if ((await state()).phase !== 'mutation') break;
      await wait(2800);
      await shot(mut === 0 ? 'loop-8-mutation' : `loop-8-mutation${mut + 1}`);
      mut++;
      await page.waitForFunction(() => window.rungame.phase !== 'mutation', { timeout: 60000, polling: 200 });
    }
  }
  await phase('end', 60000);
  await wait(800);
  await shot('loop-8-end');
  log(JSON.stringify(await state()));
  // (jump to a change in the town from the list, if there is one)
  const show = await page.evaluate(() => !!document.querySelector('.run-full button.small'));
  if (show) {
    await tap('.run-full button.small', 'Show');
    await wait(2500);
    await shot('loop-8-end-show');
    await tap('.run-sheet .go button', 'Back to the list');
  }
  // a new run in the same world: the leader screen remembers, the town still carries the tags
  await tap('.run-full button.big', 'Start a new run');
  await phase('leader', 10000);
  await wait(500);
  await shot('loop-8-newrun-leader');
  await page.evaluate(() => [...document.querySelectorAll('.run-full .leader')].find((e) => e.textContent.includes('Dunstan')).querySelector('button').click());
  await phase('city', 10000);
  await wait(2500);
  await shot('loop-8-newrun-city');
  log(JSON.stringify(await state()));
  // the saved world: the store holds the record
  log(`saved: ${JSON.stringify(await page.evaluate(() => ({ world: !!window.reclaimed.stream?.store?.has('loop:world'), mutators: !!window.reclaimed.stream?.store?.has('loop:mutators') })))}`);
});
