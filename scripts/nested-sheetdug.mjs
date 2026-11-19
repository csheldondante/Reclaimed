// Nested scales (round 16): the full selftest's order for the sheet draw's pit poses: the sandbox, the box pit section
// (pitAndCave, taps 4), the sheet draw switched on in that dug world, then pitAndCave again with its per-pose diagnosis
// (watertight.ts rayDiag): which poses see a hole, and what is round the first hole pixel.
// node scripts/nested-sheetdug.mjs --chromeargs ignore-certificate-errors [--port 5461]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-sheetdug', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning' || (t.startsWith('[pit]') && !/ 0 hole pixels/.test(t)) || t.startsWith('[sheets]')) console.log(`[page ${m.type()}] ${t.slice(0, 1500)}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(1500);
  const res = await page.evaluate(async () => {
    const { pitAndCave } = await import('/src/nested/suite.ts');
    const a = await pitAndCave(nested, { taps: 4, log: () => {} });
    await nested.smooth(true);
    await new Promise((r) => setTimeout(r, 1500));
    const b = await pitAndCave(nested, { taps: 4, diag: true, log: (s) => console.log(`[pit] ${s}`) });
    return { boxes: [a.total, a.poses], sheets: [b.total, b.poses, b.coverage] };
  });
  console.log(JSON.stringify(res));
});
