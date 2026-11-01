// (BACKLOG UI10) The title screen at a phone's size (412 x 785 CSS px, the user's): every entry — each place's button,
// the labs' buttons, the play button — on the screen, or brought onto it by scrolling the title's own panel.
//   node scripts/titlefit.mjs [--size 412x785]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'titlefit', kind: 'behaviour', size: '412x785', dpr: 2.6, echo: true }, async (R) => {
  const i = R.argv.indexOf('--size');
  const [w, h] = (i >= 0 ? R.argv[i + 1] : '412x785').split('x').map(Number);
  const p = await R.page({ size: `${w}x${h}`, dpr: 2.6 });
  await p.goto(`${R.url}/?q=low`, { waitUntil: 'load' });
  await p.waitForSelector('.menu [data-level]', { timeout: 120000 });
  await sleep(1500);
  await R.fatal(p);
  const rows = await p.evaluate(
    async (W, H) => {
      const out = [];
      for (const b of document.querySelectorAll('.menu button')) {
        if (b.offsetParent === null) continue;
        b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        await new Promise((r) => requestAnimationFrame(r));
        const r = b.getBoundingClientRect();
        const on = r.left >= 0 && r.top >= 0 && r.right <= W + 0.5 && r.bottom <= H + 0.5 && r.width > 0;
        out.push({ text: b.textContent.trim(), on, rect: [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v)) });
      }
      return out;
    },
    w,
    h,
  );
  for (const r of rows) R.log(`${r.on ? 'ok ' : 'OFF'} ${r.text.padEnd(22)} ${r.rect.join(',')}`);
  await p.screenshot({ path: 'C:/Projects/shots88/herolab/title-412x785.png' });
  const off = rows.filter((r) => !r.on);
  R.check(`every title entry on the screen or scrollable onto it at ${w}x${h} (${rows.length} buttons)`, off.length === 0, off.map((r) => r.text).join(', '));
  R.check('the hero lab and the traits lab are listed', rows.some((r) => r.text === 'Hero lab') && rows.some((r) => /Traits Lab/.test(r.text)), rows.map((r) => r.text).join(' | '));
});
