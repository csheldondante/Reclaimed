// Round 111 (TG1): the noise lab, headless, as the deployed page runs it (q's flags, 1x speed, every system the level
// has). Checks: the level opens without errors and writes its first recipe; every built-in recipe runs, its preview
// and the world drawn (shots of both); a slider moved changes the preview at once and the world when let go; the
// regenerate's cost (GPU run, the columns' packing, the world's write, the frames after it).
//   node scripts/noiselab.mjs [--url http://localhost:5207] [--out C:/Projects/shots88/noiselab] [--size 1280x800]
//     [--dpr 1] [--q medium] [--only "TG2: mesas, ramps, ravines"]
// Round 112 (TG9, TG10, TG11): the layer stack's list driven as a user would (select, add, move down, solo, up to here,
// remove: the recipe back as it was), and the carves' recipes seen from low down off the coast (a flying camera).
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
      `${name}: heights ${s.min.toFixed(0)}–${s.max.toFixed(0)}, gaps ${s.caves} (written ${s.gapCols}, opened ${s.cutCols}, joined ${s.joinedCols}), runs ≤ ${s.maxRuns}; gpu ${s.gpuMs.toFixed(1)} ms (${s.passes} passes), columns ${s.packMs.toFixed(1)} ms, world write ${s.writeMs.toFixed(1)} ms; frames after: mean ${mean.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`,
    );
    // the world with the panel shut, then the panel (its preview) open
    await p.evaluate(() => window.noiselab.panel.toggle(false));
    await sleep(400);
    await p.screenshot({ path: path.join(out, `${tag}${slug(name)}.png`) });
    await p.evaluate(() => window.noiselab.panel.toggle(true));
    await sleep(300);
    await p.screenshot({ path: path.join(out, `${tag}${slug(name)}-panel.png`) });
    // (round 112: the carves from low down, a flying camera off the cliff: TG3 from the sea to the east, TG11 its wall)
    const flyShots = name.startsWith('TG3')
      ? [[220, 70, 24, Math.PI, -0.12], [220, 111, 24, Math.PI, -0.12], [220, 150, 24, Math.PI, -0.12], [205, 40, 30, Math.PI * 0.85, -0.2]]
      : name.startsWith('TG11')
        ? [[230, 150, 22, Math.PI * 1.1, -0.1], [128, 20, 20, Math.PI * 0.5, -0.05], [30, 170, 24, -Math.PI * 0.2, -0.1]]
        : [];
    for (let k = 0; k < flyShots.length; k++) {
      const [x, y, z, yaw, pitch] = flyShots[k];
      await p.evaluate(
        (x, y, z, yaw, pitch) => {
          window.noiselab.panel.toggle(false);
          window.reclaimed.camera.fly = { pos: [x, y, z], yaw, pitch, fov: (60 * Math.PI) / 180 };
        },
        x, y, z, yaw, pitch,
      );
      await sleep(2500);
      await p.screenshot({ path: path.join(out, `${tag}${slug(name)}-fly${k + 1}.png`) });
    }
    if (flyShots.length) await p.evaluate(() => (window.reclaimed.camera.fly = null));
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
  // (round 112) the layer stack, driven through its rows and buttons
  if (!only || only.includes('TG3')) {
    await p.evaluate(() => window.noiselab.load('TG3: coastal mesas, sea caves'));
    await sleep(1500);
    await p.evaluate(() => window.noiselab.settled);
    const ui = await p.evaluate(async () => {
      const lab = window.noiselab;
      const st = lab.stack;
      lab.panel.toggle(true);
      const settle = async () => {
        await new Promise((r) => setTimeout(r, 60));
        await lab.settled;
        await new Promise((r) => setTimeout(r, 60));
        await lab.settled;
      };
      const rows = () => [...document.querySelectorAll('.lab-row')].filter((r) => !r.hidden);
      const names = () => rows().map((r) => r.querySelector('.lab-name').textContent.replace(/^\d+\. /, ''));
      const btn = (label) => [...document.querySelectorAll('.lab-bar button')].find((b) => b.textContent === label);
      const shownGroups = () => [...document.querySelectorAll('.tune-group')].filter((g) => !g.hidden).map((g) => g.querySelector('summary').textContent);
      const recipe0 = JSON.stringify(lab.registry.changed());
      const log = { start: names(), gaps0: lab.stats.caves };
      // select the third row: its parameters alone
      rows()[2].click();
      log.selected = st.selected;
      log.groupsShown = shownGroups();
      // add under it, then move the new layer down one
      btn('+ layer').click();
      await settle();
      log.afterAdd = names();
      btn('↓').click();
      await settle();
      log.afterDown = names();
      log.selAfterDown = st.selected;
      // solo the carve (the last row): it and what it reads
      const carveRow = rows().findIndex((r) => r.querySelector('.lab-name').textContent.includes('carve'));
      rows()[carveRow].querySelectorAll('.lab-view')[0].click();
      await settle();
      log.soloKeeps = st.stacked(st.effective(window.noiselab.registry.values)).map((i) => i + 1);
      log.soloGaps = lab.stats.caves;
      log.soloLinks = rows()[carveRow].querySelector('.lab-links').textContent;
      log.carveStat = rows()[carveRow].querySelector('.lab-stat').textContent;
      // the result up to the first row
      rows()[0].querySelectorAll('.lab-view')[1].click();
      await settle();
      log.upToKeeps = st.stacked(st.effective(window.noiselab.registry.values)).map((i) => i + 1);
      log.upToGaps = lab.stats.caves;
      // views off; the added layer removed: the recipe as it was
      rows()[0].querySelectorAll('.lab-view')[1].click();
      await settle();
      log.removing = st.selected;
      btn('remove').click();
      await settle();
      log.afterRemove = names();
      log.recipeBack = JSON.stringify(lab.registry.changed()) === recipe0;
      log.gapsEnd = lab.stats.caves;
      return log;
    });
    console.log('stack:', JSON.stringify(ui, null, 1));
    if (ui.afterAdd.length !== ui.start.length + 1) fail('add did not add a row');
    if (ui.afterDown[4] !== ui.afterAdd[3] || ui.afterDown[3] !== ui.afterAdd[4] || ui.selAfterDown !== 4) fail('move down did not move the new layer');
    if (ui.groupsShown.filter((g) => g.startsWith('Layer')).length !== 1) fail(`selecting a row showed ${ui.groupsShown.join(', ')}`);
    if (!(ui.soloKeeps.length < ui.afterDown.length)) fail('solo kept every layer');
    if (ui.soloGaps < 1) fail('the soloed carve cut nothing');
    if (ui.upToKeeps.length !== 1 || ui.upToGaps !== 0) fail('up to here did not stop at the first layer');
    if (!ui.recipeBack) fail('add, move, remove did not give the recipe back');
    if (ui.gapsEnd !== ui.gaps0) fail(`the gaps changed after the round trip (${ui.gaps0} → ${ui.gapsEnd})`);
    await sleep(1500);
    await p.screenshot({ path: path.join(out, `${tag}stack-ui.png`) });
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
