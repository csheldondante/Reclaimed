// Round 114 (framepace): the frame loop stops only loudly — a frame that throws, or a GPU that never finishes its
// work (every rAF held 20 s), shows the fatal overlay. node scripts/loopfail.mjs throw|stall (Vite on :5211)
import puppeteer from 'puppeteer-core';
const mode = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--window-size=412,915'], defaultViewport: { width: 412, height: 915 } });
try {
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 120)));
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 200)));
  await p.goto('http://localhost:5211/?skipmenu=1&level=atlas&tutorial=0&q=low&world=new', { timeout: 240000 });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await sleep(8000);
  await p.evaluate((mode) => {
    if (mode === 'throw') { const sc = window.reclaimed.scene; const f = sc.frame; let n = 0; sc.frame = function (...a) { if (++n === 5) throw new Error('test throw'); return f.apply(this, a); }; }
    else GPUQueue.prototype.onSubmittedWorkDone = () => new Promise(() => {});
  }, mode);
  await sleep(mode === 'stall' ? 24000 : 8000);
  console.log(mode, 'fatal:', await p.evaluate(() => document.querySelector('.fatal')?.textContent?.slice(0, 300) ?? 'none'));
} finally { await b.close(); }
