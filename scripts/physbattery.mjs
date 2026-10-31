// The physics experiment's battery (round 120, the user: "Performance batteries and feel tests so I can see what is
// improved vs the cost"): for each solver variant (?solver=old|nodes|lattice|hybrid) and each lab station, the
// station's buttons pressed in turn on the phone proxy (412 × 915, dpr 2.6, q=low, every system in play, 1×), then
// measured for a few seconds: GPU ms a frame (the profiler's timestamp queries: total, the physics passes), CPU ms of
// the physics systems, what's moving (rigid rock bodies, node-solver bodies and their nodes, physics voxels), GPU
// memory the physics holds, and a few feel checks (the fastest upward speed seen, bodies below the ground, pieces).
// A fresh page for each variant; each station reset before it plays.
//   node scripts/physbattery.mjs --url http://localhost:5211 [--variants old,nodes,lattice,hybrid]
//     [--stations rock,build,slide,house,metal,collapse] [--measure 8] [--out data/perf/solver/battery.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5211');
const variants = opt('variants', 'old,nodes,lattice,hybrid').split(',');
// (and the judges: every solver × judge)
const judges = opt('judges', 'runs,sections').split(',');
const stationsWanted = opt('stations', 'rock,build,slide,house,metal,collapse').split(',');
const measureS = Number(opt('measure', '8'));
const out = opt('out', `data/perf/solver/battery-${new Date().toISOString().slice(0, 10)}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEVEL_OF = { collapse: 'rocklab' };

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 15 * 60 * 1000,
});
const results = [];
let failed = false;
try {
  for (const variant of variants) for (const judge of judges) {
    for (const level of ['playground', 'rocklab']) {
      const mine = stationsWanted.filter((s) => (LEVEL_OF[s] ?? 'playground') === level);
      if (!mine.length) continue;
      const p = await browser.newPage();
      p.on('pageerror', (e) => {
        failed = true;
        console.log(`FAIL [${variant}] pageerror ${e.message}`);
      });
      await p.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&q=low&solver=${variant}&judge=${judge}`, { waitUntil: 'load' });
      await p.waitForFunction(() => window.reclaimed?.scene?.bugReport, { timeout: 300000 });
      await sleep(30000);
      const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
      if (fatal) throw new Error(`[${variant}] fatal overlay: ${fatal}`);
      // (the profiler reads the GPU's timings only while the perf overlay is open)
      await p.keyboard.press('`');
      const stations = await p.evaluate(() => window.reclaimed.scene.level.stations.map((s) => ({ id: s.id, actions: s.actions.map((a) => a.label) })));
      for (const id of mine) {
        const i = stations.findIndex((s) => s.id === id);
        if (i < 0) throw new Error(`no station ${id} in ${level}`);
        await p.evaluate((i) => window.reclaimed.scene.stationsBar.pick(i), i);
        await p.evaluate(() => [...document.querySelectorAll('.stations button')].find((b) => b.textContent === '↺ reset')?.click());
        await sleep(2500);
        await p.evaluate(() => {
          const R = window.reclaimed;
          R.core.host.profiler.resetTotals();
          window.__feel = { vUp: 0, below: 0, t0: R.core.sim.tick };
          window.__frames = [];
          const watch = () => {
            window.__frames.push(performance.now());
            const ig = R.scene.integrity;
            for (const b of ig?.rigid?.list ?? []) {
              window.__feel.vUp = Math.max(window.__feel.vUp, b.v[2]);
              if (b.pos[2] < 0) window.__feel.below++;
            }
            for (const b of ig?.solver?.bodies ?? []) {
              const r = ig.solver.read(b);
              if (r) window.__feel.vUp = Math.max(window.__feel.vUp, r.vel[2]);
            }
            // (the voxel lattice's bodies: their state's mean velocity)
            const ph = R.scene.physics;
            for (const b of ph?.bodies ?? []) {
              const st = ph.state(b);
              if (st) window.__feel.vUp = Math.max(window.__feel.vUp, st.vel[2]);
            }
            requestAnimationFrame(watch);
          };
          requestAnimationFrame(watch);
        });
        for (const label of stations[i].actions) {
          // (the burying and digging buttons last, after what they bury has come down)
          await p.evaluate((label) => [...document.querySelectorAll('.stations button')].find((b) => b.textContent === label)?.click(), label);
          await sleep(1500);
        }
        await sleep(measureS * 1000);
        const r = await p.evaluate(() => {
          const R = window.reclaimed;
          const pr = R.core.host.profiler;
          const n = Math.max(pr.framesResolved, 1);
          const passes = Object.fromEntries([...pr.totalMs].map(([k, v]) => [k, v / n]));
          const phys = Object.entries(passes).filter(([k]) => /^(solver|phys)/.test(k)).reduce((s, [, v]) => s + v, 0);
          const ig = R.scene.integrity;
          const sol = ig?.solver;
          const physics = R.scene.physics ?? null;
          const mem = [...pr.memory].filter(([k]) => /solver|phys/i.test(k)).reduce((s, [, v]) => s + v, 0);
          const t = window.__frames;
          const d = [];
          for (let k = 1; k < t.length; k++) d.push(t[k] - t[k - 1]);
          d.sort((a, b) => a - b);
          const cpu = R.core.sim.cpuMs;
          return {
            gpuMs: +(pr.gpuTotalMs / n).toFixed(3),
            physGpuMs: +phys.toFixed(3),
            passes: Object.fromEntries(Object.entries(passes).filter(([k]) => /^(solver|phys)/.test(k)).map(([k, v]) => [k, +v.toFixed(3)])),
            cpuMs: { solver: +(cpu.get('solver') ?? 0).toFixed(3), physics: +(cpu.get('physics') ?? 0).toFixed(3), rigid: +(ig?.rigid?.stats.stepMs ?? 0).toFixed(3) },
            frameP50: +(d[Math.floor(d.length / 2)] ?? 0).toFixed(1),
            frameP95: +(d[Math.floor(d.length * 0.95)] ?? 0).toFixed(1),
            rigidBodies: ig?.rigid?.list.length ?? 0,
            solverBodies: sol ? sol.bodies.size : 0,
            solverAwake: sol ? [...sol.bodies].filter((b) => !sol.read(b)?.asleep).length : 0,
            solverNodes: sol ? [...sol.bodies].reduce((s, b) => s + b.nodes, 0) : 0,
            solverParts: sol ? [...sol.bodies].reduce((s, b) => s + (sol.read(b)?.parts ?? 1), 0) : 0,
            physVoxels: physics ? physics.used : 0,
            physBodies: physics ? physics.bodies.length : 0,
            memBytes: mem,
            feel: { vUpMax: +window.__feel.vUp.toFixed(2), belowGround: window.__feel.below },
            bodiesMade: ig?.stats.bodies ?? 0,
          };
        });
        const row = { variant, judge, level, station: id, ...r, judgeMs: await p.evaluate(() => window.reclaimed.scene.integrity?.judge?.stats?.ms ?? null) };
        results.push(row);
        console.log(`[${variant} × ${judge}] ${id}: GPU ${r.gpuMs} ms (physics ${r.physGpuMs}), CPU solver ${r.cpuMs.solver} physics ${r.cpuMs.physics} rigid ${r.cpuMs.rigid}; rigid ${r.rigidBodies}, solver ${r.solverBodies} (${r.solverAwake} awake, ${r.solverNodes} nodes, ${r.solverParts} parts), voxels ${r.physVoxels}; mem ${(r.memBytes / 1048576).toFixed(1)} MB; vUp ${r.feel.vUpMax}`);
      }
      await p.close();
    }
  }
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.stack ?? e}`);
} finally {
  await browser.close();
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), viewport: '412x915 dpr 2.6 q=low', measureS, results }, null, 1));
console.log(`wrote ${out}`);
console.log(failed ? 'PHYSBATTERY: FAILED' : 'PHYSBATTERY: OK');
process.exit(failed ? 1 : 0);
