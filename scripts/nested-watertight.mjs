// Nested scales watertight checks: the suite in src/nested/suite.ts (the same one ?selftest=1 runs after the oracle
// checks) on the sandbox's scene: the manifold check of every level's faces at 8 eyes, the screen check over 40 poses.
// node scripts/nested-watertight.mjs --chromeargs ignore-certificate-errors [--port 5461] [--maxbuf 0]
// [--manifold 0] [--screen 0] [--tag x]
import { run, sleep } from './lib/runner.mjs';
import { PNG } from 'pngjs';
import fs from 'node:fs';

await run({ name: 'nested-watertight', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const maxbuf = R.opt('maxbuf', '0');
  const tag = R.opt('tag', '');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[suite]')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  // (round 25: gen=0, the toy root: the suite's scene and poses are its; --q extra query, e.g. smooth=1 for the sheets)
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140&gen=0${maxbuf !== '0' ? `&maxbuf=${maxbuf}` : ''}${R.opt('q', '') ? `&${R.opt('q', '')}` : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(1500);
  const res = await page.evaluate(
    async (o) => {
      const { watertightSuite } = await import('/src/nested/suite.ts');
      return watertightSuite(window.nested, { manifold: o.manifold, screen: o.screen, log: (s) => console.log(`[suite] ${s}`) });
    },
    { manifold: R.opt('manifold', '1') === '1', screen: R.opt('screen', '1') === '1' },
  );
  if (res.worst.pose >= 0) {
    // the worst pose again, the holes painted magenta
    await page.evaluate((v) => nested.setView(v), res.worst.view);
    await sleep(1200);
    await page.evaluate(() => nested.holes());
    const m = await page.evaluate(() => nested.holeImage());
    const png = new PNG({ width: m.w, height: m.h });
    for (let i = 0; i < m.w * m.h; i++) png.data.set([m.rgb[i * 3], m.rgb[i * 3 + 1], m.rgb[i * 3 + 2], 255], i * 4);
    fs.writeFileSync(`local/nested/watertight-worst${tag}.png`, PNG.sync.write(png));
  }
  for (const c of res.checks) R.check(c.name, c.pass, c.detail);
  console.log('stats', JSON.stringify(await page.evaluate(() => nested.state().stats)));
});
