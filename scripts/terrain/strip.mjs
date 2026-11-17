// Terrain: a labelled strip of stills, two to a row (no GPU: a plain page of images).
//   node scripts/terrain/strip.mjs --dir local/terrain3 --out strip.png --title "…" --items "file.png|label;file2.png|label2;…"
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const dir = opt('dir', 'local/terrain3');
const items = opt('items', '').split(';').filter(Boolean).map((s) => s.split('|'));
const img = (f) => (fs.existsSync(`${dir}/${f}`) ? `data:image/png;base64,${fs.readFileSync(`${dir}/${f}`).toString('base64')}` : '');
const cells = items.map(([f, label]) => `<div><div style="font:600 13px system-ui;margin:2px 0">${label}</div><img src="${img(f)}" style="width:480px;height:auto;display:block"></div>`).join('');
const html = `<div style="padding:8px;width:972px"><div style="font:700 18px system-ui;margin-bottom:6px">${opt('title', 'terrain')}</div><div style="display:grid;grid-template-columns:480px 480px;gap:8px">${cells}</div></div>`;
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
try {
  const p = await browser.newPage();
  await p.setViewport({ width: 990, height: 800 });
  await p.setContent(`<html><body style="margin:0;background:#fff">${html}</body></html>`, { waitUntil: 'load' });
  await p.screenshot({ path: `${dir}/${opt('out', 'strip.png')}`, fullPage: true });
} finally {
  await browser.close();
}
console.log('wrote', `${dir}/${opt('out', 'strip.png')}`);
