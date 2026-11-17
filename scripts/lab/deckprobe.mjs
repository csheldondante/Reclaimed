// (loop round 11, LS-99) Why a road's spawn point over a bridge is refused, read in the game: Muru framed, then along
// arterial k (default 0) past the town's edge, at each point: the place table's z there (a deck's or the ground's),
// the column's materials round it (WorldVox over the layers), its water (the whole column's: `water`) and the water on
// its top surface (`waterGaps` x — what the units' peel reads) and its enclosed runs. And the spawn entries' status.
//   node scripts/lab/deckprobe.mjs [--road 0] [--params ...]
import { run } from '../lib/runner.mjs';

await run({ name: 'deckprobe', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const p = await R.page();
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0${R.opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => (window.rungame.pick('ysolt'), window.rungame.closePanel()));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(6000);
  const out = await p.evaluate(async (k) => {
    const s = window.reclaimed.scene;
    const core = s.core;
    const tc = s.townContracts;
    const g = window.rungame;
    const id = g.season.town;
    const i = tc.townIndex(id);
    const TOWN_WORDS = 42240;
    const words = await tc.debugRead('places', TOWN_WORDS * 4 * (i + 1));
    const f = new Float32Array(words.buffer);
    const o = i * TOWN_WORDS;
    const off = [f[o + 4], f[o + 5], f[o + 6]];
    const spawns = [15, 16, 17].map((q) => {
      const e = o + 16 + q * 8;
      return { st: ['ok', 'none', 'rising', 'water', 'noTown'][words[e + 3]], at: [f[e] + off[0], f[e + 1] + off[1], f[e + 2] + off[2]].map((v) => +v.toFixed(1)), app: [f[e + 4] + off[0], f[e + 5] + off[1], f[e + 6] + off[2]].map((v) => +v.toFixed(1)) };
    });
    const ring = core.ring ?? core.world.ring;
    const gaps = new Uint32Array((await core.readBuffer('waterGaps', true)).buffer);
    const gf = new Float32Array(gaps.buffer);
    const water = await core.readBuffer('water', true);
    const layers = new Uint32Array((await core.readBuffer('layers')).buffer);
    const { WorldVox } = window.__deckprobe ?? {};
    const RH = Math.sqrt(3) / 2;
    const t = s.fieldTowns.live.get(id);
    const line = t.roadInWindow(k);
    const c = t.centreInWindow();
    const rows = [];
    const half = (u) => {
      const e = (u >> 10) & 31;
      const m = u & 1023;
      const sg = u >> 15 ? -1 : 1;
      return e === 0 ? sg * m * 2 ** -24 : sg * (1 + m / 1024) * 2 ** (e - 15);
    };
    let sAcc = 0;
    let prev = null;
    for (const q of line) {
      if (prev) sAcc += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
      prev = q;
      const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
      if (d < 50) continue;
      const cy = Math.floor(q[1] / RH);
      const cx = Math.floor(q[0] - 0.5 * (cy & 1));
      if (cx < 0 || cy < 0 || cx >= core.dims.w || cy >= core.dims.h) continue;
      const r = ring.i(cx, cy);
      const enc = [1, 2, 3].map((j) => gaps[r * 4 + j]).filter((u) => u).map((u) => `${half(u & 0xffff).toFixed(1)}+${half(u >>> 16).toFixed(2)}`);
      const T = s.worldApi.terrain;
      await T.load(q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1);
      const sf = T.surfaceAt(q[0], q[1]);
      rows.push(`d ${d.toFixed(0)} s~${sAcc.toFixed(0)} (${cx},${cy}) top ${JSON.stringify(sf)} water ${water[r].toFixed(2)} open ${gf[r * 4].toFixed(2)} enclosed [${enc.join(' ')}]`);
    }
    void layers;
    void WorldVox;
    // (each arterial's words: its length, limit and bridge spans — s along it, deck z at each end)
    const src = t.gen.B.ART;
    const dev = t.io.device;
    const rb = dev.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, rb, 0, src.size);
    dev.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const au = new Uint32Array(rb.getMappedRange().slice(0));
    rb.destroy();
    const af = new Float32Array(au.buffer);
    const AW = 20 + 2 * 128;
    const arts = [];
    for (let a = 0; a < Math.min(au[0] + au[2], 8); a++) {
      const o = 4 + a * AW;
      const spans = [];
      for (let q = 0; q < Math.min(au[o + 2], 4); q++) spans.push(af.slice(o + 4 + 4 * q, o + 8 + 4 * q).map((v) => +v.toFixed(1)).join('/'));
      arts.push(`art ${a}: points ${au[o]} len ${af[o + 1].toFixed(1)} lim ${af[o + 3].toFixed(1)} spans [${spans.join(' ')}]`);
    }
    return { spawns, rows, arts };
  }, Number(R.opt('road', '0')));
  R.log(JSON.stringify(out.spawns));
  for (const r of out.rows) R.log(r);
  for (const r of out.arts) R.log(r);
});
