// Round 114 (covercheck): what the pixel check's "far" share is on the screen while panning, against the geometric
// check on the same frame. A straight pan up the screen (the pan bench's line) at each zoom and speed; every frame the
// bgcheck snapshot's classes (render/bgcheck.ts: 1 background, 2 the stand-in, 3 the far land nearer) and the
// geometric coverage (TileCache.coverCheck) of the frame it was taken from; then a screenshot mid-pan with the
// snapshot's classes over it (red the stand-in, blue the far land, magenta the background) and the geometric check's
// undrawn pieces listed.
//   node scripts/covshot.mjs [--screen desktop|phone] [--zoom 8,5] [--speeds 40,640] [--secs 3] [--out dir]
import { run } from './lib/runner.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
const BENCH = 'tufts=0&shadowcache=4&prepevery=2&bandh=2&shadowsize=512&hybrid=1&settle=0&inplace=1&sleepmore=1&hitch=1&hitchhud=0';

await run({ name: 'covshot', kind: 'behaviour', size: '1600x900', dpr: 1 }, async (R) => {
  const zooms = R.opt('zoom', '8').split(',').map(Number);
  const speeds = R.opt('speeds', '40').split(',').map(Number);
  const secs = Number(R.opt('secs', 3));
  const screen = R.opt('screen', 'desktop');
  const outDir = R.opt('out', 'C:/Projects/shots88/covercheck');
  const tag = R.opt('tag', 'run');
  const stopAt = Number(R.opt('stopat', 0));
  // (--span N: back and forth over N cells from where the first run starts — every run the same land; 0 one way on)
  const span = Number(R.opt('span', 0));
  // (--dir -1: down the screen; --ab: each run twice, the focus as it was (the camera's target) then as now)
  const dirSign = Number(R.opt('dir', 1));
  const ab = R.argv?.includes?.('--ab') ?? process.argv.includes('--ab');
  const at = R.opt('at', '15024,14337');
  fs.mkdirSync(outDir, { recursive: true });
  const phone = screen === 'phone';
  const p = await R.page(phone ? { size: '412x915', dpr: 2.6 } : { size: '1600x900', dpr: 1 });
  if (phone) {
    await p.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true });
    await p.setUserAgent(UA);
  }
  const params = Object.fromEntries(new URLSearchParams(`${BENCH}&level=atlas${at === 'spawn' ? '' : `&at=${at}`}&win=${R.opt('win', 256)}&bgcheck=1&worldsave=0&tod=0.42&day=100000&season=0.3${R.opt('extra', '')}`));
  await R.level(params, { page: p, noDefaultQ: !phone });
  await R.simSeconds(p, 8);
  const rows = [];
  for (const zoom of zooms)
    for (const v of speeds)
     for (const variant of ab ? ['old', 'new'] : ['now']) {
      const res = await p.evaluate(
        async (zoom, v, secs, stopAt, span, dirSign, variant) => {
          const RR = window.reclaimed;
          const cam = RR.camera;
          const TL = RR.renderer.tiles;
          const BG = RR.renderer.bgCheck;
          const sc = RR.scene;
          const frame = () => new Promise((r) => requestAnimationFrame(r));
          TL.host.win.mesh.statPeriod = 1;
          cam.zoom = zoom;
          const [ux, uy] = cam.screenDeltaToWorld(0, -dirSign);
          const l = Math.hypot(ux, uy) || 1;
          const dir = [ux / l, uy / l];
          const S = RR.stream;
          const ROW = Math.sqrt(3) / 2;
          const here = () => [S.origin[0] + cam.target[0], S.origin[1] * ROW + cam.target[1]];
          window.__covHome ??= here();
          const home = window.__covHome;
          const ground = cam.ground;
          if (variant === 'old') cam.ground = null;
          sc.pan = { speed: v, dir: [...dir], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
          let steering = span > 0;
          let sign = 1;
          (async () => {
            while (steering) {
              await frame();
              if (!sc.pan) break;
              const h = here();
              const off = (h[0] - home[0]) * dir[0] + (h[1] - home[1]) * dir[1];
              if (off > span && sign > 0) sign = -1;
              else if (off < 0 && sign < 0) sign = 1;
              sc.pan.dir = [dir[0] * sign, dir[1] * sign];
            }
          })();
          for (let i = 0; i < 30; i++) await frame();
          // (the geometric check of the frame the snapshot copies: taken as that frame's bgcheck pass is encoded)
          const orig = BG.encode;
          let geo = null;
          let st = null;
          let probe = null;
          BG.encode = function (enc, depth, pick, ts) {
            if (this.snapWanted.length && !this.snapCopied.length) {
              geo = TL.coverCheck(cam);
              st = { m: Array.from(cam.viewProj), tz: cam.target[2], origin: [...TL.origin], W: RR.stream.W, H: RR.stream.H, drawn: new Set(TL.drawnSet), frame: TL.frameNo };
            }
            return orig.call(this, enc, depth, pick, ts);
          };
          const pairs = [];
          let worst = null;
          const t0 = performance.now();
          try {
            while (performance.now() - t0 < secs * 1000) {
              const s = await BG.snapshot();
              const n = s.cols * s.rows;
              const c = [0, 0, 0, 0];
              for (let i = 0; i < n; i++) c[s.cls[i]]++;
              const g = geo;
              const pr = { stand: c[2] / n, farland: c[3] / n, bg: c[1] / n, geo: g ? g.share : null, und: g ? g.undrawn.slice(0, 6).join(' ') : '' };
              pairs.push(pr);
              if (!worst || pr.stand + pr.farland > worst.stand + worst.farland) worst = { ...pr, cols: s.cols, rows: s.rows, cls: Array.from(s.cls) };
              // (--stopat: the pan stopped at the first frame this much far: the shot then shows it)
              if (stopAt > 0 && pr.stand + pr.farland >= stopAt) {
                sc.pan = null;
                // (each far sample's ground at the focus's height: its region, in the window or not, its tile)
                const ROW_H = Math.sqrt(3) / 2;
                const m = st.m;
                const det = m[0] * m[5] - m[4] * m[1];
                const by = {};
                for (let j = 0; j < s.rows; j++)
                  for (let i = 0; i < s.cols; i++) {
                    const cl = s.cls[j * s.cols + i];
                    if (cl < 2) continue;
                    const cx = ((i + 0.5) / s.cols) * 2 - 1;
                    const cy = 1 - ((j + 0.5) / s.rows) * 2;
                    const rx0 = cx - m[8] * st.tz - m[12];
                    const ry0 = cy - m[9] * st.tz - m[13];
                    const x = (m[5] * rx0 - m[4] * ry0) / det;
                    const y = (m[0] * ry0 - m[1] * rx0) / det / ROW_H;
                    const inWin = x >= 0 && x < st.W && y >= 0 && y < st.H;
                    const rx = Math.floor((x + st.origin[0]) / 64);
                    const ry = Math.floor((y + st.origin[1]) / 64);
                    const k = `${rx},${ry}`;
                    if (!by[k]) {
                      const t = [...TL.tiles.values()].find((t) => t.rx === rx && t.ry === ry && Math.round(t.az * 1e4) === Math.round(cam.azimuth * 1e4));
                      const zr = TL.land?.zRange?.(rx, ry);
                      by[k] = { n: 0, cls: cl, inWin, drawn: st.drawn.has(k), tile: t ? { gpu: !!t.gpu, boxed: !!t.boxed, skip: t.skip, q: t.q, age: st.frame - t.bakedAt } : null, zr: zr ? zr.map((q) => +q.toFixed(0)) : null, state: TL.land?.stateOf?.(k) ?? null };
                    }
                    by[k].n++;
                  }
                probe = { tz: +st.tz.toFixed(1), origin: st.origin.slice(0, 2), sea: RR.atlas?.p?.sea ?? null, oz: TL.land?.src?.oz?.() ?? null, regions: by };
                break;
              }
            }
          } finally {
            BG.encode = orig;
            steering = false;
            // (the ground back after the shot: the shot the variant's)
            window.__covGround = ground;
          }
          return { zoom, v, pairs, worst, probe };
        },
        zoom,
        v,
        secs,
        stopAt,
        span,
        dirSign,
        variant,
      );
      // (a screenshot mid-pan with a snapshot asked for together: the classes over it)
      const shotP = p.screenshot({ type: 'png' });
      const snap = await p.evaluate(async () => {
        const RR = window.reclaimed;
        const s = await RR.renderer.bgCheck.snapshot();
        const g = RR.renderer.tiles.coverCheck(RR.camera);
        return { cols: s.cols, rows: s.rows, cls: Array.from(s.cls), geo: g ? g.share : null, und: g ? g.undrawn.slice(0, 8) : [] };
      });
      const shot = PNG.sync.read(Buffer.from(await shotP));
      await p.evaluate(() => {
        window.reclaimed.scene.pan = null;
        window.reclaimed.camera.ground = window.__covGround;
      });
      const W = shot.width;
      const H = shot.height;
      const col = { 1: [255, 0, 255], 2: [255, 0, 0], 3: [0, 80, 255] };
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const c = snap.cls[Math.floor((y / H) * snap.rows) * snap.cols + Math.floor((x / W) * snap.cols)];
          if (!c) continue;
          const i = (y * W + x) * 4;
          for (let k = 0; k < 3; k++) shot.data[i + k] = Math.round(shot.data[i + k] * 0.5 + col[c][k] * 0.5);
        }
      const f = path.join(outDir, `${tag}-${screen}-z${zoom}-v${v}${variant === 'now' ? '' : `-${variant}`}.png`);
      fs.writeFileSync(f, PNG.sync.write(shot));
      if (stopAt > 0) {
        await new Promise((r) => setTimeout(r, 2000));
        fs.writeFileSync(f.replace('.png', '-after2s.png'), await p.screenshot({ type: 'png' }));
        snap.after = await p.evaluate(async () => {
          const RR = window.reclaimed;
          const s = await RR.renderer.bgCheck.snapshot();
          const c = [0, 0, 0, 0];
          for (const k of s.cls) c[k]++;
          const n = s.cols * s.rows;
          const S = RR.stream;
          return { stand: c[2] / n, farland: c[3] / n, at: [S.origin[0] + RR.camera.target[0], S.origin[1] + RR.camera.target[1] / (Math.sqrt(3) / 2)], geo: RR.renderer.tiles.coverCheck(RR.camera)?.share };
        });
      }
      const P = res.pairs;
      const mean = (k) => P.reduce((a, q) => a + (q[k] ?? 0), 0) / Math.max(1, P.length);
      const max = (k) => Math.max(0, ...P.map((q) => q[k] ?? 0));
      const row = {
        zoom,
        v,
        variant,
        frames: P.length,
        standMean: +mean('stand').toFixed(4),
        standMax: +max('stand').toFixed(4),
        farlandMean: +mean('farland').toFixed(4),
        farlandMax: +max('farland').toFixed(4),
        bgMax: +max('bg').toFixed(4),
        geoMean: +mean('geo').toFixed(4),
        geoMax: +max('geo').toFixed(4),
        missed: P.filter((q) => q.stand + q.farland > 0.005 && (q.geo ?? 0) < 0.001).length,
        probe: res.probe,
        worst: { stand: +res.worst.stand.toFixed(4), farland: +res.worst.farland.toFixed(4), geo: res.worst.geo, und: res.worst.und },
        shot: f,
        shotSnap: { geo: snap.geo, und: snap.und, after: snap.after },
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      await R.simSeconds(p, 3);
    }
  const jf = R.opt('json', null);
  if (jf) fs.writeFileSync(jf, JSON.stringify(rows, null, 1));
});
