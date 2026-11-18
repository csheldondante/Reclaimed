// Nested scales: the round 7 controls through real pointer events at phone size. Hold Fwd 1.5 s (the eye moves along the
// aim and nearer the ground, never into it), then Back; the stills show the controls at 412 x 915.
// node scripts/nested-controls.mjs --chromeargs ignore-certificate-errors [--port 5461] [--tag x]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-controls', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', '');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.6&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(2500);
  await page.screenshot({ path: `local/nested/controls-phone${tag}.png` });
  const eye = () => page.evaluate(() => ({ ...nested.eye(), f: nested.app.forward() }));
  const hold = async (label, ms) => {
    const box = await page.evaluate((label) => {
      const b = [...document.querySelectorAll('#aim button')].find((x) => x.textContent === label);
      const r = b.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    }, label);
    await page.mouse.move(box[0], box[1]);
    await page.mouse.down();
    await sleep(ms);
    await page.mouse.up();
    await sleep(400);
  };
  for (const [label, sign] of [['Fwd', 1], ['Back', -1]]) {
    const a = await eye();
    await hold(label, 1500);
    const b = await eye();
    const d = [b.x - a.x, b.y - a.y, b.z - a.z];
    const along = d[0] * a.f[0] + d[1] * a.f[1] + d[2] * a.f[2];
    const len = Math.hypot(...d);
    console.log(`${label}: moved ${len.toFixed(3)} (along the aim ${along.toFixed(3)}); nearest ${a.dNear.toFixed(3)} -> ${b.dNear.toFixed(3)}; lifts ${b.lifts}`);
    R.check(`${label} moves along the aim`, sign * along > 0.9 * len && len > 0.05 * a.dNear, `${along.toFixed(3)} of ${len.toFixed(3)}`);
  }
});
