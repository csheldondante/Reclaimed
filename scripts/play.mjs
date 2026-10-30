// (round 117, revive) A scripted play session on the shared runner, as a player would: the phone proxy with touch
// (isMobile, hasTouch: `(pointer: coarse)` matches, taps and drags are touch events) or a desktop mouse; steps from a
// JSON file: {eval}, {tap:[x,y]}, {click:[x,y]}, {drag:[x0,y0,x1,y1,ms]}, {hold:[x,y,ms]}, {key, ms?}, {wait}, {shot},
// {gif, frames, every}. Every value an eval returns is printed. Fails on page errors and the fatal overlay.
//   node scripts/play.mjs --url "/?skipmenu=1&level=noiselab" --steps steps.json --out DIR [--size 412x915 --dpr 2.6 --touch]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'play', kind: 'behaviour', size: '412x915', dpr: 2.6, echo: false }, async (R) => {
  const touch = R.flag('touch');
  const out = R.opt('out', '.');
  fs.mkdirSync(out, { recursive: true });
  const steps = JSON.parse(fs.readFileSync(R.opt('steps'), 'utf8'));
  const p = await R.page();
  if (touch) await p.setViewport({ width: R.W, height: R.H, deviceScaleFactor: R.dpr, isMobile: true, hasTouch: true });
  const u = R.opt('url', '/');
  await p.goto(`${R.url}${u}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  R.log(`level ready; coarse pointer ${await p.evaluate(() => matchMedia('(pointer: coarse)').matches)}`);
  await sleep(Number(R.opt('settle', '30000')));
  const touchAt = (type, pts) => p.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) });
  for (const s of steps) {
    await R.fatal(p);
    if (s.eval) {
      const r = await p.evaluate(s.eval);
      console.log(`[eval] ${s.label ?? ''} ${JSON.stringify(r)}`);
    } else if (s.tap) {
      if (touch) await p.touchscreen.tap(s.tap[0], s.tap[1]);
      else await p.mouse.click(s.tap[0], s.tap[1]);
    } else if (s.tapSel) {
      // (an element by selector and, optionally, its text: tapped at its middle as a finger would)
      const r = await p.evaluate(
        (sel, text) => {
          const e = [...document.querySelectorAll(sel)].find((el) => !text || el.textContent.trim().startsWith(text));
          if (!e) return null;
          const b = e.getBoundingClientRect();
          return [b.x + b.width / 2, b.y + b.height / 2];
        },
        s.tapSel,
        s.text ?? '',
      );
      if (!r) R.fail(`no element ${s.tapSel} ${s.text ?? ''}`);
      else if (touch) await p.touchscreen.tap(r[0], r[1]);
      else await p.mouse.click(r[0], r[1]);
      console.log(`[tap] ${s.tapSel} ${s.text ?? ''} at ${r?.map(Math.round)}`);
    } else if (s.dragSel) {
      // (a slider's thumb dragged: from `from` to `to` of its width, the first visible match)
      const r = await p.evaluate((sel) => {
        const e = [...document.querySelectorAll(sel)].find((el) => el.getBoundingClientRect().width > 0);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return [b.x, b.y + b.height / 2, b.width, e.value];
      }, s.dragSel);
      if (!r) R.fail(`no element ${s.dragSel}`);
      else {
        const [x, y, w] = r;
        s.drag = [x + w * (s.from ?? 0.3), y, x + w * (s.to ?? 0.7), y, s.ms ?? 600];
        console.log(`[drag] ${s.dragSel} (value ${r[3]})`);
        steps.splice(steps.indexOf(s) + 1, 0, { drag: s.drag });
      }
    } else if (s.click) await p.mouse.click(s.click[0], s.click[1]);
    else if (s.drag) {
      const [x0, y0, x1, y1, ms = 600] = s.drag;
      const n = Math.max(2, Math.round(ms / 16));
      if (touch) {
        await touchAt('touchStart', [[x0, y0]]);
        for (let i = 1; i <= n; i++) {
          await touchAt('touchMove', [[x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]]);
          await sleep(ms / n);
        }
        await touchAt('touchEnd', []);
      } else {
        await p.mouse.move(x0, y0);
        await p.mouse.down();
        for (let i = 1; i <= n; i++) {
          await p.mouse.move(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
          await sleep(ms / n);
        }
        await p.mouse.up();
      }
    } else if (s.hold) {
      // (a finger held still, then moved a little and held: a stick)
      const [x, y, ms, dx = 0, dy = 0] = s.hold;
      if (touch) {
        await touchAt('touchStart', [[x, y]]);
        for (let i = 1; i <= 8; i++) {
          await touchAt('touchMove', [[x + (dx * i) / 8, y + (dy * i) / 8]]);
          await sleep(16);
        }
        const t1 = Date.now() + ms;
        while (Date.now() < t1) {
          await touchAt('touchMove', [[x + dx, y + dy]]);
          await sleep(100);
        }
        await touchAt('touchEnd', []);
      } else {
        await p.mouse.move(x, y);
        await p.mouse.down();
        await p.mouse.move(x + dx, y + dy, { steps: 8 });
        await sleep(ms);
        await p.mouse.up();
      }
    } else if (s.key) {
      await p.keyboard.down(s.key);
      await sleep(s.ms ?? 50);
      await p.keyboard.up(s.key);
    } else if (s.wait) await sleep(s.wait);
    else if (s.shot) await p.screenshot({ path: path.join(out, s.shot) });
    else if (s.gif) {
      const enc = GIFEncoder();
      const every = s.every ?? 150;
      for (let i = 0; i < (s.frames ?? 20); i++) {
        const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
        // (halved: a phone shot at dpr 2.6 is 1071 px wide)
        const w = png.width >> 1, h = png.height >> 1;
        const d = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) d[(y * w + x) * 4 + c] = png.data[(y * 2 * png.width + x * 2) * 4 + c];
        const pal = quantize(d, 256);
        enc.writeFrame(applyPalette(d, pal), w, h, { palette: pal, delay: every });
        await sleep(every);
      }
      enc.finish();
      fs.writeFileSync(path.join(out, s.gif), enc.bytes());
    }
    if (s.after) await sleep(s.after);
  }
  await R.fatal(p);
});
