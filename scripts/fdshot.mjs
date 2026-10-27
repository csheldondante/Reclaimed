// Round 93 (fardetail): the land past the window at the phone's view — a shot at each spot (and turned), plain and
// with the window's edge drawn over it (its rectangle projected at the target's height), so what differs across the
// boundary can be seen; --list prints settlements and lakes near the first spot to pick spots from.
//   node scripts/fdshot.mjs [--url http://localhost:5269] [--spots "start:11956,15471;town:12000,15500"]
//     [--turns 0,1] [--out C:/Projects/shots88/fardetail] [--tag before] [--extra "&fd=0"] [--wait 35000]
//     [--size 412x915] [--list 1] [--zoom 2.6]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { PNG } from 'pngjs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5269');
const spots = opt('spots', 'start:11956,15471')
  .split(';')
  .map((s) => s.split(':'))
  .map(([n, at]) => ({ n, at }));
const turns = opt('turns', '0').split(',').map(Number);
const out = opt('out', 'C:/Projects/shots88/fardetail');
const tag = opt('tag', 'before');
const extra = opt('extra', '');
const wait = Number(opt('wait', 35000));
const list = opt('list', '') === '1';
const zoom = opt('zoom', '');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  protocolTimeout: 600000,
});
let bad = false;
try {
  for (const s of spots) {
    const p = await browser.newPage();
    p.on('pageerror', (e) => {
      bad = true;
      console.log('pageerror', e.message);
    });
    p.on('console', (m) => (m.type() === 'error' || m.text().startsWith('[fd]')) && console.log(m.type(), m.text()));
    await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=${s.at}${extra}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
    await sleep(wait);
    if (list) {
      const info = await p.evaluate(() => {
        const R = window.reclaimed;
        const a = R.atlas;
        const S = R.stream;
        const ROW_H = Math.sqrt(3) / 2;
        const c = R.camera.target;
        const wx = c[0] + S.origin[0];
        const wy = c[1] + S.origin[1] * ROW_H;
        const d = (x, y) => Math.hypot(x - wx, y - wy);
        const sites = a.settlement.sites.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y / ROW_H), size: q.size, d: Math.round(d(q.x, q.y)) })).sort((u, v) => u.d - v.d).slice(0, 8);
        const lakes = (a.lakes ?? []).map((q) => ({ ...q, d: Math.round(d(q.x ?? 0, q.y ?? 0)) })).sort((u, v) => u.d - v.d).slice(0, 4);
        return { target: [wx, wy / ROW_H], sites, lakes, wayPoints: a.ways.points.length, keys: Object.keys(lakes[0] ?? {}) };
      });
      console.log(JSON.stringify(info, null, 1));
    }
    let turned = 0;
    for (const t of turns) {
      const btn = await p.$$('.turn-ctl button');
      while (turned < t) {
        const box = await btn[1].boundingBox();
        await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(1500);
        turned++;
      }
      if (zoom) await p.evaluate((z) => (window.reclaimed.camera.zoom = z), Number(zoom));
      await sleep(t ? 6000 : 500);
      const name = `${out}/${tag}-${s.n}-t${t}`;
      await p.screenshot({ path: `${name}.png` });
      // the seam: the shot's colour a few pixels either side of the window's edge, along it (where it's on screen)
      const edge = await p.evaluate(() => {
        const R = window.reclaimed;
        const c = R.camera;
        const { w, h } = R.core.dims;
        const H = h * (Math.sqrt(3) / 2);
        const out = [];
        const [cx, cy] = [w / 2, H / 2];
        const add = (x, y) => {
          // (the inside a few cells toward the middle, the outside a few past)
          const len = Math.hypot(cx - x, cy - y);
          const ux = (cx - x) / len;
          const uy = (cy - y) / len;
          const z = R.camera.target[2];
          const a = c.project(x + ux * 4, y + uy * 4, z);
          const b = c.project(x - ux * 4, y - uy * 4, z);
          out.push([a, b]);
        };
        for (let i = 1; i < 64; i++) {
          add((w * i) / 64, 0);
          add((w * i) / 64, H);
          add(0, (H * i) / 64);
          add(w, (H * i) / 64);
        }
        return { pairs: out, vw: c.viewportW, vh: c.viewportH };
      });
      {
        const png = PNG.sync.read(fs.readFileSync(`${name}.png`));
        const sx = png.width / edge.vw;
        const px = ([x, y]) => {
          const X = Math.round(x * sx);
          const Y = Math.round(y * sx);
          if (X < 2 || Y < 2 || X >= png.width - 2 || Y >= png.height - 2) return null;
          // (a 5 x 5 mean)
          const m = [0, 0, 0];
          for (let j = -2; j <= 2; j++)
            for (let i = -2; i <= 2; i++) {
              const o = ((Y + j) * png.width + X + i) * 4;
              for (let k = 0; k < 3; k++) m[k] += png.data[o + k] / 25;
            }
          return m;
        };
        let n = 0;
        let dl = 0;
        let dc = 0;
        let lin = 0;
        let lout = 0;
        const gin = [0, 0, 0];
        const gout = [0, 0, 0];
        for (const [a, b] of edge.pairs) {
          const A = px(a);
          const B = px(b);
          if (!A || !B) continue;
          // (the HUD's corners are excluded by being few; the sky's never the ground's edge)
          n++;
          const la = 0.3 * A[0] + 0.59 * A[1] + 0.11 * A[2];
          const lb = 0.3 * B[0] + 0.59 * B[1] + 0.11 * B[2];
          dl += Math.abs(la - lb);
          dc += Math.hypot(A[0] - la - (B[0] - lb), A[1] - la - (B[1] - lb), A[2] - la - (B[2] - lb));
          lin += la;
          lout += lb;
          for (let k = 0; k < 3; k++) {
            gin[k] += A[k];
            gout[k] += B[k];
          }
        }
        const f = (v) => +(v / Math.max(n, 1)).toFixed(1);
        console.log(`SEAM ${tag} ${s.n} t${t}: ${n} points on screen | |dLuma| ${f(dl)} |dChroma| ${f(dc)} | luma in ${f(lin)} out ${f(lout)} | rgb in ${gin.map(f)} out ${gout.map(f)}`);
      }
      // the window's edge over it
      await p.evaluate(() => {
        const R = window.reclaimed;
        const c = R.camera;
        const { w, h } = R.core.dims;
        const H = h * (Math.sqrt(3) / 2);
        const z = c.target[2];
        const cv = document.createElement('canvas');
        cv.id = 'fd-edge';
        cv.width = c.viewportW;
        cv.height = c.viewportH;
        cv.style.cssText = `position:fixed;left:0;top:0;width:${c.viewportW}px;height:${c.viewportH}px;pointer-events:none;z-index:99999`;
        const g = cv.getContext('2d');
        g.strokeStyle = '#ff00ff';
        g.lineWidth = 2;
        g.setLineDash([8, 6]);
        g.beginPath();
        const pts = [];
        for (let i = 0; i <= 64; i++) pts.push([(w * i) / 64, 0]);
        for (let i = 0; i <= 64; i++) pts.push([w, (H * i) / 64]);
        for (let i = 64; i >= 0; i--) pts.push([(w * i) / 64, H]);
        for (let i = 64; i >= 0; i--) pts.push([0, (H * i) / 64]);
        pts.forEach(([x, y], k) => {
          const [sx, sy] = c.project(x, y, z);
          if (k) g.lineTo(sx, sy);
          else g.moveTo(sx, sy);
        });
        g.stroke();
        document.body.appendChild(cv);
      });
      await p.screenshot({ path: `${name}-edge.png` });
      await p.evaluate(() => document.getElementById('fd-edge')?.remove());
      console.log('shot', name);
    }
    await p.close();
  }
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
