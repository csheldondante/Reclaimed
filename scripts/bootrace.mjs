// Round 112 (testspeed): a Chrome trace of one level boot — where the GPU process spends the boot (Dawn, the D3D
// compiler, the command buffers). Records from navigation to 'level-ready' with the GPU's trace categories, then
// sums the complete events by name per process (GPU process first) and prints the biggest. A/B with --extra:
//   node scripts/bootrace.mjs [--level atlas] [--extra "&wgslstrip=1"] [--top 25] [--out trace.json] [--snap]
import fs from 'node:fs';
import { run, stages } from './lib/runner.mjs';

await run({ name: 'bootrace', kind: 'timing' }, async (R) => {
  const params = { level: R.opt('level', 'atlas') };
  for (const kv of R.opt('extra', '').split('&').filter(Boolean)) {
    const [k, v] = kv.split('=');
    params[k] = v ?? '';
  }
  const p = await R.page();
  const path = R.opt('out', `${process.env.TEMP ?? '.'}/bootrace-${Date.now()}.json`);
  await p.tracing.start({ path, categories: ['toplevel', 'gpu', 'gpu.service', 'disabled-by-default-gpu.service', 'disabled-by-default-gpu.dawn', 'gpu.dawn', 'devtools.timeline', 'v8.execute'] });
  await R.level(params, { page: p });
  await p.tracing.stop();
  const tr = JSON.parse(fs.readFileSync(path, 'utf8'));
  const ev = tr.traceEvents ?? tr;
  const pname = new Map();
  const tname = new Map();
  for (const e of ev) {
    if (e.ph === 'M' && e.name === 'process_name') pname.set(e.pid, e.args.name);
    if (e.ph === 'M' && e.name === 'thread_name') tname.set(`${e.pid}:${e.tid}`, e.args.name);
  }
  const sums = new Map();
  for (const e of ev) {
    if (e.ph !== 'X' || !e.dur) continue;
    const k = `${pname.get(e.pid) ?? e.pid} / ${tname.get(`${e.pid}:${e.tid}`) ?? e.tid} / ${e.name}`;
    const s = sums.get(k) ?? { ms: 0, n: 0, max: 0 };
    s.ms += e.dur / 1000;
    s.n++;
    s.max = Math.max(s.max, e.dur / 1000);
    sums.set(k, s);
  }
  const top = [...sums].sort((a, b) => b[1].ms - a[1].ms).slice(0, Number(R.opt('top', 30)));
  console.log(`boot: ${stages(p.boot)}`);
  for (const [k, s] of top) console.log(`${s.ms.toFixed(0).padStart(7)} ms  ${String(s.n).padStart(6)}x  max ${s.max.toFixed(0).padStart(6)}  ${k}`);
  console.log(`trace: ${path}`);
});
