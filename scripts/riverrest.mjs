// Rivers at rest (rivers branch, round 84): does an arrived river stay as it is when it's woken with nothing done?
// Finds an atlas river (a node of riverNodes: temperate water, a few cells wide, not at its mouth), walks in there,
// lets the land come in and fall asleep, then wakes the chunks round the river (--wake event: a circle of --r cells,
// as an edit would; --wake all: the whole window) and counts, over --secs, the wet columns whose depth changed by
// more than 0.05 and the water's volume. --wake none: the control (asleep, nothing done). --breach: dig through the
// bank beside the river after the first snapshot (an edit's own wake) and take pictures (--out).
//   node scripts/riverrest.mjs [--url http://localhost:5219] [--flags rivers=table] [--wake event|all|none]
//        [--r 40] [--secs 5] [--pick mid|wide] [--out C:/Projects/shots84/river] [--shots 1] [--q high]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5219');
const flags = opt('flags', '');
const wake = opt('wake', 'event');
const R = Number(opt('r', 40));
const secs = Number(opt('secs', 5));
const pick = opt('pick', 'mid');
const out = opt('out', '');
const shots = opt('shots', '0') === '1';
const breach = argv.includes('--breach');
const q = opt('q', 'high');
const zoom = Number(opt('zoom', 10));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1000,800'],
  defaultViewport: { width: 1000, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
try {
  let spot = opt('at', '');
  let node = null;
  if (!spot) {
    const v = await browser.newPage();
    v.on('pageerror', (e) => console.log('view pageerror', e.message));
    v.on('console', (m) => m.type() === 'error' && console.log('view console', m.text().slice(0, 300)));
    await v.goto(`${url}/?atlas=view&overlay=0`, { waitUntil: 'load' });
    await v.waitForFunction(() => window.reclaimed?.atlas?.riverNodes?.length, { timeout: 180000 });
    node = await v.evaluate((pick) => {
      const a = window.reclaimed.atlas;
      const u = a.riverNodes;
      const f = new Float32Array(u.buffer);
      const W = 8;
      const n = u.length / W;
      const warmAt = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
      let best = null;
      for (let k = 0; k < n; k++) {
        const o = k * W;
        if (u[o + 5] & 1) continue;
        if (f[o] < 300 || f[o] > a.worldW - 300 || f[o + 1] < 300 || f[o + 1] > a.worldH - 300) continue;
        const nx = u[o + 4];
        const nn = u[nx * W + 4];
        if (nx === k || nn === nx) continue;
        const warm = warmAt(f[o + 1]);
        if (warm < 0.5 || warm > 0.8) continue;
        const lv = f[o + 2];
        const drop = lv - f[nx * W + 2];
        if (lv < a.p.sea + 8 || lv > a.p.sea + 120 || drop > 3) continue;
        const w = f[o + 3];
        if (pick === 'mid' ? w < 5 || w > 8 : w < 9) continue;
        const ex = f[nx * W] - f[o];
        const ey = f[nx * W + 1] - f[o + 1];
        const el = Math.hypot(ex, ey) || 1;
        const s = { k, wx: f[o], wy: f[o + 1], dir: [ex / el, ey / el], at: [Math.floor(f[o]), Math.floor(f[o + 1] / 0.866)], w: +w.toFixed(1), level: +lv.toFixed(1), drop: +drop.toFixed(2), q: +f[o + 7].toFixed(3) };
        if (!best || (pick === 'wide' ? w > best.w : Math.abs(warm - 0.65) < best.d)) best = { ...s, d: Math.abs(warm - 0.65) };
      }
      return best && { ...best, stats: a.riverStats };
    }, pick);
    await v.close();
    if (!node) throw new Error('no river found');
    spot = node.at.join(',');
    console.log('river node', JSON.stringify(node));
  }
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=${q}&level=atlas&tod=0.35&at=${spot}${flags ? '&' + flags : ''}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await sleep(14000);
  // (no storms: rain wakes and adds water)
  const snap = async () =>
    p.evaluate(async (R) => {
      const X = window.reclaimed;
      X.weather.storms.length = 0;
      const w = new Float32Array((await X.readBuffer('water')).buffer);
      const surf = new Uint32Array((await X.readBuffer('surface')).buffer);
      const W = X.core.dims.w;
      const H = X.core.dims.h;
      const [tx, ty] = X.camera.target;
      const rf = (await X.core.readTexture(X.core.world.riverFlow)).data;
      const riv = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) riv[i] = rf[i * 4 + 2] > 0 ? 1 : 0;
      return { riv: Array.from(riv), w: Array.from(w.slice(0, W * H)), s: Array.from(surf.slice(0, W * H)), W, H, tx, ty, tick: X.core.sim.tick, org: X.stream.origin.slice(), awake: X.core.sleep?.awake ?? -1, sea: X.globals.seaZ ?? -1 };
    }, R);
  const a = await snap();
  const [cx, cy] = node ? [node.wx - a.org[0], node.wy - a.org[1] * 0.866] : [a.tx, a.ty];
  console.log('river in the window at', cx.toFixed(1), cy.toFixed(1), 'camera', a.tx.toFixed(1), a.ty.toFixed(1));
  if (shots && out) {
    await p.evaluate((cx, cy, zoom) => {
      document.getElementById('ui').style.visibility = 'hidden';
      window.reclaimed.stream.auto = false;
      window.reclaimed.camera.target[0] = cx;
      window.reclaimed.camera.target[1] = cy;
      window.reclaimed.camera.zoom = zoom;
    }, cx, cy, zoom);
    await sleep(1500);
    await p.screenshot({ path: `${out}-rest-0.png` });
    await sleep(400);
    await p.screenshot({ path: `${out}-rest-1.png` });
  }
  if (breach) {
    // dig through the river's bank: an edit beside the line (the level's own dig wakes round it)
    // (a trench across the bank, from the river's edge out, a few cells deep: the level's dig wakes round it)
    const dir = node?.dir ?? [1, 0];
    const hw = node?.w ?? 5;
    await p.evaluate(
      async (cx, cy, dir, hw) => {
        const t = window.reclaimed.api.terrain;
        const side = [-dir[1], dir[0]];
        for (let k = 0; k < 6; k++) {
          const s = hw * 0.8 + k * 2.5;
          for (let j = 0; j < 3; j++) t.dig(cx + side[0] * s, cy + side[1] * s, { radius: 2.5, layers: 3 });
          await new Promise((r) => setTimeout(r, 120));
        }
      },
      cx,
      cy,
      dir,
      hw,
    );
  } else if (wake !== 'none') {
    await p.evaluate(
      (wake, cx, cy, R, secs) => {
        const sl = window.reclaimed.core.sleep;
        const now = performance.now() / 1000;
        if (wake === 'all') sl.wakeAll(secs + 2, now);
        else sl.wake(cx, cy, R, secs + 2, now);
      },
      wake,
      cx,
      cy,
      R,
      secs,
    );
  }
  if (shots && out && breach) {
    for (let k = 0; k < 4; k++) {
      await sleep((secs * 1000) / 4);
      await p.screenshot({ path: `${out}-breach-${k}.png` });
    }
  } else await sleep(secs * 1000);
  const b = await snap();
  // compare: the wet columns above the sea, within R of the river (and the window)
  const ROW_H = 0.866;
  const cnt = (rad, only = -1) => {
    let wet = 0;
    let changed = 0;
    let va = 0;
    let vb = 0;
    let maxd = 0;
    for (let y = 0; y < a.H; y++)
      for (let x = 0; x < a.W; x++) {
        const i = y * a.W + x;
        const dx = x + 0.5 + 0.5 * (y & 1) - cx;
        const dy = (y + 0.5) * ROW_H - cy;
        if (rad > 0 && dx * dx + dy * dy > rad * rad) continue;
        const da = a.w[i];
        const db = b.w[i];
        const z = (a.s[i] & 0xffff) / 256;
        if (Math.max(da, db) < 0.05) continue;
        if (only >= 0 && a.riv[i] !== only) continue;
        if (a.sea > 0 && z + da < a.sea + 0.5) continue;
        wet++;
        va += da;
        vb += db;
        const d = Math.abs(db - da);
        if (d > 0.05) changed++;
        maxd = Math.max(maxd, d);
      }
    return { wet, changed, volA: +va.toFixed(1), volB: +vb.toFixed(1), dVolPct: +((100 * (vb - va)) / Math.max(va, 1e-6)).toFixed(2), maxd: +maxd.toFixed(2) };
  };
  // where the river columns changed: rising or falling, and by the steepest drop of the bed to a neighbour
  {
    const nb = (x, y) => {
      const o = y & 1;
      return [[x + 1, y], [x - 1, y], [x + o, y + 1], [x + o - 1, y + 1], [x + o, y - 1], [x + o - 1, y - 1]];
    };
    const bins = { flat: [0, 0, 0], step1: [0, 0, 0], step3: [0, 0, 0] };
    for (let y = 1; y < a.H - 1; y++)
      for (let x = 1; x < a.W - 1; x++) {
        const i = y * a.W + x;
        if (!a.riv[i]) continue;
        const z = (a.s[i] & 0xffff) / 256;
        let drop = 0;
        for (const [qx, qy] of nb(x, y)) drop = Math.max(drop, z - (a.s[qy * a.W + qx] & 0xffff) / 256);
        const k = drop > 3 ? 'step3' : drop > 1 ? 'step1' : 'flat';
        const d = b.w[i] - a.w[i];
        bins[k][0]++;
        if (d < -0.05) bins[k][1]++;
        if (d > 0.05) bins[k][2]++;
      }
    console.log('river columns by the bed drop [n, fell, rose]', JSON.stringify(bins));
  }
  console.log(JSON.stringify({ flags, wake: breach ? 'breach' : wake, secs, ticks: b.tick - a.tick, awakeA: a.awake, awakeB: b.awake, near: cnt(R), window: cnt(0), riverCols: cnt(0, 1), otherCols: cnt(0, 0) }));
  // (--refreeze: how long until every chunk sleeps again — ?settletol keeps settling water awake)
  if (argv.includes('--refreeze')) {
    const t0 = Date.now();
    let aw = -1;
    while (Date.now() - t0 < 70000) {
      aw = await p.evaluate(() => window.reclaimed.core.sleep?.awake ?? -1);
      if (aw === 0) break;
      await sleep(1000);
    }
    const c = await snap();
    let wet = 0;
    for (let i = 0; i < c.w.length; i++) if (c.w[i] > 0.05) wet++;
    console.log(JSON.stringify({ refrozenAfterS: +((Date.now() - t0) / 1000 + secs).toFixed(1), awake: aw, wetCols: wet }));
    if (shots && out) await p.screenshot({ path: `${out}-refrozen.png` });
  }
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) console.log('FATAL', fatal);
} finally {
  await browser.close();
}
