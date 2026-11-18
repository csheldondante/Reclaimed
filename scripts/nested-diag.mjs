// Nested scales: a diagnostic still of one view in the draw's diagnostic colours (Renderer.diag: 1 triangle parity,
// 2 face kind). node scripts/nested-diag.mjs --chromeargs ignore-certificate-errors --port 5462 --view x,y,d,yaw,pitch
//   [--diag 0,1,2] [--tag x]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-diag', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const [x, y, d, yaw, pitch] = R.opt('view', '120,118,5,0.7,0.55').split(',').map(Number);
  const modes = R.opt('diag', '0,1,2').split(',').map(Number);
  const tag = R.opt('tag', '');
  const page = await R.page();
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  // (--rel dx,dy,dz: build the watertight suite's scene first and put the eye at its hit point plus this offset)
  const rel = R.opt('rel', '');
  if (rel) {
    const h = await page.evaluate(async () => {
      const { watertightSuite } = await import('/src/nested/suite.ts');
      const e = nested.eye();
      const f = nested.app.forward();
      const h = [e.x + f[0] * e.dHit, e.y + f[1] * e.dHit, e.z + f[2] * e.dHit];
      await watertightSuite(window.nested, { manifold: false, screen: false });
      return h;
    });
    const o = rel.split(',').map(Number);
    await page.evaluate((v) => nested.setView(v), { yaw, pitch, eye: [h[0] + o[0], h[1] + o[1], h[2] + o[2]] });
  } else await page.evaluate((v) => nested.setView(v), { tx: x, ty: y, d, yaw, pitch });
  await sleep(4000);
  for (const m of modes) {
    await page.evaluate((m) => (nested.app.render.diag = m), m);
    await sleep(400);
    await page.screenshot({ path: `local/nested/diag${m}${tag}.png` });
  }
  console.log(JSON.stringify(await page.evaluate(() => ({ live: nested.state().live, eye: nested.eye() }))));
});
