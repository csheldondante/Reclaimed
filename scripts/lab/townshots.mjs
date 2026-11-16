// (PQ3, PQ9) The sandbox's shots in the real town under the physics engine, at Muru: the engine's meteor at a roof and
// cannonballs at a house's wall, as the tools' taps make them (reclaimed.cannonAt / meteorRowAt at a screen point),
// filmed at phone size. Reports the rows, the hits that knocked lots down (window.housefall.log) and the ground's
// blows; fails only on a missing tool or engine: what the shots do is for the report.
//   node scripts/lab.mjs run scripts/lab/townshots.mjs --flags "&solver=engine&sandbox=1" --out <dir>
export default async function (lab, args) {
  const R = window.reclaimed;
  const scene = R.scene;
  const core = R.core;
  const eng = scene.engine?.engine;
  if (!eng) throw new Error('no engine: --flags "&solver=engine&sandbox=1"');
  const tools = [...document.querySelectorAll('.editor [data-t]')];
  const editor = document.querySelector('.editor');
  const out = { editorShown: !!editor && getComputedStyle(editor).display !== 'none', tools: tools.map((t) => t.dataset.t).filter((t) => ['cannon', 'meteor', 'drop', 'smash', 'drag'].includes(t)) };
  if (!out.editorShown) throw new Error('the sandbox tools are hidden: --flags "&sandbox=1"');
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
  const surface = async () => {
    const S = new Uint32Array((await core.readBuffer('surface')).buffer);
    const zAt = (x, y) => (S[y * w + x] & 0x1ffff) / 256;
    const ext = (x, y) => ((S[y * w + x] >>> 17) & 0xff) === 39;
    const house = (x, y) => {
      if (x < 4 || y < 4 || x >= w - 4 || y >= h - 4 || !ext(x, y)) return false;
      let lo = Infinity;
      for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) if (!ext(x + a, y + b)) lo = Math.min(lo, zAt(x + a, y + b));
      return zAt(x, y) - lo >= 2.5 && zAt(x, y) - lo < 40;
    };
    return { zAt, house };
  };
  // (the view on the built core: the middle of the town's tall External columns)
  const core0 = async () => {
    const { house } = await surface();
    const c = (await lab.places(lab.town)).named.market.at;
    const cy = Math.round(c[1] / ROW_H - 0.5);
    const cx = Math.round(c[0] - 0.5);
    let sx = 0, sy = 0, n = 0;
    for (let j = -70; j <= 70; j++) for (let i = -70; i <= 70; i++) if (house(cx + i, cy + j)) { sx += cx + i; sy += cy + j; n++; }
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
  // (two houses near the middle of the view: a 5 x 5 of house columns each, apart)
  const { zAt, house } = await surface();
  const cam = core.camera;
  const [cx, cy] = [Math.round(cam.target[0] - 0.5), Math.round(cam.target[1] / ROW_H - 0.5)];
  const roofs = [];
  for (let r = 0; r < 40 && roofs.length < 2; r++)
    for (let j = -r; j <= r; j++)
      for (let i = -r; i <= r; i++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r || roofs.length >= 2) continue;
        const x = cx + i, y = cy + j;
        let all = true;
        for (let b = -2; b <= 2 && all; b++) for (let a = -2; a <= 2 && all; a++) all = house(x + a, y + b);
        if (all && roofs.every((q) => Math.hypot(q[0] - x, q[1] - y) > 12)) roofs.push([x, y, zAt(x, y)]);
      }
  if (!roofs.length) throw new Error('no house near the middle of the view');
  const screen = (x, y, z) => cam.project(x + 0.5 + 0.5 * (y & 1), (y + 0.5) * ROW_H, z);
  const hf = window.housefall;
  await lab.shot('fb-town-0');
  let f = 0;
  const film = async (n, tag, step = 0.1) => {
    for (let k = 0; k < n; k++) {
      await lab.run(step, 1, { renderEvery: 1 });
      await lab.shot(`${tag}_${String(f++).padStart(3, '0')}`);
    }
  };
  const stats = () => ({ rows: eng.rows, awake: eng.awakeSeen, felled: hf.log.length, blows: scene.integrity.stats.blows, freedRows: scene.integrity.stats.rows });
  out.before = stats();
  // the meteor at the first roof
  const m = screen(...roofs[0]);
  R.meteorRowAt(m[0], m[1]);
  await film(args.meteorFrames ?? 34, 'fb-meteor');
  await lab.run(2.5, 1);
  await lab.shot('fb-meteor-rest');
  out.afterMeteor = stats();
  // three cannonballs at the other house's wall (or the same house's, if only one was found), a second apart
  const t = roofs[1] ?? roofs[0];
  for (let k = 0; k < 3; k++) {
    const c = screen(t[0], t[1], t[2] - 1.5);
    R.cannonAt(c[0], c[1]);
    await film(args.cannonFrames ?? 16, 'fb-cannon');
  }
  await lab.run(2.5, 1);
  await lab.shot('fb-cannon-rest');
  out.afterCannon = stats();
  out.log = hf.log.map((e) => ({ lot: e.lot, energy: e.energy, blocks: e.blocks, cells: e.cells }));
  out.roofs = roofs;
  return out;
}
