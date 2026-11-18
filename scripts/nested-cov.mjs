// Nested scales (round 8): the coverage check alone on the sandbox's start, with the columns it flags printed
// node scripts/nested-cov.mjs --chromeargs ignore-certificate-errors [--port 5461] [--q "k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140"]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-cov', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const q = R.opt('q', 'k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(2500);
  const r = await page.evaluate(async () => {
    const c = await nested.coverage();
    const s = await nested.app.nest.readAll();
    const cols = [];
    for (const w of c.where) {
      const m = /L(\d+) column (-?\d+),(-?\d+)/.exec(w);
      if (!m) continue;
      const col = s.column(+m[1], +m[2], +m[3]);
      cols.push({ w, col: JSON.stringify(col) });
    }
    return { c, cols, live: nested.state().live, wins: nested.state().wins };
  });
  console.log(JSON.stringify(r, null, 1).slice(0, 4000));
  R.check('coverage', r.c.stale + r.c.missing === 0, `${r.c.stale} stale, ${r.c.missing} missing`);
});
