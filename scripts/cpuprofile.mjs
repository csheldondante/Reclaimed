// Round 80: where the main thread's time goes while riding (?drive) — the CDP CPU profiler over N seconds,
// self time by function (and by file), and the long frames' count. For the hitches.
//   node scripts/cpuprofile.mjs [--url http://localhost:5207] [--seconds 20] [--at 12304,5457] [--extra ""]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const seconds = Number(opt('seconds', 20));
const at = opt('at', '12304,5457');
const extra = opt('extra', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&drive=18&at=${at}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 4000));
  const cdp = await p.createCDPSession();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await p.evaluate(() => {
    window.__long = [];
    let last = performance.now();
    const tick = () => {
      const t = performance.now();
      if (t - last > 50) window.__long.push(+(t - last).toFixed(0));
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await cdp.send('Profiler.start');
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const { profile } = await cdp.send('Profiler.stop');
  const long = await p.evaluate(() => window.__long);
  // self time per node: samples × interval
  const dt = new Map();
  const n = profile.samples.length;
  const total = profile.endTime - profile.startTime;
  for (let i = 0; i < n; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i + 1] ?? 0));
  const byFn = new Map();
  const byFile = new Map();
  for (const node of profile.nodes) {
    const t = (dt.get(node.id) ?? 0) / 1000;
    if (!t) continue;
    const cf = node.callFrame;
    const file = (cf.url.split('/').pop() || '(native)').split('?')[0];
    const key = `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`;
    byFn.set(key, (byFn.get(key) ?? 0) + t);
    byFile.set(file, (byFile.get(file) ?? 0) + t);
  }
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([a, b]) => `${b.toFixed(0).padStart(6)} ms  ${a}`);
  console.log(`profiled ${(total / 1000).toFixed(0)} ms; frames over 50 ms: ${long.length} [${long.slice(0, 30).join(' ')}]`);
  console.log('-- by file');
  console.log(top(byFile, 15).join('\n'));
  console.log('-- by function');
  console.log(top(byFn, 30).join('\n'));
} finally {
  await browser.close();
}
