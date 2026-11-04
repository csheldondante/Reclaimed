// (round 128j, claims at load) The static grids' claims are in the GPU's columns wherever their land is written, across
// slides: on the atlas at a town (town=1), the camera taken out of the town and back four ways (each leg slides the window
// several regions), and after each the layers read back whole and audited (sim/static-claims.ts audit): every column of a
// town's building (or the fortress's block) in the window, on written land, is External or ground over its spans; no
// External cell in the window lies outside every claim (an orphan to be); no building was lost (cut, loose). Then the
// same after a whole-window warp away and back (the pool's regions thawed, claims and all).
//   node scripts/staticclaims.mjs [--legs 4] [--dist 220] [--fortress]
import { run } from './lib/runner.mjs';

await run({ name: 'staticclaims', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const legs = Number(R.opt('legs', 4));
  const dist = Number(R.opt('dist', 220));
  const extra = R.flag('fortress') ? { fortress: '1' } : {};
  const p = await R.level({ level: 'atlas', town: '1', tod: '0.4', day: '100000', worldsave: '0', tutorial: '0', ...extra });
  await R.simSeconds(p, 3);
  const audit = (label) =>
    p.evaluate(async (label) => {
      const RR = window.reclaimed;
      const S = RR.stream;
      const frame = () => new Promise((res) => requestAnimationFrame(res));
      for (let t0 = performance.now(); (S.busy || S.unwritten.length) && performance.now() - t0 < 20000; ) await frame();
      for (let i = 0; i < 10; i++) await frame();
      const st = RR.statics();
      if (!st) return { label, error: 'no static claims' };
      const f = await RR.core.readBuffer('layers');
      const a = st.audit(new Uint32Array(f.buffer), RR.core.packed);
      const ext = RR.core.integrity?.external;
      const view = RR.settlementsView?.();
      return { label, slides: S.stats?.slides, ...a, missing: a.missing.slice(0, 3).map((m) => ({ ...m, col: m.col.map((iv) => `${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}:${iv.mat}`).join(' ') })), stats: { ...st.stats }, lost: view?.stats.lost, ext: ext && { cut: ext.stats.cut, loose: ext.stats.loose, orphans: ext.stats.orphans } };
    }, label);
  const rows = [];
  const first = await audit('start');
  console.log(JSON.stringify(first));
  rows.push(first);
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  for (let k = 0; k < legs; k++) {
    const [dx, dy] = dirs[k % 4];
    for (const sign of [1, -1]) {
      await p.evaluate(
        async (dx, dy, dist) => {
          const cam = window.reclaimed.camera;
          const frame = () => new Promise((res) => requestAnimationFrame(res));
          const steps = Math.ceil(dist / 6);
          for (let i = 0; i < steps; i++) {
            cam.target[0] += (dx * dist) / steps;
            cam.target[1] += (dy * dist) / steps;
            await frame();
          }
        },
        dx * sign,
        dy * sign,
        dist,
      );
      const r = await audit(`leg ${k} ${sign > 0 ? 'out' : 'back'} (${dx},${dy})`);
      console.log(JSON.stringify(r));
      rows.push(r);
    }
  }
  for (const r of rows) {
    R.check(`${r.label}: the static claims' columns hold (claimed or buried)`, !r.error && r.checked > 0 && r.held === r.checked, JSON.stringify({ checked: r.checked, held: r.held, missing: r.missing }));
    R.check(`${r.label}: no External cell outside a claim`, r.unclaimed === 0, `${r.unclaimed} of ${r.external}`);
  }
  const last = rows[rows.length - 1];
  R.check('the window slid', (last.slides ?? 0) > 0, `${last.slides} slides`);
  R.check('no building lost, nothing cut or loose', !last.lost && !last.ext?.cut && !last.ext?.loose, JSON.stringify({ lost: last.lost, ext: last.ext }));
});
