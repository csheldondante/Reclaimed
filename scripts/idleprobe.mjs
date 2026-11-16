// phone-idle: does the user's level reach a running frame loop? The atlas town booted with given params, its frames
// and ticks counted over a few seconds (no census needed). A boot check for the census and the idle bench.
//   node scripts/idleprobe.mjs [--params "census=1&x=y"] [--secs 20] [--shot perf-reports/idleprobe.png]
import path from 'node:path';
import { run, ROOT } from './lib/runner.mjs';

await run({ name: 'idleprobe', kind: 'behaviour' }, async (R) => {
  const extra = Object.fromEntries(new URLSearchParams(R.opt('params', '')));
  const p = await R.level({ level: 'atlas', town: 1, fresh: 1, ...extra });
  const secs = Number(R.opt('secs', 20));
  for (let k = 0; k < secs / 5; k++) {
    const a = await p.evaluate(() => ({ tick: window.reclaimed.core.globals.tick, frame: window.reclaimed.core.host.profiler.frameNo, busy: window.reclaimed.stream?.busy ? window.reclaimed.stream.busyWhy : '', season: window.season?.town ?? null }));
    await R.sleep(5000);
    const b = await p.evaluate(() => ({ tick: window.reclaimed.core.globals.tick, frame: window.reclaimed.core.host.profiler.frameNo }));
    R.log(`5 s: ${b.frame - a.frame} frames, ${b.tick - a.tick} ticks${a.busy ? `, streamer busy (${a.busy})` : ''}, season town ${a.season}`);
    await R.fatal(p);
  }
  if (R.opt('shot', '')) await p.screenshot({ path: path.resolve(ROOT, R.opt('shot', '')) });
});
