// (card-table, docs/design/FACTORY.md) Phone-size stills of the board's factory game (412x915), driven through the
// page's own controls: taps on the map's markers and the sheet's buttons, "Next season". Needs the board's dev server
// (default https://localhost:5460). node scripts/boardstills.mjs [--server https://localhost:5460] [--out local/board2]
// Writes NN-name.png and log.txt (each step, the stock, the cards, the news). Exits non-zero on a page error.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const server = arg('server', 'https://localhost:5460');
const out = arg('out', 'local/board2');
fs.mkdirSync(out, { recursive: true });
const log = [];
const say = (s) => (console.log(s), log.push(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--ignore-certificate-errors'], defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
const page = await b.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !/favicon|404/.test(m.text()) && errors.push(m.text()));
await page.goto(`${server}/board.html?seed=7`, { waitUntil: 'load' });
await page.waitForFunction(() => window.board?.state?.(), { timeout: 60000 });
await sleep(2500);
let n = 0;
/** the whole town in view, as the page opens (for the stills that compare seasons) */
const overview = async () => {
  await page.evaluate(() => {
    const [x, y] = window.board.scene.siteXY('keep');
    Object.assign(window.board.cam, { x, y: y + 30, zoom: 0.72 });
  });
  await sleep(300);
};
const shot = async (name) => {
  n++;
  const f = path.join(out, `${String(n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f });
  say(`shot ${path.basename(f)}`);
  const err = await page.$('#err');
  if (err) throw new Error(`fatal overlay: ${await page.evaluate((e) => e.textContent, err)}`);
};
const st = () =>
  page.evaluate(() => {
    const s = window.board.state();
    return { season: s.season, stock: s.stock.filter((x) => x.have).map((x) => `${x.k} ${x.have}`).join(', '), crews: s.crews, offers: s.offers.map((o) => `${o.card.title}${Object.keys(o.card.short).length ? ' (short)' : ''}`), works: s.works.map((w) => `${w.name} ${w.clicks ? `${w.clicks.left}/${w.clicks.of}` : '-'}${w.ready ? ' READY' : ''}`) };
  });
const where = (site) => page.evaluate((k) => window.board.where(k), site);
/** tap a site on the map (its chip or its ground) */
const tapSite = async (site) => {
  // (the player pans to it first: the camera is set over the place, as a drag would)
  await page.evaluate((k) => {
    const [x, y] = window.board.scene.siteXY(k);
    window.board.cam.x = x;
    window.board.cam.y = y + 40;
  }, site);
  await sleep(200);
  const [x, y] = await where(site);
  await page.mouse.click(x, y - 10);
  await sleep(500);
};
/** tap an offer's marker on the map */
const tapOffer = async (title) => {
  // (the player pans to the card's place first)
  await page.evaluate((t) => {
    const o = window.board.state().offers.find((x) => x.card.title === t);
    const k = o ? window.board.offerAt(o.card.id) : null;
    const [x, y] = window.board.scene.siteXY(k ?? 'keep');
    window.board.cam.x = x;
    window.board.cam.y = y - 40;
  }, title);
  await sleep(250);
  const hit = await page.evaluate((t) => {
    const o = window.board.state().offers.find((x) => x.card.title === t);
    const h = window.board.hits().find((x) => x.act.kind === 'offer' && x.act.id === o?.card.id);
    return h ? [h.x, h.y] : null;
  }, title);
  if (!hit) return false;
  await page.mouse.click(hit[0], hit[1]);
  await sleep(500);
  return true;
};
/** a button of the page pressed (its own click handler; the sheet is drawn again after each move, so the element is
 *  found and pressed in one step) */
const click = async (sel) => {
  const ok = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el || el.disabled) return false;
    el.click();
    return true;
  }, sel);
  await sleep(350);
  return ok;
};
const closeSheet = () => click('#sheet [data-do="close"]');
const next = async (shotAt, name) => {
  await click('[data-act="next"]');
  if (shotAt) {
    await sleep(shotAt);
    await shot(name);
  }
  await page.waitForFunction(() => !document.querySelector('[data-act="next"]')?.disabled, { timeout: 30000 });
  await sleep(400);
  const news = await page.evaluate(() => window.board.table().log.filter((l) => l.season === window.board.table().season - 1 || l.season === window.board.table().season).slice(-8).map((l) => l.text));
  say(`  news: ${news.join(' / ')}`);
};
const post = async (thing) => click(`#sheet [data-do="post"][data-id="${thing}"]`);
const use = async (id) => click(`#sheet [data-do="use"][data-use="${id}"]`);
const T = (id) => `thing:factory-${id}`;

try {
  say(`S1 ${JSON.stringify(await st())}`);
  await shot('board');
  // ---- season 1: post crews, harvest and bake, fell; build the sawmill and the quarry ----
  await tapSite('fields');
  await post(T('fields'));
  await use('factory-harvest');
  await sleep(1500);
  await closeSheet();
  await tapSite('mill');
  await post(T('bakery'));
  await shot('sheet-recipes');
  await page.evaluate(() => document.querySelector('#sheet [data-use="factory-bake"]').click());
  await sleep(420);
  await shot('conversion-in-flight');
  await sleep(1500);
  await closeSheet();
  await tapSite('woods');
  await post(T('woodcutters'));
  await use('factory-fell');
  await closeSheet();
  await sleep(1200);
  for (const t of ['Build a sawmill', 'Open the quarry']) {
    if (await tapOffer(t)) {
      if (t === 'Build a sawmill') await shot('card-preview');
      await click('#sheet [data-do="take"]');
      await sleep(900);
    }
  }
  await closeSheet();
  await overview();
  await shot('season1-after-turn');
  say(`S1 end ${JSON.stringify(await st())}`);
  await next(2200, 'timelapse-season2');
  say(`S2 ${JSON.stringify(await st())}`);
  // ---- season 2: a card short of planks; its chain of clicks; then commit ----
  const shortCard = await page.evaluate(() => window.board.state().offers.find((o) => Object.keys(o.card.short).length && !o.card.threat && window.board.table().chain(o.card.id)?.length)?.card.title ?? null);
  say(`  short card with a chain: ${shortCard}`);
  if (shortCard) {
    await tapOffer(shortCard);
    await shot('card-shortfall');
    const chain = await page.evaluate((t) => window.board.table().chain(window.board.state().offers.find((o) => o.card.title === t).card.id), shortCard);
    say(`  chain: ${chain.map((c) => c.name).join(' -> ')}`);
    await closeSheet();
    // (the chain, by the page's own taps: each step's building opened, a crew posted where it says, the recipe made)
    for (const c of chain) {
      const site = await page.evaluate((id) => window.board.state().works.find((w) => w.id === id)?.site, c.thing);
      await tapSite(site);
      if (!c.use) await post(c.thing);
      else await use(c.use);
      await closeSheet();
    }
    await tapOffer(shortCard);
    await shot('chain-done-card-ready');
    await click('#sheet [data-do="take"]');
    await sleep(700);
    await shot('card-committed');
  }
  // (the rest of the season: the posted crews click what they can)
  for (const [site, thing, recipe] of [['fields', 'fields', 'factory-harvest'], ['mill', 'bakery', 'factory-bake'], ['woods', 'woodcutters', 'factory-fell']]) {
    await tapSite(site);
    await use(recipe);
    await closeSheet();
    void thing;
  }
  say(`S2 end ${JSON.stringify(await st())}`);
  await next(0);
  say(`S3 ${JSON.stringify(await st())}`);
  await overview();
  await sleep(2500);
  await shot('season3-town');
  // ---- season 3 and 4: keep the bread up, take what can be taken ----
  for (let s = 3; s <= 4; s++) {
    for (const [site, recipe] of [['fields', 'factory-harvest'], ['mill', 'factory-bake'], ['woods', 'factory-fell'], ['quarry', 'factory-cut'], ['river', 'factory-saw']]) {
      await tapSite(site);
      const thing = await page.evaluate((k) => window.board.state().works.find((w) => w.site === k && w.clicks)?.id ?? null, site);
      if (thing) {
        const c = await page.evaluate((id) => window.board.state().works.find((w) => w.id === id).clicks, thing);
        if (c.of === 0 && (await page.evaluate(() => window.board.state().crews.free))) await post(thing);
        await use(recipe);
      }
      await closeSheet();
    }
    const can = await page.evaluate(() => window.board.state().offers.filter((o) => !Object.keys(o.card.short).length && o.card.template.startsWith('factory-')).map((o) => o.card.title));
    if (can[0]) {
      await tapOffer(can[0]);
      await click('#sheet [data-do="take"]');
      await sleep(600);
    }
    say(`S${s} end ${JSON.stringify(await st())}`);
    await next(s === 4 ? 1800 : 0, 'timelapse-upkeep');
  }
  say(`S5 ${JSON.stringify(await st())}`);
  // ---- on until a need runs out at its deadline: the season's news, mid-lapse ----
  for (let s = 5; s <= 10; s++) {
    const lapsed = await page.evaluate(() => window.board.table().lapsed.length);
    await click('[data-act="next"]');
    await sleep(1800);
    const now = await page.evaluate(() => window.board.table().lapsed.length);
    if (now > lapsed) {
      await shot('need-failed');
      const lines = await page.evaluate(() => window.board.table().log.filter((l) => l.season >= window.board.table().season - 1).map((l) => l.text));
      say(`  lapsed at S${s}: ${lines.join(' / ')}`);
      await page.waitForFunction(() => !document.querySelector('[data-act="next"]')?.disabled, { timeout: 30000 });
      await sleep(500);
      await shot('after-need-failed');
      break;
    }
    await page.waitForFunction(() => !document.querySelector('[data-act="next"]')?.disabled, { timeout: 30000 });
    await sleep(300);
  }
  // ---- zoomed in: titles and names ----
  await page.evaluate(() => {
    window.board.cam.zoom = 1.3;
  });
  await sleep(500);
  await shot('zoomed-in-labels');
} catch (e) {
  errors.push(String(e.stack ?? e));
}
fs.writeFileSync(path.join(out, 'log.txt'), [...log, ...errors.map((e) => `ERROR ${e}`)].join('\n'));
await b.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
