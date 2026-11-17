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
    const near = () =>
      p.evaluate(() => {
        const c = window.rungame.live.figures('challenger');
        const f = window.rungame.live.figures('pit-fighter');
        if (c.length < 3 || !f.length) return null;
        const m = [c.reduce((s, q) => s + q[0], 0) / c.length, c.reduce((s, q) => s + q[1], 0) / c.length];
        const on = m[0] > 30 && m[0] < innerWidth - 30 && m[1] > 120 && m[1] < innerHeight - 260;
        return { on, d: Math.hypot(m[0] - f[0][0], m[1] - f[0][1]) };
      });
    for (let k = 0; k < 240; k++) {
      v = await view();
      const n = await near();
      if (n?.on && n.d < 140) break;
      await R.sleep(1000);
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
    for (const [k, s] of [[2, 2], [3, 4], [4, 8]]) {
      await R.sleep(s * 1000);
      R.log(`${mode} +${s}s: ${JSON.stringify(await view())}`);
      await shot(`${mode}-${k}-after`);
    }
    const end = await view();
    R.log(`${mode} after: ${JSON.stringify(end)}`);
  }
});
