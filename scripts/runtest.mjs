// The run story as a player plays it (round 88, branch `runstory`): the atlas level at the phone tier (q=low,
// 412×915) with ?run=bell. Everything goes through the page the way a player's input does — taps on the
// screen (a person: walk up and talk; the ground: walk there), the dialog's buttons, the swing (the pad's
// scripted stick and swing, as a held button would) — and the state is read back through window.reclaimed.run.
//   won:  Ilsa at the ford → Reeve Hesk in Mebe (the bone key; o-mebe done) → the barrow's ossuary (o-barrow)
//         → the bone door opens with the key → the Bellwarden: "I've come to end you" → it and its dead fight →
//         killed (the happening: dead-stopped, o-end done, AtlasEvents in the world) → back to Hesk: "I destroyed
//         the Bellwarden" → the run won, the end card with the RunRecord.
//   lost: a fresh run, hostiles come for the hero standing still: it dies, the run is lost.
//   warp: the map's warp moves the hero; (round 99, RS16) warped back, the places, the doors and the cast are there.
//   far:  (round 99, RS9) the window streams during the run: the bone door opened, the hero rides 200 cells away
//         (three regions and more: the places' regions frozen) and back; the places, the open door and the cast
//         are as they were, and `reached` still notes a room.
// Stage points are world units since round 99 (the run's `winOf` puts one in the window as it is now).
//   node scripts/runtest.mjs [--url http://localhost:5241] [--q low] [--shots C:/Projects/shots88/run] [--only won|lost|warp|far]
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
  p.on('console', (m) => ((m.type() === 'error' && !m.text().includes('404')) || m.text().startsWith('[run]')) && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=${q}&level=atlas&run=bell${extra}`, { waitUntil: 'load' });
  const errs = pageErrors;
  for (let t = 0; !(await p.evaluate(() => !!window.reclaimed?.run?.play)); t += 1000) {
    if (pageErrors > errs) throw new Error('the page failed while the run started');
    if (t > 240000) throw new Error('the run never started');
    await sleep(1000);
  }
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

/** is there a person under this point of the screen (a tap there would be on them, not the ground) */
const onFigure = (p, sx, sy) =>
  p.evaluate(
    (sx, sy) => window.reclaimed.run.units.all().some((u) => {
      if (!u.alive) return false;
      const [x, y] = window.reclaimed.camera.project(u.at[0], u.at[1], u.at[2] + 1.2);
      return Math.hypot(x - sx, y - sy) < 44;
    }),
    sx,
    sy,
  );

/** walk to a point: a tap on it when it's on the screen (the ground under the finger), else sent there by the run */
/** anything hostile coming at the hero on the way (the story's own walking dead, at 300 s): fight it off first */
async function fightOff(p) {
  let fought = false;
  for (let k = 0; k < 400; k++) {
    const f = await p.evaluate(() => {
      const r = window.reclaimed.run;
      const h = r.hero.position();
      const foes = r.hero.alive ? r.units.query([h[0], h[1]], 9, { hostile: true }) : [];
      if (!foes.length) {
        r.pad.scripted = null;
        return false;
      }
      const t = foes[0];
      const d = Math.hypot(t.at[0] - h[0], t.at[1] - h[1]);
      if (d > 2.2) r.seek(t.id);
      r.pad.scripted = { attack: d < 3 };
      return true;
    });
    if (!f) break;
    fought = true;
    await sleep(150);
  }
  if (fought) console.log('     fought off what came at the hero on the way');
  return fought;
}

async function walkTo(p, to, what, tol = 1.6) {
  const t0 = Date.now();
  let last = null;
  let still = 0;
  let sent = false;
  while (Date.now() - t0 < 60000) {
    if (await fightOff(p)) {
      sent = false;
      still = 0;
      last = null;
    }
    const s = await p.evaluate((st) => {
      const r = window.reclaimed.run;
      const to = r.winOf(st);
      const h = r.hero.position();
      const d = Math.hypot(to[0] - h[0], to[1] - h[1]);
      const z = window.reclaimed.api.terrain.heightAt(to[0], to[1]) ?? h[2];
      const [sx, sy] = window.reclaimed.camera.project(to[0], to[1], z);
      return { d, sx, sy, h, talking: r.play.dialog.isOpen, busy: r.play.cam.busy };
    }, to);
    if (s.d <= tol) return true;
    // (round 97: a talk opened on the way, as an event — Hesk calls the hero over once the dead are stopped)
    if (s.talking) return true;
    if (s.busy) {
      // (a reveal shot: a tap cuts it short)
      await p.mouse.click(206, 300);
      await sleep(300);
      continue;
    }
    if (last && Math.hypot(s.h[0] - last[0], s.h[1] - last[1]) < 0.2) still++;
    else still = 0;
    last = s.h;
    if (still > 10) {
      console.log(`     stuck at ${s.h.map((v) => v.toFixed(1))} on the way to ${what}`);
      const dbg = await p.evaluate((st) => {
        const r = window.reclaimed.run;
        const to = r.winOf(st);
        const t = window.reclaimed.api.terrain;
        const h = r.hero.position();
        const rows = [];
        for (let dy = -6; dy <= 6; dy++) {
          let s = '';
          for (let dx = -8; dx <= 8; dx++) {
            const z = t.heightAt(h[0] + dx, h[1] + dy);
            s += dx === 0 && dy === 0 ? '@' : z === null ? '?' : z - h[2] > 2.5 ? '#' : h[2] - z > 2.5 ? 'v' : '.';
          }
          rows.push(s);
        }
        const near = r.units.query([h[0], h[1]], 4, { dead: true }).map((u) => `${u.role}${u.alive ? '' : '(dead)'}@${u.at.map((v) => v.toFixed(1))}`);
        return { water: window.reclaimed.api.water?.depthAt(h[0], h[1]), route: r.route([h[0], h[1]], to), rows, near, mat: t.materialAt(h[0], h[1]), flat: t.heightAt(h[0], h[1]), smooth: t.heightAt(h[0], h[1], { smooth: true }) };
      }, to);
      console.log(`     ${JSON.stringify({ ...dbg, rows: undefined })}\n     ${dbg.rows.join('\n     ')}`);
      return false;
    }
    // (sent once; again only when it's stopped)
    if (sent && still < 2) {
      await sleep(700);
      continue;
    }
    // (the first try a tap on it; again, sent there by the run — a tap on a point inside a walled room can land on
    // the wall in front of it, the ground under the finger being the wall's top)
    const tap = !sent;
    sent = true;
    if (tap && s.sx > 10 && s.sx < 402 && s.sy > 120 && s.sy < 700 && !(await onFigure(p, s.sx, s.sy))) await p.mouse.click(s.sx, s.sy);
    else await p.evaluate((st) => window.reclaimed.run.walkTo(window.reclaimed.run.winOf(st)), to);
    await sleep(700);
  }
  console.log(`     timed out on the way to ${what} (${JSON.stringify(last)} → ${to.map((v) => v.toFixed(1))})`);
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
    const on = s.sx > 20 && s.sx < 392 && s.sy > 120 && s.sy < 700;
    if (!s.busy && !on) {
      // (off the screen: walk toward them until they're in view)
      const at = await p.evaluate((who) => window.reclaimed.run.worldOf(window.reclaimed.run.units.byCharacter(who).at), who);
      await walkTo(p, at, who, 8);
      continue;
    }
    if (!s.busy) await p.mouse.click(s.sx, s.sy);
    else if (s.busy) await p.mouse.click(206, 300);
    await sleep(800);
  }
  console.log(`     could not talk to ${who}: ${JSON.stringify(await p.evaluate((who) => { const r = window.reclaimed.run; const u = r.units.get(r.play.unitOf(who)); const h = r.hero.position(); const sp = u && window.reclaimed.camera.project(u.at[0], u.at[1], u.at[2] + 1.2); const el = sp && document.elementFromPoint(sp[0], sp[1]); return { sp, el: el && (el.className || el.tagName), u: u && { at: u.at, alive: u.alive, hostile: u.hostile, state: u.state }, can: r.play.canTalk(who), hero: h, busy: r.play.cam.busy, open: r.play.dialog.isOpen, ended: r.play.run.over, queued: r.play.talks, talks: window.__talks, cam: window.reclaimed.camera.target.map((v) => +v.toFixed(1)), zoom: window.reclaimed.camera.zoom, follows: !!r.play.cam.following }; }, who))}`);
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
    return { locs: Object.fromEntries(Object.entries(st.locations).map(([k, v]) => [k, v.at.map((x) => +x.toFixed(1))])), rooms: Object.fromEntries(Object.entries(st.rooms).flatMap(([l, rs]) => Object.entries(rs).map(([k, v]) => [k, v.at.map((x) => +x.toFixed(0))]))), locks: st.locks.map((l) => [l.id, l.at.map((x) => +x.toFixed(0))]) };
  });
  console.log(`     staged: ${JSON.stringify(stage)}`);
  await shot(p, '01-spawn');
  await whereToGo(p);
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
  await walkTo(p, door, 'the bone door', 4);
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
        // (a tap on the foe when it's out of reach — the hero finds its way to it — and the swing held when it's close)
        if (d > 2.2) r.seek(t.id);
        r.pad.scripted = { attack: d < 3 };
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
  // (round 97: every talk opened and closed from here on, for the failure print)
  await p.evaluate(() => {
    const d = window.reclaimed.run.play.dialog;
    window.__talks = [];
    d.onOpen.push((t) => window.__talks.push(`open ${t.id} ${Math.round(performance.now())}`));
    d.onClose.push((t, path) => window.__talks.push(`close ${t.id} ${JSON.stringify(path)} ${Math.round(performance.now())}`));
  });
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

/** (round 94) where to go: the arrow or marker, the objective's line, the map's pin; then a walk after the arrow */
async function whereToGo(p) {
  const w = await p.evaluate(() => {
    const r = window.reclaimed.run;
    const vis = (s) => {
      const e = document.querySelector(s);
      return !!e && e.style.display !== 'none';
    };
    return { target: r.target && { name: r.target.name, kind: r.target.kind }, arrow: vis('.wp-arrow'), marker: vis('.wp-marker'), hint: document.querySelector('.objective .obj-where')?.textContent ?? null, dist: document.querySelector('.wp-dist')?.textContent };
  });
  ok(w.target?.name === 'Reeve Hesk Marr' && w.target.kind === 'person', `the first objective points at the reeve (${JSON.stringify(w.target)}), from the story's own "talked" condition`);
  ok(w.arrow || w.marker, `an arrow at the screen's edge (${w.arrow}, ${w.dist}) or a marker over him (${w.marker})`);
  ok(!!w.hint && /Reeve Hesk Marr/.test(w.hint) && /(north|south|east|west)/.test(w.hint) && / m$/.test(w.hint), `the objective says where: "${w.hint}"`);
  await shot(p, '09-arrow');
  // the map: the 🗺 button, as a tap on it
  const mapBtn = await p.$('button[title^="the atlas map"]');
  ok(!!mapBtn, 'the map button is there');
  if (mapBtn) {
    await mapBtn.click();
    await sleep(2500);
    const m = await p.evaluate(() => {
      const map = window.reclaimed.scene.atlasMap;
      return { open: map.isOpen, marks: map.marks?.().map((x) => x.name), player: map.playerAt?.(), facing: map.facing?.(), warp: map.canWarp };
    });
    ok(m.open && m.marks?.includes('Reeve Hesk Marr') && m.player && typeof m.facing === 'number', `the map open with the objective's pin (${m.marks}) and the hero's dot and facing; warp ${m.warp ? 'on' : 'off'}`);
    await shot(p, '10-map-pin');
    await p.keyboard.press('Escape');
    await sleep(600);
  }
  // after the arrow: the stick pushed the way it points, a few seconds (the GIF), the distance coming down
  const d0 = await p.evaluate(() => {
    const r = window.reclaimed.run;
    const h = r.hero.position();
    return Math.hypot(r.target.at[0] - h[0], r.target.at[1] - h[1]);
  });
  await gif(p, '11-follow-arrow', async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 7000) {
      await p.evaluate(() => {
        const r = window.reclaimed.run;
        const el = document.querySelector('.wp-arrow');
        const m = /rotate\(([-\d.]+)rad\)/.exec(el?.style.transform ?? '');
        // (the arrow's screen angle is the stick's: up the screen is away from the camera)
        const a = m ? Number(m[1]) : null;
        r.pad.scripted = a === null ? null : { stick: [Math.cos(a) * 56, Math.sin(a) * 56] };
      });
      await sleep(150);
    }
    await p.evaluate(() => (window.reclaimed.run.pad.scripted = null));
  });
  const d1 = await p.evaluate(() => {
    const r = window.reclaimed.run;
    const h = r.hero.position();
    return Math.hypot(r.target.at[0] - h[0], r.target.at[1] - h[1]);
  });
  ok(d1 < d0 - 20, `following the arrow for 7 s: ${d0.toFixed(0)} → ${d1.toFixed(0)} cells to the reeve`);
}

