// (loop round 18) The stills round 17 could not take, at phone size (412x915, q=low, ?rise=1 the construction clip):
// the town with the new palette at the loop's framing; a petition with its "With your …" lines; the messenger walking
// in on foot, on a horse and by cart (4 frames each, the camera following); the cutaway over a site; a district rising.
//   node scripts/lab/round18shots.mjs [--out local/round18] [--leader dunstan]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'round18shots', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'local/round18');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /\[messenger\]/.test(t)) R.log(t.slice(0, 300));
  });
  const shot = async (name) => {
    await p.screenshot({ path: path.join(out, `${name}.png`) });
    R.log(`shot ${name}`);
  };
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0&rise=1`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate((who) => window.rungame.pick(who), R.opt('leader', 'dunstan'));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(3000);
  await p.evaluate(() => (window.rungame.closePanel(), window.rungame.messenger?.skip()));
  const parts = R.opt('parts', 'town,cutaway,rise,petition,mounts').split(',');
  // (a) the town at the loop's framing
  await p.evaluate(() => window.rungame.showTown());
  await R.sleep(4000);
  if (parts.includes('town')) await shot('town');
  // (b) the cutaway: the camera held on the keep's spot at the messenger's zoom — what stands in front dithered
  if (parts.includes('cutaway')) {
    R.log(`cutaway at ${await p.evaluate(() => {
      // (the town's middle, the square, where the streets meet among the houses — read again each frame: the window
      // slides under a held point)
      const r = window.rungame;
      const t = window.citygen.live.get(window.season.town);
      const at = () => {
        const c = t.centreInWindow();
        return [c[0], c[1], r.z(c[0], c[1])];
      };
      void r.cam.look(at(), { zoom: 11, ease: 0.5, place: [0.5, 0.42] }).then(() => r.cam.follow(at));
      return JSON.stringify({ at: at(), keep: r.siteAt('keep') });
    })}`);
    await R.sleep(3000);
    await shot('cutaway');
    await p.evaluate(() => (window.rungame.cam.follow(null), window.rungame.showTown()));
    await R.sleep(2000);
  }
  // (c) a district rising (the construction clip, ?rise=1): claimed now, the camera held on it
  if (parts.includes('rise')) {
    const d = await p.evaluate(async () => {
      const r = window.rungame;
      const t = window.citygen.live.get(window.season.town);
      const c = await t.claimDistrict(0, t.clock);
      if (c.id < 0) return { id: c.id };
      // (read again each frame: the window slides under a held point — round 18's first try drifted into the woods)
      const at = () => {
        const w = t.inWindow(c.at);
        return [w[0], w[1], r.z(w[0], w[1])];
      };
      void r.cam.look(at(), { zoom: 6, ease: 0.3, place: [0.5, 0.5] }).then(() => r.cam.follow(at));
      return { id: c.id, w: at(), centre: t.centreInWindow(), clock: t.clock };
    });
    R.log(`district: ${JSON.stringify(d)}`);
    for (const [k, ms] of [[1, 1200], [2, 2500], [3, 3000], [4, 4000]]) {
      await R.sleep(ms);
      await shot(`rise-${k}`);
      R.log(`rise ${k}: clock ${await p.evaluate(() => window.citygen.live.get(window.season.town).clock)}`);
    }
    await p.evaluate(() => (window.rungame.cam.follow(null), window.rungame.showTown()));
  }
  // (the petitions: the first whose panel shows a "With your" line; the combos each offer has, logged)
  const petitions = async (tag) => {
    const offers = await p.evaluate(() => window.rungame.realm.offers().filter((o) => o.status === 'offered').map((o) => ({ id: o.id, t: o.template, combos: window.rungame.combos(o.template) })));
    R.log(`offers ${tag}: ${JSON.stringify(offers)}`);
    for (const o of offers) {
      if (!o.combos.some((l) => /With your/.test(l))) continue;
      await p.evaluate((id) => window.rungame.open(id), o.id);
      await R.sleep(2500);
      const txt = await p.evaluate(() => document.body.innerText);
      R.log(`on screen at ${o.id}: ${txt.split('\n').filter((l) => /With your|Sets off/.test(l)).join(' | ') || 'none'}`);
      await shot(`petition-combo-${tag}`);
      await p.evaluate(() => window.rungame.talk.close());
      await R.sleep(800);
      return true;
    }
    return false;
  };
  if (parts.includes('petition') && !(await petitions('s1'))) {
    // (none yet: the quarry agreed, a season played, the asks looked at again)
    const q = await p.evaluate(() => window.rungame.realm.offers().find((o) => o.status === 'offered' && o.template.startsWith('build:'))?.id ?? null);
    R.log(`agreeing ${q}`);
    if (q) {
      await p.evaluate((id) => window.rungame.open(id), q);
      await R.sleep(2000);
      await p.evaluate(() => [...document.querySelectorAll('button, li, div')].find((b) => /^\s*1?\s*Agree\.?\s*$/.test(b.textContent ?? ''))?.click());
      await R.sleep(1500);
      await p.evaluate(() => window.rungame.talk.isOpen && window.rungame.talk.close());
      await p.evaluate(() => window.rungame.next());
      await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 180000, polling: 300 });
      await R.sleep(3000);
      await p.evaluate(() => (window.rungame.closePanel(), window.rungame.messenger?.skip()));
      if (!(await petitions('s2'))) R.log('no petition with a "With your" line in season 2 either');
    }
  }
  // (the messenger by each mount: 4 frames as they walk in, the camera following)
  for (const how of parts.includes('mounts') ? ['foot', 'horse', 'cart'] : []) {
    await p.evaluate(() => window.rungame.showTown());
    await R.sleep(2500);
    await p.evaluate((how) => {
      const r = window.rungame;
      const t = window.citygen.live.get(window.season.town);
      const c = t.centreInWindow();
      void r.announce({ name: `Test ${how}`, role: how === 'horse' ? 'rider' : how === 'cart' ? 'merchant' : 'steward', lines: ['A test.'] }, how === 'horse' ? [c[0] + 200, c[1] + 40] : null, null, how);
    }, how);
    for (let k = 1; k <= 4; k++) {
      await R.sleep(1600);
      await shot(`${how}-${k}`);
      R.log(`${how} ${k}: ${await p.evaluate(() => {
        const m = window.rungame.messenger;
        const st = window.reclaimed.core.clock.stats;
        return JSON.stringify({ s: m.state, at: m.walker?.at?.map((v) => +v.toFixed(1)), to: m.to?.map((v) => +v.toFixed(1)), ticks: st.ticks });
      })}`);
    }
    await p.evaluate(() => window.rungame.messenger.skip());
  }
});
