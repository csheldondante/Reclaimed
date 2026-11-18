// Nested scales watertight checks on the stills' scene (a mound with a tunnel through it, a blob on a stalk, a blob in
// mid-air, the tunnel crossing level rims): (i) the manifold check of every level's drawn mesh at several eyes (open
// interior edges must be 0), also during the fade; (ii) the screen check from ~40 poses round and inside the shapes:
// pixels with no surface whose ray points below the horizon (ground must be there), sampled during the 0.4 s fade
// and after. node scripts/nested-watertight.mjs --chromeargs ignore-certificate-errors [--maxbuf 0] [--port 5461]
import { run, sleep } from './lib/runner.mjs';
import { PNG } from 'pngjs';
import fs from 'node:fs';

await run({ name: 'nested-watertight', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const maxbuf = R.opt('maxbuf', '0');
  const tag = R.opt('tag', '');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140${maxbuf !== '0' ? `&maxbuf=${maxbuf}` : ''}${R.opt('cut', '') ? `&cut=${R.opt('cut', '')}` : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(2500);
  const scene = await page.evaluate(async () => {
    const W = (ms) => new Promise((s) => setTimeout(s, ms));
    const e = nested.eye();
    const a = nested.app;
    const f = a.forward();
    const h = [e.x + f[0] * e.dHit, e.y + f[1] * e.dHit, e.z + f[2] * e.dHit];
    const snap = await a.nest.readAll();
    const zo = snap.zOrigin(1);
    const w1 = a.nest.wins[1];
    const ed = async (op, x, y, z, r) => {
      while (!a.nest.edit({ op, radius: r, amount: 0, at: { level: 1, x: x * 8 - w1.gx, y: y * 8 - w1.gy, z: (z - zo) * 8 } })) await W(50);
    };
    await ed('add', h[0], h[1], h[2] + 1.2, 2.2);
    for (let t = -3.2; t <= 3.2; t += 0.3) await ed('carve', h[0] - t, h[1], h[2] + 1.3, 0.75);
    for (let z = 0.2; z <= 2.6; z += 0.2) await ed('add', h[0], h[1] + 5, h[2] + z, 0.3);
    await ed('add', h[0], h[1] + 5, h[2] + 3.4, 1.0);
    await ed('add', h[0] + 4, h[1] - 5, h[2] + 3.0, 0.8);
    await W(500);
    return { h, stats: nested.state().stats };
  });
  const [hx, hy, hz] = scene.h;
  const tz = hz + 1.3;
  // (i) the manifold check at eyes that open levels 2 and 3 round each shape
  const eyes = {
    'mound outside': { yaw: 0, pitch: 0.03, eye: [hx + 7, hy, tz + 0.2] },
    'tunnel inside': { yaw: 0, pitch: 0.0, eye: [hx + 0.3, hy, tz - 0.1] },
    'tunnel mouth (rim crossing)': { yaw: 0, pitch: 0.05, eye: [hx + 2.6, hy + 0.2, tz] },
    'blob on a stalk': { yaw: 0, pitch: 0.1, eye: [hx + 6, hy + 5, hz + 2.5] },
    'mid-air blob': { yaw: Math.PI / 2, pitch: 0.2, eye: [hx + 4, hy - 8, hz + 3.5] },
  };
  let openAll = 0;
  const onlyEyes = R.opt('eyes', '');
  for (const [name, v] of Object.entries(R.opt('manifold', '1') === '1' ? eyes : {})) {
    if (onlyEyes && !name.includes(onlyEyes)) continue;
    await page.evaluate((v) => nested.setView(v), v);
    await sleep(250);
    const early = await page.evaluate(() => nested.manifold());
    await sleep(3000);
    const late = await page.evaluate(() => nested.manifold());
    for (const [when, rep] of [
      ['fading', early],
      ['settled', late],
    ]) {
      const open = rep.reduce((s, r) => s + r.open, 0);
      openAll += open;
      console.log(`manifold ${name} (${when}): ${rep.map((r) => `L${r.depth} ${r.tris} tris ${JSON.stringify(r.trisBy)} from ${r.items} item slots, ${r.edges} edges, open ${r.open}, over ${r.over}${r.open ? ` by source ${JSON.stringify(r.bySrc)} at ${JSON.stringify(r.whereBy)}` : ''}`).join('; ')}`);
    }
  }
  R.check('manifold: no open interior edge on any level', openAll === 0, `${openAll} open edges in total`);
  if (R.opt('kcount', '0') === '1') {
    // (NS-37: the page shape 32 x 32 x K = 4) per live level: columns past 4 intervals, and those that are ring-only
    // (every extra footprint a ghost: nothing a brush made present)
    const kc = await page.evaluate(async () => {
      const a = nested.app;
      const s = await a.nest.readAll();
      const out = [];
      for (let L = 0; L < a.nest.live; L++) {
        const w = a.nest.wins[L];
        let over = 0;
        let ringOver = 0;
        let ghosts = 0;
        const hist = {};
        for (let y = 0; y < w.n; y++)
          for (let x = 0; x < w.n; x++) {
            const c = s.column(L, w.gx + x, w.gy + y);
            const n = c.mat.length;
            hist[n] = (hist[n] ?? 0) + 1;
            const ghost = c.mat.some((_m, i) => i > 0 && (c.eS[i] <= 0 || c.eG[i] <= 0));
            const made = c.mat.some((_m, i) => i > 0 && ((c.eS[i] > 0 && c.eS[i] < 1024) || (c.eG[i] > 0 && c.eG[i] < 1024)));
            if (ghost && !made) ghosts++;
            if (n > 4) {
              over++;
              if (ghost && !made) ringOver++;
            }
          }
        out.push(`L${L}: ${w.n * w.n} columns, counts ${JSON.stringify(hist)}; past 4: ${over} (ring-only ${ringOver}); ring-only columns ${ghosts}`);
      }
      return out;
    });
    for (const l of kc) console.log(`kcount ${l}`);
  }
  const at = R.opt('probeAt', '');
  if (at) {
    // (diagnostics) the columns round a level's local point: L,x,y
    const [L, x, y] = at.split(',').map(Number);
    const lines = await page.evaluate(async ([L, x, y]) => {
      const a = nested.app;
      const s = await a.nest.readAll();
      const w = a.nest.wins[L];
      const out = [];
      for (let j = -2; j <= 2; j++)
        for (let i = -2; i <= 2; i++) {
          const c = s.column(L, w.gx + Math.floor(x) + i, w.gy + Math.floor(y) + j);
          out.push(`${Math.floor(x) + i},${Math.floor(y) + j}: n ${c.mat.length} ` + c.mat.map((m, q) => `[${m} ${c.z0[q].toFixed(2)}..${c.z1[q].toFixed(2)} eS ${c.eS[q].toFixed(2)} eG ${c.eG[q].toFixed(2)}]`).join(' '));
        }
      return out;
    }, [L, x, y]);
    for (const l of lines) console.log(`col ${l}`);
  }
  if (R.opt('probe', '0') === '1') {
    // (diagnostics) per live level: the B flags and gap-table pages along the window's first and last rows
    const pr = await page.evaluate(async () => {
      const a = nested.app;
      const s = await a.nest.readAll();
      const out = [];
      for (let L = 0; L < a.nest.live; L++) {
        const w = a.nest.wins[L];
        for (const row of [0, 1, 2, w.n - 3, w.n - 2, w.n - 1]) {
          let flagged = 0;
          let pages = 0;
          let counts = {};
          for (let i = 0; i < w.n; i++) {
            const X = w.gx + i;
            const Y = w.gy + row;
            const p = s.page(16 + L, X >> 4, Y >> 4, 0);
            const n = s.column(L, X, Y).mat.length;
            counts[n] = (counts[n] ?? 0) + 1;
            if (p < 0 || p >= 0xfffffffe) continue;
            pages++;
            const c = (Y & 15) * 16 + (X & 15);
            if ((s.pg[p * 16640 + 256 + c * 16 * 4 + 2] >>> 16) & 1) flagged++;
          }
          out.push(`L${L} row ${row}: ${pages} with gap pages, ${flagged} flagged, counts ${JSON.stringify(counts)}`);
        }
      }
      return out;
    });
    for (const l of pr) console.log(`probe ${l}`);
  }
  // (ii) the screen check: 40 poses
  const poses = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * 2 * Math.PI;
    const r = i % 2 ? 4 : 7;
    poses.push({ yaw: a, pitch: 0.55, eye: [hx + 1 + Math.cos(a) * r, hy + 2.5 + Math.sin(a) * r, hz + 2.5 + (i % 3)] });
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 2 * Math.PI;
    poses.push({ yaw: a, pitch: 0.9, eye: [hx + Math.cos(a) * 2, hy + Math.sin(a) * 2, hz + 3.5] });
  }
  for (let i = 0; i < 12; i++) {
    // inside the tunnel, looking at its walls and floor (yaw across the tunnel, pitch down)
    poses.push({ yaw: Math.PI / 2 + (i % 2 ? Math.PI : 0), pitch: 0.2 + 0.1 * (i % 3), eye: [hx - 2 + i * 0.35, hy, tz] });
  }
  let holesAll = 0;
  let worst = { n: 0, pose: -1 };
  const onlyPoses = (R.opt('poses', '') || '').split(',').filter(Boolean).map(Number);
  for (let p = 0; p < poses.length; p++) {
    if (onlyPoses.length && !onlyPoses.includes(p)) continue;
    await page.evaluate((v) => nested.setView(v), poses[p]);
    for (const wait of [120, 250, 900]) {
      await sleep(wait);
      const rr = await page.evaluate(async (pitch) => {
        const h = await nested.holes();
        const t = Math.tan((50 * Math.PI) / 360);
        let n = 0;
        // rows whose ray points 0.1 rad or more below the horizon
        for (let y = 0; y < h.h; y++) {
          const ndcy = 1 - ((y + 0.5) / h.h) * 2;
          const dz = -Math.sin(pitch) + ndcy * t * Math.cos(pitch);
          const len = Math.hypot(1, ndcy * t);
          if (dz / len < -0.1) n += h.rows[y];
        }
        return { n, at: h.at, eye: nested.eye(), live: nested.state().live };
      }, poses[p].pitch);
      const r = rr.n;
      holesAll += r;
      if (r > 0) console.log(`pose ${p} after ${wait} ms: ${r} holes, first at ${JSON.stringify(rr.at)}; eye ${JSON.stringify(rr.eye)} live ${rr.live}`);
      if (r > worst.n) {
        worst = { n: r, pose: p, wait };
        // the screenshot with the info target's holes painted magenta
        const m = await page.evaluate(() => nested.holeImage());
        const png = new PNG({ width: m.w, height: m.h });
        for (let i = 0; i < m.w * m.h; i++) png.data.set([m.rgb[i * 3], m.rgb[i * 3 + 1], m.rgb[i * 3 + 2], 255], i * 4);
        fs.writeFileSync(`local/nested/watertight-worst${tag}.png`, PNG.sync.write(png));
      }
    }
  }
  if (worst.pose >= 0) {
    // the worst pose again, levels tinted and B's parts in flat colours (floors blue, ceilings green, walls red)
    await page.evaluate((v) => {
      nested.setView(v);
      nested.tint(true);
      nested.app.render.diagB = true;
    }, poses[worst.pose]);
    await sleep(1500);
    await page.evaluate(() => nested.holes());
    const m = await page.evaluate(() => nested.holeImage());
    const png = new PNG({ width: m.w, height: m.h });
    for (let i = 0; i < m.w * m.h; i++) png.data.set([m.rgb[i * 3], m.rgb[i * 3 + 1], m.rgb[i * 3 + 2], 255], i * 4);
    fs.writeFileSync(`local/nested/watertight-worst-diag${tag}.png`, PNG.sync.write(png));
    await page.evaluate(() => {
      nested.tint(false);
      nested.app.render.diagB = false;
    });
  }
  R.check('screen: no hole pixels below the horizon from 40 poses (during the fade and after)', holesAll === 0, `${holesAll} hole pixels; worst pose ${worst.pose} with ${worst.n}${worst.pose >= 0 ? ` ${JSON.stringify(poses[worst.pose])}` : ''}`);
  console.log('stats', JSON.stringify(await page.evaluate(() => nested.state().stats)));
});
