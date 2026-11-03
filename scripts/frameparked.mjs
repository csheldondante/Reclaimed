// Round 125 (forest): the mean frame interval parked at a spot on the atlas level with play's lich, on the phone proxy
// (412x915 dpr 2.6, q=low; the runner's timing kind), every system in play at 1x — to compare branches at one spot
// (forest against places) without either's lab.
//   node scripts/frameparked.mjs [--at 13728,5216] [--window 4] [--rounds 4] [--extra "&under=0"]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'frameparked', kind: 'timing', size: '412x915', dpr: 2.6 }, async (R) => {
  const at = R.opt('at', '13728,5216');
  const extra = Object.fromEntries(new URLSearchParams(R.opt('extra', '')));
  const win = Number(R.opt('window', '4'));
  const rounds = Number(R.opt('rounds', '4'));
  const p = await R.level({ level: 'atlas', at, play: 'lich', ...extra });
  await sleep(25000);
  const out = [];
  for (let r = 0; r < rounds; r++) {
    out.push(
      await p.evaluate(async (s) => {
        const t = [];
        await new Promise((res) => {
          const f = (now) => {
            t.push(now);
            if (now - t[0] < s * 1000) requestAnimationFrame(f);
            else res();
          };
          requestAnimationFrame(f);
        });
        const d = t.slice(1).map((x, i) => x - t[i]);
        const sd = [...d].sort((a, b) => a - b);
        return { mean: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2), p50: +sd[Math.floor(sd.length / 2)].toFixed(1), p95: +sd[Math.floor(sd.length * 0.95)].toFixed(1) };
      }, win),
    );
  }
  R.log(`FRAMES ${JSON.stringify(out)}`);
});
