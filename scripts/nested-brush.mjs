// Nested scales: hold-to-grow and swept strokes through real pointer events. Carve: press, hold still 1.5 s (the ball
// grows; a still with the ring), drag across, back over the same path, release; then Add the same way elsewhere.
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
  const stroke = async (mode, x0, y0, x1, y1, name) => {
    await page.keyboard.press(mode === 'carve' ? 'c' : 'f');
    const e0 = await ops();
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await sleep(1500);
    const r = await page.evaluate(() => ({ px: nested.app.strokePx, text: document.getElementById('info').textContent.split('\n').find((l) => l.startsWith('Brush')) }));
    await page.screenshot({ path: `local/nested/brush-${name}-hold${tag}.png` });
    const e1 = await ops();
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(x0 + ((x1 - x0) * i) / 30, y0 + ((y1 - y0) * i) / 30);
      await sleep(30);
    }
    for (let i = 29; i >= 0; i--) {
      await page.mouse.move(x0 + ((x1 - x0) * i) / 30, y0 + ((y1 - y0) * i) / 30);
      await sleep(30);
    }
    await page.mouse.up();
    await sleep(1500);
    const e2 = await ops();
    const st = await page.evaluate(() => nested.state().stats);
    console.log(`${name}: ring ${r.px.toFixed(1)} px after 1.5 s ("${r.text}"); edits while held ${e1 - e0}, over the stroke ${e2 - e0}; pages ${st.used} of ${st.cap}, waits ${st.waits}, refused ${st.refused}`);
    await page.screenshot({ path: `local/nested/brush-${name}-after${tag}.png` });
  };
  await stroke('carve', 380, 330, 600, 330, 'carve');
  await stroke('add', 380, 450, 600, 450, 'add');
  await page.mouse.move(480, 200);
});
