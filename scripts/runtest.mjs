// The run story as a player plays it (round 88, branch `runstory`): the atlas level at the phone tier (q=low,
// 412×915) with ?run=bell. Everything goes through the page the way a player's input does — taps on the
// screen (a person: walk up and talk; the ground: walk there), the dialog's buttons, the swing (the pad's
// scripted stick and swing, as a held button would) — and the state is read back through window.reclaimed.run.
//   won:  Ilsa at the ford → Reeve Hesk in Mebe (the bone key; o-mebe done) → the barrow's ossuary (o-barrow)
//         → the bone door opens with the key → the Bellwarden: "I've come to end you" → it and its dead fight →
//         killed (the happening: dead-stopped, o-end done, AtlasEvents in the world) → back to Hesk: "I destroyed
//         the Bellwarden" → the run won, the end card with the RunRecord.
//   lost: a fresh run, hostiles come for the hero standing still: it dies, the run is lost.
//   node scripts/runtest.mjs [--url http://localhost:5241] [--q low] [--shots C:/Projects/shots88/run] [--only won|lost]
import puppeteer from 'puppeteer-core';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const { GIFEncoder, quantize, applyPalette } = gifenc;
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5241');
const q = opt('q', 'low');
const shots = opt('shots', '');
const only = opt('only', '');
const extra = opt('params', '');
if (shots) fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) fails++;
  return cond;
};
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1, hasTouch: false },
  protocolTimeout: 600000,
});
let pageErrors = 0;

