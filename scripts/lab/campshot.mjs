// (loop-skeleton round 7, BACKLOG LS-67) The refugees' camp on the ground: the realm's 'camp' sign cast as its `camp`
// helper casts it (by the watch post), a still of its tents at play zoom, then the page loaded again (the saved world
// kept) and the same still — the tents must stand after the reload.
//   node scripts/lab/campshot.mjs [--out dir]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'campshot', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const out = R.opt('out', 'campshot');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  const url = (fresh) => `${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&q=low&warmcache=0${fresh ? '&fresh=1' : ''}`;
  const boot = async (fresh) => {
    await p.goto(url(fresh), { waitUntil: 'load' });
    await p.waitForFunction(() => ['leader', 'city'].includes(window.rungame?.phase) || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(p);
  };
  // (the camp's cell in the window, the camera on it at the town's play zoom)
  const look = () =>
    p.evaluate(async () => {
      const s = window.mutators.signs().find((x) => x.kind === 'camp');
      if (!s?.at) return null;
      const S = window.reclaimed.scene.stream;
      const x = s.at[0] - S.origin[0];
      const y = (s.at[1] - S.origin[1]) * 0.8660254037844386;
      // (the ground's height there read first: a camera aimed at height 0 under ground 100 high looks elsewhere)
      const t = window.reclaimed.scene.worldApi.terrain;
      await t.load(x - 2, y - 2, x + 2, y + 2);
      window.rungame.cam.look([x, y, t.surfaceAt(x, y)?.z ?? window.reclaimed.scene.heightAt(x, y) ?? 0], { zoom: 9, ease: 0.3, place: [0.5, 0.45] });
      return { at: s.at, window: [Math.round(x), Math.round(y)] };
    });
  await boot(true);
  await p.evaluate(() => window.rungame.pick('ysolt'));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(3000);
  // (--site: the site the camp is cast by; default the realm's own choice for a camp)
  const cast = await p.evaluate((site) => {
    const r = window.rungame.realm;
    window.mutators.sign({ kind: 'camp', place: r.home, at: site ? r.campCell(site) : r.campCell(), cause: 'campshot' });
    return window.mutators.signs().map((s) => `${s.kind} ${s.at ?? ''}`);
  }, R.opt('site', ''));
  R.log(`signs: ${JSON.stringify(cast)}`);
  const where = await look();
  R.log(`camp: ${JSON.stringify(where)}`);
  await R.sleep(5000);
  // (what the ground's top is round the camp's middle: canvas and dirt road where the tents went)
  R.log(`tops: ${JSON.stringify(
    await p.evaluate(async (w) => {
      const t = window.reclaimed.scene.worldApi.terrain;
      await t.load(w[0] - 14, w[1] - 14, w[0] + 14, w[1] + 14);
      // (the layers' pages are asked for by a first query and read a frame later)
      for (let dx = -12; dx <= 12; dx += 3) for (let dy = -12; dy <= 12; dy += 3) t.layersAt(w[0] + dx, w[1] + dy);
      await new Promise((r) => setTimeout(r, 800));
      const out = {};
      for (let dx = -12; dx <= 12; dx += 3)
        for (let dy = -12; dy <= 12; dy += 3) {
          const l = t.layersAt?.(w[0] + dx, w[1] + dy);
          const k = l?.length ? l[l.length - 1].mat ?? l[l.length - 1].material : 'none';
          out[k] = (out[k] ?? 0) + 1;
        }
      return out;
    }, where.window),
  )}`);
  const onScreen = () =>
    p.evaluate(() => {
      const s = window.mutators.signs().find((x) => x.kind === 'camp');
      const S = window.reclaimed.scene.stream;
      const x = s.at[0] - S.origin[0];
      const y = (s.at[1] - S.origin[1]) * 0.8660254037844386;
      const c = window.reclaimed.camera;
      return { window: [Math.round(x), Math.round(y)], screen: c.project(x, y, window.reclaimed.scene.heightAt(x, y) ?? 0).map((v) => Math.round(v)), target: [...c.target].map((v) => Math.round(v)), zoom: +c.zoom.toFixed(1) };
    });
  R.log(`on the screen: ${JSON.stringify(await onScreen())}`);
  await p.screenshot({ path: path.join(out, 'camp-1-cast.png') });
  // (the save: the mutators' list is written when it changes; a moment for it to land)
  await R.sleep(3000);
  await boot(false);
  await R.sleep(4000);
  const after = await p.evaluate(() => window.mutators.signs().map((s) => `${s.kind} ${s.at ?? ''}`));
  R.check('the camp sign is there after the reload', after.some((s) => s.startsWith('camp ')), after);
  R.log(`camp after reload: ${JSON.stringify(await look())}`);
  await R.sleep(5000);
  R.log(`on the screen after reload: ${JSON.stringify(await onScreen())}`);
  await p.screenshot({ path: path.join(out, 'camp-2-reload.png') });
});