/**
 * (round 99) The stage as it stands: each built piece's top over its base (null: its spot not in the window), the
 * locks, the cast (world spots, alive), the stamps and the window's slides.
 */
const places = (p) =>
  p.evaluate(() => {
    const R = window.reclaimed;
    const r = R.run;
    const S = R.scene.stream;
    const t = R.api.terrain;
    const rel = r.land.pieces.map((q) => {
      if (q.grow || q.layers <= 0 || q.base === undefined) return null;
      const [x, y] = r.winOf(q.at);
      const z = t.heightAt(x, y);
      return z === null ? null : { tag: q.tag, layers: q.layers, rel: +(z + S.oz - q.base).toFixed(2), gone: !!q.gone };
    });
    const cast = Object.fromEntries(
      r.play.d.story.cast.map((c) => {
        const u = r.units.get(r.play.unitOf(c.id));
        return [c.id, u ? { at: r.worldOf([u.at[0], u.at[1]]).map((v) => +v.toFixed(1)), alive: u.alive } : null];
      }),
    );
    return { rel, locks: r.stage.locks.map((k) => ({ id: k.id, open: k.open })), cast, land: { ...r.land.stats }, slides: S.stats.slides, frozen: S.stats.frozen, thawed: S.stats.thawed, generated: S.stats.generated, origin: [...S.origin] };
  });

