// Round 99 (?meshinst=1): the instanced meshes and the External intervals, tested with every system on, as the phone
// runs it (q=low, 412×915, 1× speed).
//   node scripts/meshinsttest.mjs trees [--url http://localhost:5281] [--at x,y] [--out dir] [--wait 35000]
//     the atlas at the phone tier with meshinst off and on: a shot each, the trees drawn per species, GPU errors
//   node scripts/meshinsttest.mjs rock [--url …] [--out dir]
//     the rock lab: a boulder dropped tilted comes to rest and stays its mesh (External intervals, no ground written),
//     sand poured over it (buried: it holds the sand), a dig through it (cut: it lets go, its cells ground again)
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const mode = argv[0] ?? 'trees';
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5281');
const out = opt('out', 'C:/Projects/shots88/meshinst');
const wait = Number(opt('wait', 35000));
const at = opt('at', '11956,15471');
const extra = opt('extra', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const page = async () => {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad++;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /validation|WGSL|error/i.test(t)) console.log('console', m.type(), t.slice(0, 400));
  });
  return p;
};
const fatal = (p) => p.evaluate(() => document.querySelector('.fatal, #fatal')?.textContent ?? null);
try {
  if (mode === 'trees') {
    for (const on of ['0', '1']) {
      const p = await page();
      await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&perf=1&at=${at}&meshinst=${on}${extra}`, { waitUntil: 'load' });
      await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
      await sleep(wait);
      console.log(`meshinst=${on} fatal:`, await fatal(p));
      const r = await p.evaluate(async () => {
        const R = window.reclaimed;
        const mi = R.renderer.meshInst;
        const counts = mi ? await mi.counts(R.core.host.gpu.device, R.renderer.indirect) : null;
        return { counts, mesh: mi?.stats ?? null };
      });
      console.log(`meshinst=${on}`, JSON.stringify(r));
      await p.screenshot({ path: `${out}/trees_${on === '1' ? 'mesh' : 'boxes'}.png` });
      await p.close();
    }
  } else if (mode === 'forest') {
    // a wood grown round the camera (api.plants.grow: a wood at once), then the frame and the GPU measured still
    for (const on of ['0', '1']) {
      const p = await page();
      await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&perf=1&at=${at}&meshinst=${on}${extra}`, { waitUntil: 'load' });
      await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
      await sleep(wait);
      await p.evaluate(() => {
        const R = window.reclaimed;
        const [x, y] = R.camera.target;
        R.api.plants.grow(x, y, { radius: 70, strength: 60 });
      });
      await sleep(10000);
      const r = await p.evaluate(async (secs) => {
        const R = window.reclaimed;
        const P = R.core.host.profiler;
        P.resetTotals();
        const t = [];
        let go = true;
        const f = () => {
          if (!go) return;
          t.push(performance.now());
          requestAnimationFrame(f);
        };
        requestAnimationFrame(f);
        await new Promise((res) => setTimeout(res, secs * 1000));
        go = false;
        const d = [];
        for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
        d.sort((a, b) => a - b);
        const fr = Math.max(P.framesResolved, 1);
        const per = (k) => +((P.totalMs.get(k) ?? 0) / fr).toFixed(3);
        const mi = R.renderer.meshInst;
        return {
          p50: +d[Math.floor(d.length / 2)].toFixed(1),
          p95: +d[Math.floor(d.length * 0.95)].toFixed(1),
          gpu: +(P.gpuTotalMs / fr).toFixed(2),
          draw: per('draw'),
          gbuffer: per('gbuffer'),
          shadow: per('shadow'),
          renderprep: per('renderprep'),
          draws: P.draws,
          trees: mi ? await mi.counts(R.core.host.gpu.device, R.renderer.indirect) : null,
          plantBoxes: R.renderer.instanceCounts?.plants ?? null,
        };
      }, 10);
      console.log(`forest meshinst=${on}`, JSON.stringify(r));
      await p.screenshot({ path: `${out}/forest_${on === '1' ? 'mesh' : 'boxes'}.png` });
      await p.close();
    }
  } else if (mode === 'rock') {
    const p = await page();
    await p.goto(`${url}/?skipmenu=1&level=rocklab&tutorial=0&q=low&perf=1&rockbody=1&meshinst=1${extra}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.integrity?.(), { timeout: 240000 });
    await sleep(wait);
    console.log('fatal:', await fatal(p));
    // a boulder over the camera's target, turning: it falls, tumbles and rests
    const where = await p.evaluate(() => {
      const R = window.reclaimed;
      const I = R.integrity();
      const [tx, ty] = R.camera.target;
      const cx = Math.round(tx);
      const cy = Math.round(ty / 0.866);
      const top = R.api.terrain.heightAt(tx, ty) ?? 20;
      const cells = [];
      for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) for (let z = 0; z < 6; z++) if (x * x + y * y * 0.75 + (z - 2.5) * (z - 2.5) * 1.2 <= 10) cells.push({ x: cx + x, y: cy + y, z: Math.round(top) + 10 + z, mat: 1 });
      const b = I.rigid.spawn(cells);
      b.w = [0.9, 0.4, 0.2];
      b.slot = I.rockMesh?.alloc(cells)?.id;
      return { cx, cy, tx, ty, top, cells: cells.length };
    });
    console.log('dropped', JSON.stringify(where));
    await sleep(300);
    await p.screenshot({ path: `${out}/rock_falling.png` });
    await sleep(9000);
    const rest = await p.evaluate(() => {
      const I = window.reclaimed.integrity();
      return { bodies: I.rigid.list.length, resting: I.restingCount, ext: I.external?.stats, why: I.why };
    });
    console.log('rest', JSON.stringify(rest));
    await p.screenshot({ path: `${out}/rock_rest.png` });
    // the ground under it: External intervals there
    const cols = await p.evaluate(async (w) => {
      const R = window.reclaimed;
      await R.api.refresh?.();
      const L = [];
      for (const dx of [-2, 0, 2]) L.push(R.api.terrain.layersAt(w.tx + dx, w.ty).map((l) => `${l.material}:${l.z0.toFixed(1)}-${l.z1.toFixed(1)}`).join(' '));
      return L;
    }, where);
    console.log('layers', JSON.stringify(cols));
    // where it lies: the first resting instance's middle column (world units)
    const lies = await p.evaluate(() => {
      const I = window.reclaimed.integrity();
      const inst = [...(I.external?.instances ?? [])][0];
      if (!inst) return null;
      const c = inst.cols[Math.floor(inst.cols.length / 2)];
      const top = Math.max(...inst.cols.map((q) => q.z1));
      return { x: c.x + 0.5 + 0.5 * (c.y & 1), y: (c.y + 0.5) * 0.866, top, cols: inst.cols.length };
    });
    console.log('lies', JSON.stringify(lies));
    if (lies) Object.assign(where, { tx: lies.x, ty: lies.y });
    const ext = await p.evaluate((w) => window.reclaimed.api.terrain.layersAt(w.tx, w.ty).map((l) => `${l.material}:${l.z0.toFixed(1)}-${l.z1.toFixed(1)}`).join(' '), where);
    console.log('under it', ext);
    // buried: sand poured over it
    await p.evaluate((w) => window.reclaimed.api.terrain.deposit(w.tx, w.ty, 'sand', { radius: 6, layers: 4 }), where);
    await sleep(6000);
    console.log('buried layers', await p.evaluate((w) => window.reclaimed.api.terrain.layersAt(w.tx, w.ty).map((l) => `${l.material}:${l.z0.toFixed(1)}-${l.z1.toFixed(1)}`).join(' '), where));
    const bur = await p.evaluate(() => {
      const I = window.reclaimed.integrity();
      return { bodies: I.rigid.list.length, resting: I.restingCount, ext: I.external?.stats, why: I.why };
    });
    console.log('buried', JSON.stringify(bur));
    await p.screenshot({ path: `${out}/rock_buried.png` });
    // cut: a dig through it
    await p.evaluate((w) => window.reclaimed.api.terrain.dig(w.tx, w.ty, { radius: 2, layers: 12 }), where);
    await sleep(5000);
    const cut = await p.evaluate(() => {
      const I = window.reclaimed.integrity();
      return { bodies: I.rigid.list.length, resting: I.restingCount, ext: I.external?.stats, why: I.why };
    });
    console.log('cut', JSON.stringify(cut));
    await p.screenshot({ path: `${out}/rock_cut.png` });
    console.log('fatal:', await fatal(p));
  }
} finally {
  await browser.close();
}
console.log(bad ? `FAIL ${bad} page errors` : 'ok');
process.exit(bad ? 1 : 0);
