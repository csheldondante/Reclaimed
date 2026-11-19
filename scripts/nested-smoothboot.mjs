// Nested scales (round 18): the first boot with ?smooth=1 on a fresh world, as the owner's phone sees it. Per --maxbuf
// (MB; 0: the device's own limit): every status line the page shows while the sheets are wanted but not drawn, the time
// to the first frame and to the first sheet frame, both pipelines' creation times, the switch's bake (pages asked, wall
// time, frames, rows) and the pages the sheets actually hold after it.
// node scripts/nested-smoothboot.mjs --chromeargs ignore-certificate-errors [--port 5461] [--maxbuf 0,512,256]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-smoothboot', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[smooth]')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
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
  for (const mb of R.opt('maxbuf', '0,512,256').split(',').map(Number)) {
    await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140&smooth=1${mb ? `&maxbuf=${mb}` : ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.nested && nested.app.frameCount > 0, { timeout: 120000, polling: 50 });
    const seen = new Map();
    let st = null;
    for (let i = 0; i < 600; i++) {
      st = await page.evaluate(() => {
        const a = nested.app;
        return { text: a.smoothText, on: a.nest.smooth, first: a.firstFrameAt, sheet: a.firstSheetAt, live: a.nest.live, cap: a.nest.cap, max: a.nest.stats.maxPages, used: a.nest.stats.used, frames: a.frameCount };
      });
      const kind = st.text.replace(/[0-9]+/g, '#');
      if (st.text && !seen.has(kind)) seen.set(kind, st.text);
      if (st.on || st.text.includes('cannot')) break;
      await sleep(100);
    }
    const after = await page.evaluate(async () => {
      const a = nested.app;
      await a.device.queue.onSubmittedWorkDone();
      const s = await a.nest.readAll();
      const pages = [];
      for (let m = 0; m < a.nest.live; m++) pages.push({ level: m, chunks: (a.nest.wins[m].n / 16) ** 2, sheetPages: s.pagesOf(48 + m), facePages: s.pagesOf(16 + m), columnPages: s.pagesOf(m) });
      return { compileNest: a.nest.compileMs, compileDraw: a.render.compileMs, switchLog: a.nest.switchLog, pages, maxCz: a.nest.stats.maxCz, live: a.nest.live };
    });
    console.log(`maxbuf ${mb || 'device'}: first frame ${st.first.toFixed(0)} ms, first sheet frame ${st.on ? st.sheet.toFixed(0) : 'never'} ms; pool ${st.cap} pages (device ${st.max}), used ${st.used}; ${after.live} levels`);
    console.log(`  statuses: ${[...seen.values()].join(' | ') || '(none seen)'}`);
    console.log(`  pipelines: sheet pass ${after.compileNest.toFixed(0)} ms, sheet draw ${after.compileDraw.toFixed(0)} ms (asynchronous)`);
    console.log(`  switch: ${JSON.stringify(after.switchLog)}; maxCz ${after.maxCz}`);
    console.log(`  pages after: ${JSON.stringify(after.pages)}`);
    R.check(`maxbuf ${mb || 'device'}: the sheets are drawn, or the page says why not`, st.on || st.text.includes('cannot'), st.text);
  }
});
