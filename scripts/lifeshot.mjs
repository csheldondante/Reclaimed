// Round 117 (inhabitants): a look at the creatures — a level with ?life=, the camera close on them, a still and a GIF.
//   node scripts/lifeshot.mjs [--level bestiary|atlas] [--life 1|dragon|town|viewer] [--at x,y] [--zoom 22]
//     [--follow deer|wolves|crows|...] (--zoom 0 keeps the level's) [--frames 40] [--every 80] [--out dir] [--wait 600 (ticks)] [--q low]
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
  // --stage hunt: (with --life empty) a herd and two wolves 30 cells off, the camera fixed between them — one hunt
  // from the stalk to the chase, start to end in one view
  const stage = R.opt('stage', null);
  if (stage === 'hunt')
    await p.evaluate((zoom) => {
      const r = window.reclaimed;
      const life = r.inhabitants;
      const [x, y] = r.camera.target;
      const deer = life.define({ id: 'deer', plan: 'quadruped', seed: 3, proportions: { size: 1.15, legs: 1.15, neck: 1.1, tail: 0.35 }, palette: { body: '#a0703f', belly: '#e9d6b4', accent: '#3a2a1c' }, secondary: { tailFlex: 0.7 }, behaviour: { kind: 'herd' }, walk: 1.6, run: 9, sight: 16 });
      const wolf = life.define({ id: 'wolf', plan: 'quadruped', seed: 7, proportions: { size: 0.85, legs: 0.95, neck: 0.55, head: 1.25, tail: 1.4, girth: 1.05 }, palette: { body: '#3a3c44', belly: '#d8d2c4', accent: '#15161a', eye: '#ffd23a' }, secondary: { fur: 0.8, fur_colour: '#26272d', tailFlex: 0.8 }, behaviour: { kind: 'stalker', prey: ['deer'] }, walk: 1.4, run: 11, sight: 60, threat: 0.8 });
      const h = life.spawnGroup(deer, [x - 10, y], 9);
      life.drive(h, { kind: 'roam', around: [x - 10, y], radius: 8 });
      const w = life.spawnGroup(wolf, [x + 22, y + 4], 2, { spread: 1.5 });
      life.drive(w, { kind: 'roam', around: [x + 22, y + 4], radius: 6 });
      r.camera.zoom = zoom;
      r.editor?.()?.setVisible?.(false);
    }, Number(R.opt('zoom', 12)));
  const zoom = Number(R.opt('zoom', 22));
  const follow = R.opt('follow', 'deer');
  const look = async () =>
    p.evaluate(
      (zoom, follow) => {
        const r = window.reclaimed;
        const life = r.inhabitants;
        // (--zoom 0: the level's own zoom)
        if (zoom > 0) r.camera.zoom = zoom;
        r.editor?.()?.setVisible?.(false);
        const g = life.groups().find((g) => g.species === follow) ?? life.groups()[0];
        if (g && g.count > 0) {
          r.camera.target[0] = g.centre[0];
          r.camera.target[1] = g.centre[1];
          r.camera.target[2] = g.centre[2];
        }
        return { count: life.count, groups: life.groups().map((g) => ({ s: g.species, n: g.count, c: g.centre.map((v) => +v.toFixed(1)) })) };
      },
      zoom,
      follow,
    );
  const info = stage ? await p.evaluate(() => ({ count: window.reclaimed.inhabitants.count, groups: [] })) : await look();
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
      if (R.flag('track') && i % (stage ? 2 : 5) === 0) await look();
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
