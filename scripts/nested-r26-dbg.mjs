// Nested scales (round 26): a page's boot state over time, every console line (diagnosis).
// node scripts/nested-r26-dbg.mjs --chromeargs ignore-certificate-errors --port 5461 [--q "&field=3"] [--secs 120]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'r26-dbg', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => console.log(`[page ${m.type()}] ${m.text().slice(0, 600)}`));
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.evaluateOnNewDocument(() => window.addEventListener('unhandledrejection', (e) => console.error(`unhandled rejection: ${e.reason?.stack ?? e.reason}`)));
  await page.goto(`https://localhost:${port}/nested.html?smooth=1${R.opt('q', '&field=3')}`, { waitUntil: 'load' });
  const secs = Number(R.opt('secs', '120'));
  for (let t = 0; t < secs; t += 5) {
    await sleep(5000);
    const s = await page.evaluate(() => {
      if (window.__selftest?.error) return { fatal: window.__selftest.error };
      if (!window.nested) return { none: true, info: document.getElementById('info')?.textContent };
      const a = nested.app;
      return { pipes: a.pipesReady, gen: a.genReady, field: a.fieldDone, frames: a.frameCount, live: a.nest.live, fieldReady: a.nest.fieldReady, info: document.getElementById('info')?.textContent?.slice(0, 300) };
    });
    console.log(`${t + 5}s ${JSON.stringify(s)}`);
    if (s.field && s.gen && s.pipes) break;
  }
});
