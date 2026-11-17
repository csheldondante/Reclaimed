// (loop round 18, LS-149) Why the messenger does not walk: one messenger on foot, and a plain worker sent to the same
// place, read every 0.5 s — where they stand, their group, the field it follows, the goal seeds.
//   node scripts/lab/round18probe.mjs [--params agentscope=0]
import { run } from '../lib/runner.mjs';

await run({ name: 'round18probe', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /\[messenger\]/.test(t)) R.log(t.slice(0, 300));
  });
  const extra = R.opt('params', '');
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0${extra ? '&' + extra : ''}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => window.rungame.pick('dunstan'));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(2000);
  await p.evaluate(() => (window.rungame.closePanel(), window.rungame.messenger?.skip()));
  await R.sleep(1500);
  const info = await p.evaluate(() => {
    const U = window.reclaimed.scene.units;
    const t = window.citygen.live.get(window.season.town);
    const c = t.centreInWindow();
    const to = [c[0], c[1]];
    // (a worker 10 cells off the centre, sent to it; and a named one the same)
    const w = U.spawn('worker', [c[0] + 10, c[1] + 4], null, { job: { kind: 'go', to } });
    const n = U.spawn('character', [c[0] - 10, c[1] - 4], null, { name: 'Probe', speed: 5, job: { kind: 'go', to } });
    U.observe(w);
    U.observe(n);
    window.__probe = { w, n, to };
    return { c, w, n };
  });
  R.log(`spawned: ${JSON.stringify(info)}`);
  for (let k = 0; k < 2; k++) {
    await R.sleep(500);
    R.log(
      await p.evaluate(() => {
        const U = window.reclaimed.scene.units;
        const A = U.agents;
        const one = (id) => {
          const r = U.recs.get(id);
          return { at: r?.v?.at?.map((v) => +v.toFixed(1)), st: r?.v?.state, g: r?.group, goal: r?.goal, gpu: r?.gpu, arr: r?.arrived, f: r ? A.groupField[r.group] : null };
        };
        const st = window.reclaimed.core.clock.stats;
        return JSON.stringify({ t: +(performance.now() / 1000).toFixed(2), ticks: st.ticks, frames: st.frames, dropped: +st.droppedS.toFixed(2), w: one(window.__probe.w), n: one(window.__probe.n), goals: U.goals.map((g) => g && g.at.map(Math.round)), seeds: A.seeds.map((s) => [s.field, Math.round(s.x), Math.round(s.y)]) });
      }),
    );
  }
  // (the messenger by each mount, timed: where it stands every 0.5 s, the sim's ticks)
  for (const how of R.opt('mounts', 'foot,horse,cart').split(',')) {
    await p.evaluate(() => window.rungame.showTown());
    await R.sleep(1500);
    await p.evaluate((how) => {
      const r = window.rungame;
      const t = window.citygen.live.get(window.season.town);
      const c = t.centreInWindow();
      void r.announce({ name: `Test ${how}`, role: 'test', lines: ['A test.'] }, how === 'horse' ? [c[0] + 200, c[1] + 40] : null, null, how);
    }, how);
    for (let k = 0; k < 14; k++) {
      await R.sleep(500);
      R.log(
        `${how} ` +
          (await p.evaluate(() => {
            const U = window.reclaimed.scene.units;
            const m = window.rungame.messenger;
            const rec = [...U.recs.values()].at(-1);
            const st = window.reclaimed.core.clock.stats;
            const out = { t: +(performance.now() / 1000).toFixed(2), ticks: st.ticks, s: m.state, at: m.walker?.at?.map((v) => +v.toFixed(1)), to: m.to?.map(Math.round), g: rec?.group, goal: rec?.goal, vs: rec?.v?.state, seen: rec?.seenState, box: U.agents.scope?.box };
            // (the goal field read where the messenger stands: its distance there, and how many columns it reaches)
            const at = m.walker?.at;
            if (at && rec && rec.group >= 2 && rec.group <= 4) {
              const f = rec.group + 7;
              const w = U.agents.world.w;
              const NK = 4;
              return U.agents.readField(f).then(({ dist }) => {
                let n = 0;
                for (const d of dist) if (d < 1e8) n++;
                const col = Math.round(at[0]);
                const row = Math.round(at[1] / (Math.sqrt(3) / 2));
                let here = 1e9;
                for (let k = 0; k < NK; k++) here = Math.min(here, dist[(row * w + col) * NK + k] ?? 1e9);
                return JSON.stringify({ ...out, field: f, reach: n, here: +here.toFixed(1), len: dist.length, w });
              });
            }
            return JSON.stringify(out);
          })),
      );
    }
    await p.evaluate(() => window.rungame.messenger.skip());
  }
});
