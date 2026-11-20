// Nested scales (round 18): the first boot with ?smooth=1 on a fresh world, as the owner's phone sees it. Per --maxbuf
// (MB; 0: the device's own limit): every status line the page shows while the sheets are wanted but not drawn, the time
// to the first frame and to the first sheet frame, both pipelines' creation times, the switch's bake (pages asked, wall
// time, frames, rows) and the pages the sheets actually hold after it.
// node scripts/nested-smoothboot.mjs --chromeargs ignore-certificate-errors [--port 5461] [--maxbuf 0,512,256]
import { run, sleep } from './lib/runner.mjs';

/** (round 19, the boot gate) ms after the page opened, desktop Chrome with ?smooth=1; about 1.5 x round 19's cold run
 *  (first frame 7.2 s, every boot pipeline 12.8 s, first sheet frame 10.5 s), the same for reloads */
const BOOT_BUDGET = { firstFrame: 11000, allPipes: 19000, firstSheet: 16000 };

await run({ name: 'nested-smoothboot', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[smooth]')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  // (--boot 1, round 19: smooth off; when the first frame was submitted and when the GPU finished it: Chrome compiles
  // pipelines made synchronously in the GPU process, so a first frame's submit returns before they are compiled)
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  page.on('console', (m) => {
    if (m.text().startsWith('[boot]')) console.log(`[page log] ${m.text()}`);
  });
  if (R.opt('boot', '0') === '1') {
    for (let i = 0; i < 2; i++) {
      await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140${R.opt('q', '') ? `&${R.opt('q', '')}` : ''}`, { waitUntil: 'load' });
      const ok = await page.waitForFunction(() => window.nested && nested.app.frameCount > 0, { timeout: 120000, polling: 20 }).then(
        () => true,
        () => false,
      );
      if (!ok) {
        console.log(`no frame in 120 s; the page says: ${await page.evaluate(() => document.body.innerText.slice(0, 600))}`);
        R.check('boot: a first frame', false, 'none');
        return;
      }
      const t = await page.evaluate(async () => {
        const a = nested.app;
        await a.device.queue.onSubmittedWorkDone();
        return { first: a.firstFrameAt, done: performance.now() };
      });
      console.log(`boot ${i ? 'reload' : 'cold'}: first frame submitted ${t.first.toFixed(0)} ms, GPU done with it ${t.done.toFixed(0)} ms`);
    }
    return;
  }
  // (--split 1: smooth off, then each sheet pipeline made alone, one after the other, timed)
  if (R.opt('split', '0') === '1') {
    await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.nested && nested.app.frameCount > 10, { timeout: 120000, polling: 50 });
    const t = await page.evaluate(async () => {
      const a = nested.app;
      const wait = async (f) => {
        const t0 = performance.now();
        while (!f()) await new Promise((r) => setTimeout(r, 20));
        return performance.now() - t0;
      };
      const draw = await wait(() => a.render.prepareSheets());
      const pass = await wait(() => a.nest.prepareSheets());
      return { draw, pass };
    });
    console.log(`split: sheet draw alone ${t.draw.toFixed(0)} ms, then the sheet pass alone ${t.pass.toFixed(0)} ms`);
    return;
  }
  let loads = 0;
  for (const mb of R.opt('maxbuf', '0,512,256').split(',').map(Number)) {
    await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140&smooth=1${mb ? `&maxbuf=${mb}` : ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.nested && nested.app.frameCount > 0, { timeout: 120000, polling: 50 });
    const seen = new Map();
    let st = null;
    for (let i = 0; i < 600; i++) {
      st = await page.evaluate(() => {
        const a = nested.app;
        return { text: a.smoothText, on: a.nest.smooth, first: a.firstFrameAt, sheet: a.firstSheetAt, pipes: a.pipesAt, live: a.nest.live, cap: a.nest.cap, max: a.nest.stats.maxPages, used: a.nest.stats.used, frames: a.frameCount };
      });
      const kind = st.text.replace(/[0-9]+/g, '#');
      if (st.text && !seen.has(kind)) seen.set(kind, st.text);
      if ((st.on && st.pipes) || st.text.includes('cannot')) break;
      await sleep(100);
    }
    const after = await page.evaluate(async () => {
      const a = nested.app;
      await a.device.queue.onSubmittedWorkDone();
      const s = await a.nest.readAll();
      const pages = [];
      for (let m = 0; m < a.nest.live; m++) pages.push({ level: m, chunks: (a.nest.wins[m].n / 16) ** 2, sheetPages: s.pagesOf(48 + m), facePages: s.pagesOf(16 + m), columnPages: s.pagesOf(m) });
      // (round 28) the last boot pipelines made: what sets "every boot pipeline made"
      const made = Object.entries(a.nest.pipeMade).sort((x, y) => y[1].at - x[1].at).slice(0, 6).map(([n, t]) => `${n} at ${t.at.toFixed(0)} (${t.ms.toFixed(0)} ms)`);
      return { compileNest: a.nest.compileMs, compileDraw: a.render.compileMs, switchLog: a.nest.switchLog, pages, maxCz: a.nest.stats.maxCz, live: a.nest.live, made, bootAt: a.bootAt };
    });
    console.log(`maxbuf ${mb || 'device'}: first frame ${st.first.toFixed(0)} ms, first sheet frame ${st.on ? st.sheet.toFixed(0) : 'never'} ms; pool ${st.cap} pages (device ${st.max}), used ${st.used}; ${after.live} levels`);
    console.log(`  statuses: ${[...seen.values()].join(' | ') || '(none seen)'}`);
    console.log(`  pipelines: sheet pass ${after.compileNest.toFixed(0)} ms, sheet draw ${after.compileDraw.toFixed(0)} ms (asynchronous)`);
    console.log(`  switch: ${JSON.stringify(after.switchLog)}; maxCz ${after.maxCz}`);
    console.log(`  pages after: ${JSON.stringify(after.pages)}`);
    console.log(`  boot pipelines: first frame's made at ${after.bootAt.toFixed(0)} ms; the last made: ${after.made.join(', ')}`);
    R.check(`maxbuf ${mb || 'device'}: the sheets are drawn, or the page says why not`, st.on || st.text.includes('cannot'), st.text);
    // (round 19, the boot gate: ms after the page opened, desktop Chrome, each about 1.5 x round 19's cold run; a fresh
    // browser each run, so the first page is cold and the next ones reloads)
    for (const [what, v, budget] of [
      ['first frame', st.first, BOOT_BUDGET.firstFrame],
      ['every boot pipeline made', st.pipes, BOOT_BUDGET.allPipes],
      ['first sheet frame', st.sheet, BOOT_BUDGET.firstSheet],
    ])
      R.check(`boot gate, ${loads ? 'reload' : 'cold'} (maxbuf ${mb || 'device'}): ${what} within ${budget} ms`, v > 0 && v <= budget, `${v ? v.toFixed(0) : 'never'} ms`);
    loads++;
  }
});
