// Round 81: the field mesh as built, summed without regard to order (vertices a chunk, their positions and
// normals) — the window's and the band's — so two builds (one with a change, one without) can be compared.
//   node scripts/meshcmp.mjs [--url http://localhost:5207] [--at 12304,5457] [--wait 15000] [--zoom 0.6]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const at = opt('at', '12304,5457');
const wait = Number(opt('wait', 15000));
const zoom = Number(opt('zoom', 0.6));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&at=${at}&speed=0${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await p.evaluate((z) => (window.reclaimed.camera.zoom = z), zoom);
  await new Promise((r) => setTimeout(r, wait));
  const r = await p.evaluate(async () => {
    const core = window.reclaimed.core;
    const dev = core.host.gpu.device;
    const read = async (src) => {
      const tmp = dev.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(src, 0, tmp, 0, src.size);
      dev.queue.submit([enc.finish()]);
      await tmp.mapAsync(GPUMapMode.READ);
      const o = tmp.getMappedRange().slice(0);
      tmp.destroy();
      return o;
    };
    const out = {};
    const R = core.renderer;
    for (const [pre, mesh] of [['window', R.fieldMesh], ['band', R.band?.mesh]]) {
      if (!mesh) continue;
      const st = new Uint32Array(await read(mesh.stateBuffer));
      const vb = new Float32Array(await read(mesh.vertexBuffer));
      // (round 81: four words after the chunks: the rebuild dispatch)
      const chunks = (st.length - 20) / 18;
      const per = vb.length / 8 / chunks;
      let n = 0;
      const sum = [0, 0, 0, 0, 0, 0];
      let full = 0;
      for (let c = 0; c < chunks; c++) {
        const b = 16 + c * 14;
        const cnt = st[b + 7];
        const rg = st[b + 10];
        full += st[b + 9];
        n += cnt;
        for (let v = 0; v < cnt; v++) {
          const o = (rg * per + v) * 8;
          for (let k = 0; k < 3; k++) sum[k] += vb[o + k];
          for (let k = 0; k < 3; k++) sum[3 + k] += vb[o + 4 + k];
        }
      }
      out[pre] = { verts: n, full, sum: sum.map((v) => +v.toFixed(1)) };
    }
    return out;
  });
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
