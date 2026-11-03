// Round 128 (treegen): a fire through a wood the way a player sets one — lightning called down by the player's power
// (Powers.scriptStrike: the tap under a storm, its strike seeking the high ground in the bowl) round the forest
// station's stand — then the wood from above, from afar (the far trees as sprites, ?flod=sprite) and from under the
// canopy (the understory held). Logs the fire field round each strike over time (core.probe('fire')), the chunks awake
// and held by the fire (the desktop proxy for a big burn's sleep cost), and the snags standing after (the snag
// texture read back), so "nothing burned" is told apart from "burned but not drawn".
//   node scripts/burnshot.mjs [--out C:/Projects/shots88/treegen] [--burn 90000] [--strikes 6]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'burnshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/treegen');
  // (--lab 0: the plain atlas, the free camera — the views from above and afar; the default, the forest station with the
  // hero, its camera the understory's — the view from under the canopy)
  const lab = R.opt('lab', '1') === '1';
  const p = await R.level({ level: 'atlas', at: R.opt('at', '13728,5216'), fseason: '0.3', flod: 'sprite', ...(lab ? { play: 'lich', forest: 'lab', fride: '0' } : {}) });
  // (main: the sandbox's tool panel hidden in every in-world shot)
  await p.addStyleTag({ content: '.editor{display:none!important}' });
  if (lab) await p.waitForFunction(() => window.reclaimed?.forest?.stand, { timeout: 120000, polling: 500 });
  await sleep(20000);
  // the hero parked in front of the stand, the ride off (as the foliage bench does)
  const at = await p.evaluate((lab) => {
    const r = window.reclaimed;
    if (!lab) {
      r.camera.zoom = 5;
      return r.camera.target.slice(0, 2);
    }
    r.forest.ride = false;
    const park = r.forest.stand.park ?? r.forest.stand.at;
    r.play.session.hero.place(park);
    r.camera.zoom = 5;
    return r.forest.stand.at;
  }, lab);
  await sleep(4000);
  const pre = lab ? 'lab-' : '';
  await p.screenshot({ path: `${out}/burn-${pre}before-z5.png` });
  const strikes = await p.evaluate(
    ({ n, at }) => {
      const r = window.reclaimed;
      const ROW_H = Math.sqrt(3) / 2;
      const cells = [];
      for (let k = 0; k < n; k++) {
        const wx = at[0] + (k % 3) * 10 - 10;
        const wy = at[1] + Math.floor(k / 3) * 10 - 5;
        const ty = Math.round(wy / ROW_H - 0.5);
        const tx = Math.round(wx - 0.5 - 0.5 * (ty & 1));
        cells.push([tx, ty]);
      }
      if (!r.powers?.scriptStrike) return { error: 'no powers.scriptStrike in this scene', keys: Object.keys(r) };
      cells.forEach(([tx, ty], i) => setTimeout(() => r.powers.scriptStrike(tx, ty, 0), i * 400));
      return { cells };
    },
    { n: Number(R.opt('strikes', '6')), at },
  );
  R.log(`strikes ${JSON.stringify(strikes)}`);
  if (strikes.error) throw new Error(strikes.error);
  const burn = Number(R.opt('burn', '90000'));
  const probe = async () =>
    p.evaluate(async (cells) => {
      const r = window.reclaimed;
      const f = [];
      for (const [x, y] of cells) f.push(+(await r.probe('fire', x, y, 6)).toFixed(3));
      return { fire: f, sleep: r.sleepStats?.() };
    }, strikes.cells);
  let maxAwake = 0;
  let maxBurning = 0;
  for (let t = 0; t < burn; t += 10000) {
    await sleep(10000);
    const s = await probe();
    maxAwake = Math.max(maxAwake, s.sleep?.awake ?? 0);
    maxBurning = Math.max(maxBurning, s.sleep?.burning ?? 0);
    R.log(`t+${(t + 10000) / 1000}s fire round each strike ${JSON.stringify(s.fire)} chunks ${JSON.stringify(s.sleep)}`);
    if (t === 30000) await p.screenshot({ path: `${out}/burn-${pre}during-z5.png` });
  }
  await R.fatal(p);
  const snags = await p.evaluate(async () => {
    const r = window.reclaimed;
    const t = await r.core.readTexture(r.core.world.snag);
    let n = 0;
    for (let i = 0; i < t.w * t.h; i++) if (t.data[i * 4] > 0) n++;
    return { columns: n, of: t.w * t.h };
  });
  R.log(`snag columns: ${JSON.stringify(snags)}; the most chunks awake ${maxAwake}, held by fire ${maxBurning}`);
  // (the camera on the burn's middle: the strikes' cells, cellPos)
  if (!lab)
    await p.evaluate((cells) => {
      const r = window.reclaimed;
      const ROW_H = Math.sqrt(3) / 2;
      const [x, y] = cells[Math.floor(cells.length / 2)];
      r.camera.target = [x + 0.5 + 0.5 * (y & 1), (y + 0.5) * ROW_H, r.camera.target[2]];
    }, strikes.cells);
  // from above, from afar (the sprites), and under the canopy (the understory held round the hero)
  for (const z of [5, 2]) {
    await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
    await sleep(3000);
    await p.screenshot({ path: `${out}/burn-${pre}after-z${z}.png` });
    R.log(`saved burn-after-z${z}.png`);
  }
  if (lab) {
    await p.evaluate(() => {
      const r = window.reclaimed;
      r.camera.zoom = 12;
      r.forest.d.driver.force = 1;
    });
    await sleep(4000);
    await p.screenshot({ path: `${out}/burn-lab-after-under.png` });
    R.log('saved burn-after-under.png');
  }
});
