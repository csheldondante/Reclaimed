// Interiors' cost on the phone proxy (412×915, dpr 2.6, ?q=low), by toggling (no per-pass timestamps, no readbacks):
// the frame time (rAF intervals, uncapped: the GPU's cost) on the street, then inside, then inside with each of the
// interior's parts off in turn — the post pass, the shafts, the people, the interior's draw — every system in play.
//   node scripts/interiorperf.mjs [--town 1] [--seconds 6] [--tod 0.38]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'interiorperf', kind: 'timing', size: '412x915', dpr: 2.6, chromeArgs: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] }, async (R) => {
  const town = R.opt('town', '1');
  const secs = Number(R.opt('seconds', '6'));
  const tod = R.opt('tod', '0.38');
  const p = await R.level({ level: 'atlas', town, interior: '1', tod, day: '100000' });
  await p.waitForFunction(() => !!window.reclaimed.interior?.active && !!window.reclaimed.interiorPeople, { timeout: 120000, polling: 250 });
  await R.simSeconds(p, 8);
  const measure = async (label) => {
    await sleep(800);
    const r = await p.evaluate(
      (s) =>
        new Promise((res) => {
          const ts = [];
          let last = performance.now();
          const t0 = last;
          const f = () => {
            const n = performance.now();
            ts.push(n - last);
            last = n;
            if (n - t0 < s * 1000) requestAnimationFrame(f);
            else {
              ts.sort((a, b) => a - b);
              res({ n: ts.length, p50: ts[Math.floor(ts.length * 0.5)], p95: ts[Math.floor(ts.length * 0.95)], worst: ts[ts.length - 1] });
            }
          };
          requestAnimationFrame(f);
        }),
      secs,
    );
    R.log(`${label.padEnd(34)} p50 ${r.p50.toFixed(2)} ms  p95 ${r.p95.toFixed(2)} ms  worst ${r.worst.toFixed(1)} ms  (${r.n} frames)`);
    return r;
  };
  const set = (js) => p.evaluate(js);
  const street = await measure('street (post on)');
  await set(() => window.reclaimed.interior.enter());
  await sleep(3500);
  const inside = await measure('inside, everything');
  await set(() => (window.reclaimed.post.look.on = false));
  await measure('inside, post filters off');
  await set(() => (window.reclaimed.post.look.on = true));
  await set(() => (window.reclaimed.interior.active.draw.shaftsOn = false));
  await measure('inside, shafts off');
  await set(() => (window.reclaimed.interior.active.draw.shaftsOn = true));
  await set(() => window.reclaimed.core.camera.lights.length);
  await set(() => (window.reclaimed.interior.active.draw.on = false));
  await measure('inside, interior draw off');
  await set(() => (window.reclaimed.interior.active.draw.on = true));
  await set(() => window.reclaimed.core.setPost(null));
  await measure('inside, no post pass (full res)');
  R.log(`inside − street: ${(inside.p50 - street.p50).toFixed(2)} ms p50`);
});
