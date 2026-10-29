// Headless verification helper: loads the game in Chrome with WebGPU, runs
// optional page scripts, prints console output and saves screenshots.
//
//   node scripts/shot.mjs [--url "/?skipmenu=1&level=atlas"] [--out file.png] [--wait ms]
//        [--eval "js"] [--then ms --out2 file2.png] [--size 960x540] [--dpr 1]
//        [--clicks "x,y;wait:ms;x,y"] [--drag x0,y0,x1,y1] [--gif g.gif --frames N --every ms]
//        [--kind behaviour|timing] [--dev] [--server http://localhost:5173]
//
// (round 112, testspeed) On the shared runner (scripts/lib/runner.mjs): this worktree's production build, served on its
// own port, a kept Chrome profile (the shader cache), the GPU leased as a behaviour check. `--url` is a path and query
// on that server (a full http URL is used as it is). A level page (?skipmenu=1) is waited for by its boot marks
// (level-ready, the store open) and then `--wait` ms; any other page `--wait` ms after load. `--dev`: Vite's dev
// server instead (a page script that imports /src/... needs it).
//
// Fails loudly (non-zero exit) on page errors, console errors or the fatal overlay.
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'shot', kind: 'behaviour', size: '960x540', dpr: 1, echo: true }, async (R) => {
  const args = Object.fromEntries(
    R.argv.reduce((acc, a, i, arr) => {
      if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
      return acc;
    }, []),
  );
  const u = args.url ?? '/?perf=1';
  const url = /^https?:/.test(u) ? u : `${R.url}${u.startsWith('/') ? '' : '/'}${u}`;
  const page = await R.page();
  await page.goto(url, { waitUntil: 'load' });
  if (new URL(url).searchParams.get('skipmenu') === '1') {
    await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(page);
    await page.waitForFunction(() => !window.reclaimed?.stream || window.__boot?.at.store || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
    R.log(`boot ${JSON.stringify(await page.evaluate(() => window.__boot.at))}`);
  }
  await sleep(Number(args.wait ?? 2000));
  await R.fatal(page);
  if (args.eval) {
    const r = await page.evaluate(args.eval);
    if (r !== undefined) console.log(`[eval] ${JSON.stringify(r)}`);
  }
  // --clicks "x,y;wait:ms;x,y"  (CSS px)  --drag "x0,y0,x1,y1"
  if (args.clicks) {
    for (const c of args.clicks.split(';')) {
      if (c.startsWith('wait:')) {
        await sleep(Number(c.slice(5)));
        continue;
      }
      const [x, y] = c.split(',').map(Number);
      await page.mouse.click(x, y);
      await sleep(400);
    }
  }
  if (args.drag) {
    const [x0, y0, x1, y1] = args.drag.split(',').map(Number);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(x0 + ((x1 - x0) * i) / 20, y0 + ((y1 - y0) * i) / 20);
      await sleep(30);
    }
    await page.mouse.up();
  }
  if (args.then) await sleep(Number(args.then));
  await page.screenshot({ path: args.out ?? 'shot.png' });
  console.log(`saved ${args.out ?? 'shot.png'}`);
  if (args.eval2) {
    const r = await page.evaluate(args.eval2);
    if (r !== undefined) console.log(`[eval2] ${JSON.stringify(r)}`);
  }
  // --gif out.gif [--frames 40] [--every 60]  animated capture at the end
  if (args.gif) {
    const frames = Number(args.frames ?? 40);
    const every = Number(args.every ?? 60);
    const enc = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
      await sleep(every);
    }
    enc.finish();
    fs.writeFileSync(args.gif, enc.bytes());
    console.log('saved ' + args.gif);
  }
  if (args.out2) {
    await sleep(Number(args.then2 ?? 3000));
    await page.screenshot({ path: args.out2 });
    console.log(`saved ${args.out2}`);
  }
  await R.fatal(page);
});
