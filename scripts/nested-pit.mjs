// Nested scales (round 8): the owner's sky-through-ground report reproduced. Dig a pit with repeated carve taps at the
// screen's centre at a large size, following it down with Fwd; look down, level and back out at each depth; carve a
// cave into a hillside and look out of its mouth; count hole pixels (no surface) on rays below the horizon (where the
// ground must be). Stills under local/nested/r8-*.png.
// node scripts/nested-pit.mjs --chromeargs ignore-certificate-errors [--port 5461] [--frac 1] [--taps 8] [--tag x]
import { run, sleep } from './lib/runner.mjs';
import { PNG } from 'pngjs';
import fs from 'node:fs';

await run({ name: 'nested-pit', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', '');
  const frac = Number(R.opt('frac', '1'));
  const taps = Number(R.opt('taps', '8'));
  const d0 = Number(R.opt('d', '8'));
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=30&pitch=1.0&yaw=-1.5708&tx=70&ty=120${R.opt('shrink', '1') === '0' ? '&shrink=0' : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(1000);
  const res = await page.evaluate(
    async (frac, taps, d0) => {
      const { pitAndCave } = await import('/src/nested/suite.ts');
      return pitAndCave(nested, { frac, taps, d0, images: true, log: (s) => console.log(s) });
    },
    frac,
    taps,
    d0,
  );
  for (const l of res.lines) console.log(l);
  // the frames with holes as they were seen (holes magenta, half resolution)
  for (const [i, v] of res.worstViews.entries()) {
    if (!v.img) continue;
    const png = new PNG({ width: v.img.w, height: v.img.h });
    for (let p = 0; p < v.img.w * v.img.h; p++) {
      png.data[p * 4] = v.img.rgb[p * 3];
      png.data[p * 4 + 1] = v.img.rgb[p * 3 + 1];
      png.data[p * 4 + 2] = v.img.rgb[p * 3 + 2];
      png.data[p * 4 + 3] = 255;
    }
    fs.writeFileSync(`local/nested/r8-holes-${i}${tag}.png`, PNG.sync.write(png));
    console.log(`r8-holes-${i}${tag}.png: ${v.name}, ${v.n}`);
  }
  // stills of the worst poses
  let i = 0;
  for (const v of res.worstViews) {
    await page.evaluate((v) => nested.setView(v), v.view);
    await sleep(1500);
    await page.screenshot({ path: `local/nested/r8-${v.name}${tag}.png` });
    console.log(`still r8-${v.name}${tag}.png: ${v.n} hole pixels at ${JSON.stringify(v.view)}`);
    if (++i >= 6) break;
  }
  R.check('no hole pixels below the horizon in the pit and cave poses', res.total === 0, `${res.total}`);
  R.check('every column in view drawn by exactly one level', res.coverage === 0, `${res.coverage}`);
});
