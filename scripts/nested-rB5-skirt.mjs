// Nested scales (round 32, step B5: the owner on rB3b-gentle-add80-side-T4.png, "the skirt is just bad because of the
// texture sawtooth"): what the teeth round an 80 m sphere add's foot are. No cliff look (no ?cliff). On rB3's gentle site,
// one ball (add 80 m, made with the 2 m level open, at rB3's add80 position), then a side view (rB3's) and a close view of
// the skirt, each drawn as: textured (default), ?tex=0's flat colour (the column's material colour, Lambert), ?tex=2
// (the per-pixel border mix), the textured draw's diagnostic 3 (green = the shading normal's Lambert, no material),
// the level tint ("Colour levels"). With --extra '&field=1,2,3' the field mesh draws those levels: its dbg 1 (lit normal)
// and 2 (material colour, unlit) are added. A transect of the stored columns (top z, top material) from the ball's
// centre toward the camera at the 2 m and 16 m levels is printed.
// node scripts/nested-rB5-skirt.mjs --chromeargs ignore-certificate-errors --port 5461 [--extra '&field=1,2,3' --tag rB5f]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'rB5-skirt', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const extra = R.opt('extra', '');
  const tag = R.opt('tag', 'rB5');
  const field = extra.includes('field=');
  fs.mkdirSync('local/nested', { recursive: true });
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?smooth=1${extra}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.frameCount > 30, { timeout: 180000, polling: 200 });
  await page.waitForFunction(() => nested.app.render.texDrawn, { timeout: 120000, polling: 200 });
  const settle = async (minLive = 0) => {
    for (let i = 0; i < 400; i++) {
      await sleep(150);
      const ok = await page.evaluate((m) => nested.app.nest.settled && !nested.app.nest.switching && !nested.app.nest.fieldJob && nested.app.nest.live >= m, minLive);
      if (ok && i > 10) break;
    }
    await sleep(800);
  };
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const two = () => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res)))));
  // (rB3's flat spot: the flattest 7 x 7 root columns of the root window's middle)
  const info = await page.evaluate(async () => {
    const a = nested.app;
    const s = await a.nest.readAll();
    const w = a.nest.wins[0];
    const top = (X, Y) => {
      const c = s.column(0, X, Y);
      return c.z1[c.z1.length - 1];
    };
    let flat = { x: 0, y: 0, range: 1e9, z: 0 };
    for (let y = w.gy + 40; y < w.gy + w.n - 40; y++)
      for (let x = w.gx + 40; x < w.gx + w.n - 40; x++) {
        if ((x - w.gx) % 3 || (y - w.gy) % 3) continue;
        let lo = 1e9;
        let hi = -1e9;
        for (let j = -3; j <= 3; j++)
          for (let i = -3; i <= 3; i++) {
            const t = top(x + i, y + j);
            lo = Math.min(lo, t);
            hi = Math.max(hi, t);
          }
        if (hi - lo < flat.range) flat = { x, y, range: hi - lo, z: top(x, y) };
      }
    return { flat, k: a.k, m: a.render.mpu };
  });
  const { flat, k, m } = info;
  console.log(`site gentle: ${JSON.stringify(flat)}; k ${k}, ${m} m a root column`);
  const x = flat.x + 0.5 + 1.6;
  const y = flat.y + 0.5 + 1.6;
  const up = [0, -1];
  const r = 80 / m;
  const L = 2;
  const groundAt = (x, y, L) =>
    page.evaluate(
      async ({ x, y, L }) => {
        const a = nested.app;
        const s = await a.nest.readAll();
        const S = a.k ** L;
        const c = s.column(L, Math.floor(x * S), Math.floor(y * S));
        const c0 = s.column(0, Math.floor(x), Math.floor(y));
        return { z: c.z1.length ? c.z1[c.z1.length - 1] : 0, z0: c0.z1[c0.z1.length - 1], live: a.nest.live };
      },
      { x, y, L },
    );
  const z0 = (await groundAt(x, y, 0)).z0;
  const dEye = 0.3;
  await page.evaluate((v) => nested.setView(v), look([x + up[0] * dEye, y + up[1] * dEye, z0 + dEye * 0.7], [x, y, z0]));
  await settle(L + 1);
  const g = await groundAt(x, y, L);
  if (g.live <= L) throw new Error(`level ${L} did not open (${g.live} live)`);
  const ok = await page.evaluate(
    async ({ r, L, x, y, z }) => {
      const a = nested.app;
      const w = a.nest.wins[L];
      const S = a.k ** L;
      for (let t = 0; t < 100; t++) {
        if (a.nest.edit({ op: 'add', radius: r, amount: 1, at: { level: L, x: x * S - w.gx, y: y * S - w.gy, z } })) return true;
        await new Promise((res) => setTimeout(res, 50));
      }
      return false;
    },
    { r, L, x, y, z: g.z },
  );
  console.log(`add radius 80 m at (${x.toFixed(3)}, ${y.toFixed(3)}) root columns, made at level ${L}: ${ok ? 'made' : 'refused'}`);
  await settle(L + 1);
  // the transect: from the centre toward the camera (-y), the stored columns' top and top material, 2 m and 16 m levels
  const tr = await page.evaluate(
    async ({ x, y, r }) => {
      const a = nested.app;
      const s = await a.nest.readAll();
      const out = [];
      for (const L of [1, 2]) {
        const S = a.k ** L;
        const w = a.nest.wins[L];
        const X = Math.floor(x * S);
        const row = [];
        for (let Y = Math.floor((y - r * 1.25) * S); Y <= Math.floor((y - r * 0.75) * S); Y++) {
          if (!w || X < w.gx || Y < w.gy || X >= w.gx + w.n || Y >= w.gy + w.n) {
            row.push('-');
            continue;
          }
          const c = s.column(L, X, Y);
          const n = c.z1.length;
          // (top in metres above the level's z origin: local units x metres a column)
          row.push(n ? `${(c.z1[n - 1] * (a.render.mpu / S)).toFixed(1)}:${c.mat[n - 1] & 255}` : 'none');
        }
        out.push(`L${L} (${a.render.mpu / S} m) x=${X}, y from ${Math.floor((y - r * 1.25) * S)}: ${row.join(' ')}`);
      }
      return out;
    },
    { x, y, r },
  );
  for (const t of tr) console.log(`  ${t}`);
  const variants = [
    ['tex1', async () => page.evaluate(() => nested.texMode(1))],
    ['tex0', async () => page.evaluate(() => nested.texMode(0))],
    ['tex2', async () => page.evaluate(() => nested.texMode(2))],
    [
      'diag3',
      async () => {
        await page.evaluate(() => nested.texMode(1));
        await page.evaluate(() => (nested.app.render.diag = 3));
      },
    ],
    [
      'tint',
      async () => {
        await page.evaluate(() => (nested.app.render.diag = 0));
        await page.evaluate(() => nested.tint(true));
      },
    ],
  ];
  if (field) {
    variants.push(['fdbg1', async () => page.evaluate(() => { nested.tint(false); nested.app.render.fieldOpt.dbg = 1; })]);
    variants.push(['fdbg2', async () => page.evaluate(() => (nested.app.render.fieldOpt.dbg = 2))]);
  }
  const reset = async () => page.evaluate(async () => {
    nested.tint(false);
    nested.app.render.diag = 0;
    if (nested.app.render.fieldOpt) nested.app.render.fieldOpt.dbg = 0;
    await nested.texMode(1);
  });
  const sv = look([x + up[0] * r * 3.2 + up[1] * r * 1.2, y + up[1] * r * 3.2 - up[0] * r * 1.2, z0 + r * 1.3], [x, y, z0 - r * 0.2]);
  // (close: the skirt's foot on the camera's side, about 30 m away, a little above)
  const foot = [x, y - r * 1.0, z0];
  const cv = look([foot[0] - r * 0.12, foot[1] - r * 0.35, z0 + r * 0.18], [foot[0], foot[1] + r * 0.1, z0 + r * 0.02]);
  // (above: straight down onto the foot on the camera's side, about 50 m up: the border's shape in plan)
  const av = look([foot[0] + 0.001, foot[1] - r * 0.02, z0 + r * 0.6], [foot[0], foot[1], z0]);
  for (const [name, v] of [['side', sv], ['close', cv], ['above', av]]) {
    await page.evaluate((v) => nested.setView(v), v);
    await settle(2);
    const lv = await page.evaluate(() => nested.app.nest.live);
    for (const [vn, f] of variants) {
      await f();
      await two();
      await sleep(250);
      await page.screenshot({ path: `local/nested/${tag}-${name}-${vn}.png` });
    }
    await reset();
    console.log(`  ${name}: ${lv} levels live; stills ${tag}-${name}-{${variants.map((v) => v[0]).join(',')}}.png`);
  }
});
