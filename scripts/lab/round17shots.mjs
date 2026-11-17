// (loop round 17) The loop at phone size: colours by layer (the town framing and the close zoom, same views as round 16's
// stills), the messenger on foot, on a horse, by cart, by ship, the story camera's cutaway on the speaker, and a
// building going up (the construction clip) during the time-lapse after a building card is agreed.
//   node scripts/lab/round17shots.mjs [--out local/round17] [--leader dunstan]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'round17shots', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'local/round17');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /\[messenger\]|\[quiet\]|\[loop\] a quiet/.test(t)) R.log(t.slice(0, 300));
  });
  const shot = async (name) => {
    await p.screenshot({ path: path.join(out, `${name}.png`) });
    R.log(`shot ${name}`);
  };
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate((who) => window.rungame.pick(who), R.opt('leader', 'dunstan'));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(4000);
  await shot('foot');
  await p.evaluate(() => (window.rungame.closePanel(), window.rungame.messenger?.skip()));
  await R.sleep(6000);
  await shot('after-town');
  // (the camera's zoom and the screen's pixels a cell: a figure's height in pixels at this framing)
  const px = await p.evaluate(() => {
    const cam = window.reclaimed.camera;
    const a = cam.worldToScreen ? cam.worldToScreen([0, 0, 0]) : null;
    const b = cam.worldToScreen ? cam.worldToScreen([0, 0, 1]) : null;
    return { zoom: cam.zoom, cellUp: a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : null, w: innerWidth };
  });
  R.log(`town framing: ${JSON.stringify(px)}`);
  const close = await p.evaluate(() => {
    const t = window.citygen.live.get(window.season.town);
    const c = t.centreInWindow();
    window.rungame.cam.follow(null);
    window.rungame.cam.look([c[0], c[1], window.reclaimed.scene.heightAt(c[0], c[1]) ?? 0], { zoom: 7, ease: 0.3, place: [0.5, 0.48] });
    return c;
  });
  await R.sleep(3000);
  await shot('after-close-1');
  R.log(`close zoom 7: ${JSON.stringify(await p.evaluate(() => window.reclaimed.camera.zoom))} at ${close}`);
  // (the mounts: a rider from a far place, a cart, a ship to the quay)
  const g = 'window.rungame';
  for (const [how, far] of [['horse', true], ['cart', false], ['ship', false]]) {
    await p.evaluate(() => window.rungame.showTown());
    await R.sleep(1500);
    await p.evaluate(
      ([how, far]) => {
        const r = window.rungame;
        const t = window.citygen.live.get(window.season.town);
        const c = t.centreInWindow();
        void r.announce({ name: `Test ${how}`, role: how === 'horse' ? 'rider' : how === 'cart' ? 'merchant' : 'ship master', lines: ['A test.'] }, far ? [c[0] + 200, c[1] + 40] : null, null, how);
      },
      [how, far],
    );
    await R.sleep(1800);
    await shot(`mount-${how}-1`);
    R.log(`${how} at 1.8 s: ${await p.evaluate(() => {
      const U = window.reclaimed.scene.units;
      const rec = [...(U.recs?.values?.() ?? [])].at(-1);
      return JSON.stringify({ at: window.rungame.messenger.walker?.at?.map(Math.round), goals: (U.goals ?? []).map((g) => (g ? g.at.map(Math.round) : 0)), group: rec?.group, state: rec?.v?.state, gpu: rec?.gpu, live: U.get?.(rec?.v?.id)?.at?.map(Math.round) });
    })}`);
    await R.sleep(1800);
    await shot(`mount-${how}-2`);
    R.log(`${how}: ${await p.evaluate(() => JSON.stringify({ s: window.rungame.messenger.state, w: window.rungame.messenger.walker }))}`);
    await p.evaluate(() => window.rungame.messenger.skip());
  }
  void g;
  // (why the messenger stands: its unit's group, the goals held)
  R.log(`units: ${await p.evaluate(() => {
    const U = window.reclaimed.scene.units;
    return JSON.stringify({ goals: (U.goals ?? []).map((g) => (g ? 1 : 0)).join(''), recs: U.recs?.size });
  })}`);
  // (Next season: the time-lapse — the town's clock runs; a homes district claimed now and watched close as it rises)
  await p.evaluate(() => window.rungame.showTown());
  await R.sleep(1500);
  await p.evaluate(() => window.rungame.next());
  await R.sleep(300);
  const d = await p.evaluate(async () => {
    const t = window.citygen.live.get(window.season.town);
    const c = await t.claimDistrict(0, t.clock);
    if (c.id < 0) return { id: c.id };
    const w = t.inWindow(c.at);
    window.__look = () => {
      const cam = window.reclaimed.camera;
      window.rungame.cam.follow(() => [w[0], w[1], window.reclaimed.scene.heightAt(w[0], w[1]) ?? 0]);
      cam.target[0] = w[0];
      cam.target[1] = w[1];
      cam.target[2] = window.reclaimed.scene.heightAt(w[0], w[1]) ?? cam.target[2];
      cam.zoom = 6;
      return [t.clock, t.animUntil];
    };
    return { id: c.id, w, clock: t.clock };
  });
  R.log(`district: ${JSON.stringify(d)}`);
  for (let k = 1; k <= 10; k++) {
    R.log(`clock ${JSON.stringify(await p.evaluate(() => window.__look?.()))}`);
    await R.sleep(1000);
    await shot(`build-${k}`);
  }
  await p.waitForFunction(() => window.rungame.phase !== 'season', { timeout: 120000, polling: 200 });
  await R.sleep(1500);
  await shot('news-1');
  await R.sleep(2000);
  await shot('news-2');
  R.log(`after the season: messenger ${await p.evaluate(() => window.rungame.messenger?.state)}`);
});
