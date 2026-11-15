// (physics10-atlas, PA2) `?physdemo=1` played at Muru: the view on the town's built core, the demo's buttons pressed as
// a player would (stone blocks on the houses, a boulder rolled at them), frames saved for a GIF, and a meteor landed
// beside the houses (the sandbox's tool) to see what an edit frees and what the town is told.
//   RECLAIMED_PORT=5871 node scripts/lab.mjs run scripts/lab/townphysdemo.mjs --flags "&solver=engine&physdemo=1" --out <dir>
//   node scripts/lab/frames2gif.mjs <dir> demo_ <out.gif> --delay 100 --scale 1
export default async function (lab, args) {
  const R = window.reclaimed;
  const scene = R.scene;
  const core = R.core;
  const eng = scene.engine?.engine;
  if (!eng) throw new Error('no engine: --flags "&solver=engine&physdemo=1"');
  const btn = (id) => {
    const b = document.querySelector(`[data-physdemo=${id}]`);
    if (!b) throw new Error(`no demo button ${id}: --flags "&physdemo=1"`);
    return b;
  };
  const sheet = document.querySelector('.season-sheet');
  if (sheet && !sheet.classList.contains('folded')) sheet.querySelector('.s-fold').click();
  const ROW_H = Math.sqrt(3) / 2;
  const { w, h } = core.dims;
  const settle = async () => {
    for (let k = 0, still = 0, o = ''; k < 80 && still < 4; k++) {
      await lab.run(0.2, 1);
      const n = scene.stream.origin.join(',') + scene.stream.busy;
      still = n === o && !scene.stream.busy ? still + 1 : 0;
      o = n;
    }
  };
  // (the view on the built core: the middle of the town's tall External columns)
  const core0 = async () => {
    const S = new Uint32Array((await core.readBuffer('surface')).buffer);
    const N = (await lab.places(lab.town)).named;
    const c = N.market.at;
    const cy = Math.round(c[1] / ROW_H - 0.5);
    const cx = Math.round(c[0] - 0.5);
    const zAt = (x, y) => (S[y * w + x] & 0x1ffff) / 256;
    const ext = (x, y) => ((S[y * w + x] >>> 17) & 0xff) === 39;
    let sx = 0, sy = 0, n = 0;
    for (let j = -70; j <= 70; j++)
      for (let i = -70; i <= 70; i++) {
        const x = cx + i, y = cy + j;
        if (x < 4 || y < 4 || x >= w - 4 || y >= h - 4 || !ext(x, y)) continue;
        let lo = Infinity;
        for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) if (!ext(x + a, y + b)) lo = Math.min(lo, zAt(x + a, y + b));
        if (zAt(x, y) - lo >= 2.5 && zAt(x, y) - lo < 40) { sx += x; sy += y; n++; }
      }
    return n ? [sx / n + 0.5, (sy / n + 0.5) * ROW_H] : [c[0], c[1]];
  };
  await scene.worldApi.terrain.load(0, 0, w - 1, (h - 1) * ROW_H);
  for (let pass = 0; pass < 4; pass++) {
    const o = scene.stream.origin.join(',');
    const p = await core0();
    lab.look(p[0], p[1], 12, 0.5);
    await settle();
    if (scene.stream.origin.join(',') === o) break;
  }
  await lab.shot('still-0-town');
  let f = 0;
  const film = async (n, step = 0.12) => {
    for (let k = 0; k < n; k++) {
      await lab.run(step, 1, { renderEvery: 1 });
      await lab.shot(`demo_${String(f++).padStart(3, '0')}`);
    }
  };
  const out = { rows: [] };
  btn('drop').click();
  await lab.run(0.1, 1);
  await film(args.dropFrames ?? 28);
  out.rows.push(eng.rows);
  await lab.shot('still-1-blocks');
  btn('boulder').click();
  await lab.run(0.1, 1);
  await film(args.boulderFrames ?? 40);
  out.rows.push(eng.rows);
  await lab.shot('still-2-boulder');
  await lab.run(4, 1);
  await lab.shot('still-3-rest');
  if (args.smash ?? true) {
    // (the sandbox's meteor beside the houses: what the judge frees are rows under ?solver=engine; the town is told
    // which records the edit cut — FieldTown.damaged)
    const t = core.camera.target;
    const town = lab.towns.live.get(lab.town);
    const pool0 = Array.from(await eng.readPool()).slice(0, 8);
    let err = null;
    try {
      R.meteorNow(t[0] + 6, t[1], t[2] + 1);
    } catch (e) {
      err = String(e?.message ?? e);
    }
    await film(args.smashFrames ?? 24, 0.15);
    await lab.run(3, 1);
    await lab.shot('still-4-meteor');
    out.smash = { err, hostRows: eng.rows, pool0, pool1: Array.from(await eng.readPool()).slice(0, 8), damaged: [...(town?.damaged ?? [])] };
  }
  return out;
}