/** (round 99) two looks at the stage: the pieces seen both times within a cell of their height, the same people alive where they were */
function samePlaces(a, b, what) {
  let both = 0;
  let same = 0;
  let up0 = 0;
  let up1 = 0;
  const off = [];
  a.rel.forEach((x, i) => {
    const y = b.rel[i];
    if (!x || !y) return;
    both++;
    if (Math.abs(x.rel - y.rel) < 1.2) same++;
    else if (off.length < 6) off.push(`${x.tag} ${x.rel}->${y.rel}`);
    if (x.rel >= x.layers * 0.7) up0++;
    if (y.rel >= y.layers * 0.7) up1++;
  });
  ok(both > 200 && same >= both * 0.95 && up1 >= up0 * 0.95, `${what}: the places' ${both} pieces seen both times, ${same} at the same height, ${up0} -> ${up1} standing${off.length ? ` (off: ${off.join(', ')})` : ''}`);
  ok(JSON.stringify(a.locks) === JSON.stringify(b.locks), `${what}: the locks as they were (${a.locks.map((k) => `${k.id} ${k.open ? 'open' : 'shut'}`).join(', ')})`);
  const moved = Object.entries(a.cast).filter(([id, c]) => !c || !b.cast[id] || c.alive !== b.cast[id].alive || Math.hypot(c.at[0] - b.cast[id].at[0], c.at[1] - b.cast[id].at[1]) > 2);
  ok(!moved.length, `${what}: the cast where they were, alive (${moved.length ? JSON.stringify(moved.map(([id]) => [id, a.cast[id], b.cast[id]])) : Object.keys(a.cast).join(', ')})`);
}

