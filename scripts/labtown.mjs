// (round 128m, townlab) The land fixtures (src/lab/townfixture.ts; docs/TOOLING.md): a window of atlas land captured
// from the full game, for the street lab's sites. (Switchover: the `capture` of the old start town as the behaviour lab's
// `town` fixture, data/lab/town.rclt, is retired with the old towns.)
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep, ROOT } from './lib/runner.mjs';

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
console.log('node scripts/labtown.mjs site <name> <cx>,<cy> [<wx>,<wy>]   (a street-lab site → data/lab/site-<name>.rclt)');
process.exit(1);
