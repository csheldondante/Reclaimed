// (loop round 13, LS-99) Why a column made on Muru's road-0 bridge deck stands, read in the game: the parade begun
// (`rungame.measureEvent('gate-parade')`, the column called down road 0), then every few seconds for its marchers: where
// each stands (x, y, z), the walkable surfaces of its column and their links (agents.wgsl nav: z, head, the six
// links), the order group's anchor (state, s, lag) and each rank's mode and target (orders.wgsl, mail), the route the
// march reads (its points' z and width near the units) and the arterial's words (lim, spans).
//   node scripts/lab/deckwalkprobe.mjs [--secs 30]
import { run } from '../lib/runner.mjs';

await run({ name: 'deckwalkprobe', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(live|forces)\]/.test(t)) R.log(t.slice(0, 300));
  });
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0${R.opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => (window.rungame.pick('ysolt'), window.rungame.closePanel()));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(4000);
  R.check('gate-parade begun', await p.evaluate(() => window.rungame.measureEvent('gate-parade')));
  const secs = Number(R.opt('secs', '30'));
  for (let t = 0; t < secs; t += 5) {
    await R.sleep(5000);
    const out = await p.evaluate(async () => {
      const s = window.reclaimed.scene;
      const units = s.units;
      const A = units.agents;
      const live = window.rungame.live;
      const run = live.runs[0];
      if (!run) return { none: true };
      const rg = [...run.groups.values()].find((g) => g.def.tags.includes('marchers')) ?? [...run.groups.values()][0];
      const ids = rg.force !== null ? s.townForces.members(rg.force) : [...rg.units];
      const raw = new Float32Array(await A.readRaw('units'));
      const nav = new Uint32Array(await A.readRaw('nav'));
      const nf = new Float32Array(nav.buffer);
      const mail = new Uint32Array(await A.readRaw('mail'));
      const mf = new Float32Array(mail.buffer);
      const L = A.mailLayout;
      const ring = s.core.ring;
      const RH = Math.sqrt(3) / 2;
      const cellOf = (x, y) => {
        const r = (y - 0.5 * RH) / RH;
        const c = [x - 0.5 - 0.5 * r, r, -(x - 0.5 - 0.5 * r) - r];
        const q = c.map(Math.round);
        const d = c.map((v, i) => Math.abs(q[i] - v));
        if (d[0] > d[1] && d[0] > d[2]) q[0] = -q[1] - q[2];
        else if (d[1] > d[2]) q[1] = -q[0] - q[2];
        return [q[0] + (q[1] - (q[1] & 1)) / 2, q[1]];
      };
      const navAt = (cx, cy) => {
        const out = [];
        for (let k = 0; k < 4; k++) {
          const o = (ring.idx(cx, cy) * 4 + k) * 4;
          if (nf[o] === -1 && nav[o + 1] === 0) continue;
          const links = Array.from({ length: 6 }, (_, d) => (nav[o + 1] >>> (9 + 3 * d)) & 7).join('');
          out.push(`z ${nf[o].toFixed(2)} h ${((nav[o + 1] & 255) / 8).toFixed(1)} w ${nf[o + 3].toFixed(2)} L ${links}`);
        }
        return out.join(' | ');
      };
      const us = ids.flatMap((id) => {
        const u = units.recs.get(id);
        if (!u || !u.v.alive) return [];
        const o = (u.gpu % 8192) * 24;
        return [{ id, slot: u.order, x: raw[o], y: raw[o + 1], z: raw[o + 2] }];
      });
      const slot = us[0]?.slot ?? 0;
      const G = L.groups + slot * L.groupW;
      const F = G + L.formAt;
      const ranks = [];
      for (let k = 0; k < L.ranksPerGroup; k++) {
        const r = L.ranks + (slot * L.ranksPerGroup + k) * L.rankW;
        if (!mail[r + 4] || (mail[r + 3] & 0xff) === 0) continue;
        ranks.push(`r${k} mode ${mail[r + 3] & 0xff} to (${mf[r].toFixed(1)},${mf[r + 1].toFixed(1)}) d ${mf[r + 5].toFixed(1)}`);
      }
      const first = us[0];
      const c = first ? cellOf(first.x, first.y) : [0, 0];
      const around = [];
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0, 2], [0, -2], [0, 3], [0, -3]]) around.push(`(${c[0] + dx},${c[1] + dy}) ${navAt(c[0] + dx, c[1] + dy)}`);
      return {
        t: run.t,
        step: run.entry?.step,
        units: us.map((u) => `${u.x.toFixed(1)},${u.y.toFixed(1)},${u.z.toFixed(2)}`),
        group: { kind: mail[G], place: mail[G + 11], field: mail[G + 6], form: [mail[F], mail[F + 1], mail[F + 2]], len: +mf[F + 3].toFixed(1), s: +mf[F + 4].toFixed(1), state: mail[F + 8], lag: +mf[F + 10].toFixed(1) },
        ranks,
        around,
        cell: c,
      };
    });
    R.log(`t+${t + 5}s ${JSON.stringify(out, null, 0)}`);
  }
});
