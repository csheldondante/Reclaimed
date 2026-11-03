// Round 128 (treegen): the foliage phone bench (src/perf/foliagebench.ts) run headless — a DESKTOP PROXY only (the
// user's PERF RULE: the phone's report decides). Opens the forest station with ?foliagebench=1 at the phone tier
// (q=low, 412x915), lets it reload through its variants, saves the report.
//   node scripts/foliagebench.mjs [--variants fwind:static,fwind:1A1C] [--out C:/Projects/shots88/treegen]
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'foliagebench', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/treegen');
  const variants = R.opt('variants', null);
  fs.mkdirSync(out, { recursive: true });
  const page = await R.page();
  const q = new URLSearchParams({ skipmenu: '1', tutorial: '0', warmcache: '0', q: 'low', level: 'atlas', play: 'lich', forest: 'lab', fride: '0', fseason: '0.5', foliagebench: '1' });
  if (variants) q.set('variants', variants);
  await page.goto(`${R.url}/?${q}`, { waitUntil: 'load' });
  const t0 = Date.now();
  let body = null;
  let last = '';
  while (!body && Date.now() - t0 < 40 * 60 * 1000) {
    await sleep(5000);
    try {
      body = await page.evaluate(() => window.foliageBenchReport ?? null);
      const say = await page.evaluate(() => document.getElementById('bench-say')?.textContent ?? '');
      if (say !== last) R.log(say);
      last = say;
      await R.fatal(page);
    } catch (e) {
      if (/fatal/i.test(String(e))) throw e;
      // (between the variants' loads)
    }
  }
  if (!body) throw new Error('foliagebench: no report in 40 min');
  const f = `${out}/foliagebench-desktop-proxy.json`;
  fs.writeFileSync(f, body);
  R.log(`saved ${f}`);
  for (const l of JSON.parse(body).summary) R.log(l);
});
