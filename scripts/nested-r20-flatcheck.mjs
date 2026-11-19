// Nested scales (round 20): the textured toggle off draws exactly what round 19 drew. In one page with ?tex=0, the
// current flat draw is compared pixel for pixel with a pipeline built from the round 19 draw.wgsl (git show <rev>), for
// the box draw and the sheet draw at a few views. Two screenshots of the same pipeline first (the frame is still).
// node scripts/nested-r20-flatcheck.mjs --chromeargs ignore-certificate-errors --port 5476 [--rev 3c1ccc33]
import { run, sleep } from './lib/runner.mjs';
import { execSync } from 'node:child_process';
import { PNG } from 'pngjs';

await run({ name: 'r20-flatcheck', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const rev = R.opt('rev', '3c1ccc33');
  const oldDraw = execSync(`git show ${rev}:src/nested/gpu/draw.wgsl`, { encoding: 'utf8' });
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140&tex=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60 && nested.app.pipesReady, { timeout: 180000, polling: 100 });
  // the round 19 pipelines (same layout, entry points and targets)
  await page.evaluate(async (oldDraw) => {
    const r = nested.app.render;
    const { segWgsl, TCAP } = await import('/src/nested/gpu/nest.ts');
    const store = (await import('/src/nested/gpu/store.wgsl?raw')).default;
    const n = nested.app.nest;
    const module = nested.app.device.createShaderModule({ code: `const TCAP: u32 = ${TCAP}u;\n${segWgsl(n.S, n.segP, true)}\n${store}\n${oldDraw}` });
    const desc = (vs, fs) => ({
      layout: r.pl,
      vertex: { module, entryPoint: vs },
      fragment: { module, entryPoint: fs, targets: [{ format: r.format }, { format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    window.__old = { box: await nested.app.device.createRenderPipelineAsync(desc('vs', 'fs')), sheet: await nested.app.device.createRenderPipelineAsync(desc('vsSheet', 'fsS')) };
  }, oldDraw);
  const clip = { x: 0, y: 170, width: 870, height: 330 };
  const shot = async () => PNG.sync.read(Buffer.from(await page.screenshot({ clip })));
  const diff = (a, b) => {
    let n = 0;
    let max = 0;
    for (let i = 0; i < a.data.length; i += 4)
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[i + c] - b.data[i + c]);
        if (d) {
          n++;
          max = Math.max(max, d);
        }
      }
    return { n, max };
  };
  const swap = async (old, smooth) =>
    page.evaluate(
      async ([old, smooth]) => {
        const r = nested.app.render;
        if (!window.__new) window.__new = { box: r.pipe, sheet: r.smoothPipe?.sheet };
        if (smooth && !window.__new.sheet) window.__new.sheet = r.smoothPipe.sheet;
        r.pipe = old ? __old.box : __new.box;
        if (smooth) r.smoothPipe = { sheet: old ? __old.sheet : __new.sheet };
        for (let i = 0; i < 4; i++) await new Promise((res) => requestAnimationFrame(res));
      },
      [old, smooth],
    );
  const views = [
    { yaw: 0, pitch: 0.3, eye: [100, 120, 40] },
    { yaw: 0.8, pitch: 0.5, eye: [104, 136, 16] },
    { yaw: 2.2, pitch: 0.2, eye: [96, 142, 30] },
  ];
  let bad = 0;
  for (const smooth of [false, true]) {
    if (smooth) await page.evaluate(() => nested.smooth(true));
    for (const v of views) {
      await page.evaluate((v) => nested.setView(v), v);
      await sleep(2500);
      await swap(false, smooth);
      const a = await shot();
      const a2 = await shot();
      await swap(true, smooth);
      const b = await shot();
      await swap(false, smooth);
      const still = diff(a, a2);
      const d = diff(a, b);
      console.log(`${smooth ? 'sheets' : 'boxes '} view ${JSON.stringify(v.eye)}: same pipeline twice ${still.n} channels differ; round 20 flat vs ${rev}: ${d.n} channels differ (max ${d.max})`);
      if (still.n === 0 && d.n > 0) bad++;
    }
  }
  // (control: the swap is seen; the round 19 sheet pipeline drawn for the boxes' pipeline would be wrong, so instead the
  // textured draw must differ)
  const a = await shot();
  await page.evaluate(() => nested.tex(true));
  const t = diff(a, await shot());
  console.log(`control, textured on: ${t.n} channels differ`);
  if (t.n === 0) bad++;
  if (bad) throw new Error(`${bad} views differ from ${rev}`);
});
