// Round 111 (TG1): the noise lab, headless, as the deployed page runs it (q's flags, 1x speed, every system the level
// has). Checks: the level opens without errors and writes its first recipe; every built-in recipe runs, its preview
// and the world drawn (shots of both); a slider moved changes the preview at once and the world when let go; the
// regenerate's cost (GPU run, the columns' packing, the world's write, the frames after it).
//   node scripts/noiselab.mjs [--url http://localhost:5207] [--out C:/Projects/shots88/noiselab] [--size 1280x800]
//     [--dpr 1] [--q medium] [--only "TG2: mesas, ramps, ravines"]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const out = opt('out', 'C:/Projects/shots88/noiselab');
const [W, H] = opt('size', '1280x800').split('x').map(Number);
const dpr = Number(opt('dpr', '1'));
const q = opt('q', 'medium');
const only = opt('only', '');
const tag = opt('tag', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: dpr },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const fail = (m) => {
  failed = true;
  console.log(`FAIL ${m}`);
};
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
try {
  const p = await browser.newPage();
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text().slice(0, 900)}`);
  });
  p.on('pageerror', (e) => fail(`pageerror ${e.message}`));
  const t0 = Date.now();
  await p.goto(`${url}/?skipmenu=1&level=noiselab&tutorial=0&q=${q}${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.noiselab?.stats.writes > 0, { timeout: 240000 });
  console.log(`level up, first recipe written in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(Number(opt('settle', '30000')));
  const fatal = async () => {
    const f = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (f) throw new Error(`fatal overlay: ${f}`);
  };
  await fatal();
  const zoom = await p.evaluate((f) => {
    const c = window.reclaimed.camera;
    c.zoom *= f;
    return c.zoom;
  }, Number(opt('zoom', '0.6')));
  console.log(`camera zoom ${zoom.toFixed(2)}`);
  const names = await p.evaluate(() => window.noiselab.presets);
  const frames = (ms) =>
    p.evaluate(
      (ms) =>
        new Promise((res) => {
          const d = [];
          let last = performance.now();
          const t1 = last + ms;
          const f = (t) => {
            d.push(t - last);
            last = t;
            if (t < t1) requestAnimationFrame(f);
            else res(d);
          };
          requestAnimationFrame(f);
        }),
      ms,
    );
  const rows = [];
  for (const name of names) {
    if (only && !only.split('|').includes(name)) continue;
    const before = await p.evaluate(() => window.noiselab.stats.writes);
    await p.evaluate((n) => window.noiselab.load(n), name);
    await p.waitForFunction((b) => window.noiselab.stats.writes > b, { timeout: 30000 }, before);
    // (the frames while the mesh is remade over the whole map)
    const fr = await frames(2000);
    await sleep(2500);
    await fatal();
    const s = await p.evaluate(() => ({ ...window.noiselab.stats }));
    const worst = Math.max(...fr.slice(1));
    const mean = fr.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, fr.length - 1);
    rows.push({ name, ...s, worstFrame: worst, meanFrame: mean });
    console.log(
      `${name}: heights ${s.min.toFixed(0)}–${s.max.toFixed(0)}, caves ${s.caves}, runs ≤ ${s.maxRuns}; gpu ${s.gpuMs.toFixed(1)} ms (${s.passes} passes), columns ${s.packMs.toFixed(1)} ms, world write ${s.writeMs.toFixed(1)} ms; frames after: mean ${mean.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`,
    );
    // the world with the panel shut, then the panel (its preview) open
    await p.evaluate(() => window.noiselab.panel.toggle(false));
    await sleep(400);
    await p.screenshot({ path: path.join(out, `${tag}${slug(name)}.png`) });
    await p.evaluate(() => window.noiselab.panel.toggle(true));
    await sleep(300);
    await p.screenshot({ path: path.join(out, `${tag}${slug(name)}-panel.png`) });
    // (the sea caves close: the coast's cliff from the sea)
    if (name.startsWith('TG3')) {
      const keep = await p.evaluate(() => {
        const c = window.reclaimed.camera;
        const k = { t: [...c.target], z: c.zoom };
        window.noiselab.panel.toggle(false);
        c.target[0] = 152;
        c.target[1] = 96;
        c.target[2] = 16;
        c.zoom = k.z * 2.5;
        return k;
      });
      await sleep(1500);
      await p.screenshot({ path: path.join(out, `${tag}${slug(name)}-caves.png`) });
      await p.evaluate((k) => {
        const c = window.reclaimed.camera;
        for (let i = 0; i < 3; i++) c.target[i] = k.t[i];
        c.zoom = k.z;
      }, keep);
    }
  }
  // a slider: the preview follows while it moves, the world when it's let go
  const live = await p.evaluate(async () => {
    const lab = window.noiselab;
    lab.panel.toggle(true);
    const cv = document.querySelector('.lab-preview');
    const sum = () => {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0;
      return h;
    };
    const row = [...document.querySelectorAll('.tune-row')].find((r) => r.title.startsWith('L1.amp '));
    const input = row.querySelector('input[type=range]');
    const h0 = sum();
    const w0 = lab.stats.writes;
    const r0 = lab.stats.runs;
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    input.value = String(Number(input.value) + 20);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await lab.settled;
    await new Promise((r) => setTimeout(r, 100));
    const h1 = sum();
    const midWrites = lab.stats.writes - w0;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    await lab.settled;
    return { previewChanged: h0 !== h1, runs: lab.stats.runs - r0, writesWhileDragging: midWrites, writesAfterRelease: lab.stats.writes - w0, value: lab.registry.get('L1.amp') };
  });
  console.log('slider:', JSON.stringify(live));
  if (!live.previewChanged) fail('the preview did not change with the slider');
  if (live.writesWhileDragging !== 0) fail('the world was rewritten while the slider moved (on release expected)');
  if (live.writesAfterRelease < 1) fail('the world was not rewritten when the slider was let go');
  await sleep(2500);
  await p.evaluate(() => window.noiselab.panel.toggle(false));
  await p.screenshot({ path: path.join(out, `${tag}slider-after.png`) });
  fs.writeFileSync(path.join(out, `${tag}stats.json`), JSON.stringify({ rows, live }, null, 1));
  await fatal();
} catch (e) {
  fail(e.stack ?? String(e));
} finally {
  await browser.close();
}
console.log(failed ? 'FAILED' : 'ok');
process.exit(failed ? 1 : 0);
