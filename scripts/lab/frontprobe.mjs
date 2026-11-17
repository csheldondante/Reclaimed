// (loop round 12) The terrain round the home town and a lava spring on it: does lava poured uphill of the town reach
// it? Logs the ground's height on rings round the town (16 ways, 1.5..4 town radii), pours lava at the chosen point and
// takes stills of the town as it runs.
//   node scripts/lab/frontprobe.mjs [--out dir] [--way k] [--far 2.5] [--rate 40] [--shots 6] [--every 10] [--kind lava|water]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'frontprobe', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'frontprobe');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(live|front|probe)\]/.test(t) || m.type() === 'error') R.log(t.slice(0, 300));
  });
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0${R.opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => (window.rungame.pick('ysolt'), window.rungame.closePanel()));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(4000);
  // (the camera on the town first: the window centres on it)
  await p.evaluate(() => {
    const t = window.citygen.live.get(window.season.town);
    const c = t.centreInWindow();
    window.rungame.cam.look([c[0], c[1], 0], { zoom: 4, ease: 0.3 });
  });
  await R.sleep(6000);
  const ring = await p.evaluate(async () => {
    const t = window.citygen.live.get(window.season.town);
    const c = t.centreInWindow();
    const Rt = t.box.R;
    const api = window.reclaimed.scene.worldApi;
    await api.terrain.load(c[0] - 150, c[1] - 150, c[0] + 150, c[1] + 150);
    await new Promise((r) => setTimeout(r, 500));
    await api.terrain.load(c[0] - 150, c[1] - 150, c[0] + 150, c[1] + 150);
    const h = (x, y) => window.reclaimed.scene.heightAt(x, y);
    const rows = [];
    for (const f of [0, 20, 40, 60, 80, 100, 120]) {
      const row = [];
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const v = h(c[0] + Math.cos(a) * f, c[1] + Math.sin(a) * f);
        row.push(v === null || v === undefined ? null : +v.toFixed(1));
      }
      rows.push([f, row]);
    }
    return { c, R: Rt, dims: [window.reclaimed.core.dims.w, window.reclaimed.core.dims.h], rows };
  });
  R.log(`town centre ${ring.c.map((v) => v.toFixed(0))} R ${ring.R.toFixed(1)} window ${ring.dims}`);
  for (const [f, row] of ring.rows) R.log(`  x${f}: ${row.join(' ')}`);
  const far = Number(R.opt('far', '80'));
  // (the way: given, else the highest at `far`)
  let way = Number(R.opt('way', '-1'));
  if (way < 0) {
    const row = ring.rows.find((r) => r[0] === far)?.[1] ?? [];
    way = row.reduce((b, v, k) => ((v ?? -1e9) > (row[b] ?? -1e9) ? k : b), 0);
  }
  const kind = R.opt('kind', 'lava');
  const rate = Number(R.opt('rate', '40'));
  const src = await p.evaluate(
    ([way, far, rate, kind]) => {
      const t = window.citygen.live.get(window.season.town);
      const c = t.centreInWindow();
      const a = (way / 16) * Math.PI * 2;
      const x = c[0] + Math.cos(a) * far;
      const y = c[1] + Math.sin(a) * far;
      const z = window.reclaimed.scene.heightAt(x, y) ?? 0;
      const q0 = new URLSearchParams(location.search);
      window.reclaimed.core.flow[kind].addSpring(x, y, z + 1, rate);
      // (asleep, a chunk's liquid is frozen: the spring's chunk woken, and the steady state keeps what flows awake)
      if (!q0.get('nowake')) window.reclaimed.scene.sleep?.wake(x, y, 24, 20, performance.now() / 1000);
      // (the camera between the source and the town, or on the source with &atsrc=1)
      const q = new URLSearchParams(location.search);
      const mx = q.get('atsrc') ? x : (x + c[0]) / 2;
      const my = q.get('atsrc') ? y : (y + c[1]) / 2;
      window.rungame.cam.look([mx, my, window.reclaimed.scene.heightAt(mx, my)], { zoom: Number(new URLSearchParams(location.search).get('pz') ?? 5), ease: 0.5 });
      return { x, y, z };
    },
    [way, far, rate, kind],
  );
  R.log(`${kind} spring at way ${way} x${far}: ${[src.x, src.y, src.z].map((v) => v.toFixed(1))} rate ${rate}`);
  // (diagnosis: each second for 8 s, what the lava system and the sleep say)
  for (let k = 0; R.flag('diag') && k < 8; k++) {
    await R.sleep(1000);
    const d = await p.evaluate(([kind, x, y]) => {
      const L = window.reclaimed.core.flow[kind];
      const S = window.reclaimed.scene.sleep;
      const cx = Math.floor(x / 16);
      const cy = Math.floor(y / (Math.sqrt(3) / 2) / 16);
      const k = cy * 20 + cx;
      return { ran: L.ran, settle: L.settle?.awake, idle: L.idle(), springs: L.springs.map((s) => [s.x, s.y, s.z, s.rate].map((v) => +v.toFixed(1))), awake: S?.awake, chunk: [cx, cy], chunkAwake: S?.isAwake(k, performance.now() / 1000), tick: window.reclaimed.core.sim.tick, step: L.step, speed: window.reclaimed.scene.speed, held: JSON.stringify(window.reclaimed.scene.simHeld) };
    }, [kind, src.x, src.y]);
    R.log(`diag ${k}: ${JSON.stringify(d)}`);
  }
  const shots = Number(R.opt('shots', '6'));
  const every = Number(R.opt('every', '10'));
  for (let k = 0; k < shots; k++) {
    await R.sleep(every * 1000);
    await R.fatal(p);
    await p.screenshot({ path: path.join(out, `${kind}-${k}.png`) });
    const st = await p.evaluate(async ([kind, x, y]) => {
      const L = window.reclaimed.core.flow[kind];
      const r = (y - 0.5 * Math.sqrt(3) / 2) / (Math.sqrt(3) / 2);
      const pr = await L.probe(Math.floor(x - 0.5 * (Math.round(r) & 1)), Math.round(r));
      const S = window.reclaimed.scene.sleep;
      // (the open depth over the window: volume, wet columns, their box in window cells)
      const core = window.reclaimed.core;
      const dev = core.host.gpu.device;
      const tmp = dev.createBuffer({ size: L.open.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(L.open, 0, tmp, 0, L.open.size);
      dev.queue.submit([enc.finish()]);
      await tmp.mapAsync(GPUMapMode.READ);
      const d = new Float32Array(tmp.getMappedRange()).slice();
      tmp.destroy();
      let vol = 0, wet = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, most = 0;
      for (let i = 0; i < d.length; i++) {
        if (!(d[i] > 0.01)) continue;
        vol += d[i];
        wet++;
        most = Math.max(most, d[i]);
        const [cx, cy] = core.world.ring.xy(i);
        x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      }
      return { springs: L.springs.length, ran: L.ran, col: pr.col?.slice(0, 1), awake: S?.awake, vol: +vol.toFixed(1), wet, most: +most.toFixed(2), box: [x0, y0, x1, y1], at: [Math.floor(x - 0.5 * (Math.round(r) & 1)), Math.round(r)] };
    }, [kind, src.x, src.y]);
    R.log(`shot ${k}: ${JSON.stringify(st)}`);
  }
});
