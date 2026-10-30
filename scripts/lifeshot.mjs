// Round 117 (inhabitants): a look at the creatures — a level with ?life=, the camera close on them, a still and a GIF.
//   node scripts/lifeshot.mjs [--level bestiary|atlas] [--life 1|dragon|town|viewer] [--at x,y] [--zoom 22]
//     [--follow deer|wolves|crows|...] [--frames 40] [--every 80] [--out dir] [--wait 600 (ticks)] [--q low]
// Behaviour kind: shares the GPU. Writes <out>/<name>.png and .gif (default C:/Projects/shots88/inhabitants).
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
import { run } from './lib/runner.mjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'lifeshot', kind: 'behaviour' }, async (R) => {
  const level = R.opt('level', 'bestiary');
  const life = R.opt('life', '1');
  const out = R.opt('out', 'C:/Projects/shots88/inhabitants');
  const name = R.opt('name', `${level}-${life}`);
  fs.mkdirSync(out, { recursive: true });
  const params = { level, life, q: R.opt('q', 'low') };
  const at = R.opt('at', null);
  if (at) params.at = at;
  const extra = R.opt('params', '');
  for (const kv of extra.split('&').filter(Boolean)) {
    const [k, v] = kv.split('=');
    params[k] = v;
  }
  const p = await R.level(params, { size: R.opt('size', undefined), dpr: Number(R.opt('dpr', 1)) });
  await R.ticks(p, Number(R.opt('wait', 600)));
  const zoom = Number(R.opt('zoom', 22));
  const follow = R.opt('follow', 'deer');
  const look = async () =>
    p.evaluate(
      (zoom, follow) => {
        const r = window.reclaimed;
        const life = r.inhabitants;
        r.camera.zoom = zoom;
        const g = life.groups().find((g) => g.species === follow) ?? life.groups()[0];
        if (g && g.count > 0) {
          r.camera.target[0] = g.centre[0];
          r.camera.target[1] = g.centre[1];
        }
        return { count: life.count, groups: life.groups().map((g) => ({ s: g.species, n: g.count, c: g.centre.map((v) => +v.toFixed(1)) })) };
      },
      zoom,
      follow,
    );
  const info = await look();
  R.check('creatures alive', info.count > 0, info);
  for (const g of info.groups) R.check(`group ${g.s} read back (count ${g.n})`, g.n > 0 && g.c.every(Number.isFinite), g);
  await R.sleep(1500);
  await p.screenshot({ path: path.join(out, `${name}.png`) });
  R.log(`saved ${path.join(out, `${name}.png`)}`);
  const frames = Number(R.opt('frames', 40));
  if (frames > 0) {
    const every = Number(R.opt('every', 80));
    const enc = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      if (R.flag('track') && i % 5 === 0) await look();
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
      await R.sleep(every);
    }
    enc.finish();
    fs.writeFileSync(path.join(out, `${name}.gif`), enc.bytes());
    R.log(`saved ${path.join(out, `${name}.gif`)}`);
  }
  const after = await p.evaluate(() => window.reclaimed.inhabitants.groups().map((g) => ({ s: g.species, n: g.count, c: g.centre.map((v) => +v.toFixed(1)) })));
  R.log(JSON.stringify(after));
  await R.fatal(p);
});
