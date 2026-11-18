// Nested scales: run nested.html?selftest=1 headless and print each check.
// node scripts/nested-selftest.mjs --chromeargs ignore-certificate-errors [--port 5461]
import { run } from './lib/runner.mjs';

await run({ name: 'nested-selftest', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || (m.text().startsWith('[suite]') && /hole|odd|pit|shaft|cave|coverage/.test(m.text()))) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?selftest=1`, { waitUntil: 'load' });
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
  if (r.failed !== 0) process.exitCode = 1;
});