/** (round 94) the map's warp in a run: the hero goes with it, the story goes on (round 99: and back, the places there) */
async function warp() {
  console.log('--- warp: the map moves the hero, the run goes on');
  const p = await open();
  await sleep(12000);
  const before = await p.evaluate(() => {
    const R = window.reclaimed;
    const h = R.run.hero.position();
    return { cell: R.scene.atlasMap.playerAt(), h };
  });
  const s0 = await places(p);
  console.log(`     the stage stamped: ${JSON.stringify(s0.land)}; ${s0.rel.filter(Boolean).length} pieces in the window`);
  await (await p.$('button[title^="the atlas map"]')).click();
  await sleep(2500);
  // a tap on the map a little way from the middle: a warp there
  await p.mouse.click(206 + 60, 457 - 40);
  for (let k = 0; k < 60; k++) {
    await sleep(1000);
    const done = await p.evaluate(() => !window.reclaimed.scene.atlasMap.isOpen && window.reclaimed.api.fresh);
    if (done) break;
  }
  await sleep(4000);
  const after = await p.evaluate(() => {
    const R = window.reclaimed;
    const h = R.run.hero.position();
    const t = R.camera.target;
    return { cell: R.scene.atlasMap.playerAt(), h, t, over: R.run.play.run.over, shown: R.run.play.run.objectives().filter((o) => o.state === 'shown').map((o) => o.id), hint: document.querySelector('.objective .obj-where')?.textContent };
  });
  const moved = Math.hypot(after.cell[0] - before.cell[0], after.cell[1] - before.cell[1]);
  ok(moved > 100, `the hero went with the warp: ${moved.toFixed(0)} cells across the atlas`);
  ok(Math.hypot(after.h[0] - after.t[0], after.h[1] - after.t[1]) < 6, 'it stands where the view is (the window\'s middle)');
  ok(!after.over && after.shown.length > 0 && !!after.hint, `the run goes on: ${after.shown} shown, "${after.hint}"`);
  await shot(p, '12-after-warp');
  // (round 99, RS16) and back where the run began: the window made again from the atlas, the places stamped on it
  await p.evaluate((c) => window.reclaimed.scene.atlasMap.warpTo(c[0], c[1]), before.cell);
  for (let k = 0; k < 60; k++) {
    await sleep(1000);
    if (await p.evaluate(() => !window.reclaimed.scene.stream.busy && window.reclaimed.api.fresh)) break;
  }
  await sleep(6000);
  const s1 = await places(p);
  console.log(`     back: ${JSON.stringify(s1.land)}`);
  samePlaces(s0, s1, 'warped away and back');
  await shot(p, '13-warped-back');
  await p.close();
}

