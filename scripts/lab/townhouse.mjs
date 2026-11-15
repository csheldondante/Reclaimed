// (physics10-atlas, PA11) A hard hit knocks a house down, at Muru: the demo's boulder rolled into the houses and its
// huge block dropped on one (`?physdemo=1`), filmed at phone size. The gate: at least one lot is knocked down; each
// lot down is flagged gone in its town, its footprint's middle column holds no External interval, the town no longer
// claims a building there (after its mesh run), and the engine's rows grew by its blocks. No page error.
//   RECLAIMED_PORT=5871 node scripts/lab.mjs run scripts/lab/townhouse.mjs --flags "&solver=engine&physdemo=1" --out <dir>
//   node scripts/lab/frames2gif.mjs <dir> house_ <out.gif> --delay 100 --scale 0.6
export default async function (lab, args) {
  const R = window.reclaimed;
  const scene = R.scene;
  const core = R.core;
  const eng = scene.engine?.engine;
  if (!eng) throw new Error('no engine: --flags "&solver=engine&physdemo=1"');
  const hf = window.housefall;
  if (!hf) throw new Error('no house fall installed (level/housefall.ts)');
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
  await lab.shot('house-0-town');
  let f = 0;
  const film = async (n, step = 0.12) => {
    for (let k = 0; k < n; k++) {
      await lab.run(step, 1, { renderEvery: 1 });
      await lab.shot(`house_${String(f++).padStart(3, '0')}`);
    }
  };
  const out = { rows: [eng.rows] };
  btn('boulder').click();
  await lab.run(0.1, 1);
  await film(args.boulderFrames ?? 50);
  out.rows.push(eng.rows);
  await lab.shot('house-1-boulder');
  await lab.run(3, 1);
  await lab.shot('house-2-boulder-rest');
  out.afterBoulder = hf.log.length;
  btn('slab').click();
  await lab.run(0.1, 1);
  await film(args.slabFrames ?? 46);
  out.rows.push(eng.rows);
  await lab.shot('house-3-block');
  await lab.run(4, 1);
  await lab.shot('house-4-rest');
  out.log = hf.log.map((e) => ({ ...e }));
  out.queued = hf.queued;
  if (!hf.log.length) throw new Error('no house was knocked down');
  // (the gate, a lot down: flagged, its spans gone, not claimed, its blocks rows)
  const origin0 = scene.stream.origin.join(',');
  out.checks = [];
  for (const e of hf.log) {
    const town = lab.towns.live.get(e.town);
    const col = (await R.phys.column(e.at[0], e.at[1])).map((v) => [+v.z0.toFixed(1), +v.z1.toFixed(1), v.mat]);
    const claimed = await town.lotAt(e.at[0], e.at[1]);
    const c = { lot: e.lot, flagged: town.gen.goneLots.has(e.lot), column: col, external: col.some((v) => v[2] === 39), claimedBy: claimed };
    out.checks.push(c);
    if (!c.flagged) throw new Error(`lot ${e.lot} fell and is not flagged gone`);
    if (c.external) throw new Error(`lot ${e.lot} fell and its middle column still holds External: ${JSON.stringify(col)}`);
    if (claimed === e.lot) throw new Error(`lot ${e.lot} fell and the town's claim grid still names it`);
  }
  if (scene.stream.origin.join(',') !== origin0) throw new Error('the window slid during the checks');
  const blocks = hf.log.reduce((s, e) => s + e.blocks, 0);
  if (eng.rows < out.rows[0] + 2 + blocks) throw new Error(`the engine has ${eng.rows} rows: fewer than the 2 dropped and the ${blocks} blocks`);
  return out;
}
