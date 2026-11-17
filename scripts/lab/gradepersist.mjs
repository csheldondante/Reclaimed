// (loop-streets) Streets as terrain persist: Muru's graded square and arterials are paving (MAT 43) at sample points
// when made, after the window slides far away and back (the land leaves and arrives again), and after a reload of the
// saved world (no fresh). Reads the ground's surface words of a few boxes (the world API's pages), nothing else.
//   node scripts/lab/gradepersist.mjs [--slides 6]
import { run } from '../lib/runner.mjs';

const PAVING = 43;
await run({ name: 'gradepersist', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const p = await R.page();
  const open = async (fresh) => {
    await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1${fresh ? '&fresh=1' : ''}&q=low&warmcache=0`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.rungame?.phase || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(p);
    await p.waitForFunction(() => window.rungame.phase === 'leader' || window.rungame.phase === 'city', { timeout: 300000, polling: 250 });
    if (await p.evaluate(() => window.rungame.phase === 'leader')) await p.evaluate(() => window.rungame.pick('ysolt'));
    await p.waitForFunction(() => window.rungame.phase === 'city' && [...(window.citygen?.live.values() ?? [])][0]?.times, { timeout: 120000, polling: 250 });
    await R.sleep(6000);
  };
  await open(true);
  // the sample points (world units): the square round the centre, and each road 22–60 units out
  const pts = await p.evaluate(() => {
    const t = [...window.citygen.live.values()][0];
    // (kept in the town's grid frame: fixed in the world, placed in the window again at each check)
    const g = t.gridPlace();
    const RH = Math.sqrt(3) / 2;
    const w = ([x, y]) => [x - g.dx, y - g.dy * RH];
    const c = t.centreInWindow();
    const out = [];
    for (let a = 0; a < 12; a++) out.push({ k: 'square', at: w([c[0] + 8 * Math.cos(a * 0.52), c[1] + 8 * Math.sin(a * 0.52)]) });
    for (let k = 0; k < t.roadCount; k++) {
      const line = t.roadInWindow(k);
      for (const q of line) {
        const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
        if (d > 22 && d < 60) out.push({ k: `road ${k}`, at: w(q) });
      }
    }
    return out;
  });
  const check = (what) =>
    p.evaluate(async (pts) => {
      const t = [...window.citygen.live.values()][0];
      const T = window.reclaimed.scene.worldApi.terrain;
      const by = { origin: [...window.reclaimed.stream.origin], live: !!t };
      if (!t) return by;
      for (const q of pts) {
        const [x, y] = t.inWindow(q.at);
        if (!T.inWindow(x, y)) {
          (by[q.k] ??= { paving: 0, other: 0, out: 0 }).out++;
          continue;
        }
        await T.load(x - 1, y - 1, x + 1, y + 1);
        const s = T.surfaceAt(x, y);
        const e = (by[q.k] ??= { paving: 0, other: 0, out: 0, mats: {} });
        if (s?.mat === 43) e.paving++;
        else {
          e.other++;
          e.mats = e.mats ?? {};
          e.mats[s?.mat ?? 'none'] = (e.mats[s?.mat ?? 'none'] ?? 0) + 1;
        }
      }
      return by;
    }, pts).then((by) => {
      R.log(`${what}: ${JSON.stringify(by)}`);
      return by;
    });
  const total = (by) => Object.values(by).reduce((s, e) => s + (e?.paving ?? 0), 0);
  const made = total(await check('made'));
  // (a sample point on a deck is the deck's External slab, one in the river or under a building not graded: the
  // baseline is what was paving once made)
  R.check('paving at the sample points once made', made > 10, `${made} of ${pts.length}`);
  // slide far east and back (the town's land leaves the window and comes back)
  const n = Number(R.opt('slides', '6'));
  const slid = await p.evaluate(async (n) => {
    const Rc = window.reclaimed;
    const S = Rc.stream;
    const n0 = S.stats.slides;
    // (the camera's target is in window units: a slide moves it — compare in world columns)
    const wx = () => Rc.camera.target[0] + S.origin[0];
    const x0 = wx();
    for (let f = 0; f < 4000 && S.stats.slides - n0 < n; f++) {
      Rc.camera.target[0] += 3;
      await new Promise((r) => requestAnimationFrame(r));
    }
    const away = S.stats.slides - n0;
    await new Promise((r) => setTimeout(r, 3000));
    for (let f = 0; f < 4000 && wx() > x0; f++) {
      Rc.camera.target[0] -= Math.min(3, wx() - x0);
      await new Promise((r) => requestAnimationFrame(r));
    }
    // (the window follows a little behind: wait till it has slid back as far as it went)
    for (let f = 0; f < 600 && S.stats.slides - n0 < 2 * away; f++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 4000));
    return { away, total: S.stats.slides - n0 };
  }, n);
  R.log(`slid ${JSON.stringify(slid)}`);
  await R.fatal(p);
  const back = total(await check('after the slides away and back'));
  R.check('paving after sliding away and back', back >= made - 2, `${back} (made ${made})`);
  // reload the saved world (no fresh)
  await p.evaluate(() => window.rungame.save?.());
  await R.sleep(2000);
  await open(false);
  const again = total(await check('after a reload'));
  R.check('paving after a reload', again >= made - 2, `${again} (made ${made})`);
});
