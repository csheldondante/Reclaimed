// Nested scales: run nested.html?selftest=1 headless and print each check.
// node scripts/nested-selftest.mjs --chromeargs ignore-certificate-errors [--port 5461]
import { run } from './lib/runner.mjs';

await run({ name: 'nested-selftest', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || (m.text().startsWith('[suite]') && /hole|odd|pit|shaft|cave|coverage|trace|hazard/.test(m.text())) || m.text().startsWith('[carves]')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  // (--q: extra query, e.g. "oracle=0&wtscreen=0&pit=0" while bisecting)
  const extra = R.opt('q', '');
  await page.goto(`https://localhost:${port}/nested.html?selftest=1${extra ? `&${extra}` : ''}`, { waitUntil: 'load' });
  let seen = 0;
  // (up to 20 minutes: round 8 added the pit, cave and shaft poses)
  for (let i = 0; i < 480; i++) {
    const s = await page.evaluate(() => ({ done: !!(window.__selftest && window.__selftest.done), log: document.getElementById('log')?.textContent ?? '' }));
    if (s.log.length > seen) {
      process.stdout.write(s.log.slice(seen));
      seen = s.log.length;
    }
    if (s.done) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  const r = await page.evaluate(() => window.__selftest);
  if (r.error) console.log('ERROR', r.error);
  for (const c of r.results ?? []) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name} :: ${c.detail}`);
  console.log(`failed ${r.failed} of ${(r.results ?? []).length}`);
  if (R.opt('dump', '0') === '1') {
    // (NS-86 bisecting) the sandbox's pool and, for every root chunk with an empty column, its page ids
    const d = await page.evaluate(async () => {
      if (!window.nested) return 'no sandbox';
      const n = nested.app.nest;
      const s = await n.readAll();
      const bad = [];
      for (let Y = 0; Y < 256; Y++)
        for (let X = 0; X < 256; X++) {
          if (s.records(0, X, Y).top.length) continue;
          const key = `${X >> 4},${Y >> 4}`;
          let b = bad.find((v) => v.chunk === key);
          if (!b) bad.push((b = { chunk: key, page: s.page(0, X >> 4, Y >> 4, 0), cols: 0, first: `${X},${Y}` }));
          b.cols++;
        }
      return { audit: s.audit(n.cap), cap: n.cap, physical: n.physical, segCap: n.segCap, stats: n.stats, growLog: n.growLog, ctl: Array.from(s.ctl.slice(0, 16)), bad, ops: nested.app.opLog.filter((o) => o.what === 'shrink' || o.what.startsWith('grow')).length };
    });
    console.log('DUMP', JSON.stringify(d));
  }
  if (r.failed !== 0) process.exitCode = 1;
});
