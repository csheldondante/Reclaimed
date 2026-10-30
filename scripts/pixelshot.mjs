// Round 113 (tilesfirst, step 5.1): screenshots of fixed views made as repeatable as the page allows, to compare two
// builds pixel for pixel — the atlas at the tile gate's spot, world and time of day; the sim paused; the shaders' clock
// held (WorldCore.t0 read as 5 s ago, every frame); each view after its land and tiles are in (the geometric check 0
// for 60 frames, at most 20 s). The phone proxy (412x915, dpr 2.6, q=low, a Pixel's UA) and the desktop (1600x900).
//   node scripts/pixelshot.mjs --out C:/Projects/shots88/tilesfirst/px-a [--zooms 14,8,5] [--screens phone,desktop]
import { run } from './lib/runner.mjs';
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
await run({ name: 'pixelshot', kind: 'behaviour', size: '412x915', dpr: 2.6 }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/tilesfirst/px');
  const zooms = R.opt('zooms', '14,8,5').split(',').map(Number);
  const screens = R.opt('screens', 'phone,desktop').split(',');
  fs.mkdirSync(out, { recursive: true });
  for (const sc of screens) {
    const phone = sc === 'phone';
    const p = await R.page(phone ? { size: '412x915', dpr: 2.6 } : { size: '1600x900', dpr: 1 });
    if (phone) {
      await p.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true });
      await p.setUserAgent(UA);
    }
    const params = Object.fromEntries(new URLSearchParams(`level=atlas&at=15024,14337&worldsave=0&world=tilegate&tod=0.42&day=100000&season=0.3&hybrid=1&tufts=0${R.opt('extra', '')}`));
    await R.level(params, { page: p, noDefaultQ: !phone });
    await R.simSeconds(p, 6);
    await p.evaluate(() => {
      const c = window.reclaimed.core;
      Object.defineProperty(c, 't0', { get: () => performance.now() - 5000, set: () => {}, configurable: true });
      window.reclaimed.scene.speed = 0;
      // (the UI out of the picture)
      for (const e of document.querySelectorAll('body > *:not(canvas)')) if (!e.querySelector('canvas')) e.style.visibility = 'hidden';
    });
    for (const z of zooms) {
      const ok = await p.evaluate(async (z) => {
        const R = window.reclaimed;
        R.camera.zoom = z;
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        let clean = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < 20000 && clean < 60) {
          await frame();
          const g = R.renderer.tiles?.coverCheck(R.camera);
          clean = g && g.share === 0 ? clean + 1 : 0;
        }
        for (let i = 0; i < 30; i++) await frame();
        return clean >= 60;
      }, z);
      const f = path.join(out, `${sc}-z${z}.png`);
      await p.screenshot({ path: f });
      console.log(`${f}${ok ? '' : ' (not all drawn)'}`);
    }
    await p.close();
  }
});
