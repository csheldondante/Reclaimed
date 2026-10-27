// Round 91 (phonecam): the atlas map's names and the compass at phone size (touch). Shots: the game view turned
// by the ↻ button (the compass), the compass tapped (facing north), the map at its opening zoom, zoomed out, and
// zoomed in twice; the page's errors fail it.
//   node scripts/mapnames.mjs [--url http://localhost:5261] [--out C:/Projects/shots88/phonecam/names]
//     [--at 11956,15471] [--wait 35000] [--size 412x915]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5261');
const out = opt('out', 'C:/Projects/shots88/phonecam/names');
const at = opt('at', '11956,15471');
const wait = Number(opt('wait', 35000));
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
fs.mkdirSync(path.dirname(out), { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  protocolTimeout: 600000,
});
let bad = false;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text()));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=${at}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await pause(wait);
  const tap = async (sel, i = 0) => {
    const b = (await p.$$(sel))[i];
    const box = await b.boundingBox();
    await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  };
  const state = () => p.evaluate(() => ({ az: +((window.reclaimed.camera.azimuth * 180) / Math.PI).toFixed(1), needle: document.querySelector('.compass .rose')?.getAttribute('transform'), fatal: !!document.querySelector('.fatal') }));
  const shoot = async (name) => {
    const s = await state();
    if (s.fatal) bad = true;
    console.log(name, JSON.stringify(s));
    await p.screenshot({ path: `${out}-${name}.png` });
  };
  await shoot('view');
  await tap('.turn-ctl button', 1);
  await pause(2000);
  await shoot('turned');
  await tap('.compass');
  await pause(2500);
  await shoot('north');
  // the map: the 🗺 button (the atlas buttons' first)
  await tap('.atlas-ctl button', 0);
  await pause(1500);
  console.log('labels', await p.evaluate(() => window.reclaimed.scene.atlasMap?.labelStats));
  await shoot('map');
  const zoom = async (label) => {
    const i = await p.evaluate((l) => [...document.querySelectorAll('button')].findIndex((b) => b.textContent === l), label);
    await tap('button', i);
    await pause(600);
  };
  await zoom('−');
  await shoot('map-out');
  await zoom('+');
  await zoom('+');
  await shoot('map-in');
  await zoom('+');
  await shoot('map-in2');
} finally {
  await browser.close();
}
if (bad) process.exit(1);
