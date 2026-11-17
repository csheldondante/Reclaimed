// (loop round 10, LS-94) The toy spells on units in the real game, at phone size: the arena pack's Red mist (berserk)
// and Veil (hidden) cast into the Red Wolf's bout (four challengers, your fighter), stills before and after.
// The bout is played with `rungame.measureEvent` (no card, never resolved); the two abilities are unlocked by a fixture
// (the record line their cards' `unlock` writes). The spell is armed and the map tapped, as a player does.
//   node scripts/lab/spellshots.mjs [--out dir] [--mode berserk|veil|both]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'spellshots', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'spellshots');
  const modes = R.opt('mode', 'both') === 'both' ? ['berserk', 'veil'] : [R.opt('mode', 'berserk')];
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(live|loop)\]/.test(t)) R.log(t.slice(0, 300));
  });
  const shot = async (name) => {
    await p.screenshot({ path: path.join(out, `${name}.png`) });
    R.log(`shot ${name}`);
  };
  const view = () =>
    p.evaluate(() => {
      const d = window.rungame.liveDebug();
      const r = d.runs[0];
      return { phase: window.rungame.phase, t: r && Math.round(r.t), groups: r && Object.fromEntries(Object.entries(r.state.groups).map(([k, g]) => [k, `${g.alive}/${g.made}${g.arrived ? ' arrived' : ''}`])), challengers: window.rungame.live.figures('challenger').length, fighter: window.rungame.live.figures('pit-fighter').length, line: window.rungame.fightLine };
    });
  for (const mode of modes) {
    await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0&packs=arena`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(p);
    await p.evaluate(() => (window.rungame.pick('ilveth'), window.rungame.closePanel()));
    await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
    await R.sleep(4000);
    // (the fixture: both abilities unlocked as their cards' `unlock` does — the record line)
    await p.evaluate(() => {
      const r = window.rungame.realm;
      for (const id of ['arena-red-mist', 'arena-veil']) r.w.facts.record({ kind: `ability-unlocked:${id}`, by: ['player'], to: [r.home], note: `you learned ${id} (fixture)` });
    });
    R.check(`${mode}: the bout begun`, await p.evaluate(() => window.rungame.measureEvent('arena-bout-3')));
    // (the challengers in, near the fighter and on the screen — they march in down a road first)
    let v = null;
    // (by where the units stand in the world, not on the screen: the bout's camera does not follow the fight — LS-104 —
    // so once the challengers are within 24 cells of the fighter the script puts the camera over them, a fixture)
    const near = () =>
      p.evaluate(() => {
        const g = window.rungame;
        const run = g.live.focus;
        const at = (tag) => g.live.ids(run, tag).map((id) => window.reclaimed.units.get(id)?.at).filter(Boolean);
        const c = at('challenger');
        const f = at('pit-fighter');
        if (c.length < 3 || !f.length) return null;
        const m = [c.reduce((s, q) => s + q[0], 0) / c.length, c.reduce((s, q) => s + q[1], 0) / c.length, c[0][2]];
        return { m, f: f[0], d: Math.hypot(m[0] - f[0][0], m[1] - f[0][1]) };
      });
    let n = null;
    for (let k = 0; k < 300; k++) {
      v = await view();
      n = await near();
      if (n && n.d < 24) break;
      await R.sleep(500);
    }
    R.log(`${mode}: challengers ${n ? n.d.toFixed(1) : '?'} cells from the fighter`);
    // (loop round 11: the bout's camera follows the fight (LS-104) — the fixture only with `--fixture-camera`, as round
    // 10's stills were made; otherwise a moment for the game's own camera to close in)
    if (n && !R.flag('fixture-camera')) {
      await R.sleep(2500);
      v = await view();
    } else if (n) {
      // (berserk: between the crew and the fighter; the veil: on the fighter, who is to vanish)
      const look = mode === 'veil' ? [n.f[0], n.f[1], n.f[2]] : [(n.m[0] + n.f[0]) / 2, (n.m[1] + n.f[1]) / 2, n.m[2]];
      await p.evaluate((q) => window.rungame.cam.look(q, { zoom: 14, ease: 0.3, place: [0.5, 0.4] }), look);
      await R.sleep(1200);
      v = await view();
    }
    R.log(`${mode} before: ${JSON.stringify(v)}`);
    const abilities = await p.evaluate(() => window.rungame.liveNow?.abilities ?? []);
    R.log(`${mode}: abilities on the sheet: ${JSON.stringify(abilities)}`);
    await shot(`${mode}-0-before`);
    const id = mode === 'berserk' ? 'arena-red-mist' : 'arena-veil';
    const tag = mode === 'berserk' ? 'challenger' : 'pit-fighter';
    const at = await p.evaluate((t) => {
      const f = window.rungame.live.figures(t);
      return f.length ? [f.reduce((s, q) => s + q[0], 0) / f.length, f.reduce((s, q) => s + q[1], 0) / f.length] : null;
    }, tag);
    R.check(`${mode}: the ${tag} figures are on the screen`, !!at, at);
    if (!at) continue;
    // (armed by its button on the sheet, as a player does, then the tap)
    await p.evaluate((name) => {
      const b = [...document.querySelectorAll('.run-sheet .go button')].find((e) => e.textContent.startsWith(name));
      if (!b) throw new Error(`no button for ${name}`);
      b.click();
    }, mode === 'berserk' ? 'Red mist' : 'Veil');
    await R.sleep(300);
    await p.mouse.click(at[0], at[1]);
    await R.sleep(400);
    await shot(`${mode}-1-cast`);
    // (what the GPU holds for the bout's units: combat word, spell word, target, alive — one read, for this lab only)
    await R.sleep(1500);
    R.log(
      `${mode} words: ${JSON.stringify(
        await p.evaluate(async () => {
          const g = window.rungame;
          const run = g.live.focus;
          const U = window.reclaimed.units;
          const ag = U.agents;
          const units = new Uint32Array(await ag.readRaw('units'));
          const combat = new Uint32Array(await ag.readRaw('combat'));
          const mail = new Uint32Array(await ag.readRaw('mail'));
          return ['challenger', 'pit-fighter'].flatMap((tag) =>
            g.live.ids(run, tag).map((id) => {
              const s = U.recs.get(id).gpu % 8192;
              return { tag, s, combat: combat[s * 4].toString(16), spell: combat[8192 * 4 + s].toString(16), target: units[s * 24 + 21], alive: (units[s * 24 + 3] >> 8) & 1, kind: (units[s * 24 + 3] >> 9) & 7, state: (units[s * 24 + 3] >> 12) & 7, at: U.get(id)?.at?.map((v) => Math.round(v)) };
            }),
          );
        }),
      )}`,
    );
    for (const [k, s] of [[2, 2], [3, 4], [4, 8]]) {
      await R.sleep(s * 1000);
      R.log(`${mode} +${s}s: ${JSON.stringify(await view())}`);
      await shot(`${mode}-${k}-after`);
    }
    const end = await view();
    R.log(`${mode} after: ${JSON.stringify(end)}`);
  }
});
