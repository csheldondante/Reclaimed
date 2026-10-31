// Screenshots of the structures viewer (structures.html), one per view given, to C:/Projects/shots88/structures/.
//   node scripts/structshot.mjs [--size 1280x800] [--dpr 1] [--out prefix] "system=irregular&view=city" "view=building" …
// Behaviour kind (shares the GPU). Fails on page errors, a GPU error or the viewer's fatal box.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './lib/runner.mjs';

const OUT = 'C:/Projects/shots88/structures';
fs.mkdirSync(OUT, { recursive: true });

await run({ name: 'structshot', kind: 'behaviour', size: '1280x800', strictConsole: true }, async (R) => {
  const views = R.argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && R.argv[i - 1].startsWith('--')));
  const prefix = R.opt('out', 'shot');
  const p = await R.page();
  let k = 0;
  for (const v of views.length ? views : ['']) {
    await p.goto(`${R.url}/structures.html?${v}`, { waitUntil: 'load' });
    await p.waitForFunction(() => document.body.dataset.ready === '1' || document.querySelector('.fatal'), { timeout: 60000 });
    const f = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (f) {
      R.fail(`viewer fatal: ${f.slice(0, 600)}`);
      continue;
    }
    // a few frames for the shadow map and the pipelines
    await p.evaluate(() => new Promise((r) => { let n = 0; const t = () => (++n > 20 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }));
    const f2 = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (f2) R.fail(`viewer fatal: ${f2.slice(0, 600)}`);
    const stats = await p.evaluate(() => window.structures.stats());
    const file = path.join(OUT, `${prefix}-${k++}.png`);
    await p.screenshot({ path: file });
    R.check(`${v || 'default'} → ${file}`, stats.pieces > 0, stats);
  }
});
