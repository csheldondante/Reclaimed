// (round 112, herosandbox) The hero sandbox headless, on the real GPU, every system in play at 1x: drop in and out,
// units spawned that chase and hit the hero, a vessel filled with water and one with sand, the inspector updating,
// an external hero module loaded from another origin (scripts/heroserve.mjs: scripts/test-hero/hero.mjs, and one of
// an older contract refused), a contract feedback note saved, a generated course laid. GIFs to --dir.
//   node scripts/heroserve.mjs 5208 &   (the hero module's origin)
//   node scripts/herosandboxtest.mjs --port 5211 [--level playground] [--dir C:/Projects/shots88/herosandbox] [--size 412x915]
import puppeteer from 'puppeteer-core';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const port = args.port ?? '5211';
const level = args.level ?? 'playground';
const dir = args.dir ?? 'C:/Projects/shots88/herosandbox';
const [w, h] = (args.size ?? '1280x800').split('x').map(Number);
const heroes = args.heroes ?? 'http://localhost:5208/hero.mjs';
fs.mkdirSync(dir, { recursive: true });
const url = `http://localhost:${port}/?skipmenu=1&level=${level}&heroes=${encodeURIComponent(heroes)}`;

let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) fails++;
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: args.chrome ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${w},${h}`],
  defaultViewport: { width: w, height: h, deviceScaleFactor: 1 },
});
let pageErr = false;
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning' || /\[hero\]/.test(t)) console.log(`[console.${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => {
    pageErr = true;
    console.log(`[pageerror] ${e.message}\n${e.stack ?? ''}`);
  });
  const gif = async (name, frames = 30, every = 100, each) => {
    const enc = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      if (each) await each(i);
      const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
      const pal = quantize(png.data, 256);
      enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
      await sleep(every);
    }
    enc.finish();
    const f = path.join(dir, name);
    fs.writeFileSync(f, enc.bytes());
    console.log(`     saved ${f}`);
  };
  const shot = async (name) => {
    await page.screenshot({ path: path.join(dir, name) });
    console.log(`     saved ${path.join(dir, name)}`);
  };
  const ev = (f, ...a) => page.evaluate(f, ...a);
  console.log(url);
  await page.goto(url, { waitUntil: 'load' });
  // (the first load after a server start is slow: judged after 35 s)
  await sleep(35000);
  const fatal = await page.$eval('.fatal', (e) => e.textContent).catch(() => null);
  ok(!fatal, `no fatal overlay${fatal ? `: ${fatal}` : ''}`);
  ok(await ev(() => !!window.reclaimed?.heroSandbox), 'the hero sandbox is mounted');
  ok(await ev(() => document.querySelector('script[type=importmap]')?.textContent.includes('reclaimed/units/figures')), 'the page carries the shared-modules import map');

  // 1. drop in (the 🧍 button), walk, the inspector
  await ev(() => document.querySelector('.hero-sb-bar button').click());
  await sleep(2500);
  const in1 = await ev(() => {
    const hs = window.reclaimed.heroSandbox;
    return { active: hs.active, role: hs.hero?.role, at: hs.hero?.position(), info: document.querySelector('.hero-sb-info').textContent, editor: document.querySelector('.editor')?.style.display ?? null };
  });
  ok(in1.active && in1.role === 'wanderer', `dropped in as the ${in1.role} at ${in1.at?.map((v) => v.toFixed(1))}`);
  ok(/intent move/.test(in1.info) && /camera zoom/.test(in1.info) && /Swing/.test(in1.info), 'the inspector shows the intent, the camera and the abilities');
  const p0 = in1.at;
  await gif('walk.gif', 25, 100, async (i) => {
    await ev((i) => (window.reclaimed.heroSandbox.pad.scripted = { stick: i < 12 ? [0, -50] : [50, 0], attack: false }), i);
  });
  const walk = await ev(() => {
    const hs = window.reclaimed.heroSandbox;
    hs.pad.scripted = null;
    return { at: hs.hero.position(), info: document.querySelector('.hero-sb-info').textContent, intents: hs.log.intents.length };
  });
  ok(Math.hypot(walk.at[0] - p0[0], walk.at[1] - p0[1]) > 5, `it walked ${Math.hypot(walk.at[0] - p0[0], walk.at[1] - p0[1]).toFixed(1)} cells (the scripted stick)`);
  ok(walk.intents > 30, `the intent trace kept ${walk.intents} intents`);

  // 2. units that chase it and hit it; it swings back
  const spawn = await ev(() => {
    const hs = window.reclaimed.heroSandbox;
    const p = hs.hero.position();
    const ids = [hs.spawn('raider', [p[0] + 9, p[1]]), hs.spawn('raider', [p[0] - 9, p[1] + 3]), hs.spawn('brute', [p[0], p[1] + 10]), hs.spawn('ally', [p[0] + 2, p[1] - 2])];
    const d = (id) => {
      const u = hs.units.get(id);
      return Math.hypot(u.at[0] - p[0], u.at[1] - p[1]);
    };
    return { ids, d0: ids.slice(0, 3).map(d) };
  });
  await gif('fight.gif', 40, 100, async (i) => {
    if (i === 20) await ev(() => (window.reclaimed.heroSandbox.pad.scripted = { attack: true }));
  });
  const fight = await ev((ids) => {
    const hs = window.reclaimed.heroSandbox;
    const p = hs.hero.position();
    hs.pad.scripted = null;
    const us = ids.map((id) => hs.units.get(id));
    return {
      d1: us.slice(0, 3).map((u) => (u ? Math.hypot(u.at[0] - p[0], u.at[1] - p[1]) : -1)),
      states: us.map((u) => u && `${u.kind}:${u.state}:${u.health}`),
      health: hs.hero.health,
      calls: hs.log.calls.map((c) => `${c.dir} ${c.call}`),
      log: document.querySelector('.hero-sb-log').textContent,
    };
  }, spawn.ids);
  ok(fight.d1.slice(0, 2).every((d, i) => d >= 0 && d < spawn.d0[i] - 3), `the raiders chased it (${spawn.d0.map((v) => v.toFixed(1))} → ${fight.d1.map((v) => v.toFixed(1))}; ${fight.states.join(', ')})`);
  ok(fight.calls.some((c) => c === 'units→hero actor.hurt') && fight.calls.some((c) => c === 'hero→host hurt'), `their blows crossed the boundary (actor.hurt, hurt): health ${fight.health}`);
  ok(fight.calls.some((c) => c === 'hero→host units.hit'), "the hero's swings crossed it (units.hit)");
  ok(/actor\.hurt|units\.hit/.test(fight.log), 'the boundary log panel shows them');

  // 3. out to the editor and back in
  await ev(() => window.reclaimed.heroSandbox.exit());
  await sleep(500);
  const out = await ev(() => ({ active: window.reclaimed.heroSandbox.active, pad: !!document.querySelector('.hero-pad') }));
  ok(!out.active && !out.pad, 'back out to the editor: no hero, no stick');
  await ev(() => window.reclaimed.heroSandbox.clearUnits());

  // 4. fill a vessel with water, and one with sand: walls built through the world API round the screen's middle
  const ring = async (dx) =>
    ev(async (dx) => {
      const r = window.reclaimed;
      const t = r.heroSandbox.d.api.terrain;
      const cam = r.camera;
      const g = cam.groundAt(cam.viewportW / 2, cam.viewportH / 2, (x, y) => t.heightAt(x, y) ?? 0);
      const c = [g[0] + dx, g[1]];
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 14) t.build(c[0] + Math.cos(a) * 6, c[1] + Math.sin(a) * 6, 'concrete', { radius: 1.6, layers: 6 });
      while (r.globals.events.length) await new Promise((res) => setTimeout(res, 100));
      await new Promise((res) => setTimeout(res, 1500));
      await t.refresh();
      return c;
    }, dx);
  const cw = await ring(-9);
  const cs = await ring(9);
  await shot('vessels.png');
  const wf = await ev((c) => {
    const f = window.reclaimed.heroSandbox.fill(c, 'water');
    return f.error ? { error: f.error } : { cells: f.basin.cells.length, level: f.basin.level, fillTo: f.basin.fillTo, vol: f.volume, n: f.commands, floor: Math.min(...f.basin.cells.map((x) => x[2])) };
  }, cw);
  ok(!wf.error && wf.cells > 40, `the water vessel found: ${wf.error ?? `${wf.cells} cells, rim ${wf.level?.toFixed(1)}, to ${wf.fillTo?.toFixed(1)}, ${wf.vol?.toFixed(0)} cells³ in ${wf.n} pours`}`);
  const sf = await ev((c) => {
    const f = window.reclaimed.heroSandbox.fill(c, 'sand');
    return f.error ? { error: f.error } : { cells: f.basin.cells.length, fillTo: f.basin.fillTo, floor: Math.min(...f.basin.cells.map((x) => x[2])) };
  }, cs);
  ok(!sf.error && sf.cells > 40, `the sand vessel found: ${sf.error ?? `${sf.cells} cells, to ${sf.fillTo?.toFixed(1)}`}`);
  await gif('fill.gif', 40, 150);
  await sleep(4000);
  const filled = await ev(
    async (cw, cs) => {
      const r = window.reclaimed;
      const api = r.heroSandbox.d.api;
      await api.terrain.refresh();
      return { depth: api.water.depthAt(cw[0], cw[1]), level: api.water.levelAt(cw[0], cw[1]), sand: api.terrain.heightAt(cs[0], cs[1]), mat: api.terrain.materialAt(cs[0], cs[1]) };
    },
    cw,
    cs,
  );
  ok(!wf.error && filled.depth > 1.5 && Math.abs(filled.level - wf.fillTo) < 1.5, `water stands in it: ${filled.depth?.toFixed(2)} deep, at ${filled.level?.toFixed(2)} (filled to ${wf.fillTo?.toFixed(2)})`);
  ok(!sf.error && filled.sand > sf.floor + 2 && filled.mat === 'sand', `sand fills the other: its top ${filled.sand?.toFixed(2)} over a floor of ${sf.floor?.toFixed(2)}, ${filled.mat}`);
  await shot('filled.png');
  const notEnclosed = await ev(() => {
    const r = window.reclaimed;
    const cam = r.camera;
    const t = r.heroSandbox.d.api.terrain;
    const g = cam.groundAt(cam.viewportW * 0.5, cam.viewportH * 0.15, (x, y) => t.heightAt(x, y) ?? 0);
    return window.reclaimed.heroSandbox.fill([g[0], g[1]], 'water').error ?? null;
  });
  console.log(`     an open spot: ${notEnclosed ?? '(it was a basin)'}`);

  // 5. the external hero: loaded from another origin through the import map, dropped in, walked, tuned
  const roles = await ev(async () => (await import('/src/hero/registry.ts')).heroRoles());
  ok(roles.includes('roller'), `the test module's hero registered from ${heroes}: ${roles.join(', ')}`);
  await ev(async () => {
    const hs = window.reclaimed.heroSandbox;
    await hs.choose('roller');
    await hs.enter();
  });
  await sleep(1500);
  const r0 = await ev(() => window.reclaimed.heroSandbox.hero.position());
  await gif('external-hero.gif', 25, 100, async (i) => {
    await ev((i) => (window.reclaimed.heroSandbox.pad.scripted = { stick: [i < 12 ? 50 : -50, 0], attack: i === 6 }), i);
  });
  const ext = await ev(() => {
    const hs = window.reclaimed.heroSandbox;
    hs.pad.scripted = null;
    const reg = hs.tuning.registry;
    reg.set('hero.speed', 12);
    return { role: hs.hero.role, at: hs.hero.position(), info: document.querySelector('.hero-sb-info').textContent, calls: hs.log.calls.map((c) => `${c.dir} ${c.call}(${c.args})`), speed: hs.hero.t.speed, ids: reg.defs.map((d) => d.id), panel: !!document.querySelector('.tune-panel.hero') };
  });
  ok(ext.role === 'roller' && Math.hypot(ext.at[0] - r0[0], ext.at[1] - r0[1]) > 3, `the roller rolled ${Math.hypot(ext.at[0] - r0[0], ext.at[1] - r0[1]).toFixed(1)} cells`);
  ok(/roller \(module\)/.test(ext.info) && /Dash/.test(ext.info), 'the inspector shows it as a module hero, with its Dash');
  ok(ext.calls.some((c) => /host\.log\(roller made against contract 1\.1\)/.test(c)), 'its host.log line crossed the boundary');
  ok(ext.speed === 12 && ext.ids.includes('hero.dash') && ext.panel, `its tunables in the hero tuning panel: ${ext.ids.join(', ')} (speed set to ${ext.speed})`);
  await ev(() => window.reclaimed.heroSandbox.exit());
  const old = await ev(async (u) => {
    const hs = window.reclaimed.heroSandbox;
    await hs.loadModule(u);
    return hs.error;
  }, heroes.replace(/hero\.mjs$/, 'hero-old.mjs'));
  ok(/0\.9/.test(old ?? '') && /1\.1/.test(old ?? ''), `a module of an older contract is refused, saying why: ${old}`);

  // 6. contract feedback: the note saved (the dev server keeps it in feedback/hero/)
  await ev(async () => {
    const hs = window.reclaimed.heroSandbox;
    await hs.choose('wanderer');
    await hs.enter();
  });
  await sleep(1000);
  await ev(() => document.querySelector('.bug-btn-as').click());
  await sleep(1500);
  await page.type('.bug-dialog textarea', 'headless test: the swing should say how far it reaches');
  await ev(() => document.querySelector('.bug-dialog .go').click());
  await sleep(1500);
  const fb = await ev(() => {
    const l = window.reclaimed.heroSandbox.feedback.last;
    return l && { kind: l.kind, note: l.note, role: l.hero?.role, contract: l.hero?.contract, calls: l.boundary?.calls?.length, intents: l.intents?.length, tunables: Object.keys(l.tunables?.all ?? {}).length, shot: (l.shot ?? '').slice(0, 22) };
  });
  ok(fb && fb.kind === 'reclaimed-hero-feedback' && fb.role === 'wanderer' && fb.contract === '1.1' && fb.calls > 0 && fb.intents > 0 && fb.tunables > 4 && fb.shot.startsWith('data:image/png'), `a feedback note: ${JSON.stringify(fb)}`);

  // 7. a generated course, the hero at its start
  const course = await ev(async () => {
    const c = await window.reclaimed.heroSandbox.gauntlet();
    return { name: c.name, pieces: c.pieces.length, foes: c.foes.length, start: c.start, at: window.reclaimed.heroSandbox.hero.position() };
  });
  ok(course.pieces > 10 && course.foes >= 3 && Math.hypot(course.at[0] - course.start[0], course.at[1] - course.start[1]) < 1, `${course.name}: ${course.pieces} pieces, ${course.foes} foes, the hero at its start`);
  await sleep(2000);
  await gif('course.gif', 40, 100, async (i) => {
    await ev((i) => (window.reclaimed.heroSandbox.pad.scripted = { stick: [0, -50], attack: i % 4 === 0 }), i);
  });
  await shot('course.png');
  const fatal2 = await page.$eval('.fatal', (e) => e.textContent).catch(() => null);
  ok(!fatal2, `no fatal overlay at the end${fatal2 ? `: ${fatal2}` : ''}`);
} finally {
  await browser.close();
}
ok(!pageErr, 'no page errors');
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
