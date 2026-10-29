// Round 112 (testspeed): the warmup, measured and fingerprinted. Boots a level `--reps` times (fresh world each page)
// and prints, for each: the warmup's loop of steps (WorldCore.warmStats: the steps' CPU, the systems' encoding in them,
// the worst step, the GPU's tail after the loop) and a hash of every world buffer as the warmup left it (read at the
// boot mark 'warmup', before the first frame — scripts/lib/runner.mjs stateHook). Two fresh boots with equal hashes:
// the warmup is deterministic, so a saved warmed world can be shown equal to a fresh one by its hash.
//   node scripts/warmprobe.mjs [--level atlas] [--at x,y] [--reps 2] [--extra "&k=v"]
//   --snap: the warm snapshot's proof — run 0 warms and saves (the cache emptied for its key first), the runs after
//   start from it; each must hash as run 0 did, every buffer, and its sim must go on (ticks run, no errors)
//   --ab "&wgslstrip=1": run 1 with these settings too — a pure transform must leave the same warmed world (every
//   buffer but the particles, which differ between any two warmups)
import fs from 'node:fs';
import path from 'node:path';
import { SNAP_DIR, run, stateHook } from './lib/runner.mjs';

await run({ name: 'warmprobe', kind: 'behaviour' }, async (R) => {
  const reps = Number(R.opt('reps', 2));
  const params = { level: R.opt('level', 'atlas') };
  if (R.opt('at', '')) params.at = R.opt('at');
  for (const kv of R.opt('extra', '').split('&').filter(Boolean)) {
    const [k, v] = kv.split('=');
    params[k] = v ?? '';
  }
  const runs = [];
  for (let i = 0; i < reps; i++) {
    const p = await R.page();
    await p.evaluateOnNewDocument(stateHook);
    const snap = R.flag('snap');
    if (snap && i === 0) fs.rmSync(SNAP_DIR, { recursive: true, force: true });
    const ab = R.opt('ab', '');
    const pi = { ...params };
    if (ab && i % 2 === 1) for (const kv of ab.split('&').filter(Boolean)) {
      const [k, v] = kv.split('=');
      pi[k] = v ?? '';
    }
    await R.level(pi, { page: p, snapshot: snap });
    const st = await p.evaluate(async () => ({ warm: window.reclaimed.core.warmStats, hash: await window.__warmState }));
    if (snap) {
      const boot = await p.evaluate(() => window.__boot.at);
      st.warmupS = +((boot.warmup - boot.level) / 1000).toFixed(1);
      if (i === 0) await p.waitForFunction(() => window.__snapSaved, { timeout: 120000, polling: 250 });
      const t0 = await p.evaluate(() => window.reclaimed.core.globals.tick);
      await R.ticks(p, 120);
      const t1 = await p.evaluate(() => window.reclaimed.core.globals.tick);
      R.log(`run ${i}: ${i === 0 ? 'warmed and saved' : 'from the snapshot'}; warmup stage ${st.warmupS} s; the sim went on ${t0} -> ${t1}; ${i === 0 ? `snapshot ${(fs.readdirSync(SNAP_DIR).map((f) => fs.statSync(path.join(SNAP_DIR, f)).size)[0] / 1e6).toFixed(0)} MB` : ''}`);
    }
    console.log(`WARM ${i} ${JSON.stringify(st.warm)}`);
    console.log(`HASH ${i} ${JSON.stringify(st.hash)}`);
    runs.push(st);
    await p.close();
  }
  if (runs.length > 1) {
    const a = Object.fromEntries(runs[0].hash.map(([k, h]) => [k, h]));
    for (let i = 1; i < runs.length; i++) {
      const diff = runs[i].hash.filter(([k, h]) => a[k] !== h && !(R.flag('snap') ? false : k === 'particles')).map(([k]) => k);
      R.check(`run ${i} has run 0's warmed world (every buffer's hash)`, diff.length === 0, diff.length ? { differ: diff } : undefined);
    }
  }
});
