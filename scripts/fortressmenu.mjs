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
  // plan houses by finger: a few taps on the ground above the bar
  await tapButton('Houses');
  const barTop = await page.evaluate(() => document.querySelector('.fort-bar').getBoundingClientRect().top);
  for (const [x, y] of [[206, barTop - 200], [236, barTop - 220], [176, barTop - 180], [206, barTop - 260]]) await tap(x, y);
  const planned = await page.evaluate(() => window.reclaimed.fortress.plan.totals({}).blocks);
  console.log('planned', planned);
  if (OUT) await page.screenshot({ path: `${OUT}/menu-plan.png` });
  await tapButton('Build');
  await sleep(8000);
  const people = () =>
    page.evaluate(() => {
      const Rc = window.reclaimed;
      const life = Rc.fortressLife();
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
  console.log('after Build', JSON.stringify(p1));
  if (OUT) await page.screenshot({ path: `${OUT}/menu-build.png` });
  // a close look at the first of them
  await page.evaluate(() => {
    const Rc = window.reclaimed;
    const u = Rc.units.get(Rc.fortressLife().ids[0]);
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
  // a builder out in the open, close up: is it drawn?
  const out = await page.evaluate(async () => {
    const Rc = window.reclaimed;
    const life = Rc.fortressLife();
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
    return Rc.fortressLife().ids.map((id) => Rc.units.get(id)).map((u) => Rc.camera.project(u.at[0], u.at[1], u.at[2]).map(Math.round).join(','));
  })));
  if (OUT) await page.screenshot({ path: `${OUT}/menu-builder-open.png` });
  R.check('the builders came out on Build', p1.life && p1.alive > 0, JSON.stringify(p1));
  R.check('they work (loads brought)', p2.stats?.trips > 0 || p2.built?.built > 0, JSON.stringify(p2));
  R.check('Plan brings the build menu back', menu.houses && menu.erase && menu.build && menu.mode === 'plan', JSON.stringify(menu));
  R.check('Build again runs time', p2.mode === 'build' && p2.speed > 0, JSON.stringify(p2));
});
