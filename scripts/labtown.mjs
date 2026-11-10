// (round 128m, townlab) The lab's `town` fixture (src/lab/townfixture.ts; docs/TOOLING.md): the window round the user's
// start town captured from the full game on the user's link, into data/lab/town.rclt. Run it again when the land
// generator changes (the fixture's test, test/unit/townfixture.test.ts, fails when GEN_VERSION moved on).
//   node scripts/labtown.mjs capture
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep, ROOT } from './lib/runner.mjs';

const LINK = '?skipmenu=1&level=atlas&town=1&fortress=1&fresh=1&q=low';
const OUT = path.join(ROOT, 'data', 'lab', 'town.rclt');

// (street lab sites: node scripts/labtown.mjs site <name> <cx>,<cy> — a bare 320 x 320 window of atlas land round
// cell (cx, cy), no towns, into data/lab/site-<name>.rclt: ?level=streetlab&site=<name>)
if (process.argv[2] === 'site') {
  // (an optional third argument: the town's centre in window world units — the window's middle by default)
  const [, , , name, at, centre] = process.argv;
  if (!name || !/^\d+,\d+$/.test(at ?? '')) throw new Error('node scripts/labtown.mjs site <name> <cx>,<cy> [<wx>,<wy>]');
  const out = path.join(ROOT, 'data', 'lab', `site-${name}.rclt`);
  await run({ name: 'labsite', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
    const page = await R.page();
    await page.goto(`${R.url}/?skipmenu=1&level=atlas&towns=0&win=320&at=${at}&fresh=1&q=low`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(page);
    await sleep(3000);
    const c = centre ? centre.split(',').map(Number) : undefined;
    const b64 = await page.evaluate((n, c) => window.reclaimed.townFixture(n, c), name, c);
    const bytes = Buffer.from(b64, 'base64');
    fs.writeFileSync(out, bytes);
    console.log(`wrote ${out}: ${(bytes.length / 1024).toFixed(0)} KB`);
  });
  process.exit(0);
}
if (process.argv[2] !== 'capture') {
  console.log('node scripts/labtown.mjs capture   (the user\'s start town → data/lab/town.rclt)');
  process.exit(1);
}
await run({ name: 'labtown', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const page = await R.page();
  await page.goto(`${R.url}/${LINK}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => (window.reclaimed?.fortress?.ready && window.reclaimed.fortress.reachKnown) || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  // (the town's land settled under it: the same wait the probes give it)
  await sleep(2000);
  const b64 = await page.evaluate(() => window.reclaimed.townFixture());
  const bytes = Buffer.from(b64, 'base64');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bytes);
  const box = await page.evaluate(() => ({ offset: window.reclaimed.fortress.offset(), stores: window.reclaimed.fortress.storesAt(), origin: window.reclaimed.stream.origin }));
  console.log(`wrote ${OUT}: ${(bytes.length / 1024).toFixed(0)} KB; window origin ${box.origin}, fortress box offset ${box.offset}, stores ${box.stores.map((v) => v.toFixed(1))}`);
});