/** (round 99, RS9) a ride far away and back with the window streaming: the places, the door opened and the cast as they were */
async function far() {
  console.log('--- far: the bone door opened, a ride three regions away and back, the window streaming');
  const p = await open();
  await sleep(15000);
  // (the key given, as Hesk would give it; the door opened the way a player opens it: coming to it holding the key)
  await p.evaluate(() => window.reclaimed.run.play.run.items.set('bone key', 1));
  const oss = await roomAt(p, 'loc-barrow', 'ossuary');
  await p.evaluate((st) => window.reclaimed.run.hero.place(window.reclaimed.run.winOf(st)), oss);
  await sleep(1500);
  const door = await p.evaluate(() => window.reclaimed.run.stage.locks.find((l) => l.id === 'bone-door').at);
  await walkTo(p, door, 'the bone door', 4);
  await sleep(3000);
  ok(await p.evaluate(() => window.reclaimed.run.stage.locks.find((l) => l.id === 'bone-door').open), 'the bone door opened with the key');
  await sleep(4000);
  const s0 = await places(p);
  const start = await p.evaluate(() => window.reclaimed.run.worldOf(window.reclaimed.run.hero.position().slice(0, 2)));
  // the ride: the hero put down 8 cells on every 0.5 s (a hover bike's pace), the camera after it, the window sliding
  const ride = async (from, dx, dy, n) => {
    let at = from;
    for (let k = 1; k <= n; k++) {
      const want = [from[0] + dx * k, from[1] + dy * k];
      const put = await p.evaluate((st) => {
        const r = window.reclaimed.run;
        const w = r.winOf(st);
        if (window.reclaimed.scene.stream.busy || window.reclaimed.api.terrain.heightAt(w[0], w[1], { smooth: true }) === null) return false;
        r.hero.place(w);
        return true;
      }, want);
      if (put) at = want;
      else k--;
      await sleep(500);
    }
    return at;
  };
  const away = await gif(p, '14-ride-away', () => ride(start, 8, 0, 26));
  const s1 = await places(p);
  const gone = Math.hypot(away[0] - start[0], away[1] - start[1]);
  ok(gone > 190 && s1.slides - s0.slides >= 3, `rode ${gone.toFixed(0)} cells away: the window slid ${s1.slides - s0.slides} times (${s1.frozen - s0.frozen} regions frozen), ${s1.rel.filter(Boolean).length} of the places' pieces still in it`);
  await ride(away, -8, 0, 26);
  for (let k = 0; k < 20 && (await p.evaluate(() => window.reclaimed.scene.stream.busy)); k++) await sleep(500);
  await sleep(6000);
  const s2 = await places(p);
  console.log(`     back: slides ${s2.slides - s0.slides}, thawed ${s2.thawed - s0.thawed}, generated ${s2.generated - s0.generated}, stamps ${JSON.stringify(s2.land)}`);
  samePlaces(s0, s2, 'rode away and back');
  await shot(p, '15-rode-back');
  // (and the place still plays: through the open door into the bell chamber, `reached` noted)
  ok(await walkTo(p, await roomAt(p, 'loc-barrow', 'bell-chamber'), 'the bell chamber', 4), 'walked through the open bone door into the bell chamber');
  await sleep(1500);
  ok(await p.evaluate(() => window.reclaimed.run.play.reached.has('loc-barrow/bell-chamber')), 'reached the bell chamber (the room measured in world units)');
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
  if (!only || only === 'warp') await warp();
  if (!only || only === 'far') await far();
} catch (e) {
  console.log('FAIL', e.stack ?? e);
  fails++;
} finally {
  await browser.close();
}
ok(pageErrors === 0, `no page errors (${pageErrors})`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
