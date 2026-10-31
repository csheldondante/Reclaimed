// The structures viewer on a phone (412×915 dpr 2.6, touch): one finger turns, two pinch to zoom; the panel opens.
//   node scripts/structtouch.mjs
import { run } from './lib/runner.mjs';

await run({ name: 'structtouch', kind: 'behaviour', size: '412x915', dpr: 2.6 }, async (R) => {
  const p = await R.page();
  await p.emulate({ viewport: { width: 412, height: 915, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9a) Mobile' });
  await p.goto(`${R.url}/structures.html?view=city`, { waitUntil: 'load' });
  await p.waitForFunction(() => document.body.dataset.ready === '1' || document.querySelector('.fatal'), { timeout: 60000 });
  const st = () => p.evaluate(() => ({ yaw: window.structures.state.yaw, zoom: window.structures.state.zoom, folded: document.getElementById('panel').classList.contains('folded') }));
  const s0 = await st();
  R.check('the panel starts folded on a phone', s0.folded, s0);
  // one finger: turn
  await p.touchscreen.touchStart(200, 500);
  for (let i = 1; i <= 10; i++) await p.touchscreen.touchMove(200 + i * 12, 500);
  await p.touchscreen.touchEnd();
  const s1 = await st();
  R.check('one finger turns the view', Math.abs(s1.yaw - s0.yaw) > 0.2, { before: s0.yaw, after: s1.yaw });
  // two fingers apart: zoom in (CDP touch events with two points)
  const cdp = p.cdp;
  const pts = (d) => [{ x: 206 - d, y: 500 }, { x: 206 + d, y: 500 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(40) });
  for (let d = 50; d <= 140; d += 10) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const s2 = await st();
  R.check('two fingers apart zoom in', s2.zoom < s1.zoom * 0.7, { before: s1.zoom, after: s2.zoom });
  // the panel opens
  await p.tap('#panel .head button');
  const s3 = await st();
  R.check('+ opens the panel', !s3.folded, s3);
  const f = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  R.check('no fatal', !f, f);
});
