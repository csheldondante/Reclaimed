// (round 128e) The fortress the way the user starts it: the start menu's Fortress button, then everything by finger at
// the phone's size (412x915) — pick Houses, tap the ground to plan, tap Build, watch the builders come out and work, tap
// Plan (the build menu comes back), tap Build again. The user: "Reopening build doesn't seem to work … The agents never
// appeared for me to begin work."
//   node scripts/fortressmenu.mjs [--out C:/Projects/shots88/fortress]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
await run({ name: 'fortressmenu', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const page = await R.page();
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const tap = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(700);
  };
  /** a button's middle on screen (by its text, or a selector) */
  const where = (sel, text) =>
    page.evaluate(
      (sel, text) => {
        const b = [...document.querySelectorAll(sel)].find((e) => (text === null || e.textContent.trim() === text) && e.getBoundingClientRect().width > 0);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      },
      sel,
      text,
    );
  const tapButton = async (text, sel = '.fort-bar button') => {
    const p = await where(sel, text);
    if (!p) throw new Error(`no visible button "${text}"`);
    await tap(...p);
  };
  await page.goto(`${R.url}/${process.env.Q ? `?q=${process.env.Q}` : ""}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('[data-a="fortress"]') || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await sleep(1500);
  const fb = await where('[data-a="fortress"]', null);
  if (!fb) throw new Error('no Fortress button on the start menu');
  // (the menu reloads the page with the fortress's address)
  await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 120000 }), tap(...fb)]);
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(3000);
  console.log('url', await page.evaluate(() => location.search));
  const barTop = await page.evaluate(() => document.querySelector('.fort-bar').getBoundingClientRect().top);
  // (FT-48) Inspect on the old town: taps on its buildings (the camera starts over it) show their card
  await tapButton('Inspect');
  // (where on screen the town's buildings are: the same press a tap makes, over a grid — then real taps on two of them)
  const spots = await page.evaluate((barTop) => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const out = [];
    const seen = new Set();
    for (let y = 120; y < barTop - 20; y += 40)
      for (let x = 30; x < 400; x += 40) {
        if (!f.press(Rc.camera.ray(x, y), -1) || !f.inspectedTown) continue;
        const k = f.inspectedTown.mega ?? f.inspectedTown.use ?? f.inspectedTown.kind;
        if (!seen.has(k)) out.push({ x, y, k });
        seen.add(k);
      }
    f.inspectedTown = null;
    return out;
  }, barTop);
  console.log('town spots', JSON.stringify(spots));
  const townCards = [];
  for (const { x, y } of spots.slice(0, 3)) {
    await tap(x, y);
    townCards.push(await page.evaluate(() => [...document.querySelectorAll('.fort-info p')].map((e) => e.textContent)));
  }
  console.log('town cards', JSON.stringify(townCards));
  if (OUT) await page.screenshot({ path: `${OUT}/menu-inspect-town.png` });
  await tapButton('Inspect');
  // plan houses by finger: a few taps on the ground above the bar
  await tapButton('Houses');
  for (const [x, y] of [[206, barTop - 200], [236, barTop - 220], [176, barTop - 180], [206, barTop - 260]]) await tap(x, y);
  const planned = await page.evaluate(() => window.reclaimed.fortress.plan.totals({}).blocks);
  console.log('planned', planned);
  if (OUT) await page.screenshot({ path: `${OUT}/menu-plan.png` });
  await tapButton('Build');
  await sleep(8000);
  const people = () =>
    page.evaluate(() => {
      const Rc = window.reclaimed;
      const life = Rc.fortressCrowd();
      if (!life) return { life: false };
      const us = life.ids.map((id) => Rc.units.get(id)).filter(Boolean);
      return {
        life: true,
        n: us.length,
        alive: us.filter((u) => u.alive).length,
        at: us.slice(0, 3).map((u) => u.at.map((v) => Math.round(v))),
        onScreen: us.filter((u) => {
          const [x, y] = Rc.camera.project(u.at[0], u.at[1], u.at[2]);
          return x >= 0 && y >= 0 && x < 412 && y < 915;
        }).length,
        stats: { ...life.stats },
        mode: Rc.fortress.mode,
        speed: Rc.scene.speed,
        built: Rc.fortress.progress(),
      };
    });
  const p1 = await people();
  const crew = await page.evaluate(() => [...document.querySelectorAll('.fort-info p')].map((e) => e.textContent));
  console.log('after Build', JSON.stringify(p1), JSON.stringify(crew));
  if (OUT) await page.screenshot({ path: `${OUT}/menu-build.png` });
  // a close look at the first of them
  await page.evaluate(() => {
    const Rc = window.reclaimed;
    const u = Rc.units.get(Rc.fortressCrowd().ids[0]);
    if (!u) return;
    Rc.camera.target[0] = u.at[0];
    Rc.camera.target[1] = u.at[1] + 4;
    Rc.camera.zoom = 16;
  });
  await sleep(2500);
  if (OUT) await page.screenshot({ path: `${OUT}/menu-builder-near.png` });
  await page.evaluate(() => {
    const Rc = window.reclaimed;
    Rc.camera.zoom = 6;
  });
  await sleep(1000);
  // (the user's way: Inspect pressed while building, a tap on the town, then Plan)
  await tapButton('Inspect');
  await tap(206, barTop - 200);
  await tapButton('Plan');
  await sleep(1000);
  const menu = await page.evaluate(() => {
    const vis = (t) => [...document.querySelectorAll('.fort-bar button')].some((b) => b.textContent.trim() === t && b.getBoundingClientRect().width > 0);
    return { houses: vis('Houses'), erase: vis('Erase'), build: vis('Build'), mode: window.reclaimed.fortress.mode, speed: window.reclaimed.scene.speed };
  });
  console.log('after Plan', JSON.stringify(menu));
  if (OUT) await page.screenshot({ path: `${OUT}/menu-replan.png` });
  // plan one more, and build again
  await tapButton('Houses');
  await tap(266, barTop - 240);
  await tapButton('Build');
  await sleep(4000);
  const p2 = await people();
  console.log('after Build again', JSON.stringify(p2));
  // (FT-50) the time row: 16x, then Skip to done until the plan stands
  await tapButton('16x');
  const sp16 = await page.evaluate(() => window.reclaimed.scene.speed);
  await tapButton('Skip to done');
  const skipSpeed = await page.evaluate(() => window.reclaimed.scene.speed);
  const t0 = Date.now();
  await page.waitForFunction(() => window.reclaimed.fortress.note, { timeout: 240000, polling: 500 });
  const skipped = await page.evaluate(() => ({ note: window.reclaimed.fortress.note, built: window.reclaimed.fortress.progress(), speed: window.reclaimed.scene.speed, bar: [...document.querySelectorAll('.fort-info p')].map((e) => e.textContent) }));
  console.log('skip', Math.round((Date.now() - t0) / 1000), 's', JSON.stringify({ sp16, skipSpeed, ...skipped }));
  if (OUT) await page.screenshot({ path: `${OUT}/menu-skipped.png` });
  // a plan the stores can't pay for: Skip stops early and says what's short
  await tapButton('Plan');
  const tall = await page.evaluate(() => {
    const f = window.reclaimed.fortress;
    const s = f.plan.structures()[0];
    const c = [...s.cells.keys()][0];
    let n = 0;
    for (let l = f.plan.top(c) + 1; n < 3; l++, n++) if (!f.paint(c, l, 'house')) break;
    // (the stores emptied of wood and stone, nothing coming in)
    const st = window.reclaimed.settlements;
    const rec = st.settlement(st.pinnedId);
    for (const g of ['log', 'stone']) rec.stores[g] = { stock: 0, rate: 0 };
    return n;
  });
  await tapButton('Build');
  await tapButton('Skip to done');
  await page.waitForFunction(() => window.reclaimed.fortress.note, { timeout: 300000, polling: 500 });
  const short = await page.evaluate(() => ({ note: window.reclaimed.fortress.note, built: window.reclaimed.fortress.progress(), stores: window.reclaimed.fortress.stores(), speed: window.reclaimed.scene.speed }));
  console.log('skip short', tall, JSON.stringify(short));
  if (OUT) await page.screenshot({ path: `${OUT}/menu-skip-short.png` });
  R.check('16x runs time at 16; Skip runs it faster', sp16 === 16 && skipSpeed > 16, JSON.stringify({ sp16, skipSpeed }));
  R.check('Skip to done stops when the plan stands, back at the speed picked', skipped.note === 'Everything you planned is built.' && skipped.built.built === skipped.built.total && skipped.speed === 16, JSON.stringify(skipped));
  R.check('Skip stops early when the stores run short, and says what is short', /^Skip stopped\. The stores need/.test(short.note ?? '') && short.built.built < short.built.total, JSON.stringify(short));
  // a builder out in the open, close up: is it drawn?
  const out = await page.evaluate(async () => {
    const Rc = window.reclaimed;
    const life = Rc.fortressCrowd();
    for (let k = 0; k < 60; k++) {
      const h = Rc.settlements.spotsOf(Rc.settlements.pinnedId).find((s) => s.kind === 'pile').w;
      const u = life.ids.map((id) => Rc.units.get(id)).find((u) => u && Math.hypot(u.at[0] - h[0], u.at[1] - h[1]) > 14);
      if (u) {
        Rc.camera.target[0] = u.at[0];
        Rc.camera.target[1] = u.at[1] + 3;
        Rc.camera.zoom = 20;
        return u.at.map(Math.round);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  });
  await sleep(600);
  console.log('out in the open', JSON.stringify(out), JSON.stringify(await page.evaluate(() => {
    const Rc = window.reclaimed;
    return Rc.fortressCrowd().ids.map((id) => Rc.units.get(id)).map((u) => Rc.camera.project(u.at[0], u.at[1], u.at[2]).map(Math.round).join(','));
  })));
  if (OUT) await page.screenshot({ path: `${OUT}/menu-builder-open.png` });
  R.check("Inspect shows the old town's buildings", townCards.some((c) => c.length > 1 && /before your fortress/.test(c.join(' '))), JSON.stringify(townCards));
  R.check('the builders came out on Build, on screen, and the bar says what they do', p1.life && p1.alive > 0 && p1.onScreen > 0 && crew.some((l) => /^\d+ builders\./.test(l)), JSON.stringify([p1, crew]));
  R.check('they work (loads brought)', p2.stats?.trips > 0 || p2.built?.built > 0, JSON.stringify(p2));
  R.check('Plan brings the build menu back', menu.houses && menu.erase && menu.build && menu.mode === 'plan', JSON.stringify(menu));
  R.check('Build again runs time', p2.mode === 'build' && p2.speed > 0, JSON.stringify(p2));
});
