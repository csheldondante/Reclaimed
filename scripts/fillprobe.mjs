// Round 115 (tilecal): how fast this device fills a screenful of tiles from nothing, against what the calibration
// (render/tilecalib.ts) measured. The atlas at the tile gate's spot, the camera at the zoom floor (asked for 0.5); then
// the view turned a quarter (every tile is keyed by the turn: none drawn) and, every frame, the geometric coverage
// (TileCache.coverCheck) till the screen's all drawn for 10 frames running. Reports the fill's seconds and frames, the
// land's tiles baked in it (tiles a second: the true fill rate), the floor, its bound and the calibration's rate.
//   node scripts/fillprobe.mjs --server http://localhost:5312 [--screens 1600x900,3440x1440] [--phone] [--turns 2]
import { run } from './lib/runner.mjs';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
await run({ name: 'fillprobe', kind: 'behaviour', size: '1600x900', dpr: 1 }, async (R) => {
  const phone = process.argv.includes('--phone');
  const screens = R.opt('screens', phone ? '412x915' : '1600x900').split(',');
  const turns = Number(R.opt('turns', 2));
  const out = [];
  for (const sc of screens) {
    const [w, h] = sc.split('x').map(Number);
    const dpr = phone ? 2.6 : 1;
    const p = await R.page({ size: sc, dpr });
    if (phone) {
      await p.setViewport({ width: w, height: h, deviceScaleFactor: dpr, hasTouch: true, isMobile: true });
      await p.setUserAgent(UA);
    }
    const params = { level: 'atlas', at: '15024,14337', worldsave: '0', world: 'tilegate', tod: '0.42', day: '100000', season: '0.3', hitch: '1', hitchhud: '0', bgcheck: '1', ...(phone ? { q: 'low' } : {}), ...Object.fromEntries(new URLSearchParams(R.opt('extra', ''))) };
    await R.level(params, { page: p, noDefaultQ: !phone });
    await R.simSeconds(p, 10);
    for (let t = 0; t < turns; t++) {
      const r = await p.evaluate(async () => {
        const RR = window.reclaimed;
        const cam = RR.camera;
        const TL = RR.renderer.tiles;
        const raf = () => new Promise((res) => requestAnimationFrame(res));
        cam.zoom = 0.5;
        for (let i = 0; i < 240; i++) await raf();
        cam.zoom = 0.5;
        for (let i = 0; i < 60; i++) await raf();
        const b0 = TL.land.stats.baked;
        cam.azimuth += Math.PI / 2;
        const t0 = performance.now();
        let frames = 0;
        let clean = 0;
        let worst = 0;
        while (performance.now() - t0 < 30000) {
          await raf();
          frames++;
          const c = TL.coverCheck(cam);
          worst = Math.max(worst, c ? c.share : 0);
          if (c && c.share === 0 && frames > 5) {
            if (++clean >= 10) break;
          } else clean = 0;
        }
        const s = (performance.now() - t0) / 1000;
        const baked = TL.land.stats.baked - b0;
        return { zoom: +cam.zoom.toFixed(2), floor: TL.stats.zoomFloor, bound: TL.stats.floorBound, floorTiles: TL.stats.floorTiles, fillS: +s.toFixed(2), frames, baked, tilesPerS: +(baked / s).toFixed(1), drawn: TL.stats.drawn, slots: TL.stats.slots, grown: TL.stats.grown, mb: TL.stats.mb, worstUndrawn: +worst.toFixed(3), cal: TL.cal ? { ...TL.cal.stats, rate: +TL.cal.stats.rate.toFixed(1), measuredS: +TL.cal.stats.measuredS.toFixed(1) } : null };
      });
      console.log(`${sc}${phone ? ' phone' : ''} turn ${t + 1}: ${JSON.stringify(r)}`);
      out.push({ sc, ...r });
    }
    await p.close();
  }
  console.log(JSON.stringify(out));
});
