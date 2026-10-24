// The beam bores into a cliff (round 62). A stone block 14 high stands in
// the sandbox; the beam is aimed at its face 4 up, pointing in (+x), and
// re-aimed each 150 ms where the line meets rock (as a game's ray would).
// Checks: a hole at the beam's height reaches into the block, the rock over
// it still stands (an overhang: the block's top unchanged), the melt ran out
// of the hole as lava in front of the face, terrain.floorAt finds the
// bore's floor, and the beam on the open top still melts it from the top.
// Prints the measures; screenshot to <out>.png.
//
//   node scripts/boretest.mjs [--url http://localhost:5181] [--out bore]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5181');
const out = opt('out', 'bore');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const results = [];
const check = (name, ok, data) => {
  results.push(ok);
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(data)}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) {
      failed = true;
      console.log('console.error:', m.text().slice(0, 800));
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.4`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.scene?.lava && window.reclaimed?.api?.terrain, { timeout: 90000 });
  await wait(3000);
  // the block
  await page.evaluate(async () => {
    const R = window.reclaimed;
    const T = R.api.terrain;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const [x, y] = cellPos(Math.floor(w / 2) + 20, Math.floor(h / 2) + 10);
    await T.refresh();
    window.__b = { x, y, g: T.heightAt(x, y) };
    for (let dx = -4; dx <= 4; dx += 1) for (let dy = -4; dy <= 4; dy += 1) T.build(x + dx, y + dy, 'stone', { radius: 1, layers: 14 });
  });
  await wait(6000);
  const before = await page.evaluate(async () => {
    const R = window.reclaimed;
    const T = R.api.terrain;
    const B = window.__b;
    await T.refresh();
    // the face: the first column along +x whose top stands 8 over the ground
    let fx = B.x - 8;
    while (fx < B.x && (T.heightAt(fx, B.y) ?? 0) < B.g + 8) fx += 0.25;
    B.face = fx;
    B.top = T.heightAt(B.x, B.y);
    B.bz = B.g + 4;
    return { ground: B.g, top: B.top, face: +(fx - B.x).toFixed(2) };
  });
  console.log('block:', JSON.stringify(before));
  // bore: aim at the first rock along the line, 4 up
  await page.evaluate(() => {
    const R = window.reclaimed;
    const T = R.api.terrain;
    const L = R.scene.lava;
    const B = window.__b;
    const aim = () => {
      let x = B.x - 9;
      while (x < B.x + 5 && T.materialAt(x, B.y, B.bz) === 'air') x += 0.25;
      L.beam = { at: [x, B.y, B.bz], radius: 1.6, power: 9000, dir: [1, 0, 0] };
      B.reach = x;
    };
    aim();
    B.timer = setInterval(async () => {
      await T.refresh();
      aim();
    }, 150);
  });
  await wait(9000);
  const bored = await page.evaluate(async () => {
    const R = window.reclaimed;
    const T = R.api.terrain;
    const L = R.scene.lava;
    const B = window.__b;
    clearInterval(B.timer);
    L.beam = null;
    await new Promise((r) => setTimeout(r, 300));
    await T.refresh();
    // how far in the hole goes at bz, the rock over it, the floor
    let depth = 0;
    for (let x = B.face + 0.5; x < B.x + 5; x += 0.25) {
      if (T.materialAt(x, B.y, B.bz) !== 'air') break;
      depth = x - B.face;
    }
    const at = B.face + Math.min(depth, 3) * 0.5;
    const ls = T.layersAt(at, B.y).map((l) => [+l.z0.toFixed(2), +l.z1.toFixed(2), l.material]);
    // lava in front of the face (and on the block's top: none)
    const f = new Float32Array((await R.core.readBuffer('lava')).buffer);
    const { cellAt, cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    let front = 0;
    let onTop = 0;
    for (let cy = 0; cy < h; cy++)
      for (let cx = 0; cx < w; cx++) {
        const [px, py] = cellPos(cx, cy);
        if (Math.abs(py - B.y) > 10) continue;
        const d = f[(cy * w + cx) * 4];
        if (px < B.face - 0.3 && px > B.face - 12) front += d;
        if (px > B.face + 0.5 && px < B.x + 4 && (T.heightAt(px, py) ?? 0) > B.g + 10) onTop += d;
      }
    void cellAt;
    return {
      depth: +depth.toFixed(2),
      reach: +(B.reach - B.face).toFixed(2),
      layersIn: ls,
      topNow: T.heightAt(at, B.y),
      topWas: B.top,
      floor: T.floorAt(at, B.y, B.bz),
      floorFromTop: T.floorAt(at, B.y, T.heightAt(at, B.y)),
      bz: B.bz,
      lavaFront: +front.toFixed(2),
      lavaOnTop: +onTop.toFixed(2),
    };
  });
  check('a hole bored in at the beam height', bored.depth >= 2, bored);
  // (over the hole: the block's top, 14 up, still there)
  const roof = bored.layersIn.find((l) => l[0] > bored.bz);
  check('the rock over it stands', !!roof && bored.topNow > before.ground + 13, { topNow: bored.topNow, layers: bored.layersIn });
  check('the melt ran out as lava in front of the face, none on the top', bored.lavaFront > 0.5 && bored.lavaOnTop < 0.05, { front: bored.lavaFront, onTop: bored.lavaOnTop });
  check('floorAt finds the bore floor under it, the top over it', bored.floor !== null && bored.floor < before.ground + 4 && bored.floor > before.ground && bored.floorFromTop > before.ground + 13, { floor: bored.floor, fromTop: bored.floorFromTop });
  await page.screenshot({ path: `${out}.png` });
  // the open top: the beam on it melts it from the top
  const sky = await page.evaluate(async () => {
    const R = window.reclaimed;
    const T = R.api.terrain;
    const L = R.scene.lava;
    const B = window.__b;
    const x = B.x + 2;
    const t0 = T.heightAt(x, B.y);
    L.beam = { at: [x, B.y, t0 + 1], radius: 1.6, power: 9000 };
    await new Promise((r) => setTimeout(r, 5000));
    L.beam = null;
    await new Promise((r) => setTimeout(r, 300));
    await T.refresh();
    return { before: t0, after: T.heightAt(x, B.y) };
  });
  check('the beam on the open top melts it down', sky.after < sky.before - 0.5, sky);
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
