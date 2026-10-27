// ?story=demo played headlessly at phone size (round 83, dialog): the markers, a talk with Wren (the camera
// framing her, her line typed, the answers), the promise, the walk to the sluice (the camera's target moved,
// as a pan would), the reveal shot of the camp greening, and the end card after telling Wren.
//
//   node scripts/storyshot.mjs [--url http://localhost:5227/] [--size 412x915] [--out shots/story]
// Writes <out>-1-markers.png, -2-dialog.png, -3-reveal.png, -4-end.png. Exits non-zero on a page error.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') && acc.push([a.slice(2), arr[i + 1]]), acc), []),
);
const base = args.url ?? 'http://localhost:5227/';
const [w, h] = (args.size ?? '412x915').split('x').map(Number);
const out = args.out ?? 'shots/story';
fs.mkdirSync(path.dirname(out), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${w},${h}`],
  defaultViewport: { width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => {
    failed = true;
    console.log(`[pageerror] ${e.message}`);
  });
  await page.goto(`${base}?skipmenu=1&story=demo&tod=0.3`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.story, { timeout: 90000 });
  // (the opening shot eases to the camp)
  await page.waitForFunction(() => !reclaimed.story.cam.busy, { timeout: 30000 });
  await sleep(1000);
  const fatal = await page.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal: ${fatal}`);
  await page.screenshot({ path: `${out}-1-markers.png` });
  console.log('objectives', JSON.stringify(await page.evaluate(() => reclaimed.story.run.objectives())));

  // tap Wren's badge (its centre), as a finger would
  const badge = await page.evaluateHandle(() => [...document.querySelectorAll('.story-badge')].find((b) => b.textContent.includes('Wren')));
  const box = await badge.boundingBox();
  const at = await page.evaluate((b) => {
    const r = b.querySelector('.i').getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  }, badge);
  console.log('badge', JSON.stringify(box), 'tap', at);
  await page.touchscreen.tap(at[0], at[1]);
  await sleep(500);
  console.log('tapped', await page.evaluate(() => reclaimed.story.dialog.tree?.speaker));
  // (headless frames are slow: wait for the framing to land)
  await page.waitForFunction(() => !reclaimed.story.cam.move, { timeout: 20000 });
  console.log('camera', JSON.stringify(await page.evaluate(() => ({ t: reclaimed.core.camera.target, zoom: reclaimed.core.camera.zoom }))));
  console.log('open', await page.evaluate(() => reclaimed.story.dialog.isOpen));
  await sleep(2500);
  // (the line typed out by now; the answers in)
  await page.screenshot({ path: `${out}-2-dialog.png` });
  const choose = async (text) => {
    const ok = await page.evaluate((t) => {
      const b = [...document.querySelectorAll('.dlg-choice')].find((x) => x.textContent.includes(t));
      b?.click();
      return !!b;
    }, text);
    if (!ok) throw new Error(`no answer "${text}"`);
    await sleep(300);
    // (tap through the typing)
    await page.evaluate(() => document.querySelector('.dlg-scrim').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await sleep(300);
  };
  await choose('could use some help');
  await choose("I'll open it");
  // (the promise node has no answers: a tap closes it)
  await page.evaluate(() => document.querySelector('.dlg-scrim').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await sleep(1500);
  console.log('after talk', JSON.stringify(await page.evaluate(() => ({ open: reclaimed.story.dialog.isOpen, busy: reclaimed.story.cam.busy, obj: reclaimed.story.run.objectives() }))));

  // to the sluice (the camera's target, as a pan would take it), then the reveal of the camp
  await page.evaluate(() => {
    const c = reclaimed.core.camera;
    c.target[0] = 100;
    c.target[1] = 90;
  });
  await page.waitForFunction(() => reclaimed.story.cam.busy, { timeout: 5000 });
  await page.waitForFunction(() => reclaimed.story.cam.holding, { timeout: 20000 });
  await sleep(800);
  await page.screenshot({ path: `${out}-3-reveal.png` });
  console.log('world', JSON.stringify(await page.evaluate(() => ({ history: reclaimed.story.world.history().map((e) => [e.kind, e.cause]), region: reclaimed.story.world.region(0) }))));
  await page.waitForFunction(() => !reclaimed.story.cam.busy, { timeout: 10000 });

  // back to Wren: her unlocked node ends the run, and the card shows once the camera lets go
  await page.evaluate(() => void reclaimed.story.talk('wren'));
  await sleep(1200);
  await page.evaluate(() => document.querySelector('.dlg-scrim').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await sleep(300);
  await choose('Take care');
  await page.waitForSelector('.story-end', { timeout: 8000 });
  await sleep(500);
  await page.screenshot({ path: `${out}-4-end.png` });
  console.log('record', JSON.stringify(await page.evaluate(() => reclaimed.story.world.runs)));
} catch (e) {
  failed = true;
  console.log(`[error] ${e.stack ?? e}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
