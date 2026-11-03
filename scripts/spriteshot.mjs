// Round 128 (treegen, M6): the far trees as baked sprites against the low-poly far mesh — the same spot, the same
// zooms, a reload each (?flod=mesh | sprite): stills at each zoom, a turn GIF (the camera's azimuth round a step and
// back) and a pan GIF across the LOD boundary. Every system in play at 1x; only the camera moves.
//   node scripts/spriteshot.mjs [--at 13728,4768] [--zooms "7,10,14"] [--modes mesh,sprite] [--tag m6]
//        [--out C:/Projects/shots88/treegen] [--settle 30000] [--gif 1] [--extra "&fseason=0.5"]
import fs from 'node:fs';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'spriteshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/treegen');
  const tag = R.opt('tag', 'm6');
  const at = R.opt('at', '13728,4768');
  const zooms = R.opt('zooms', '7,10,14').split(',').map(Number);
  const modes = R.opt('modes', 'mesh,sprite').split(',');
  const settle = Number(R.opt('settle', '30000'));
  const extra = Object.fromEntries(new URLSearchParams(R.opt('extra', '')));
  fs.mkdirSync(out, { recursive: true });
  const gif = async (p, file, frames, every, step) => {
    const enc = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      await p.evaluate(step, i);
      await sleep(every);
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
    }
    enc.finish();
    fs.writeFileSync(file, enc.bytes());
    R.log(`saved ${file}`);
  };
  for (const flod of modes) {
    const p = await R.level({ level: 'atlas', at, flod, ...extra });
    await sleep(settle);
    for (const z of zooms) {
      await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
      await sleep(4000);
      await R.fatal(p);
      // (the stills without the UI over them: every positioned element that holds no canvas hidden)
      if (R.opt('clean', '1') === '1')
        await p.evaluate(() => {
          const cv = [...document.querySelectorAll('canvas')];
          for (const el of document.body.querySelectorAll('*')) {
            if (el.tagName === 'CANVAS' || cv.some((c) => el.contains(c))) continue;
            const pos = getComputedStyle(el).position;
            if (pos === 'fixed' || pos === 'absolute') el.style.visibility = 'hidden';
          }
        });
      const f = `${out}/${tag}-${flod}-z${z}.png`;
      await p.screenshot({ path: f });
      const counts = await p.evaluate(async () => {
        const r = window.reclaimed.renderer;
        const c = await r.meshInst.counts(r.device, r.indirect);
        return { plants: c.reduce((a, b) => a + b, 0), sprites: r.floraSprites ? r.floraSprites.bakes : null };
      });
      R.log(`saved ${f} ${JSON.stringify(counts)}`);
    }
    if (R.opt('gif', '1') === '1') {
      await p.evaluate((z) => (window.reclaimed.camera.zoom = z), zooms[0]);
      await sleep(3000);
      // (the turn: a sixth of a turn and back, as the player's turn control steps it)
      await p.evaluate(() => (window.__az0 = window.reclaimed.camera.azimuth));
      await gif(p, `${out}/${tag}-${flod}-turn.gif`, 36, 90, (i) => {
        const t = i < 18 ? i / 17 : (35 - i) / 17;
        window.reclaimed.camera.azimuth = window.__az0 + (Math.PI / 3) * t;
      });
      // (the pan: across the boundary between the full trees and the far ones)
      await p.evaluate(() => (window.__t0 = [...window.reclaimed.camera.target]));
      await gif(p, `${out}/${tag}-${flod}-pan.gif`, 30, 100, (i) => {
        const t = window.__t0;
        window.reclaimed.camera.target = [t[0] + i * 1.5, t[1] - i * 1.5, t[2]];
      });
    }
    await p.close();
  }
});
