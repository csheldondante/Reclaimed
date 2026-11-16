// (loop-skeleton round 7) One live event played straight away in the loop's town, with stills at phone size: the
// quick look at how an event reads, without a whole walk. Picks a leader, waits for the town, plays the event with
// `rungame.measureEvent` (no card; never resolved), and takes a still every `--every` seconds, logging how it stands.
//   node scripts/lab/liveshot.mjs --event gate-parade [--out dir] [--shots 8] [--every 6] [--pre "js"] [--params "&tod=0.8"]
// `--pre`: a script run in the page before the event (e.g. a card's building granted).
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'liveshot', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const tpl = R.opt('event', 'gate-parade');
  const out = R.opt('out', 'liveshot');
  const shots = Number(R.opt('shots', '8'));
  const every = Number(R.opt('every', '6'));
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(live|loop|forces)\]/.test(t)) R.log(t.slice(0, 300));
  });
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0${R.opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => window.rungame.pick('ysolt'));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(4000);
  if (R.opt('pre', '')) R.log(`pre: ${JSON.stringify(await p.evaluate(R.opt('pre', '')))}`);
  const ok = await p.evaluate((t) => window.rungame.measureEvent(t), tpl);
  R.check(`${tpl} begun`, ok);
  const view = () =>
    p.evaluate(() => {
      const c = window.reclaimed.camera;
      const d = window.rungame.liveDebug();
      const r = d.runs[0];
      return { phase: window.rungame.phase, zoom: +c.zoom.toFixed(1), tod: +window.reclaimed.core.dayNight.timeOfDay.toFixed(3), speed: window.reclaimed.scene.speed, line: window.rungame.fightLine, t: r?.t, step: r?.entry?.step, numbers: r?.numbers, arrived: r && Object.fromEntries(Object.entries(r.state.groups).map(([k, g]) => [k, `${g.alive}/${g.made}${g.arrived ? ' arrived' : ''}`])), figures: window.rungame.deadAt().length, marks: window.rungame.markers().map((m) => m.label || m.kind).slice(0, 6) };
    });
  // (--mail: each order group's words as the GPU has them — kind, status, anchor state and point, the place, lag, alive,
  // arrived serial: why a group does or does not arrive, BACKLOG LS-72)
  const mail = () =>
    p.evaluate(async () => {
      const units = window.reclaimed.scene.units;
      const L = units.agents.mailLayout;
      const buf = await units.agents.readRaw('mail');
      const u32 = new Uint32Array(buf);
      const f = new Float32Array(buf);
      return units.groups.flatMap((g, s) => {
        if (!g) return [];
        const o = L.groups + s * L.groupW;
        const r = (v) => +v.toFixed(1);
        return [`slot ${s} id ${g.id} n ${g.members?.size ?? g.members?.length ?? '?'}: kind ${u32[o]} form ${u32[o + 3] & 0xff} serial ${u32[o + 7]} status ${u32[o + 11]} place ${[f[o + 8], f[o + 9], f[o + 10]].map(r)} alive ${u32[o + 18]} told ${u32[o + 14]} anchor st ${u32[o + L.formAt + 8]} at ${[f[o + L.formAt + 5], f[o + L.formAt + 6], f[o + L.formAt + 7]].map(r)} s ${r(f[o + L.formAt + 4])} lag ${r(f[o + L.formAt + 10])}`];
      });
    });
  for (let k = 0; k < shots; k++) {
    await R.sleep(every * 1000);
    await R.fatal(p);
    const v = await view();
    R.log(`${k}: ${JSON.stringify(v)}`);
    if (R.flag('mail')) for (const l of await mail()) R.log(`  ${l}`);
    await p.screenshot({ path: path.join(out, `${tpl}-${k}.png`) });
    if (v.phase !== 'event') {
      R.log('the event is over');
      break;
    }
  }
});
