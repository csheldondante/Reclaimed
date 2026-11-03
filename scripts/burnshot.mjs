// Round 128 (treegen): a fire through a wood the way a player sets one — lightning called down by the player's power
// (Powers.scriptStrike: the tap under a storm, its strike seeking the high ground in the bowl) — then the wood from above
// and from afar, the burned trees standing. Logs the fire field round each strike over time (core.probe('fire')) and the
// snag field after, so "nothing burned" is told apart from "burned but not drawn".
//   node scripts/burnshot.mjs [--at 13728,5216] [--out C:/Projects/shots88/treegen] [--burn 60000] [--strikes 4]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'burnshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/treegen');
  const p = await R.level({ level: 'atlas', at: R.opt('at', '13728,5216'), fseason: '0.3' });
  await sleep(25000);
  await p.evaluate(() => (window.reclaimed.camera.zoom = 5));
  await sleep(3000);
  await p.screenshot({ path: `${out}/burn-before-z5.png` });
  // the strikes: window columns round the view's middle, called down as the player's power does
  const strikes = await p.evaluate((n) => {
    const r = window.reclaimed;
    const ROW_H = Math.sqrt(3) / 2;
    const [x, y] = r.camera.target;
    const cells = [];
    for (let k = 0; k < n; k++) {
      const wx = x + (k % 2) * 12 - 6;
      const wy = y + Math.floor(k / 2) * 10 - 5;
      const ty = Math.round(wy / ROW_H - 0.5);
      const tx = Math.round(wx - 0.5 - 0.5 * (ty & 1));
      cells.push([tx, ty]);
    }
    if (!r.powers?.scriptStrike) return { error: 'no powers.scriptStrike in this scene', keys: Object.keys(r) };
    cells.forEach(([tx, ty], i) => setTimeout(() => r.powers.scriptStrike(tx, ty, 0), i * 400));
    return { cells };
  }, Number(R.opt('strikes', '4')));
  R.log(`strikes ${JSON.stringify(strikes)}`);
  if (strikes.error) throw new Error(strikes.error);
  const burn = Number(R.opt('burn', '60000'));
  const probe = async () =>
    p.evaluate(async (cells) => {
      const r = window.reclaimed;
      const out = [];
      for (const [x, y] of cells) out.push([+(await r.probe('fire', x, y, 6)).toFixed(3), +(await r.probe('veg', x, y, 6)).toFixed(2), +(await r.probe('moisture', x, y, 6)).toFixed(2)]);
      return out;
    }, strikes.cells);
  for (let t = 0; t < burn; t += 10000) {
    await sleep(10000);
    R.log(`t+${(t + 10000) / 1000}s fire/veg/moisture round each strike ${JSON.stringify(await probe())}`);
    if (t === 20000) await p.screenshot({ path: `${out}/burn-during-z5.png` });
  }
  await R.fatal(p);
  const snags = await p.evaluate(async () => {
    const r = window.reclaimed;
    try {
      const s = await r.readBuffer('snag');
      let n = 0;
      for (let i = 0; i < s.length; i += 4) if (s[i] > 0) n++;
      return n;
    } catch (e) {
      return String(e);
    }
  });
  R.log(`snag texels > 0: ${snags}`);
  for (const z of [5, 3, 2]) {
    await p.evaluate((z) => (window.reclaimed.camera.zoom = z), z);
    await sleep(3000);
    await p.screenshot({ path: `${out}/burn-after-z${z}.png` });
    R.log(`saved burn-after-z${z}.png`);
  }
});
