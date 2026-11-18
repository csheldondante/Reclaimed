// Nested scales stress: rapid alternating carves and adds at the screen's centre, one an animation frame (as a held
// finger did before hold-to-grow), at a phone-like buffer limit. Reports the pool (used vs reserved, grows, refusals),
// whether frames keep flowing, the page's error lines, and a still.
// node scripts/nested-stress.mjs --chromeargs ignore-certificate-errors [--maxbuf 128] [--n 300] [--port 5461] [--tag x]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-stress', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const maxbuf = R.opt('maxbuf', '128');
  const n = Number(R.opt('n', '300'));
  const tag = R.opt('tag', '');
  const page = await R.page();
  const errs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errs.push(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
  const q = `k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140${maxbuf !== '0' ? `&maxbuf=${maxbuf}` : ''}`;
  await page.goto(`https://localhost:${port}/nested.html?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frames.length > 60, { timeout: 120000, polling: 100 });
  console.log('limits', JSON.stringify(await page.evaluate(() => window.__limits)));
  // zoom to depth 2 over the ground in front
  await page.evaluate(() => nested.setView({ yaw: 0, pitch: 0.6, d: 1.2 }));
  await sleep(4000);
  console.log('before', JSON.stringify(await page.evaluate(() => nested.state())));
  const t0 = Date.now();
  const r = await page.evaluate(async (n) => {
    const out = [];
    const W = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < n; i++) {
      const s = nested.state();
      if (s.queue === 0) nested.sculpt(i % 2 ? 'add' : 'carve', (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, 1, 40 + Math.random() * 60);
      await W();
      if (i % 50 === 49) out.push({ i, frames: nested.app.frames.length, ...nested.state().stats, live: nested.state().live });
    }
    return out;
  }, n);
  console.log(`ran ${n} frames in ${Date.now() - t0} ms`);
  for (const x of r) console.log('stats', JSON.stringify(x));
  await sleep(1500);
  const f0 = await page.evaluate(() => nested.app.frameCount);
  await sleep(1000);
  const f1 = await page.evaluate(() => nested.app.frameCount);
  console.log(`frames flowing after: ${f1 - f0} in 1 s`);
  console.log('info', JSON.stringify(await page.evaluate(() => document.getElementById('info').textContent)));
  const fatal = await page.evaluate(() => [...document.querySelectorAll('.fatal')].map((d) => d.textContent.slice(0, 300)));
  console.log('fatal', JSON.stringify(fatal));
  R.check('no fatal overlay', fatal.length === 0, fatal.join(' | '));
  R.check('frames keep flowing', f1 - f0 > 20, `${f1 - f0} frames in 1 s`);
  for (const e of errs.slice(0, 12)) console.log(e);
  await page.screenshot({ path: `local/nested/stress${tag}.png` });
});
