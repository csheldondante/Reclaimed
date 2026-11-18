// Nested scales: the streaming measurements (src/nested/stream.ts). Scenarios: a slow zoom in and out across the
// promote and demote thresholds; cruises over the ground at depth 2 and 3 at several speeds and pitches. Per run: frame
// times, slides / promotes / demotes and their reversals, frames with more than one level op, and in the central half
// of the view the reads drawn coarser than wanted and the reads with a pop; the pool at the end.
// node scripts/nested-stream.mjs --chromeargs ignore-certificate-errors [--port 5461] [--maxbuf 0] [--runs zoom,c2,...]
// [--seconds 10] [--size 960x640]
import { run, sleep } from './lib/runner.mjs';

const RUNS = {
  zoom: { kind: 'zoom', d0: 30, d1: 0.12, s: 12, pitch: 1.0 },
  c2: { kind: 'cruise', D: 1.5, pitch: 1.0, wps: 1 },
  c2low: { kind: 'cruise', D: 1.5, pitch: 0.35, wps: 1 },
  c2turn: { kind: 'cruise', D: 1.5, pitch: 0.8, wps: 1, turn: 0.5 },
  c3: { kind: 'cruise', D: 0.2, pitch: 1.0, wps: 1 },
  's0.25': { kind: 'cruise', D: 1.5, pitch: 1.0, wps: 0.25 },
  's0.5': { kind: 'cruise', D: 1.5, pitch: 1.0, wps: 0.5 },
  s1: { kind: 'cruise', D: 1.5, pitch: 1.0, wps: 1 },
  s2: { kind: 'cruise', D: 1.5, pitch: 1.0, wps: 2 },
  s4: { kind: 'cruise', D: 1.5, pitch: 1.0, wps: 4 },
  s8: { kind: 'cruise', D: 1.5, pitch: 1.0, wps: 8 },
  s16: { kind: 'cruise', D: 1.5, pitch: 1.0, wps: 16 },
  's1-pitch0.75': { kind: 'cruise', D: 1.5, pitch: 0.75, wps: 1 },
};

await run({ name: 'nested-stream', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const maxbuf = R.opt('maxbuf', '0');
  const seconds = Number(R.opt('seconds', '10'));
  const runs = R.opt('runs', 'zoom,c2,c2low,c3').split(',');
  const shots = R.opt('shots', '0') === '1';
  const tag = R.opt('tag', '');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=30&pitch=1.0&yaw=-1.5708&tx=70&ty=120${maxbuf !== '0' ? `&maxbuf=${maxbuf}` : ''}${R.opt('shrink', '1') === '0' ? '&shrink=0' : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(1500);
  const all = {};
  for (const name of runs) {
    const c = RUNS[name];
    await page.evaluate(
      async (c, seconds, tint) => {
        const S = await import('/src/nested/stream.ts');
        const app = nested.app;
        nested.tint(tint);
        if (c.kind === 'zoom') {
          await S.settle(app, 70, 120, c.d0, -Math.PI / 2, c.pitch);
          window.__run = S.zoomInOut(app, c.d0, c.d1, c.s);
          return;
        }
        await S.settle(app, 70, 120, c.D, -Math.PI / 2 + 0.3, c.pitch);
        window.__run = S.cruise(app, c.wps, seconds, c.turn ?? 0);
      },
      c,
      seconds,
      shots,
    );
    // (--shots 1: stills of the cruise at 1/3 and 2/3 of its time, levels tinted)
    if (shots && c.kind === 'cruise') {
      for (const f of [1, 2]) {
        await sleep((seconds * 1000) / 3);
        await page.screenshot({ path: `local/nested/stream-${name}-${f}${tag}.png` });
      }
    }
    const r = await page.evaluate(() => window.__run);
    all[name] = r;
    const { log, ...rest } = r;
    console.log(`${name}: ${JSON.stringify(rest, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v))}`);
    if (name === 'zoom') console.log(`  ${log.join('\n  ')}`);
  }
  const fatal = await page.evaluate(() => document.querySelector('.fatal')?.textContent ?? '');
  R.check('no GPU error', !fatal, fatal.slice(0, 300));
  R.check('no pages refused', Object.values(all).every((r) => r.refused === 0), Object.values(all).map((r) => r.refused).join(','));
});
