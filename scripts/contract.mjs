// Round 112 (testspeed): the contract tier's runner — src/test/contract.ts's tests on tiny worlds, one page, no atlas.
// A behaviour check (may share the GPU). Seconds, not minutes.
//   node scripts/contract.mjs [--only breach,pool] [--systems all] [--ticks N]
import { run } from './lib/runner.mjs';

await run({ name: 'contract', kind: 'behaviour', size: '200x200' }, async (R) => {
  const p = await R.page();
  const tNav = Date.now();
  await p.goto(`${R.url}/contract.html`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.contract, { timeout: 60000 });
  const names = R.opt('only', '') ? R.opt('only').split(',') : await p.evaluate(() => window.contract.list);
  R.log(`page up in ${((Date.now() - tNav) / 1000).toFixed(1)} s; tests ${names.join(', ')}`);
  const opts = {};
  if (R.opt('systems', '') === 'all') opts.systems = 'all';
  if (R.opt('ticks', '')) opts.ticks = Number(R.opt('ticks'));
  for (const n of names) {
    const r = await p.evaluate((n, o) => window.contract.run(n, o), n, opts);
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${n}: ${r.ticks} ticks, make ${r.ms.make} ms, run ${r.ms.run} ms (${(r.ticks / (r.ms.run / 1000)).toFixed(0)} ticks/s), systems ${r.systems.join(' ')}`);
    for (const c of r.checks) console.log(`     ${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail !== undefined ? `: ${JSON.stringify(c.detail)}` : ''}`);
    console.log(`     data ${JSON.stringify(r.data)}`);
    if (!r.ok) R.fail(`contract ${n}`);
  }
  await R.fatal(p);
});
