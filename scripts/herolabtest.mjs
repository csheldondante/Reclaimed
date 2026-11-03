// (round 128, herolab) The hero lab as the user's test bench, headless on a phone-shaped page (412x915, touch): the
// test menu first (every entry a tap), each hero × each station (loads, moves, no errors), the test menu's tests by
// their buttons, GIFs of the bike in the canyon per handling variant, the knight among raiders by real swipes, the
// cut at the canyon and the cliffs; with --perf, frame times per hero on the canyon (the phone proxy, dpr 2.6).
//   node scripts/herolabtest.mjs [--out C:/Projects/shots88/herolab2] [--settle 30] [--only menu,grid,tests,gifs,knight,cut]
//   node scripts/herolabtest.mjs --perf [--pairs hoverbike:chase,hoverbike:cutaway+tilt]   (the phone bench, ?herobench=1)
import fs from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const PERF = process.argv.includes('--perf');

await run({ name: 'herolabtest', kind: PERF ? 'timing' : 'behaviour', size: '412x915', dpr: PERF ? 2.6 : 1 }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/herolab2');
  fs.mkdirSync(out, { recursive: true });
  const only = new Set(R.opt('only', 'menu,grid,tests,gifs,knight,cut,auto,drive').split(','));
  const page = await R.page();
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: PERF ? 2.6 : 1, hasTouch: true, isMobile: true });
  // (no ?station=: the test menu first, as the user's link lands)
  const p = await R.level({ level: 'herolab' }, { page });
  await p.waitForFunction(() => window.reclaimed?.lab, { timeout: 120000, polling: 250 });
  await sleep(Number(R.opt('settle', 30)) * 1000);
  await R.fatal(p);
  const shot = (name) => p.screenshot({ path: path.join(out, name) });
  const hero = () => p.evaluate(() => {
    const h = window.reclaimed.lab.session.hero;
    return { at: h.position(), speed: h.speed(), hp: h.health, id: window.reclaimed.lab.session.heroId };
  });
  const now = () => p.evaluate(() => document.querySelector('.lab-now')?.textContent ?? '');
  const stick = (s) => p.evaluate((s) => (window.reclaimed.lab.session.controls.script = s ? { stick: s, buttons: [] } : null), s);
  const station = (label) => p.evaluate((l) => [...document.querySelectorAll('.play-station button')].find((b) => b.textContent === l)?.click(), label);

  async function gif(name, frames, every, act = async () => {}) {
    const enc = GIFEncoder();
    const cap = (async () => {
      for (let i = 0; i < frames; i++) {
        const t0 = Date.now();
        const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
        const pal = quantize(png.data, 128);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
        if (i === Math.floor(frames / 2)) fs.writeFileSync(path.join(out, name.replace('.gif', '-mid.png')), PNG.sync.write(png));
        await sleep(Math.max(0, every - (Date.now() - t0)));
      }
    })();
    await act();
    await cap;
    enc.finish();
    fs.writeFileSync(path.join(out, name), enc.bytes());
    R.log(`saved ${name}`);
  }

  if (PERF) {
    // (the phone bench itself, src/perf/herobench.ts: each hero on the canyon under the chase and the cut, a reload
    // each; here it's the desktop proxy until the user's phone report)
    const u = new URL(p.url());
    u.searchParams.set('herobench', '1');
    const pairs = R.opt('pairs', null);
    if (pairs) u.searchParams.set('pairs', pairs);
    await p.goto(u.toString(), { waitUntil: 'load' });
    await p.waitForFunction(() => window.heroBenchReport || document.querySelector('.fatal'), { timeout: 900000, polling: 1000 });
    await R.fatal(p);
    const body = await p.evaluate(() => window.heroBenchReport);
    fs.writeFileSync(path.join(out, 'herobench-desktop-proxy.json'), body);
    await shot('herobench-card.png');
    for (const r of JSON.parse(body).rows) R.log(`${r.pair}: p50 ${r.p50} p95 ${r.p95} p99 ${r.p99} fps ${r.fps} gpu ${r.gpu} play ${r.playMs} ms cells ${r.cells} cut ${JSON.stringify(r.cutToggle)}`);
    return;
  }

  // ---- the test menu: shown first, every entry on screen and a thumb's size
  if (only.has('menu')) {
    const m = await p.evaluate(() => {
      const menu = document.querySelector('.lab-menu');
      const bs = [...menu.querySelectorAll('.lab-menu-test')].map((b) => {
        const r = b.getBoundingClientRect();
        return { t: b.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
      });
      return { on: menu.classList.contains('on'), bs, vh: innerHeight, vw: innerWidth };
    });
    R.check('the test menu is up first', m.on);
    R.check('every test on screen', m.bs.every((b) => b.x >= 0 && b.x + b.w <= m.vw && b.y + b.h <= m.vh), m.bs.filter((b) => b.y + b.h > m.vh || b.x + b.w > m.vw));
    R.check('every test a thumb\'s size (44 px tall)', m.bs.every((b) => b.h >= 44), m.bs.filter((b) => b.h < 44));
    await shot('menu.png');
  }

  // ---- each hero × each station: it loads, the hero moves (the autopilot, or the stick held on the raiders' field)
  if (only.has('grid')) {
    const all = await p.evaluate(() => window.reclaimed.lab.stations.list.map((s) => s.id));
    const stations = R.opt('stations', null)?.split(',') ?? all;
    for (const id of ['hoverbike', 'lich', 'knight'])
      for (const st of stations) {
        await p.evaluate((o) => window.reclaimed.lab.pick(o), { hero: id, station: st });
        if (st === 'enemy') await stick([0.6, -0.8]);
        await sleep(1500);
        const a = await hero();
        await sleep(2500);
        const b = await hero();
        await stick(null);
        const moved = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]);
        R.check(`${id} @ ${st} moves`, moved > 2 && b.id === id, { moved: +moved.toFixed(1), at: b.at.map((v) => +v.toFixed(1)), hp: b.hp });
        if (st === 'enemy' || st === 'moves-canyon' || st === 'cliff' || st === 'traits') await shot(`grid-${id}-${st}.png`);
        await R.fatal(p);
      }
  }

  // ---- the menu's tests, by their buttons
  if (only.has('tests')) {
    const ids = await p.evaluate(() => [...document.querySelectorAll('.lab-menu-test')].map((b) => b.dataset.test));
    for (const t of ids) {
      await p.evaluate(() => window.reclaimed.lab.showMenu(true));
      await sleep(200);
      const r = await p.evaluate((t) => {
        const r = document.querySelector(`.lab-menu-test[data-test="${t}"]`).getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      }, t);
      await p.touchscreen.tap(r[0], r[1]);
      await sleep(2500);
      const s = await p.evaluate(() => ({ url: location.search, menu: document.querySelector('.lab-menu').classList.contains('on') }));
      R.check(`test ${t}: the menu closes, the address says it`, !s.menu && s.url.includes(`test=${t}`), s.url);
      // (main's review: one row by default; the handling's button the bike's only; nothing over the bar)
      const lay = await p.evaluate(() => {
        const bar = document.querySelector('.lab-bar').getBoundingClientRect();
        const hand = document.querySelector('.tune-btn.herolab-hand');
        const vis = (e) => !!e && getComputedStyle(e).display !== 'none';
        const reclaim = document.querySelector('.reclaim');
        return { bar: Math.round(bar.bottom), hand: vis(hand), reclaim: vis(reclaim), hero: window.reclaimed.lab.session.heroId };
      });
      R.check(`test ${t}: the bar one row (under 150 px), the handling button only with the bike, no goal meter`, lay.bar < 150 && lay.hand === (lay.hero === 'hoverbike') && !lay.reclaim, lay);
      R.log(`${t}: "${(await now()).replace(/\n/g, ' / ')}"`);
      await shot(`test-${t}.png`);
    }
  }

  // ---- the bike in the canyon, each handling variant and the default
  if (only.has('gifs'))
    for (const v of ['stock', 'tight', 'carve', 'governor', 'gripplus']) {
      await p.evaluate((v) => window.reclaimed.lab.pick({ hero: 'hoverbike', station: 'moves-canyon', handling: v, cam: 'cutaway+tilt' }), v);
      await sleep(2500);
      await gif(`bike-canyon-${v}.gif`, 40, 150);
    }

  // ---- the knight among raiders: a wave, then real swipes at the nearest
  if (only.has('knight'))
  for (const test of ['knight-raiders', 'knight-guards']) {
    await p.evaluate(() => window.reclaimed.lab.showMenu(true));
    await p.evaluate((t) => document.querySelector(`.lab-menu-test[data-test="${t}"]`).click(), test);
    await sleep(4000);
    const S = [230, 560];
    const swipe = (d) =>
      p.evaluate(
        async (S, d) => {
          const pad = document.querySelector('.play-pad');
          const id = 40 + Math.floor(Math.random() * 1000);
          const ev = (type, x, y) => pad.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
          ev('pointerdown', S[0], S[1]);
          for (let i = 1; i <= 4; i++) {
            await new Promise((r) => setTimeout(r, 14));
            ev('pointermove', S[0] + d[0] * 18 * i, S[1] + d[1] * 18 * i);
          }
          ev('pointerup', S[0] + d[0] * 72, S[1] + d[1] * 72);
        },
        S,
        d,
      );
    const toNearest = () =>
      p.evaluate(() => {
        const r = window.reclaimed;
        const h = r.lab.session.hero;
        const [x, y, z] = h.position();
        const us = r.lab.d.units.query([x, y], 20);
        if (!us.length) return [1, 0];
        const a = r.core.camera.project(x, y, z);
        const b = r.core.camera.project(us[0].at[0], us[0].at[1], us[0].at[2]);
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
      });
    await gif(`${test}.gif`, 45, 120, async () => {
      for (const gap of [500, 60, 700, 400, 60, 700, 400, 60, 700]) {
        await swipe(await toNearest());
        await sleep(gap);
      }
    });
    // (why no blow lands, if none: the knight's place against the raiders' — the blade checks reach, arc and height)
    const near = await p.evaluate(() => {
      const r = window.reclaimed;
      const h = r.lab.session.hero;
      const at = h.position();
      return { knight: at.map((v) => +v.toFixed(2)), raiders: r.lab.d.units.query([at[0], at[1]], 8).slice(0, 4).map((u) => ({ at: u.at.map((v) => +v.toFixed(2)), d: +Math.hypot(u.at[0] - at[0], u.at[1] - at[1]).toFixed(2), radius: u.radius, hostile: u.hostile })) };
    });
    R.log(`knight vs raiders: ${JSON.stringify(near)}`);
    const read = await p.evaluate(() => document.querySelector('.play-station-read')?.textContent ?? '');
    R.log(`knight station: ${read.replace(/\n/g, ' / ')}`);
    R.check(`${test}: the knight lands blows`, /landed [1-9]/.test(read), read);
    await shot(`${test}-end.png`);
  }

  // ---- (round 128) the auto camera on the tour: the zoom by what sticks up, the tilt by the cliff
  if (only.has('auto'))
    for (const hero of ['hoverbike', 'knight']) {
      await p.evaluate((h) => window.reclaimed.lab.pick({ hero: h, station: 'tour', cam: 'auto+cutfade' }), hero);
      await sleep(2000);
      const log = [];
      await gif(`tour-auto-${hero}.gif`, hero === 'knight' ? 60 : 64, 300, async () => {
        for (let k = 0; k < (hero === 'knight' ? 18 : 19); k++) {
          await sleep(1000);
          if (k % 3 === 0) await shot(`tour-${hero}-${String(k).padStart(2, '0')}.png`);
          log.push(await p.evaluate(() => {
            const l = window.reclaimed.lab;
            const a = l.session.rig.all?.auto ?? l.session.rig['all'].auto;
            const h = l.session.hero.position();
            return `${h[0].toFixed(0)},${h[1].toFixed(0)} up ${a.last.up.toFixed(2)} wall ${a.last.wall.toFixed(2)} zoom ${window.reclaimed.core.camera.zoom.toFixed(1)} el ${((window.reclaimed.core.camera.elevation * 180) / Math.PI).toFixed(0)}`;
          }));
        }
      });
      R.log(`tour ${hero}: ${log.join(' | ')}`);
    }

  // ---- (round 128, PL41) the physical drive on the hill: the highest it gets from a run-up and from standing
  if (only.has('drive'))
    for (const [hero, drive] of [['knight', 'physical'], ['knight', 'brute'], ['knight', 'own']]) {
      const top = async (label, secs) => {
        await p.evaluate((o) => window.reclaimed.lab.pick(o), { hero, station: 'hill', drive, cam: 'cutaway+tilt' });
        await sleep(800);
        await p.evaluate((l) => window.reclaimed.lab.act(l), label);
        let best = -1e9;
        let base = null;
        for (let k = 0; k < secs * 5; k++) {
          await sleep(200);
          const z = await p.evaluate(() => window.reclaimed.lab.session.hero.position()[2]);
          base ??= z;
          best = Math.max(best, z - base);
        }
        return +best.toFixed(2);
      };
      const run = await top('Run-up', 6);
      await shot(`hill-${hero}-${drive}-run.png`);
      const stand = await top('Standing start', 4);
      R.log(`hill ${hero} ${drive}: run-up climbs ${run}, standing ${stand}`);
    }

  // ---- the cut (CAM11) at the canyon and the cliffs, against the chase alone
  if (only.has('cut'))
    for (const st of ['canyon', 'cliff'])
      for (const cam of ['cutaway+tilt', 'chase']) {
        await p.evaluate((o) => window.reclaimed.lab.pick(o), { hero: 'hoverbike', station: st, cam });
        await sleep(4000);
        await shot(`cut-${st}-${cam.replace('+', '_')}.png`);
      }
});
