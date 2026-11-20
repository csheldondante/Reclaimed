// Nested scales (round 32 step B3, the owner's addition): what spherical carves and adds look like under ?cliff=5. On one
// site (--site gentle: the flattest ground of the root window's middle; --site slope: rB2's steepest root step), four
// balls centred at the ground, each made with the camera close so finer levels are open (the 40 m ones with the 0.25 m
// level open, the 80 m ones with the 2 m level): carve 40 m, add 40 m, carve 80 m, add 80 m. Then per ball a side view and
// a view from above, each as cliff=0 (render.cliffBoxOn off), cliff=5 T 2 and cliff=5 T 4 (the table rebuilt), with the
// closure count (holes below the horizon) and the SPLIT cell count. The first ball's edit also gets stills 1 and 3
// frames after the edit call (the table is rebuilt only once the store settles: the lag) and at the edit pose.
// node scripts/nested-rB3-brush.mjs --chromeargs ignore-certificate-errors --port 5461 --site gentle|slope
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'rB3-brush', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const site = R.opt('site', 'gentle');
  const tag = `${R.opt('tag', 'rB3b')}-${site}`;
  fs.mkdirSync('local/nested', { recursive: true });
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?cliff=5&smooth=1${R.opt('extra', '')}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.frameCount > 30, { timeout: 180000, polling: 200 });
  await page.waitForFunction(() => nested.app.render.texDrawn && nested.app.render.cliffBox && nested.app.render.cliffBox.ready, { timeout: 120000, polling: 200 });
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
  const frames = (k) =>
    page.evaluate((k) => new Promise((res) => {
      const f = (i) => (i <= 0 ? res() : requestAnimationFrame(() => f(i - 1)));
      f(k);
    }), k);
  const holes = (pitch) =>
    page.evaluate(async (pitch) => {
      const hl = await nested.holes();
      const tn = Math.tan((50 * Math.PI) / 360);
      let cnt = 0;
      for (let y = 0; y < hl.h; y++) {
        const ny = 1 - ((y + 0.5) / hl.h) * 2;
        const dz = -Math.sin(pitch) + ny * tn * Math.cos(pitch);
        if (dz / Math.hypot(1, ny * tn) < -0.1) cnt += hl.rows[y];
      }
      return cnt;
    }, pitch);
  /** cliff=0, or cliff=5 at threshold T (waits for the table to be rebuilt); the SPLIT cells read back (measurement) */
  const setLook = (T) =>
    page.evaluate(async (T) => {
      const a = nested.app;
      const cb = a.render.cliffBox;
      a.render.cliffBoxOn = T > 0;
      if (T > 0 && a.render.cliffBoxT !== T) {
        const b0 = cb.builds;
        a.render.cliffBoxT = T;
        for (let i = 0; i < 200 && cb.builds === b0; i++) await new Promise((res) => setTimeout(res, 50));
      }
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
      if (T === 0) return 0;
      const dev = a.render.device;
      const buf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(cb.args, 0, buf, 0, 16);
      dev.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const n = new Uint32Array(buf.getMappedRange())[1];
      buf.unmap();
      buf.destroy();
      return n;
    }, T);
  const stills = async (name, v) => {
    const out = [];
    for (const T of [0, 2, 4]) {
      const n = await setLook(T);
      await sleep(250);
      const file = `local/nested/${tag}-${name}-${T ? `T${T}` : 'cliff0'}.png`;
      await page.screenshot({ path: file });
      out.push(`${T ? `T${T}` : 'cliff0'}: holes ${await holes(v.pitch)}${T ? `, SPLIT ${n}` : ''}`);
    }
    console.log(`  ${name}: ${out.join('; ')}`);
  };
  const info = await page.evaluate(async () => {
    const a = nested.app;
    const s = await a.nest.readAll();
    const w = a.nest.wins[0];
    const top = (X, Y) => {
      const c = s.column(0, X, Y);
      return c.z1[c.z1.length - 1];
    };
    let best = { x: 0, y: 0, step: 0, dir: [1, 0], hi: 0, lo: 0 };
    let flat = { x: 0, y: 0, range: 1e9, z: 0 };
    for (let y = w.gy + 40; y < w.gy + w.n - 40; y++)
      for (let x = w.gx + 40; x < w.gx + w.n - 40; x++) {
        for (const d of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const st = top(x, y) - top(x + d[0], y + d[1]);
          if (st > best.step) best = { x, y, step: st, dir: d, hi: top(x, y), lo: top(x + d[0], y + d[1]) };
        }
        // (the flattest 7 x 7 root columns: the four balls fit on it)
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
    return { best, flat, k: a.k, m: a.render.mpu };
  });
  const { best: spot, flat, k, m } = info;
  console.log(`site ${site}: ${JSON.stringify(site === 'gentle' ? flat : spot)}; k ${k}, ${m} m a root column`);
  // the four balls (world units: root columns); gentle: a 2 x 2 grid 1.6 columns apart round the flat spot's centre;
  // slope: along the step's edge, 1.6 columns apart
  const balls = [
    ['carve40', 'carve', 40, 3],
    ['add40', 'add', 40, 3],
    ['carve80', 'carve', 80, 2],
    ['add80', 'add', 80, 2],
  ];
  let C;
  let up;
  if (site === 'gentle') {
    const c0 = [flat.x + 0.5, flat.y + 0.5];
    C = [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]].map(([dx, dy]) => [c0[0] + dx * 2, c0[1] + dy * 2]);
    up = [0, -1];
  } else {
    const e = [spot.x + 0.5 + spot.dir[0] * 0.5, spot.y + 0.5 + spot.dir[1] * 0.5];
    const perp = [-spot.dir[1], spot.dir[0]];
    C = [-2.4, -0.8, 0.8, 2.4].map((t) => [e[0] + perp[0] * t, e[1] + perp[1] * t]);
    // (the side views from the low side, looking at the face)
    up = [-spot.dir[0], -spot.dir[1]];
  }
  const groundAt = (x, y, L) =>
    page.evaluate(
      async ({ x, y, L }) => {
        const a = nested.app;
        const s = await a.nest.readAll();
        const S = a.k ** L;
        const c = s.column(L, Math.floor(x * S), Math.floor(y * S));
        const c0 = s.column(0, Math.floor(x), Math.floor(y));
        return { z: c.z1.length ? c.z1[c.z1.length - 1] : 0, z0: c0.z1[c0.z1.length - 1], live: a.nest.live, w: { ...a.nest.wins[L] } };
      },
      { x, y, L },
    );
  for (let i = 0; i < balls.length; i++) {
    const [name, op, rm, L] = balls[i];
    const [x, y] = C[i];
    const r = rm / m;
    // the edit pose: close to the ground so level L is open (L 3: about 4 m away; L 2: about 40 m)
    const z0 = (await groundAt(x, y, 0)).z0;
    const dEye = L === 3 ? 0.03 : 0.3;
    const pose = look([x + up[0] * dEye, y + up[1] * dEye, z0 + dEye * 0.7], [x, y, z0]);
    await page.evaluate((v) => nested.setView(v), pose);
    await settle(L + 1);
    const g = await groundAt(x, y, L);
    if (g.live <= L) {
      console.log(`  ${name}: level ${L} did not open (${g.live} live); skipped`);
      continue;
    }
    if (i === 0) await stills(`${name}-pose-before`, pose);
    await setLook(2);
    const ok = await page.evaluate(
      async ({ op, r, L, x, y, z }) => {
        const a = nested.app;
        const w = a.nest.wins[L];
        const S = a.k ** L;
        for (let t = 0; t < 100; t++) {
          if (a.nest.edit({ op, radius: r, amount: 1, at: { level: L, x: x * S - w.gx, y: y * S - w.gy, z } })) return true;
          await new Promise((res) => setTimeout(res, 50));
        }
        return false;
      },
      { op, r, L, x, y, z: g.z },
    );
    console.log(`${name}: ${op} radius ${rm} m (${r.toFixed(3)} root columns) at (${x.toFixed(2)}, ${y.toFixed(2)}), made at level ${L} (${g.live} levels open): ${ok ? 'made' : 'refused'}`);
    if (i === 0) {
      // (the lag: the table is rebuilt once the store settles; until then the boxes are the old table's)
      for (const f of [1, 3]) {
        await frames(f === 1 ? 1 : 2);
        await page.screenshot({ path: `local/nested/${tag}-${name}-lag${f}.png` });
      }
      const b = await page.evaluate(() => nested.app.render.cliffBox.builds);
      await settle(L + 1);
      const b2 = await page.evaluate(() => nested.app.render.cliffBox.builds);
      console.log(`  lag stills ${tag}-${name}-lag1|3.png; table builds ${b} -> ${b2} by the settle`);
      await stills(`${name}-pose`, pose);
    } else await settle(L + 1);
  }
  for (let i = 0; i < balls.length; i++) {
    const [name, , rm] = balls[i];
    const [x, y] = C[i];
    const r = rm / m;
    const z0 = (await groundAt(x, y, 0)).z0;
    const sv = look([x + up[0] * r * 3.2 + up[1] * r * 1.2, y + up[1] * r * 3.2 - up[0] * r * 1.2, z0 + r * 1.3], [x, y, z0 - r * 0.2]);
    await page.evaluate((v) => nested.setView(v), sv);
    await settle(2);
    await stills(`${name}-side`, sv);
    const av = look([x + up[0] * r * 0.6, y + up[1] * r * 0.6, z0 + r * 4], [x, y, z0]);
    await page.evaluate((v) => nested.setView(v), av);
    await settle(2);
    await stills(`${name}-above`, av);
  }
});
