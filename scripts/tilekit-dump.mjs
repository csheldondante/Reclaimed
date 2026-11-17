// (tilekit step 2) The real irregular grid round Muru's centre, welded in the lab (archgen's GPU grid lab, read back
// once), written as the tile kit's unit-test fixture: src/tilekit/fixtures/grid-muru.json (positions to the mm, CCW
// quads, each cell's lot and class). Re-run when the grid's generator changes.
//   node scripts/tilekit-dump.mjs --server http://127.0.0.1:5491
import fs from 'node:fs';
import { run } from './lib/runner.mjs';

await run({ name: 'tilekit-dump', kind: 'behaviour', size: '640x360', dpr: 1, echo: true }, async (R) => {
  const page = await R.page();
  await page.goto(`${R.url}/tilekit.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.tilekit || document.querySelector('.fatal'), { timeout: 240000, polling: 250 });
  const fat = await page.evaluate(() => document.querySelector('.fatal')?.textContent ?? null);
  if (fat) throw new Error(fat);
  const g = await page.evaluate(() => tilekit.grid());
  fs.mkdirSync('src/tilekit/fixtures', { recursive: true });
  fs.writeFileSync('src/tilekit/fixtures/grid-muru.json', JSON.stringify(g));
  console.log(`wrote src/tilekit/fixtures/grid-muru.json: ${g.xy.length / 2} vertices, ${g.cells.length / 4} cells`);
});
