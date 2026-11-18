// Nested scales (round 9, NS-86): the store under a seeded random sequence of ops (src/nested/stress.ts): jumps,
// pans, carves, forced grows and shrinks; every few ops the pool's books, no column without records, and the coverage
// check. node scripts/nested-storestress.mjs --chromeargs ignore-certificate-errors [--maxbuf 128] [--n 300]
// [--seed 1] [--port 5461]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-storestress', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const maxbuf = R.opt('maxbuf', '0');
  const n = Number(R.opt('n', '300'));
  const seed = Number(R.opt('seed', '1'));
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[stress]')) console.log(`[page ${m.type()}] ${m.text().slice(0, 1200)}`);
  });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  const q = `k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140${maxbuf !== '0' ? `&maxbuf=${maxbuf}` : ''}`;
  await page.goto(`https://localhost:${port}/nested.html?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(1500);
  const t0 = Date.now();
  const r = await page.evaluate(
    async (o) => {
      const { storeStress } = await import('/src/nested/stress.ts');
      return storeStress(window.nested, { n: o.n, seed: o.seed, log: (s) => console.log(`[stress] ${s}`) });
    },
    { n, seed },
  );
  const st = await page.evaluate(() => nested.state().stats);
  const fatal = await page.evaluate(() => document.querySelector('.fatal')?.textContent ?? '');
  console.log(`ops ${JSON.stringify(r.ops)} in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${r.checks} checks; stats ${JSON.stringify(st)}`);
  R.check('no fatal overlay', !fatal, fatal);
  R.check('the pool\'s books balance at every check (no page held twice, none over the cap, the free stack clean)', r.audit === 0, `${r.audit} faults`);
  R.check('no column of any live window without records at every check', r.emptyCols === 0, `${r.emptyCols} empty columns`);
  R.check('coverage: every column in view drawn by exactly one level at every check', r.coverage === 0, `${r.coverage} faults`);
  R.check('no allocation refused inside a kernel', st.refused === 0, `refused ${st.refused}; waits ${st.waits}; error "${st.error}"`);
});
