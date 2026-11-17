// phone-idle (2026-11-15): the frame census (src/perf/census.ts, ?census=1) run headless on the level the user opens —
// ?skipmenu=1&level=atlas&town=1&fresh=1 at 412x915 — in four states: just loaded and settling, idle with the camera
// still, panning, and during a "Next season" time-lapse. Prints, per state, each system's per-frame counts and the
// phone's estimated ms by the measured cost model (census.ts PHONE_MODEL), and writes the reports as JSON.
// Counts, not timings: a behaviour check (it may share the GPU).
//   node scripts/census.mjs [--noq] [--states settle,idle,pan,season] [--idle 20] [--out perf-reports/census.json] [--top 16] [--labels]
//   --noq     the link without q=low (the user's first link)
//   --labels  each system's labels (passes, buffers) under it
//   --pick <leader>  (with --params loop=1) pick the main loop's leader before measuring
import fs from 'node:fs';
import path from 'node:path';
import { run, ROOT } from './lib/runner.mjs';

const COLS = [
  ['ind', 'indirect'],
  ['dir', 'direct'],
  ['cpass', 'computePasses'],
  ['rpass', 'renderPasses'],
  ['draw', 'draws'],
  ['drawI', 'drawsIndirect'],
  ['reads', 'reads'],
  ['readKB', 'readBytes', 1024],
  ['upl', 'uploads'],
  ['uplKB', 'uploadBytes', 1024],
  ['copy', 'copies'],
  ['copyKB', 'copyBytes', 1024],
  ['clr', 'clears'],
  ['bg', 'bindGroups'],
  ['buf', 'buffers'],
];
const fmt = (v) => (v === 0 ? '.' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
function table(name, r, top, labels) {
  const lines = [];
  lines.push(`== ${name}: ${r.frames} frames in ${r.seconds} s (${(r.frames / Math.max(0.001, r.seconds)).toFixed(0)} fps here), ${r.ticksPerFrame} ticks a frame; est. phone ${r.total.phoneMs} ms a frame`);
  const head = `${'system'.padEnd(26)} ${'phoneMs'.padStart(7)} ${COLS.map(([k]) => k.padStart(6)).join(' ')}`;
  lines.push(head);
  const row = (n, c) => `${n.slice(0, 26).padEnd(26)} ${fmt(c.phoneMs).padStart(7)} ${COLS.map(([, f, div]) => fmt((c[f] ?? 0) / (div ?? 1)).padStart(6)).join(' ')}`;
  lines.push(row('TOTAL', r.total));
  for (const s of r.systems.slice(0, top)) {
    lines.push(row(s.system, s));
    if (labels) for (const l of s.labels.slice(0, 8)) lines.push(row(`   ${l.label}`, l));
  }
  if (r.systems.length > top) lines.push(`(+ ${r.systems.length - top} more systems, est. ${r.systems.slice(top).reduce((a, s) => a + s.phoneMs, 0).toFixed(2)} ms)`);
  return lines.join('\n');
}

await run({ name: 'census', kind: 'behaviour' }, async (R) => {
  const states = R.opt('states', 'settle,idle,pan,season').split(',');
  const idleS = Number(R.opt('idle', 20));
  const top = Number(R.opt('top', 16));
  const labels = R.flag('labels');
  const out = path.resolve(ROOT, R.opt('out', `perf-reports/census${R.flag('noq') ? '-noq' : ''}.json`));
  const extra = Object.fromEntries(new URLSearchParams(R.opt('params', '')));
  const p = await R.level({ level: 'atlas', town: 1, fresh: 1, census: 1, censusevery: 0, ...extra }, { noDefaultQ: R.flag('noq') });
  const take = () => p.evaluate(() => window.__census.take());
  const flags = await p.evaluate(() => ({ url: location.href, quality: window.reclaimed.core.host.qualityName, q: window.reclaimed.core.host.quality, canvas: [document.getElementById('world').width, document.getElementById('world').height], dpr: devicePixelRatio }));
  R.log(`page: ${flags.url}`);
  R.log(`quality ${flags.quality} ${JSON.stringify(flags.q)}, canvas ${flags.canvas.join('x')}, dpr ${flags.dpr}`);
  const reports = { flags };
  const say = (name, r) => {
    reports[name] = r;
    console.log(table(name, r, top, labels));
  };
  // (the boot's own calls — pipelines, the warmup — are not a frame's: dropped)
  const boot = await take();
  reports.boot = { frames: boot.frames, total: boot.total };
  // (headless on this desktop — D3D11, FXC — the level's first two frames hold the GPU 25-30 s (BACKLOG PI-9), past
  // main.ts's 20 s watchdog: its overlay comes up though the frames then run. That stall is the boot's, not a frame's:
  // waited out and said, the overlay taken down so the states after it are measured. Any other fatal still fails.)
  const tStall = Date.now();
  await p.waitForFunction(() => window.__census.census.frames >= 4, { timeout: 180000, polling: 250 });
  const stall = (Date.now() - tStall) / 1000;
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal && /the GPU never finished/.test(fatal)) {
    R.log(`the first frames held the GPU ${stall.toFixed(1)} s (the watchdog's overlay taken down: BACKLOG PI-9)`);
    await p.evaluate(() => document.querySelector('.fatal')?.remove());
  } else await R.fatal(p);
  reports.firstFramesStallS = +stall.toFixed(1);
  await take();
  if (states.includes('settle')) {
    await R.sleep(8000);
    say('settle (the first 8 s after the level is ready)', await take());
  }
  // (the town made, its people given, the first hand dealt; then the world left alone)
  // FIXED-CITY (BACKLOG PI-20): the census measures at the run's start town.
  await p.waitForFunction(() => window.season?.town != null || document.querySelector('.fatal'), { timeout: 180000, polling: 250 });
  await R.fatal(p);
  // (--pick <leader>: with --params loop=1, the main loop's leader picked first, so idle is the town with its names
  // over the map and not the leader screen)
  if (R.opt('pick', '')) {
    await p.waitForFunction(() => window.rungame?.phase === 'leader', { timeout: 180000, polling: 250 });
    // (loop round 16: the opening is a messenger now — skipped, as the panel was closed)
    await p.evaluate((who) => (window.rungame.pick(who), window.rungame.closePanel(), window.rungame.messenger?.skip()), R.opt('pick', ''));
    R.log(`the loop's leader picked: ${R.opt('pick', '')}`);
  }
  await R.sleep(Number(R.opt('settle', 25)) * 1000);
  await take();
  if (states.includes('idle')) {
    await R.sleep(idleS * 1000);
    const idle = await take();
    say(`idle (${idleS} s, the camera still)`, idle);
    // (the idle gates: what a cut removed stays removed)
    R.check("idle: the sandbox valley's timed reads don't run in the town game (DA-B5, PI-2)", !idle.systems.some((s) => s.system === 'valley-reads'), idle.systems.find((s) => s.system === 'valley-reads')?.labels);
    R.check('idle: under 4 KB read back a frame', idle.total.readBytes < 4096, { readKB: +(idle.total.readBytes / 1024).toFixed(2), reads: idle.total.reads });
    R.check('idle: nothing made in a frame (pipelines, bind groups, buffers, textures)', idle.total.pipelines + idle.total.bindGroups + idle.total.textures < 0.05 && idle.total.buffers < 0.2, { pipelines: idle.total.pipelines, bindGroups: idle.total.bindGroups, buffers: idle.total.buffers, textures: idle.total.textures });
  }
  if (states.includes('pan')) {
    // (the camera moved 30 cells a second for 10 s, as a held pan does: the window slides after it)
    await p.evaluate(
      () =>
        new Promise((res) => {
          const cam = window.reclaimed.camera;
          const t0 = performance.now();
          let last = t0;
          const step = (t) => {
            cam.target[0] += (30 * (t - last)) / 1000;
            last = t;
            if (t - t0 < 10000) requestAnimationFrame(step);
            else res();
          };
          window.__census.take();
          requestAnimationFrame(step);
        }),
    );
    const pan = await take();
    say('pan (30 cells a second for 10 s)', pan);
    R.check('pan: Integrity reads nothing back (PI-5: a slide alone asks for no judge pass)', (pan.systems.find((s) => s.system === 'integrity')?.readBytes ?? 0) === 0, pan.systems.find((s) => s.system === 'integrity')?.labels?.slice(0, 3));
    await R.sleep(5000);
    await take();
  }
  if (states.includes('season')) {
    // (a houses card started and Next season pressed: the time-lapse plays, not skipped)
    const started = await p.evaluate(async () => {
      const S = window.season;
      S.grant({ labor: 10, might: 4, materials: 20, magic: 4, intel: 4 });
      let i = S.hand.findIndex((o, k) => o.card.id === 'houses' && !S.started.has(k));
      if (i < 0) i = S.offer('houses');
      const can = S.canStart(i);
      if (!can.ok) return { ok: false, can };
      S.start(i);
      window.__census.take();
      window.__seasonDone = false;
      void S.next().then(() => (window.__seasonDone = true));
      return { ok: true };
    });
    R.check('season: a houses card started', started.ok, started);
    const t0 = Date.now();
    await p.waitForFunction(() => window.__seasonDone && !window.season.playing, { timeout: 120000, polling: 100 });
    R.log(`season: the time-lapse played ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const lapse = await take();
    say('season (the Next season time-lapse)', lapse);
    R.check('time-lapse: no megabyte read (PI-5)', lapse.total.readBytes * lapse.frames < 1048576, { readKB: +((lapse.total.readBytes * lapse.frames) / 1024).toFixed(0), integrity: lapse.systems.find((s) => s.system === 'integrity')?.labels?.slice(0, 3) });
    await R.sleep(10000);
    say('after the season (10 s)', await take());
  }
  if (states.includes('event')) {
    // (loop round 6: a live event running — `--event <template>`, with --params loop=1 --pick <leader>: the fire at the
    // market by default, the one event that reads anything back)
    const tpl = R.opt('event', 'market-fire');
    const ok = await p.evaluate((t) => window.rungame?.measureEvent(t) ?? false, tpl);
    R.check(`event: ${tpl} begun`, ok);
    // (loop round 12: `--during "<js>"` run in the page 3 s in — a shield raised over the town, for its cost)
    if (R.opt('during', '')) {
      await R.sleep(3000);
      R.log(`during: ${JSON.stringify(await p.evaluate(R.opt('during', '')))}`);
    }
    await R.sleep(6000);
    await take();
    await R.sleep(idleS * 1000);
    say(`event (${tpl}, ${idleS} s from 6 s in)`, await take());
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(reports, null, 1));
  R.log(`written ${out}`);
  if (R.opt('shot', '')) await p.screenshot({ path: path.resolve(ROOT, R.opt('shot', '')) });
});