async function open() {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    pageErrors++;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=${q}&level=atlas&run=bell${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.run?.play, { timeout: 240000 });
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal: ${fatal}`);
  return p;
}

const shot = async (p, name) => {
  if (!shots) return;
  await p.screenshot({ path: `${shots}/${name}.png` });
  console.log(`     saved ${shots}/${name}.png`);
};

/** a GIF while `during` runs */
async function gif(p, name, during, every = 120) {
  if (!shots) return during();
  const enc = GIFEncoder();
  let on = true;
  let n = 0;
  const rec = (async () => {
    while (on && n < 90) {
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      // (half size: a phone GIF that's small enough to send)
      const w = png.width >> 1;
      const h = png.height >> 1;
      const half = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          for (let c = 0; c < 4; c++) half[(y * w + x) * 4 + c] = png.data[(y * 2 * png.width + x * 2) * 4 + c];
      const pal = quantize(half, 256);
      enc.writeFrame(applyPalette(half, pal), w, h, { palette: pal, delay: every });
      n++;
      await sleep(every);
    }
  })();
  try {
    return await during();
  } finally {
    on = false;
    await rec;
    enc.finish();
    fs.writeFileSync(`${shots}/${name}.gif`, enc.bytes());
    console.log(`     saved ${shots}/${name}.gif (${n} frames)`);
  }
}

const state = (p) =>
  p.evaluate(() => {
    const r = window.reclaimed.run;
    const h = r.hero.position();
    return {
      hero: [+h[0].toFixed(1), +h[1].toFixed(1), +h[2].toFixed(1)],
      hp: r.hero.health,
      objectives: Object.fromEntries(r.play.run.objectives().map((o) => [o.id, o.state])),
      talking: r.play.dialog.isOpen,
      over: r.play.run.over,
      units: r.units.all().filter((u) => u.alive).length,
    };
  });

/** walk to a point by taps on the ground along the way (each tap: the ground under the finger) */
async function walkTo(p, to, what, tol = 1.6) {
  const t0 = Date.now();
  let last = null;
  let still = 0;
  while (Date.now() - t0 < 60000) {
    const s = await p.evaluate((to) => {
      const r = window.reclaimed.run;
      const h = r.hero.position();
      const d = Math.hypot(to[0] - h[0], to[1] - h[1]);
      // (a tap a short way along: the point on the screen over the ground there, as a finger would)
      const k = Math.min(1, 14 / Math.max(d, 1e-3));
      const x = h[0] + (to[0] - h[0]) * k;
      const y = h[1] + (to[1] - h[1]) * k;
      const z = window.reclaimed.api.terrain.heightAt(x, y) ?? h[2];
      const [sx, sy] = window.reclaimed.camera.project(x, y, z);
      return { d, sx, sy, h, talking: r.play.dialog.isOpen, busy: r.play.cam.busy };
    }, to);
    if (s.d <= tol) return true;
    if (s.busy) {
      // (a reveal shot: a tap cuts it short)
      await p.mouse.click(206, 300);
      await sleep(300);
      continue;
    }
    if (last && Math.hypot(s.h[0] - last[0], s.h[1] - last[1]) < 0.2) still++;
    else still = 0;
    last = s.h;
    if (still > 8) {
      console.log(`     stuck at ${s.h.map((v) => v.toFixed(1))} on the way to ${what}`);
      return false;
    }
    if (s.sx > 10 && s.sx < 402 && s.sy > 120 && s.sy < 700) await p.mouse.click(s.sx, s.sy);
    else await p.evaluate((to) => window.reclaimed.run.walkTo(to), to);
    await sleep(700);
  }
  return false;
}

/** tap a cast member on the screen: the hero walks up to them and the talk opens */
async function talkTo(p, who) {
  for (let k = 0; k < 40; k++) {
    const s = await p.evaluate((who) => {
      const r = window.reclaimed.run;
      if (r.play.dialog.isOpen) return { open: true };
      const u = r.units.get(r.play.unitOf(who));
      const [sx, sy] = window.reclaimed.camera.project(u.at[0], u.at[1], u.at[2] + 1.2);
      return { open: false, sx, sy, busy: r.play.cam.busy };
    }, who);
    if (s.open) return true;
    if (!s.busy && s.sx > 0 && s.sx < 412 && s.sy > 0 && s.sy < 915) await p.mouse.click(s.sx, s.sy);
    else if (s.busy) await p.mouse.click(206, 300);
    await sleep(800);
  }
  return false;
}

/** the dialog: tap the line to show it all, then the answer with this text (null: tap to close) */
async function answer(p, text) {
  for (let k = 0; k < 30; k++) {
    const r = await p.evaluate((text) => {
      const bs = [...document.querySelectorAll('.dlg-choice')];
      if (text === null) {
        if (!document.querySelector('.dlg')?.offsetParent && !window.reclaimed.run.play.dialog.isOpen) return 'closed';
        if (bs.length) return 'choices';
        return 'tap';
      }
      const b = bs.find((x) => x.textContent.includes(text));
      if (b) {
        b.click();
        return 'chose';
      }
      return bs.length ? `no "${text}" among ${bs.map((x) => x.textContent).join(' | ')}` : 'tap';
    }, text);
    if (r === 'chose' || r === 'closed') return true;
    if (r.startsWith('no ')) {
      console.log('     ' + r);
      return false;
    }
    // (a tap on the panel: the line all shown / the talk closed)
    await p.mouse.click(206, 860);
    await sleep(350);
  }
  return false;
}

const roomAt = (p, loc, room) => p.evaluate((loc, room) => window.reclaimed.run.stage.rooms[loc][room].at, loc, room);

async function won() {
  console.log('--- won: talk, go places, fight, return');
  const p = await open();
  await sleep(15000);
  let s = await state(p);
  ok(s.objectives['o-mebe'] === 'shown', `spawned at ${s.hero}: "${'o-mebe'}" shown, ${s.units} units in play`);
  const stage = await p.evaluate(() => {
    const st = window.reclaimed.run.stage;
    return { locs: Object.fromEntries(Object.entries(st.locations).map(([k, v]) => [k, v.at.map((x) => +x.toFixed(1))])), locks: st.locks.map((l) => l.id) };
  });
  console.log(`     staged: ${JSON.stringify(stage)}`);
  await shot(p, '01-spawn');
  // Ilsa, at the ford
  ok(await talkTo(p, 'ilsa'), 'tapped Ilsa: the hero walked up and the talk opened');
  await sleep(1200);
  await shot(p, '02-talk-ilsa');
  ok(await answer(p, "What's wrong with the water?"), 'asked Ilsa about the water');
  ok(await answer(p, "Then I'll warn Mebe."), '…and said they would warn Mebe');
  ok(await answer(p, 'Farewell.'), '…farewell');
  await answer(p, null);
  ok(await p.evaluate(() => window.reclaimed.run.play.run.flag('heard-of-barrow')), 'the flag heard-of-barrow is set');
  // Mebe: to the reeve's hall
  const gate = await roomAt(p, 'loc-mebe', 'river-gate');
  const square = await roomAt(p, 'loc-mebe', 'market-square');
  ok(await walkTo(p, gate, 'Mebe', 3), 'walked to Mebe');
  ok(await walkTo(p, square, "Mebe's square", 3), "…into its market square");
  ok(await walkTo(p, await roomAt(p, 'loc-mebe', 'reeve-hall'), "the reeve's hall", 3), "…into the reeve's hall");
  ok(await talkTo(p, 'hesk'), 'tapped Reeve Hesk: the talk opened');
  await sleep(800);
  ok(await answer(p, 'About the dead.'), 'told Hesk: about the dead');
  ok(await answer(p, 'Give me the key'), '…asked for the key');
  await answer(p, null);
  await sleep(600);
  await shot(p, '03-objective-done');
  s = await state(p);
  ok(s.objectives['o-mebe'] === 'done' && s.objectives['o-barrow'] === 'shown', `o-mebe done, o-barrow shown (${JSON.stringify(s.objectives)})`);
  ok(await p.evaluate(() => window.reclaimed.run.play.run.has('bone key') === 1), 'the bone key is held');
  // the barrow
  for (const room of ['cairn-gate', 'ossuary']) ok(await walkTo(p, await roomAt(p, 'loc-barrow', room), `the barrow's ${room}`, 2.5), `walked into the barrow's ${room}`);
  await sleep(1500);
  s = await state(p);
  ok(s.objectives['o-barrow'] === 'done' && s.objectives['o-end'] === 'shown', `reaching the ossuary: o-barrow done, o-end shown`);
  // (the bone door: walking to it with the key opens it)
  const door = await p.evaluate(() => window.reclaimed.run.stage.locks.find((l) => l.id === 'bone-door').at);
  await walkTo(p, door, 'the bone door', 2.5);
  await sleep(2500);
  ok(await p.evaluate(() => window.reclaimed.run.stage.locks.find((l) => l.id === 'bone-door').open), 'the bone door opened with the key');
  ok(await walkTo(p, await roomAt(p, 'loc-barrow', 'bell-chamber'), 'the bell chamber', 4), 'walked into the bell chamber');
  ok(await talkTo(p, 'bellwarden'), 'tapped the Bellwarden: the talk opened');
  await sleep(800);
  await shot(p, '04-talk-bellwarden');
  ok(await answer(p, "I've come to end you."), 'told the Bellwarden: "I\'ve come to end you."');
  await answer(p, null);
  await sleep(500);
  s = await state(p);
  const foes = await p.evaluate(() => window.reclaimed.run.units.all().filter((u) => u.alive && u.hostile).length);
  ok(foes >= 5, `the fight: the Bellwarden and its dead are hostile (${foes})`);
  // the fight: swing while the stick turns the hero to the nearest foe (a held button and a thumb)
  const fight = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const f = await p.evaluate(() => {
        const r = window.reclaimed.run;
        const h = r.hero.position();
        const foes = r.units.query([h[0], h[1]], 40, { hostile: true });
        const warden = r.units.byCharacter('bellwarden');
        if (!r.hero.alive || !warden?.alive || !foes.length) {
          r.pad.scripted = null;
          return { done: true, alive: r.hero.alive, warden: warden?.alive ?? false };
        }
        // (the Bellwarden first once its dead thin out; else the nearest)
        const t = foes.length <= 2 ? warden : foes[0];
        const dx = t.at[0] - h[0];
        const dy = t.at[1] - h[1];
        const d = Math.hypot(dx, dy);
        // (the stick, in screen px: world → screen with the camera's azimuth)
        const az = window.reclaimed.camera.azimuth;
        const jx = -Math.sin(az) * dx + Math.cos(az) * dy;
        const jy = Math.cos(az) * dx + Math.sin(az) * dy;
        const l = Math.hypot(jx, jy) || 1;
        r.pad.scripted = { stick: d > 1.8 ? [(jx / l) * 56, (jy / l) * 56] : undefined, attack: d < 3 };
        return { done: false, hp: r.hero.health, foes: foes.length };
      });
      if (f.done) return f;
      await sleep(150);
    }
    return { done: false, timeout: true };
  };
  const res = await gif(p, '05-fight', fight);
  ok(res.done && res.alive && !res.warden, `the fight: the Bellwarden killed, the hero standing (${JSON.stringify(res)})`);
  await sleep(1500);
  await shot(p, '06-after-fight');
  s = await state(p);
  ok(s.objectives['o-end'] === 'done' && s.objectives['o-return'] === 'shown', `the dead stopped: o-end done, o-return shown`);
  const hist = await p.evaluate(() => window.reclaimed.run.world.history().map((e) => `${e.kind}@${e.regions.join(',')}`));
  ok(hist.includes('lay-dead@2159') && hist.includes('mark@2159'), `its AtlasEvents applied to the MemoryWorldState (${hist.join(' ')})`);
  // back to Mebe
  for (const room of ['ossuary', 'cairn-gate']) await walkTo(p, await roomAt(p, 'loc-barrow', room), 'out of the barrow', 3);
  ok(await walkTo(p, await roomAt(p, 'loc-mebe', 'market-square'), 'back to Mebe', 3), 'walked back to Mebe');
  ok(await walkTo(p, await roomAt(p, 'loc-mebe', 'reeve-hall'), "the reeve's hall", 3), "…into the reeve's hall");
  ok(await talkTo(p, 'hesk'), 'tapped Hesk again');
  await sleep(600);
  ok(await answer(p, 'I destroyed the Bellwarden.'), 'told Hesk: "I destroyed the Bellwarden."');
  await answer(p, null);
  await sleep(4000);
  const rec = await p.evaluate(() => window.reclaimed.run.world.runs.at(-1));
  ok(rec?.end === 'won', `the run is won: RunRecord ${JSON.stringify({ end: rec?.end, deeds: rec?.deeds.length, events: rec?.events.length })}`);
  ok(await p.evaluate(() => !!document.querySelector('.story-end')), 'the end card shows');
  await shot(p, '07-end-card');
  await p.close();
}

async function lost() {
  console.log('--- lost: the hero dies');
  const p = await open();
  await sleep(12000);
  await p.evaluate(() => {
    const r = window.reclaimed.run;
    const h = r.hero.position();
    for (let k = 0; k < 4; k++) r.units.spawn('walking dead', [h[0] + 5 * Math.cos(k * 1.6), h[1] + 5 * Math.sin(k * 1.6)], 'f-hollow-court', { hostile: true, health: 2, damage: 3 });
  });
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < 40000) {
    s = await state(p);
    if (s.over) break;
    await sleep(500);
  }
  ok(s.hp === 0 && s.over, `standing still among the dead the hero falls (hp ${s.hp}), the run ends`);
  await sleep(3000);
  const rec = await p.evaluate(() => window.reclaimed.run.world.runs.at(-1));
  ok(rec?.end === 'lost', `the run is lost: RunRecord end ${rec?.end}`);
  await shot(p, '08-lost');
  await p.close();
}

try {
  if (!only || only === 'won') await won();
  if (!only || only === 'lost') await lost();
} catch (e) {
  console.log('FAIL', e.stack ?? e);
  fails++;
} finally {
  await browser.close();
}
ok(pageErrors === 0, `no page errors (${pageErrors})`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
