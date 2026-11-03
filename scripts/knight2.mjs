// (knight pass 2, round 128) The knight's second pass on its station, every system in play at 1x, at 412x915:
//   m1  the lunge through a crowd: a pack of 8 raiders, the knight on one side, slashes only (counted, timed) to the
//       far side; the start's help card (KN-R1)
//   m2  the guard (blocks but in its wind-up) and the lunger (dodges but when down after its lunge)
//   m3  the jump course, the jump attack, the lock-on
//   m4  the parry variants, the hook gun
// GIFs, contact sheets and stills go to --out (default C:/Projects/shots88/knight2).
//   node scripts/knight2.mjs --phase m1 [--settle 30000]
import fs from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'knight2', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/knight2');
  const phases = String(R.opt('phase', 'm1')).split(',');
  fs.mkdirSync(out, { recursive: true });
  const page = await R.page();
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const p = await R.level({ level: 'atlas', play: 'knight', station: '1' }, { page });
  await p.waitForFunction(() => window.reclaimed?.play?.hero, { timeout: 120000, polling: 250 });
  // (the start, before the settle: the help card as the player first sees it — KN-R1)
  await sleep(1500);
  await p.screenshot({ path: path.join(out, 'start-card.png') });
  await sleep(Number(R.opt('settle', 30000)));
  const cdp = p.cdp;
  const fingers = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...fingers.entries()].map(([id, [x, y]]) => ({ x, y, id })) });
  const down = async (id, x, y) => {
    fingers.set(id, [x, y]);
    await send('touchStart');
  };
  const up = async (id) => {
    const at = fingers.get(id);
    fingers.delete(id);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: at[0], y: at[1], id }] });
  };
  /** a stroke dispatched in the page as touch pointer events on the play pad, `ms` apart (a finger's timing) */
  const stroke = (pts, ms = 16, hold = 0) =>
    p.evaluate(
      async (pts, ms, hold) => {
        const pad = document.querySelector('.play-pad');
        const id = 40 + Math.floor(Math.random() * 1000);
        const ev = (type, [x, y]) => pad.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: false }));
        const wait = (t) => new Promise((r) => setTimeout(r, t));
        ev('pointerdown', pts[0]);
        for (const q of pts.slice(1)) {
          await wait(ms);
          ev('pointermove', q);
        }
        if (hold) await wait(hold);
        ev('pointerup', pts[pts.length - 1]);
      },
      pts,
      ms,
      hold,
    );
  const line = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  const hero = () => p.evaluate(() => ({ at: window.reclaimed.play.hero.position(), stats: { ...window.reclaimed.play.hero.stats }, act: window.reclaimed.play.hero.act?.kind, hp: window.reclaimed.play.hero.health }));
  /** the screen direction of a ground step (dx, dy) from the knight */
  const screenDir = (dx, dy) =>
    p.evaluate(
      (dx, dy) => {
        const r = window.reclaimed;
        const [x, y, z] = r.play.hero.position();
        const a = r.core.camera.project(x, y, z);
        const b = r.core.camera.project(x + dx, y + dy, z);
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
      },
      dx,
      dy,
    );
  const button = async (name) => {
    const r = await p.evaluate((n) => {
      const b = [...document.querySelectorAll('.play-btn')].find((e) => e.querySelector('small')?.textContent === n);
      if (!b) return null;
      const q = b.getBoundingClientRect();
      return [q.x + q.width / 2, q.y + q.height / 2];
    }, name);
    if (!r) throw new Error(`no button ${name}`);
    await down(5, r[0], r[1]);
    await sleep(60);
    await up(5);
    await sleep(60);
  };
  const station = async (label) => {
    await p.evaluate((l) => [...document.querySelectorAll('.play-station button')].find((b) => b.textContent === l).click(), label);
    await sleep(300);
  };
  const kept = [];
  /** a GIF captured while `act` runs, with a contact sheet of a dozen frames and a still */
  const gif = async (name, frames, every, act) => {
    const enc = GIFEncoder();
    let done = false;
    const cap = (async () => {
      for (let i = 0; i < frames && !done; i++) {
        const t0 = Date.now();
        const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
        kept.push(png);
        const pal = quantize(png.data, 128);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
        await sleep(Math.max(0, every - (Date.now() - t0)));
      }
    })();
    await act();
    done = true;
    await cap;
    enc.finish();
    fs.writeFileSync(path.join(out, name), enc.bytes());
    const sheet = new PNG({ width: 4 * 206, height: Math.ceil(Math.min(12, kept.length) / 4) * 240 });
    const step = Math.max(1, Math.floor(kept.length / 12));
    kept.filter((_, i) => i % step === 0).slice(0, 12).forEach((f, k) => {
      const ox = (k % 4) * 206;
      const oy = Math.floor(k / 4) * 240;
      for (let y = 0; y < 240; y++)
        for (let x = 0; x < 206; x++) {
          const si = ((217 + y * 2) * f.width + x * 2) * 4;
          const di = ((oy + y) * sheet.width + ox + x) * 4;
          for (let c = 0; c < 4; c++) sheet.data[di + c] = f.data[si + c];
        }
    });
    fs.writeFileSync(path.join(out, name.replace('.gif', '-sheet.png')), PNG.sync.write(sheet));
    if (kept.length) fs.writeFileSync(path.join(out, name.replace('.gif', '-still.png')), PNG.sync.write(kept[Math.floor(kept.length * 0.4)]));
    kept.length = 0;
    R.log(`saved ${name}`);
  };
  const S = [260, 330];
  const start = (await hero()).at;
  const home = () => p.evaluate((at) => window.reclaimed.play.hero.place([at[0], at[1]]), start);

  if (phases.includes('m1')) {
    // ---- the lunge through a crowd: 8 raiders in a pack 2.5 cells ahead (+x), the knight slashing that way only
    await home();
    await station('Clear');
    await sleep(500);
    const ids = await p.evaluate(() => {
      const r = window.reclaimed;
      const [x, y] = r.play.hero.position();
      const out = [];
      for (let i = 0; i < 4; i++)
        for (const [ox, oy] of [[3.5, -1.5 + i], [5.5, -1 + i]]) out.push(r.units.spawn('raider', [x + ox, y + oy], 'f-raiders', { hostile: true, health: 40, sight: 30, speed: 3.5, role: 'raider' }));
      return out;
    });
    await sleep(400);
    const d = await screenDir(1, 0);
    const c0 = await hero();
    const t0 = Date.now();
    let slashes = 0;
    let far = 0;
    await gif('crowd.gif', 40, 90, async () => {
      for (; slashes < 16; ) {
        const h = await hero();
        // (past the pack: every raider's x behind the knight by a cell)
        far = await p.evaluate((ids) => {
          const r = window.reclaimed;
          const [x] = r.play.hero.position();
          const xs = ids.map((id) => r.units.get(id)).filter((u) => u && u.alive).map((u) => u.at[0]);
          return xs.length ? x - Math.max(...xs) : 99;
        }, ids);
        // (the window may slide under it: x is measured against the pack, not the start)
        if (far > 1) break;
        void h;
        await stroke(line(S, [S[0] + d[0] * 70, S[1] + d[1] * 70], 4), 14);
        slashes++;
        await sleep(330);
      }
      await sleep(600);
    });
    const c1 = await hero();
    const secs = (Date.now() - t0) / 1000;
    R.log(`crowd: ${slashes} slashes, ${secs.toFixed(1)} s (incl. the capture's load), moved ${(c1.at[0] - c0.at[0]).toFixed(1)} cells along x, past the last raider by ${far.toFixed(1)}; lunges ${c1.stats.lunges - c0.stats.lunges}, dashed ${(c1.stats.dashed - c0.stats.dashed).toFixed(1)} cells, hits ${c1.stats.hits - c0.stats.hits}, hurt ${c0.hp - c1.hp}`);
    R.check('slashes carry the knight through the pack to the far side', far > 1, { slashes, far });
    await p.screenshot({ path: path.join(out, 'crowd-end.png') });
    await p.evaluate((ids) => ids.forEach((id) => window.reclaimed.units.remove(id)), ids);
  }

  // ---- helpers for the enemies: one spawned (dx, dy) from the knight, its state, the screen way to it, a swipe at it
  const spawnAt = (kind, dx, dy, o = {}) =>
    p.evaluate(
      (kind, dx, dy, o) => {
        const r = window.reclaimed;
        const [x, y] = r.play.hero.position();
        return r.units.spawn(kind, [x + dx, y + dy], 'f-raiders', { hostile: true, health: 30, sight: 30, speed: 3.5, role: kind, ...o });
      },
      kind,
      dx,
      dy,
      o,
    );
  const unit = (id) => p.evaluate((id) => window.reclaimed.units.get(id), id);
  const screenOf = (x, y, z) => p.evaluate((x, y, z) => window.reclaimed.core.camera.project(x, y, z), x, y, z);
  const wayTo = (id) =>
    p.evaluate((id) => {
      const r = window.reclaimed;
      const u = r.units.get(id);
      const [x, y, z] = r.play.hero.position();
      const a = r.core.camera.project(x, y, z);
      const b = r.core.camera.project(u.at[0], u.at[1], u.at[2]);
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
    }, id);
  const swipeAt = async (id) => {
    const d = await wayTo(id);
    await stroke(line(S, [S[0] + d[0] * 70, S[1] + d[1] * 70], 4), 14);
  };
  const waitFor = async (f, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await f()) return true;
      await sleep(40);
    }
    return false;
  };
  const tally = () => p.evaluate(() => ({ ...window.reclaimed.play.station.tally }));
  const tap = async ([x, y]) => stroke([[x, y], [x + 2, y + 1]], 30);
  const removeAll = (ids) => p.evaluate((ids) => ids.forEach((id) => window.reclaimed.units.remove(id)), ids);

  if (phases.includes('m2')) {
    // ---- the guard: slashed while it stands (blocked), then in its wind-up (lands)
    await home();
    await station('Clear');
    await sleep(500);
    const g = await spawnAt('blocker', 5, 0);
    await sleep(300);
    const t0 = await tally();
    let inWind = false;
    await gif('guard.gif', 50, 90, async () => {
      // (as it comes, not yet winding up, within a slash's reach and dash: blocked)
      await waitFor(async () => {
        const u = await unit(g);
        const h = await hero();
        return u && u.state !== 'swing' && Math.hypot(u.at[0] - h.at[0], u.at[1] - h.at[1]) < 3;
      }, 6000);
      await swipeAt(g);
      await sleep(900);
      // (its wind-up: the units' state 'swing' — then a swipe while it's still winding up)
      inWind = await waitFor(async () => (await unit(g))?.state === 'swing', 6000);
      if (inWind) {
        await sleep(120);
        await swipeAt(g);
      }
      await sleep(1500);
    });
    const t1 = await tally();
    R.log(`guard: blocked ${t1.blocked - t0.blocked}, dodged ${t1.dodged - t0.dodged}, landed ${t1.landed - t0.landed}; caught its wind-up ${inWind}`);
    R.check('the guard blocks a slash while it stands', t1.blocked - t0.blocked >= 1, { blocked: t1.blocked - t0.blocked });
    R.check('a slash in its wind-up lands', t1.landed - t0.landed >= 1, { landed: t1.landed - t0.landed, inWind });
    await removeAll([g]);

    // ---- the lunger: slashed as it comes (dodged), it lunges, slashed while it lies stunned (lands)
    await home();
    await sleep(500);
    const l = await spawnAt('lunger', 6, 0);
    await sleep(300);
    const l0 = await tally();
    let lunged = false;
    await gif('lunger.gif', 50, 90, async () => {
      await waitFor(async () => {
        const u = await unit(l);
        const h = await hero();
        return u && Math.hypot(u.at[0] - h.at[0], u.at[1] - h.at[1]) < 4.5;
      }, 6000);
      await swipeAt(l);
      // (it lunges: thrown, 'hurt' in the units' view; once it lies still a moment, a slash)
      lunged = await waitFor(async () => (await unit(l))?.state === 'hurt', 6000);
      if (lunged) {
        await sleep(650);
        const st = await p.evaluate((id) => {
          const r = window.reclaimed;
          const u = r.units.get(id);
          const [x, y] = r.play.hero.position();
          return { state: u?.state, d: u ? Math.hypot(u.at[0] - x, u.at[1] - y) : null, act: r.play.hero.act.kind };
        }, l);
        await swipeAt(l);
        await sleep(200);
        const aim = await p.evaluate(() => window.reclaimed.play.hero.lastAim);
        R.log(`lunger at the swipe: ${JSON.stringify(st)}; aim ${JSON.stringify(aim)}`);
      }
      await sleep(1600);
    });
    const l1 = await tally();
    R.log(`lunger: dodged ${l1.dodged - l0.dodged}, blocked ${l1.blocked - l0.blocked}, landed ${l1.landed - l0.landed}; lunged ${lunged}; the knight hurt ${(await hero()).hp}`);
    R.check('the lunger dodges a slash before its lunge', l1.dodged - l0.dodged >= 1, { dodged: l1.dodged - l0.dodged });
    R.check('down after its lunge, a slash lands', l1.landed - l0.landed >= 1, { landed: l1.landed - l0.landed, lunged });
    await removeAll([l]);
    await p.evaluate(() => window.reclaimed.play.respawn());
  }

  if (phases.includes('m3')) {
    // ---- the button cluster, at rest
    await home();
    await station('Clear');
    await sleep(800);
    await p.screenshot({ path: path.join(out, 'buttons.png') });
    // ---- the jump course: built ahead, then the stick that way and JUMP onto each step
    await p.evaluate(() => (window.reclaimed.play.hero.f.heading = 0));
    await station('Course');
    await sleep(3500);
    const ground = (await hero()).at[2];
    const heights = await p.evaluate(() => {
      const r = window.reclaimed;
      const [x, y] = r.play.hero.position();
      return [5, 10, 15, 18.6, 22].map((k) => +r.play.world.floor(x + k, y).toFixed(2));
    });
    R.log(`course ground ${ground.toFixed(2)}, tops at 5/10/15/gap 18.6/22 cells: ${JSON.stringify(heights)}`);
    const fwd = await screenDir(1, 0);
    let top = ground;
    // (the scripted stick is on the screen: the course's way, +x on the ground, as the screen shows it)
    await gif('jump-course.gif', 70, 90, async () => {
      // (the stick up the course; JUMP pressed when the ground 1.6 cells ahead stands more than a step over the feet)
      const t0 = Date.now();
      while (Date.now() - t0 < 7000) {
        const s = await p.evaluate((fwd) => {
          const r = window.reclaimed;
          const h = r.play.hero;
          const [x, y, z] = h.position();
          const ahead = r.play.world.floor(x + 1.6, y);
          const go = h.f.air === 0 && ahead - z > 0.8;
          r.play.controls.script = { stick: fwd, buttons: [go] };
          return { z, go };
        }, fwd);
        top = Math.max(top, s.z);
        await sleep(s.go ? 80 : 40);
      }
      await p.evaluate(() => (window.reclaimed.play.controls.script = null));
    });
    const end = await hero();
    R.log(`jump course: reached z ${end.at[2].toFixed(2)} (ground ${ground.toFixed(2)}, highest ${top.toFixed(2)}), jumps ${end.stats.jumps}`);
    R.check('JUMP takes the knight up the course', top - ground > 4, { rise: end.at[2] - ground, top: top - ground, jumps: end.stats.jumps });
    await p.screenshot({ path: path.join(out, 'jump-course-end.png') });

    // ---- the jump attack on a raider
    await home();
    await sleep(600);
    const r = await spawnAt('raider', 2.6, 0, { sight: 2, speed: 0.01 });
    await sleep(800);
    const j0 = await hero();
    const ja0 = await tally();
    await gif('jump-attack.gif', 30, 90, async () => {
      await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, 0], buttons: [true] }));
      await sleep(60);
      await p.evaluate(() => (window.reclaimed.play.controls.script = null));
      await sleep(260);
      await swipeAt(r);
      await sleep(1600);
    });
    const j1 = await hero();
    const ja1 = await tally();
    R.log(`jump attack: plunges ${j1.stats.plunges - j0.stats.plunges}, slams ${j1.stats.slams - j0.stats.slams}, landed ${ja1.landed - ja0.landed}`);
    R.check('a swipe in the air slams down on the raider', j1.stats.slams > j0.stats.slams && ja1.landed > ja0.landed, { slams: j1.stats.slams - j0.stats.slams, landed: ja1.landed - ja0.landed });
    await removeAll([r]);

    // ---- the lock-on: three raiders round; tap one, then run at it and slash
    await home();
    await sleep(400);
    const ids = [await spawnAt('raider', 6, 3), await spawnAt('raider', -5, 4), await spawnAt('raider', 1, -6)];
    await sleep(900);
    // (one on the screen where a right thumb taps: not in the stick's zone, not under the station's card)
    let pick = ids[0];
    let sp = null;
    for (const id of ids) {
      const u = await unit(id);
      const q = await screenOf(u.at[0], u.at[1], u.at[2] + 0.8);
      if (q[0] > 20 && q[0] < 392 && q[1] > 340 && q[1] < 880 && !(q[0] < 412 * 0.45 && q[1] > 915 * 0.5) && !(q[0] > 290 && q[1] > 600)) {
        pick = id;
        sp = q;
        break;
      }
    }
    if (!sp) {
      const u = await unit(ids[0]);
      sp = await screenOf(u.at[0], u.at[1], u.at[2] + 0.8);
    }
    ids.splice(ids.indexOf(pick), 1);
    ids.unshift(pick);
    R.log(`lock: tapping ${pick} at ${sp.map(Math.round)}`);
    const k0 = await hero();
    let locked = null;
    await gif('lock-chase.gif', 50, 90, async () => {
      await tap(sp);
      await sleep(250);
      locked = await p.evaluate(() => window.reclaimed.play.hero.lock);
      for (let k = 0; k < 8; k++) {
        const ok = await p.evaluate((id) => !!window.reclaimed.units.get(id)?.alive, ids[0]);
        if (!ok) break;
        // (a rough swipe: the screen's right, whatever way it really is)
        await stroke(line(S, [S[0] + 70, S[1] + 10], 4), 14);
        await sleep(380);
      }
      await sleep(600);
    });
    const k1 = await hero();
    R.log(`lock: locked ${locked} (wanted ${ids[0]}), locks ${k1.stats.locks - k0.stats.locks}, hits ${k1.stats.hits - k0.stats.hits}`);
    R.check('a tap on a raider locks it', locked === ids[0], { locked, id: ids[0] });
    await removeAll(ids);
  }

  if (phases.includes('m4')) {
    // ---- parry variants against a guard: PARRY tapped just before its blow; BLOCK held; a swipe in its wind-up
    const chip = (name) => p.evaluate((n) => [...document.querySelectorAll('.play-station button')].find((b) => b.textContent === n).click(), name);
    const results = {};
    for (const [mode, name] of [
      [1, 'Button'],
      [3, 'Hold'],
      [2, 'Swipe'],
    ]) {
      await home();
      await station('Clear');
      await chip(name);
      await sleep(400);
      const g = await spawnAt('blocker', 1.6, 0);
      const p0 = await hero();
      await gif(`parry-${name.toLowerCase()}.gif`, 34, 90, async () => {
        const wound = await waitFor(async () => (await unit(g))?.state === 'swing', 8000);
        if (!wound) return;
        if (mode === 1) {
          await sleep(560);
          await button('parry');
        } else if (mode === 3) {
          await sleep(520);
          const r = await p.evaluate(() => {
            const b = [...document.querySelectorAll('.play-btn')].find((e) => e.querySelector('small')?.textContent === 'block');
            const q = b.getBoundingClientRect();
            return [q.x + q.width / 2, q.y + q.height / 2];
          });
          await down(6, r[0], r[1]);
          await sleep(700);
          await up(6);
        } else {
          await sleep(80);
          await swipeAt(g);
        }
        await sleep(1400);
      });
      const p1 = await hero();
      results[name] = { parries: p1.stats.parries - p0.stats.parries, hurt: p0.hp - p1.hp };
      await removeAll([g]);
      await p.evaluate(() => window.reclaimed.play.respawn());
    }
    R.log(`parry variants: ${JSON.stringify(results)}`);
    R.check('each parry variant parried the guard', Object.values(results).every((r) => r.parries >= 1), results);
    await chip('Button');

    // ---- the hook gun: ⇄ twice to it; a tap on the course's top ledge zips up; a tap on a raider yanks it in
    await home();
    await station('Clear');
    await p.evaluate(() => (window.reclaimed.play.hero.f.heading = 0));
    await station('Course');
    await sleep(3500);
    await button('bow');
    await button('hook');
    const arm = await p.evaluate(() => window.reclaimed.play.hero.arm);
    const h0 = await hero();
    const ledge = await p.evaluate(() => {
      const r = window.reclaimed;
      const [x, y] = r.play.hero.position();
      const z = r.play.world.floor(x + 10, y);
      return r.core.camera.project(x + 10, y, z);
    });
    await gif('hook-zip.gif', 30, 90, async () => {
      await tap(ledge);
      await sleep(1800);
    });
    const h1 = await hero();
    R.log(`hook: arm ${arm}; zip from z ${h0.at[2].toFixed(2)} to ${h1.at[2].toFixed(2)}, x +${(h1.at[0] - h0.at[0]).toFixed(1)}; zips ${h1.stats.zips - h0.stats.zips}`);
    R.check('a tap on a ledge with the hook zips the knight up onto it', h1.at[2] - h0.at[2] > 2 && h1.stats.zips > h0.stats.zips, { rise: h1.at[2] - h0.at[2] });
    await home();
    await sleep(600);
    const r = await spawnAt('raider', 7, 2, { sight: 3, speed: 0.01 });
    await sleep(800);
    const ru = await unit(r);
    const rs = await screenOf(ru.at[0], ru.at[1], ru.at[2] + 0.8);
    await gif('hook-yank.gif', 30, 90, async () => {
      await tap(rs);
      await sleep(1600);
    });
    const r1 = await unit(r);
    const k = await hero();
    const near = Math.hypot(r1.at[0] - k.at[0], r1.at[1] - k.at[1]);
    R.log(`yank: the raider from ${Math.hypot(ru.at[0] - k.at[0], ru.at[1] - k.at[1]).toFixed(1)} to ${near.toFixed(1)} cells; hooks ${k.stats.hooks}`);
    R.check('a tap on a raider with the hook yanks it in', near < 3.5, { near });
    await removeAll([r]);
  }

  if (phases.includes('perf')) {
    // ---- desktop proxy: the station with a full wave (Wave × 3: 3 + 4 + 5 raiders), a scripted fight 15 s
    await home();
    await station('Clear');
    for (let k = 0; k < 3; k++) await station('Wave');
    await sleep(3000);
    let live = true;
    const fight = (async () => {
      let k = 0;
      while (live) {
        const a = k * 0.5;
        await p.evaluate((a) => (window.reclaimed.play.controls.script = { stick: [Math.cos(a), Math.sin(a)], buttons: [] }), a);
        const d = (k % 4) * (Math.PI / 2);
        await stroke(line(S, [S[0] + Math.cos(d) * 70, S[1] + Math.sin(d) * 70], 4), 14);
        k++;
        await sleep(380);
      }
      await p.evaluate(() => (window.reclaimed.play.controls.script = null));
    })();
    const ft = await p.evaluate(
      () =>
        new Promise((res) => {
          const t = [];
          const t0 = performance.now();
          const tick = (now) => {
            t.push(now);
            if (now - t0 < 15000) requestAnimationFrame(tick);
            else res(t);
          };
          requestAnimationFrame(tick);
        }),
    );
    live = false;
    await fight;
    const d = [];
    for (let i = 1; i < ft.length; i++) d.push(ft[i] - ft[i - 1]);
    d.sort((a, b) => a - b);
    const q = (x) => d[Math.min(d.length - 1, Math.floor(x * d.length))].toFixed(1);
    R.log(`perf (desktop proxy): ${d.length} frames in 15 s, p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, p99 ${q(0.99)} ms`);
    await station('Clear');
  }
});
