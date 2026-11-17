// Terrain rivers, step 1: the labelled before/after strip and the profile plots from rivers2.mjs's outputs.
//   node scripts/terrain/rivers2strip.mjs [--dir local/terrain1] [--before off] [--after on]
// Writes <dir>/plot-cross-<name>.png, <dir>/plot-long.png and <dir>/strip.png (every pair, labelled).
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const dir = path.resolve(opt('dir', 'local/terrain1'));
const B = opt('before', 'off');
const A = opt('after', 'on');
const sb = JSON.parse(fs.readFileSync(`${dir}/${B}-stats.json`, 'utf8'));
const sa = JSON.parse(fs.readFileSync(`${dir}/${A}-stats.json`, 'utf8'));

/** an SVG line plot: series [{label, colour, pts: [[x, y]…]}] */
function plot(title, series, xl, yl, W = 900, H = 340) {
  const all = series.flatMap((s) => s.pts);
  const x0 = Math.min(...all.map((p) => p[0]));
  const x1 = Math.max(...all.map((p) => p[0]));
  const y0 = Math.min(...all.map((p) => p[1]));
  const y1 = Math.max(...all.map((p) => p[1]));
  const L = 60, R = 20, T = 34, Bm = 40;
  const sx = (x) => L + ((x - x0) / Math.max(x1 - x0, 1e-6)) * (W - L - R);
  const sy = (y) => H - Bm - ((y - y0) / Math.max(y1 - y0, 1e-6)) * (H - T - Bm);
  // (a series' gaps — x steps over 1.5 — break its line: the water is only where there is water)
  const runs = (pts) => {
    const out = [[]];
    for (let i = 0; i < pts.length; i++) {
      if (i && pts[i][0] - pts[i - 1][0] > 1.5 && pts.gappy) out.push([]);
      out[out.length - 1].push(pts[i]);
    }
    return out;
  };
  series = series.flatMap((s) => runs(s.pts).map((pts, i) => ({ ...s, pts, label: i ? '' : s.label })));
  const lines = series.map((s) => `<polyline fill="none" stroke="${s.colour}" stroke-width="${s.width ?? 1.6}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} points="${s.pts.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ')}"/>`).join('');
  const legend = series.filter((s) => s.label).map((s, i) => `<text x="${L + 10 + i * 205}" y="30" fill="${s.colour}" font-size="13">■ ${s.label}</text>`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const y = y0 + t * (y1 - y0);
    return `<text x="${L - 6}" y="${sy(y) + 4}" text-anchor="end" font-size="11" fill="#555">${y.toFixed(0)}</text><line x1="${L}" x2="${W - R}" y1="${sy(y)}" y2="${sy(y)}" stroke="#eee"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#fff;font-family:system-ui"><text x="${W / 2}" y="14" text-anchor="middle" font-size="14" font-weight="600">${title}</text>${ticks}${lines}${legend}<text x="${W / 2}" y="${H - 8}" text-anchor="middle" font-size="12" fill="#333">${xl}</text><text x="14" y="${H / 2}" font-size="12" fill="#333" transform="rotate(-90 14 ${H / 2})" text-anchor="middle">${yl}</text></svg>`;
}

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--window-size=1000,800'] });
const shoot = async (html, file, w, h) => {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h });
  await p.setContent(`<html><body style="margin:0;background:#fff">${html}</body></html>`, { waitUntil: 'load' });
  await p.screenshot({ path: file, fullPage: true });
  await p.close();
};
const plots = [];
try {
  for (const name of Object.keys(sa.rows ?? {})) {
    const a = sa.rows[name];
    const b = sb.rows?.[name];
    const ser = [];
    if (b) ser.push({ label: `before (${B}): ground`, colour: '#999', pts: b.ground.map((g, i) => [i, g]) });
    ser.push({ label: `after (${A}): ground`, colour: '#b5651d', pts: a.ground.map((g, i) => [i, g]) });
    const water = a.ground.map((g, i) => [i, a.water[i] > 0.05 ? g + a.water[i] : null]).filter((p) => p[1] !== null);
    water.gappy = true;
    if (water.length) ser.push({ label: 'after: water surface', colour: '#1f6fd6', width: 3, pts: water });
    const f = `${dir}/plot-cross-${name}.png`;
    await shoot(plot(`Cross-section "${name}": row ${a.row}, x ${a.x0}–${a.x0 + a.ground.length} (world cells)`, ser, 'cells along the row', 'height (cells)'), f, 900, 340);
    plots.push([`cross-section ${name}`, f]);
  }
  const ser = [];
  if (sb.long) ser.push({ label: `before (${B}): river level`, colour: '#999', pts: sb.long.pts.map((q) => [q[0], q[1]]) }, { label: `before: ground under it`, colour: '#ccc', dash: '4 3', pts: sb.long.pts.map((q) => [q[0], q[2]]) });
  if (sa.long) ser.push({ label: `after (${A}): river level`, colour: '#1f6fd6', width: 2.2, pts: sa.long.pts.map((q) => [q[0], q[1]]) }, { label: `after: ground under it`, colour: '#b5651d', dash: '4 3', pts: sa.long.pts.map((q) => [q[0], q[2]]) });
  if (ser.length) {
    const f = `${dir}/plot-long.png`;
    await shoot(plot('Long profiles (source to sea; each world its most dropping long river)', ser, 'distance along the river (world cells)', 'height (cells)', 900, 360), f, 900, 360);
    plots.push(['long profile', f]);
  }
  const img = (f) => (fs.existsSync(f) ? `data:image/png;base64,${fs.readFileSync(f).toString('base64')}` : '');
  const names = ['map', 'plain', 'plainwide', 'fall', 'fallwide', 'volcano', 'playplain', 'playfall', 'playvolcano', 'muru'];
  const rows = names
    .filter((nm) => fs.existsSync(`${dir}/${A}-${nm}.png`))
    .map((nm) => `<div style="display:flex;gap:6px;margin:6px 0"><div><div style="font:600 14px system-ui">${nm} — before (${B})</div><img src="${img(`${dir}/${B}-${nm}.png`)}" width="480"></div><div><div style="font:600 14px system-ui">${nm} — after (${A}, a.rivers2=1)</div><img src="${img(`${dir}/${A}-${nm}.png`)}" width="480"></div></div>`)
    .join('');
  const pl = plots.map(([t, f]) => `<div style="font:600 14px system-ui;margin-top:8px">${t}</div><img src="${img(f)}" width="966">`).join('');
  await shoot(`<div style="padding:8px;width:972px"><div style="font:700 18px system-ui">Terrain rivers, step 1 — seed 1, same views before / after</div>${rows}${pl}</div>`, `${dir}/strip.png`, 990, 800);
  console.log('wrote', `${dir}/strip.png`, plots.map((p) => p[1]).join(' '));
} finally {
  await browser.close();
}
