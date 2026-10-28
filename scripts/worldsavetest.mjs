// Round 100 (`regionstore`): the world serializes. The user (DECISIONS round 100): "I want the world to serialize so
// we can recover the visited cells that change." On the atlas level as the phone runs it (q=low 412x915, every
// system on), a fresh world (a new browser profile; ?world=wst):
//   1. a dig, a build, a meteor and a rock body come to rest in the region under the camera; the land settles;
//      its columns read back (world z: the window's layers joined with what's outside it) → the reference;
//   2. ride away 6 regions and back (slides by hand: the region frozen into the pool, evicted or not): identical;
//   3. warp away 10 regions and back: identical;
//   4. reload the page: the region restored from the store: identical;
//   5. (--run) a story run's bone door opened; reload: its plug still gone.
// Measured: the region record's size raw and compressed, the pool's memory, freeze / thaw / hash / encode / load times.
//   node scripts/worldsavetest.mjs [--url http://localhost:5283] [--wait 35000] [--run] [--extra "&meshinst=1"]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5283');
const wait = Number(opt('wait', 35000));
const at = opt('at', '11956,15471');
const extra = opt('extra', '');
const doRun = argv.includes('--run') || argv.includes('--onlyrun');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
});
let failed = 0;
const ok = (cond, what, data) => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${data !== undefined ? ` ${JSON.stringify(data)}` : ''}`);
};

/** the page, its errors counted (a [worldsave] error is a failure too) */
async function open(p, q) {
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&perf=1&at=${at}${q}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream?.store, { timeout: 240000 });
  await sleep(wait);
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal: ${fatal}`);
}

function watch(p) {
  p.on('pageerror', (e) => {
    failed++;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('404')) {
      failed++;
      console.log('console.error', t.slice(0, 600));
    } else if (t.startsWith('[worldsave]') || t.startsWith('[run]')) console.log('  page:', t.slice(0, 300));
  });
}

/** a region's columns in world z (its world corner), hashed, with a few of its columns spelled out */
const regionCols = (p, wx, wy) =>
  p.evaluate(
    async (wx, wy) => {
      const R = window.reclaimed;
      const S = R.stream;
      const { readColumn, joinColumn } = await import('/src/world/layout.ts');
      const lx = wx - S.origin[0];
      const ly = wy - S.origin[1];
      if (lx < 0 || ly < 0 || lx >= S.W || ly >= S.H) return { error: `region ${wx},${wy} not in the window (origin ${S.origin})` };
      while (S.busy) await new Promise((r) => setTimeout(r, 50));
      const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
      let h = 0x811c9dc5;
      const mix = (v) => {
        h ^= v;
        h = Math.imul(h, 0x01000193) >>> 0;
      };
      const cols = [];
      let solid = 0;
      for (let y = 0; y < S.R; y++)
        for (let x = 0; x < S.R; x++) {
          const i = (ly + y) * S.W + lx + x;
          const col = joinColumn(readColumn(R.core.packed, slots, lx + x, ly + y), S.oz, S.outside[i]);
          for (const iv of col) {
            mix(Math.round(iv.z0 * 64));
            mix(Math.round(iv.z1 * 64));
            mix(iv.mat);
            solid += iv.z1 - iv.z0;
          }
          mix(0xffff);
          cols.push(col.map((iv) => `${iv.mat}:${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}`).join(' '));
        }
      return { hash: h, solid: +solid.toFixed(1), cols };
    },
    wx,
    wy,
  );

/** how two readbacks of a region differ: columns not the same, the most a top moved */
function diff(a, b) {
  if (a.error || b.error) return { error: a.error ?? b.error };
  let n = 0;
  let worst = 0;
  const top = (s) => {
    const parts = s.split(' ').filter(Boolean);
    return parts.length ? Number(parts[parts.length - 1].split('-').pop()) : 0;
  };
  for (let i = 0; i < a.cols.length; i++)
    if (a.cols[i] !== b.cols[i]) {
      n++;
      worst = Math.max(worst, Math.abs(top(a.cols[i]) - top(b.cols[i])));
    }
  return { same: a.hash === b.hash, differ: n, worstTop: +worst.toFixed(2), solid: [a.solid, b.solid] };
}

const stats = (p) =>
  p.evaluate(() => {
    const S = window.reclaimed.stream;
    const q = (a, f) => {
      if (!a.length) return null;
      const s = [...a].sort((x, y) => x - y);
      return +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(2);
    };
    const t = S.times;
    return {
      stats: { ...S.stats },
      pool: { used: S.pool.used, cap: S.pool.cap, mb: +(S.pool.gpuBytes / 1048576).toFixed(1), regionMb: +(S.layout.bytes / 1048576).toFixed(2) },
      store: { ...S.store.totals(), ...S.store.stats, world: S.store.world, mem: S.store.mem },
      ms: Object.fromEntries(Object.entries(t).map(([k, a]) => [k, { n: a.length, p50: q(a, 0.5), p95: q(a, 0.95), max: q(a, 1) }])),
    };
  });

