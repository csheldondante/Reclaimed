// (round 128m, townlab) The placement phone bench (src/perf/placebench.ts) on the user's link at the phone's size, as
// the phone runs it: ?bench=place on a fresh world. Waits for the report, saves it and a shot of the summary screen.
//   node scripts/placebench.mjs [--out dir] [--types house,wall]
import fs from 'node:fs';
import path from 'node:path';
import { run, ROOT } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const typesArg = process.argv.indexOf('--types');
const TYPES = typesArg > 0 ? `&placetypes=${process.argv[typesArg + 1]}` : '';
const OUT = outArg > 0 ? process.argv[outArg + 1] : path.join(ROOT, '.testcache', 'placebench');
await run({ name: 'placebench', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  fs.mkdirSync(OUT, { recursive: true });
  const page = await R.page();
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1&fresh=1&q=low&bench=place${TYPES}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.placeBenchReport || document.querySelector('.fatal'), { timeout: 900000, polling: 1000 });
  await R.fatal(page);
  const body = await page.evaluate(() => window.placeBenchReport);
  fs.writeFileSync(path.join(OUT, 'placebench-report.json'), body);
  await page.screenshot({ path: path.join(OUT, 'placebench-summary.png') });
  for (const l of JSON.parse(body).summary) console.log(l);
});
