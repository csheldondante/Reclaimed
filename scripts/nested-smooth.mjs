// Nested scales (round 14, NS-107): the smooth draw's narrow check on the sandbox (the selftest's scene): switch it on,
// then per level the closure of the drawn triangles (template + exceptions: odd edges, degenerate, coincident), the rim
// lines and the coverage, before and after a few carves; screenshots boxes vs smooth.
// node scripts/nested-smooth.mjs --chromeargs ignore-certificate-errors [--port 5461] [--carves 3] [--shots 1]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'nested-smooth', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[smooth]')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(1500);
  const shots = R.opt('shots', '1') === '1';
  fs.mkdirSync('local/nested', { recursive: true });
  if (shots) await page.screenshot({ path: 'local/nested/r14-dev-boxes.png' });
  await page.evaluate(() => void nested.smooth(true));
  for (let i = 0; i < 60; i++) {
    const s = await page.evaluate(() => ({ on: nested.app.nest.smooth, fatal: document.querySelector('.fatal')?.textContent ?? '', err: nested.app.nest.stats.error, frames: nested.app.frameCount }));
    if (s.on || s.fatal) {
      console.log('smooth state', JSON.stringify(s));
      break;
    }
    if (i === 59) console.log('smooth not on after 30 s', JSON.stringify(s));
    await sleep(500);
  }
  await page.evaluate(() => nested.app.device.queue.onSubmittedWorkDone());
  await sleep(800);
  if (shots) await page.screenshot({ path: 'local/nested/r14-dev-smooth.png' });
  const fatal = await page.evaluate(() => document.querySelector('.fatal')?.textContent ?? '');
  if (fatal) console.log('FATAL', fatal);
  const check = async (when) => {
    const r = await page.evaluate(async () => {
      const m = await nested.manifold();
      const c = await nested.coverage();
      return { m: m.map((x) => ({ depth: x.depth, tris: x.tris, open: x.open, degenerate: x.degenerate, coincident: x.coincident, where: x.where.slice(0, 3), rim: x.rim && { lines: x.rim.lines, junctions: x.rim.junctions, unflagged: x.rim.unflagged, where: x.rim.where } })), c };
    });
    for (const l of r.m) console.log(`${when} L${l.depth}: ${l.tris} tris, odd ${l.open}, degenerate ${l.degenerate}, coincident ${l.coincident}${l.open ? ` at ${JSON.stringify(l.where)}` : ''}${l.rim ? `, rim lines ${l.rim.lines} junctions ${l.rim.junctions} unflagged ${l.rim.unflagged} ${l.rim.where.join('; ')}` : ''}`);
    console.log(`${when} coverage: stale ${r.c.stale}, missing ${r.c.missing} ${r.c.where.slice(0, 3).join('; ')}`);
    const bad = r.m.reduce((s, l) => s + l.open + l.degenerate + l.coincident + (l.rim ? l.rim.junctions + l.rim.unflagged : 0), 0) + r.c.stale + r.c.missing;
    R.check(`smooth ${when}: closed, no degenerate or coincident faces, rim lines, coverage`, bad === 0, `${bad}`);
  };
  await check('start');
  // (--shaft 1) the pit suite's shaft carves (radius 2.2 world at level 1, 1.5 apart, down to -24), one at a time, the GPU
  // time of each (the device was lost there with the smooth draw on)
  if (R.opt('shaft', '0') === '1') {
    if (R.opt('box', '0') === '1') await page.evaluate(() => nested.smooth(false));
    const r = await page.evaluate(async () => {
      const a = nested.app;
      a.frozen = true;
      const snap = await a.nest.readAll();
      const zo = snap.zOrigin(1);
      const w1 = a.nest.wins[1];
      const x = w1.gx / 8 + 0.3;
      const y = w1.gy / 8 + w1.n / 16 + 4;
      const c = snap.column(0, Math.floor(x), Math.floor(y));
      const out = [];
      for (let z = c.z1[c.z1.length - 1] + 1; z > -24; z -= 1.5) {
        const t = performance.now();
        while (!a.nest.edit({ op: 'carve', radius: 2.2, amount: 0, at: { level: 1, x: x * 8 - w1.gx, y: y * 8 - w1.gy, z: (z - zo) * 8 } })) await new Promise((r) => setTimeout(r, 30));
        await a.device.queue.onSubmittedWorkDone();
        out.push(Math.round(performance.now() - t));
        console.log(`[smooth] shaft carve at ${z.toFixed(1)}: ${out[out.length - 1]} ms, ${a.nest.live} levels`);
      }
      a.frozen = false;
      return out;
    });
    console.log(`shaft carves ms: ${r.join(' ')}`);
    if (R.opt('box', '0') === '1') {
      // (the switch in a world dug with boxes: the full selftest lost the device there)
      const t = await page.evaluate(async () => {
        const t0 = performance.now();
        await nested.smooth(true);
        return { ms: performance.now() - t0, fatal: document.querySelector('.fatal')?.textContent ?? '' };
      });
      console.log(`switch on after the shafts: ${JSON.stringify(t)}`);
    }
  }
  // (--skips 1) how many chunks a carve's cache pass found unchanged (cache page word 2; all 0 after the switch)
  if (R.opt('skips', '0') === '1') {
    const r = await page.evaluate(async () => {
      const a = nested.app;
      const w1 = a.nest.wins[1];
      const s0 = await a.nest.readAll();
      const zo = s0.zOrigin(1);
      const X = w1.gx + w1.n / 2;
      const Y = w1.gy + w1.n / 2;
      const c = s0.column(1, X, Y);
      while (!a.nest.edit({ op: 'carve', radius: 0.5, amount: 0, at: { level: 1, x: X - w1.gx, y: Y - w1.gy, z: c.z1[c.z1.length - 1] } })) await new Promise((r) => setTimeout(r, 30));
      const bakes = await a.nest.readBakes();
      const s = await a.nest.readAll();
      const out = {};
      for (let L = 0; L < a.nest.live; L++) {
        const w = a.nest.wins[L];
        let one = 0;
        for (let cy = w.gy / 16; cy < (w.gy + w.n) / 16; cy++)
          for (let cx = w.gx / 16; cx < (w.gx + w.n) / 16; cx++) {
            const p = s.page(48 + L, cx, cy, 0);
            if (p < 0xfffffffe && s.pg[p * 12544 + 2] === 1) one++;
          }
        out[L] = { skipped: one, baked: bakes.filter((b) => b.L === L).reduce((t, b) => t + b.chunks, 0) };
      }
      return out;
    });
    console.log(`one carve at level 1: chunks per level ${JSON.stringify(r)}`);
  }
  const carves = Number(R.opt('carves', '3'));
  for (let i = 0; i < carves; i++) {
    await page.evaluate((i) => nested.sculpt('carve', -0.2 + 0.2 * i, -0.1, 1), i);
    await sleep(600);
  }
  if (carves) {
    if (shots) await page.screenshot({ path: 'local/nested/r14-dev-carved.png' });
    await check('after carves');
  }
});
