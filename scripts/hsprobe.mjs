// (round 112, herosandbox) Opens a level headless on the real GPU, waits, then runs each given file's async function body
// in the page in turn (window.reclaimed in scope), printing what it returns, and a screenshot after each.
//   node scripts/hsprobe.mjs --port 5321 --level playground --wait 35000 --out C:/Projects/shots88/herosandbox/probe probe1.js [probe2.js …]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const args = {};
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
  else files.push(argv[i]);
}
const [w, h] = (args.size ?? '1280x800').split('x').map(Number);
const out = args.out ?? 'C:/Projects/shots88/herosandbox/probe';
fs.mkdirSync(out, { recursive: true });
const url = `http://localhost:${args.port ?? 5321}/?skipmenu=1&level=${args.level ?? 'playground'}${args.extra ?? ''}`;
const browser = await puppeteer.launch({
  executablePath: args.chrome ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${w},${h}`],
  defaultViewport: { width: w, height: h, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning' || /\[probe\]/.test(m.text())) && console.log(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  console.log(url);
  await page.goto(url, { waitUntil: 'load' });
  for (let k = 0; k < 150 && !(await page.evaluate(() => !!window.reclaimed).catch(() => false)); k++) await new Promise((r) => setTimeout(r, 1000));
  await new Promise((r) => setTimeout(r, Number(args.wait ?? 30000)));
  for (const f of files) {
    const body = fs.readFileSync(f, 'utf8');
    const r = await page.evaluate(`(async () => { ${body} })()`).catch((e) => `THREW ${e.message}`);
    console.log(`== ${path.basename(f)}\n${typeof r === 'string' ? r : JSON.stringify(r, null, 1)}`);
    await page.screenshot({ path: path.join(out, `${path.basename(f, '.js')}.png`) });
  }
} finally {
  await browser.close();
}
