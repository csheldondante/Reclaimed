// Nested scales (round 16, debugging the sheet draw): the sandbox with the sheet draw on; the draw arguments, a cache
// page 0 header, and the union closure of the capture.
// node scripts/nested-sheetdbg.mjs --chromeargs ignore-certificate-errors [--port 5461]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-sheetdbg', kind: 'behaviour', size: '640x480', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[dbg]')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.5&yaw=0.6&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 30, { timeout: 120000, polling: 100 });
  await sleep(1000);
  const res = await page.evaluate(async () => {
    const a = nested.app;
    a.device.pushErrorScope('validation');
    a.device.pushErrorScope('internal');
    const ok = await nested.smooth(true);
    await a.device.queue.onSubmittedWorkDone();
    const e1 = await a.device.popErrorScope();
    const e2 = await a.device.popErrorScope();
    console.log(`[dbg] errors: ${e1?.message ?? '-'} / ${e2?.message ?? '-'}`);
    const g = a.nest;
    const rd = async (buf, size) => {
      const tmp = a.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const e = a.device.createCommandEncoder();
      e.copyBufferToBuffer(buf, 0, tmp, 0, size);
      a.device.queue.submit([e.finish()]);
      await tmp.mapAsync(GPUMapMode.READ);
      const o = new Uint32Array(tmp.getMappedRange().slice(0));
      tmp.destroy();
      return o;
    };
    const args = await rd(g.drawArgs, 4 * 8 * 16);
    const tab = await rd(g.tab, g.tab.size);
    const cz = {};
    for (let s = 0; s + 3 < tab.length; s += 4) {
      const lid = tab[s + 1] & 0xff;
      if (tab[s + 1] >= 0xfffffff0) continue;
      if (lid >= 48 && lid < 56) cz[`${lid}:${tab[s + 1] >>> 8}`] = (cz[`${lid}:${tab[s + 1] >>> 8}`] ?? 0) + 1;
    }
    console.log(`[dbg] cache pages by lid:cz ${JSON.stringify(cz)}`);
    const sheetArgs = [...Array(8)].map((_, L) => [args[(24 + L) * 4], args[(24 + L) * 4 + 1]]);
    const m = await nested.manifold();
    return { ok, live: g.live, sheetArgs, stats: g.stats, m: m.map((r) => ({ L: r.depth, tris: r.tris, open: r.open, coincident: r.coincident, where: r.rim?.where })) };
  });
  console.log(JSON.stringify(res));
  if (R.opt('out', '')) await page.screenshot({ path: R.opt('out', '') });
});