/** the regions written back since the last call, checked exactly (Streamer.verify) */
const verified = (p) =>
  p.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 500));
    const S = window.reclaimed.stream;
    const v = S.verified.splice(0);
    const how = {};
    for (const x of v) how[x.how] = (how[x.how] ?? 0) + 1;
    return { n: v.length, bad: v.filter((x) => !x.same).length, how, badKeys: v.filter((x) => !x.same).map((x) => `${x.key}:${x.how}`).slice(0, 8) };
  });

/** slides by hand, each waited for (its land made or loaded if it wasn't ahead) */
const slides = (p, dx, dy, n) =>
  p.evaluate(
    async (dx, dy, n) => {
      const S = window.reclaimed.stream;
      for (let k = 0; k < n; k++) {
        while (S.busy) await new Promise((r) => setTimeout(r, 30));
        await S.slide(dx, dy);
        await new Promise((r) => setTimeout(r, 600));
      }
      return [...S.origin];
    },
    dx,
    dy,
    n,
  );

const onlyRun = argv.includes('--onlyrun');
try {
  if (!onlyRun) {
  const p = await browser.newPage();
  watch(p);
  const t0 = Date.now();
  await open(p, '&world=wst&rsverify=1');
  console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  // ---- 1. the region under the camera changed: a dig, a build, a meteor, a rock body come to rest ----
  const spot = await p.evaluate(async () => {
    const R = window.reclaimed;
    const S = R.stream;
    S.auto = false;
    S.verify = true;
    const T = R.api.terrain;
    const [tx, ty] = R.camera.target;
    const cx = Math.floor(tx);
    const cy = Math.floor(ty / 0.866);
    const rx = Math.floor(cx / S.R) * S.R;
    const ry = Math.floor(cy / S.R) * S.R;
    // (the region's middle, in window units)
    const mx = rx + S.R / 2;
    const my = (ry + S.R / 2) * 0.866;
    await T.refresh();
    const g = T.heightAt(mx, my);
    await T.take(mx - 10, my, 5);
    await T.put(mx + 10, my, 'brick', 8);
    R.meteorNow(mx, my + 16, g);
    // a rock body dropped onto the region: it falls, comes to rest (ground again, or its mesh with ?meshinst=1)
    const I = R.integrity();
    let body = null;
    if (I.rigid) {
      const cells = [];
      const bx = Math.round(mx - 4);
      const by = Math.round((my - 16) / 0.866);
      const top = Math.round((T.heightAt(mx - 4, my - 16) ?? g) + 8);
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) for (let z = 0; z < 4; z++) if (x * x + y * y * 0.75 + (z - 1.5) ** 2 <= 6) cells.push({ x: bx + x, y: by + y, z: top + z, mat: 1 });
      const b = I.rigid.spawn(cells);
      b.slot = I.rockMesh?.alloc(cells)?.id;
      body = cells.length;
    }
    return { world: [S.origin[0] + rx, S.origin[1] + ry], local: [rx, ry], g, body, origin: [...S.origin] };
  });
  console.log('changed the region', JSON.stringify(spot));
  // (the land settles: the meteor's rim, the rock at rest, what falls)
  await sleep(20000);
  const rest = await p.evaluate(() => {
    const I = window.reclaimed.integrity();
    return { quiet: I.quiet, rigid: I.rigid?.list.length ?? 0, resting: I.restingCount };
  });
  console.log('settled', JSON.stringify(rest));
  const [wx, wy] = spot.world;
  const ref = await regionCols(p, wx, wy);
  console.log(`reference: hash ${ref.hash}, solid ${ref.solid}`);
  const still = await regionCols(p, wx, wy);
  console.log('the region read again (the sims running): ', JSON.stringify(diff(ref, still)));

  // ---- 2. away six regions and back ----
  const o0 = await p.evaluate(() => [...window.reclaimed.stream.origin]);
  await slides(p, 64, 0, 6);
  const far = await p.evaluate(() => [...window.reclaimed.stream.origin]);
  await slides(p, -64, 0, 6);
  await sleep(3000);
  const back = await regionCols(p, wx, wy);
  const d1 = diff(ref, back);
  // (exactly: each region written back into the window read back at once — before the sims' next tick — against
  // the hash it was frozen with; the readback above is seconds later, the sims' drift in it, as in `still`)
  const v1 = await verified(p);
  ok(v1.n > 0 && v1.bad === 0, `rode ${(far[0] - o0[0]) / 64} regions east and back: every region thawed or made as it was frozen or made (exact)`, v1);
  console.log('     (seconds later, the sims running — the meteor still settling when it left:) ' + JSON.stringify({ ride: d1, still: diff(ref, still) }));
  const s1 = await stats(p);
  console.log('after the ride', JSON.stringify(s1));

  // ---- 3. warp away and back ----
  await p.evaluate(async () => {
    const S = window.reclaimed.stream;
    const [ox, oy] = S.origin;
    await S.warp(ox + 640, oy, S.oz);
    await new Promise((r) => setTimeout(r, 4000));
    await S.warp(ox, oy, S.oz);
  });
  await sleep(4000);
  const warped = await regionCols(p, wx, wy);
  const d2 = diff(ref, warped);
  const v2 = await verified(p);
  ok(v2.n > 0 && v2.bad === 0 && v2.how.thawed > 0, 'warped 10 regions away and back: every region as it was frozen (exact)', v2);
  console.log('     (seconds later, the sims running — the meteor still settling when it left:) ' + JSON.stringify(d2));

  // ---- 4. reload ----
  const before = await regionCols(p, wx, wy);
  await p.evaluate(() => window.reclaimed.stream.saveAll());
  const s2 = await stats(p);
  console.log('saved', JSON.stringify(s2));
  ok(s2.store.regions > 0 && s2.store.failed === 0, `the store holds ${s2.store.regions} regions (${(s2.store.packed / 1024).toFixed(0)} KB compressed, ${(s2.store.raw / 1024).toFixed(0)} KB raw)`);
  await open(p, '&world=wst&rsverify=1');
  const v3 = await verified(p);
  ok(v3.n > 0 && v3.bad === 0 && v3.how.loaded > 0, 'reloaded: every region restored as it was saved (exact)', v3);
  const reloaded = await regionCols(p, wx, wy);
  const d3 = diff(before, reloaded);
  const s3 = await stats(p);
  ok(s3.stats.restored > 0, `reloaded: ${s3.stats.restored} regions restored into the window`, s3.stats);
  ok(d3.worstTop < 0.3, 'reloaded: the changed region as it was before the reload, but for drift', d3);
  const d3b = diff(ref, reloaded);
  console.log('reloaded against the first reference', JSON.stringify(d3b));
  // a region changed then never seen again is the generator's when it isn't on record: the record's loaded
  await p.evaluate(async () => {
    const S = window.reclaimed.stream;
    S.auto = false;
  });
  await slides(p, 64, 0, 6);
  await slides(p, -64, 0, 6);
  await sleep(3000);
  const back2 = await regionCols(p, wx, wy);
  const v4 = await verified(p);
  ok(v4.n > 0 && v4.bad === 0, 'reloaded, rode away and back: every region as it was frozen (exact)', v4);
  ok(diff(before, back2).worstTop < 0.3, 'the changed region after: as it was, but for drift', diff(before, back2));
  console.log('final', JSON.stringify(await stats(p)));
  await p.close();
  }

  // ---- 5. a story run's door ----
  if (doRun) {
    const r = await browser.newPage();
    watch(r);
    const runOpen = async () => {
      await r.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&run=bell${extra}`, { waitUntil: 'load' });
      for (let t = 0; !(await r.evaluate(() => !!window.reclaimed?.run?.play)); t += 1000) {
        if (t > 240000) throw new Error('the run never started');
        await sleep(1000);
      }
      await sleep(15000);
    };
    const plug = () =>
      r.evaluate(async () => {
        const R = window.reclaimed;
        const k = R.run.stage.locks.find((l) => l.id === 'bone-door');
        const [x, y] = R.run.winOf(k.at);
        const T = R.api.terrain;
        await T.refresh();
        let n = 0;
        for (let dy = -3.2; dy <= 3.2; dy += 0.7) for (let dx = -3.2; dx <= 3.2; dx += 0.7) if (dx * dx + dy * dy <= 10.5 && T.materialAt(x + dx, y + dy) === k.material) n++;
        return { plug: n, open: k.open, at: [x, y] };
      });
    await runOpen();
    const shut = await plug();
    console.log('the door before', JSON.stringify(shut));
    await r.evaluate(() => {
      const R = window.reclaimed;
      R.run.play.run.items.set('bone key', 1);
      const k = R.run.stage.locks.find((l) => l.id === 'bone-door');
      const w = R.run.winOf(k.at);
      R.run.hero.place([w[0] + 3, w[1]]);
    });
    await sleep(6000);
    const opened = await plug();
    ok(opened.open && opened.plug < shut.plug, 'the bone door opened with the key', { shut, opened });
    await sleep(4000);
    await r.evaluate(() => window.reclaimed.stream.saveAll());
    await runOpen();
    const after = await plug();
    ok(after.plug <= opened.plug && after.plug < shut.plug, 'reloaded the run: the door still open (its plug gone)', after);
    await r.close();
  }
} catch (e) {
  failed++;
  console.log('ERROR', e.stack ?? e);
} finally {
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
