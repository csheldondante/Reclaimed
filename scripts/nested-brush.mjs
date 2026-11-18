// Nested scales: the size slider and instant taps through real pointer events (round 7). Carve: three taps at the
// screen's centre (each the whole ball at once; each lands on the new surface, so the centre ray's first solid gets
// further each time), then a drag across and back (one layer: the second pass changes nothing more); then Add the same.
// node scripts/nested-brush.mjs --chromeargs ignore-certificate-errors [--port 5461] [--tag x]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-brush', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', '');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await page.evaluate(() => nested.setView({ yaw: 0, pitch: 0.9, d: 2.5 }));
  await sleep(4000);
  const ops = () => page.evaluate(() => nested.app.opLog.filter((o) => o.what === 'edit').length);
  const hit = () => page.evaluate(() => nested.eye().dHit);
  const [cx, cy] = [480, 320];
  for (const mode of ['carve', 'add']) {
    await page.keyboard.press(mode === 'carve' ? 'c' : 'f');
    await page.evaluate(() => (nested.app.frozen = true));
    const r = await page.evaluate(() => ({ radius: nested.app.brushRadius(), text: document.querySelector('#bar .slider .val').textContent }));
    const taps = [];
    for (let i = 0; i < 3; i++) {
      const h0 = await hit();
      const e0 = await ops();
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await sleep(120);
      await page.mouse.up();
      await sleep(700);
      taps.push({ edits: (await ops()) - e0, hitBefore: +h0.toFixed(4), hitAfter: +(await hit()).toFixed(4) });
    }
    await page.screenshot({ path: `local/nested/brush-${mode}-taps${tag}.png` });
    const e0 = await ops();
    const [x0, x1, y] = [cx - 160, cx + 160, cy + 110];
    await page.mouse.move(x0, y);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(x0 + ((x1 - x0) * i) / 30, y);
      await sleep(30);
    }
    for (let i = 29; i >= 0; i--) {
      await page.mouse.move(x0 + ((x1 - x0) * i) / 30, y);
      await sleep(30);
    }
    await page.mouse.up();
    await sleep(1200);
    const st = await page.evaluate(() => nested.state().stats);
    console.log(`${mode}: radius ${r.radius.toFixed(4)} world ("${r.text}"); taps ${JSON.stringify(taps)}; drag edits ${(await ops()) - e0}; pages ${st.used} of ${st.cap}, waits ${st.waits}, refused ${st.refused}`);
    R.check(`${mode}: a tap is one edit`, taps.every((t) => t.edits === 1), JSON.stringify(taps.map((t) => t.edits)));
    if (mode === 'carve') R.check('carve: repeated taps go deeper', taps.every((t) => t.hitAfter > t.hitBefore + 1e-4), JSON.stringify(taps));
    await page.screenshot({ path: `local/nested/brush-${mode}-after${tag}.png` });
    await page.evaluate(() => (nested.app.frozen = false));
  }
});
