// Round 117 (flora): shots of the flora viewer page (flora.html) — each biome scene and a few single plants, and a GIF
// of the birch wood in the wind with its leaves falling. Fails on page errors or the fatal box.
//   node scripts/floraview.mjs [--out C:/Projects/shots88/flora] [--tag v1] [--only birchwood,plant:birch] [--gif 1]
import fs from 'node:fs';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'floraview', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf(`--${k}`);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const out = opt('out', 'C:/Projects/shots88/flora');
  const tag = opt('tag', 'v1');
  const all = ['birchwood', 'mixedwood', 'meadow', 'riverbank', 'ruin', 'cave', 'plant:birch', 'plant:pine', 'plant:oak', 'plant:giant', 'plant:tallgrass', 'plant:fern', 'plant:ivy', 'plant:reed'];
  const only = opt('only', null)?.split(',') ?? all;
  fs.mkdirSync(out, { recursive: true });
  const page = await R.page();
  for (const what of only) {
    const [kind, sp] = what.split(':');
    const q = kind === 'plant' ? `mode=plant&species=${sp}&seed=3&wind=0.4&season=0.2` : `mode=scene&biome=${kind}&seed=2&wind=0.5&season=${kind === 'birchwood' ? 0.45 : 0.2}`;
    await page.goto(`${R.url}/flora.html?${q}`, { waitUntil: 'load' });
    await sleep(2500);
    await R.fatal(page);
    const stats = await page.evaluate(() => window.floraViewer?.stats());
    R.log(`${what}: ${stats}`);
    const name = `${out}/${tag}-${what.replace(':', '-')}`;
    await page.screenshot({ path: `${name}.png` });
    if (opt('gif', '1') === '1' && (what === 'birchwood' || what === 'meadow')) {
      const enc = GIFEncoder();
      for (let i = 0; i < 40; i++) {
        const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
        const pal = quantize(png.data, 256);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 80 });
        await sleep(80);
      }
      enc.finish();
      fs.writeFileSync(`${name}.gif`, enc.bytes());
      R.log(`saved ${name}.gif`);
    }
  }
});
