// Nested scales (round 11, NS-97 / NS-91): the narrow hole check. The selftest's sandbox (same URL), then the pit and
// shaft poses of src/nested/suite.ts pitAndCave without the oracle checks and the 40-pose suite; any pose with a few hole
// pixels prints the triangles of every level round the first one (watertight.ts rayDiag).
// node scripts/nested-shaft.mjs --chromeargs ignore-certificate-errors [--port 5461] [--shafts 1] [--taps 4]
// [--after 0] [--diag 1] [--runs 1]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-shaft', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const runs = Number(R.opt('runs', '1'));
  const o = { shaftsOnly: R.opt('shafts', '1') === '1', taps: Number(R.opt('taps', '4')), after: R.opt('after', '0') === '1', diag: R.opt('diag', '1') === '1' };
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[pit]')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  let total = 0;
  let cov = 0;
  for (let i = 0; i < runs; i++) {
    await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
    await sleep(1500);
    const res = await page.evaluate(async (o) => {
      const { pitAndCave } = await import('/src/nested/suite.ts');
      return pitAndCave(nested, { ...o, log: (s) => console.log(`[pit] ${s}`) });
    }, o);
    console.log(`run ${i + 1}: ${res.total} hole pixels over ${res.poses} poses, coverage faults ${res.coverage}`);
    total += res.total;
    cov += res.coverage;
  }
  R.check(`no hole pixels in the shaft${o.shaftsOnly ? '' : ' and pit'} poses over ${runs} runs`, total === 0, `${total}`);
  R.check('every column in view drawn by exactly one level', cov === 0, `${cov}`);
});
