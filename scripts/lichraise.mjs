// merge123 (BACKLOG LW1-1 / M123-3): play's lich raising the dead through the trait system, on the atlas with every
// system in play (?play=lich, 1x). Raiders spawned round the lich, struck down, then its raise
// button: the bodies stand up undead and follow it. Shots and a GIF; checks bodies lay and some rose and follow.
//   node scripts/lichraise.mjs [--out C:/Projects/shots88/merge123/lich] [--kill strike|slam]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'lichraise', kind: 'behaviour', size: '412x915', dpr: 2 }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/merge123/lich');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.level({ level: 'atlas', play: 'lich', q: R.opt('q', 'low') });
  await sleep(30000);
  await R.fatal(p);
  const shot = (name) => p.screenshot({ path: path.join(out, name) });
  const gif = async (name, frames, every) => {
    const enc = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      const t = Date.now();
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      const w2 = png.width >> 1;
      const h2 = png.height >> 1;
      const half = new Uint8Array(w2 * h2 * 4);
      for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) for (let c = 0; c < 4; c++) half[(y * w2 + x) * 4 + c] = png.data[(2 * y * png.width + 2 * x) * 4 + c];
      const pal = quantize(half, 256);
      enc.writeFrame(applyPalette(half, pal), w2, h2, { palette: pal, delay: every });
      await sleep(Math.max(0, every - (Date.now() - t)));
    }
    enc.finish();
    fs.writeFileSync(path.join(out, name), enc.bytes());
    R.log(`saved ${name}`);
  };
  const press = (buttons) =>
    p.evaluate((b) => {
      window.reclaimed.play.session.controls.script = b ? { stick: [0, 0], buttons: b } : null;
    }, buttons);
  const count = () =>
    p.evaluate(async () => {
      const r = window.reclaimed;
      const [x, y] = r.play.session.hero.position();
      // (round 128p, U1: a query is asked of the GPU — async; each answer with its place)
      const all = await r.units.query([x, y], 14, { dead: true });
      const live = all.filter((u) => u.alive);
      const h = r.play.session.hero;
      return {
        near: all.length,
        alive: live.length,
        dead: all.length - live.length,
        following: live.filter((u) => u.job?.kind === 'follow').length,
        hostile: live.filter((u) => u.hostile).length,
        hero: { at: h.position().map((v) => +v.toFixed(1)), alive: h.alive, camera: r.camera.target.map((v) => +v.toFixed(1)) },
        units: live.slice(0, 4).map((u) => ({ at: u.at.map((v) => +v.toFixed(1)), state: u.state })),
      };
    });
  // a ring of raiders round the lich
  await p.evaluate(() => {
    const r = window.reclaimed;
    const [x, y] = r.play.session.hero.position();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      r.units.spawn('raider', [x + Math.cos(a) * 3.5, y + Math.sin(a) * 3.5], 'f-raiders', { hostile: true, health: 3, sight: 24, role: 'raider' });
    }
  });
  await R.simSeconds(p, 1);
  await shot('01-raiders.png');
  // struck down: by default a plain blow round the lich (--kill strike); --kill slam uses its slam button, whose crater
  // hides the lich from view afterwards (pre-existing on places, BACKLOG M123-9)
  if (R.opt('kill', 'strike') === 'slam') {
    for (let k = 0; k < 4; k++) {
      await press([true]);
      await R.simSeconds(p, 0.2);
      await press([false]);
      await R.simSeconds(p, 1.3);
    }
  } else {
    await p.evaluate(() => {
      const r = window.reclaimed;
      const [x, y] = r.play.session.hero.position();
      r.units.strike({ at: [x, y], radius: 6, damage: 10, push: 2 }, 'hero');
    });
  }
  await R.simSeconds(p, 1.5);
  const c0 = await count();
  R.log(`after the slams ${JSON.stringify(c0)}`);
  await shot('02-fallen.png');
  // raise (button 2)
  await press([false, false, true]);
  await R.simSeconds(p, 0.2);
  await press(null);
  await gif('03-raise.gif', 24, 200);
  await R.simSeconds(p, 2);
  const c1 = await count();
  R.log(`after the raise ${JSON.stringify(c1)}`);
  await shot('03-raised.png');
  R.check('the slams leave bodies', c0.dead >= 3, c0);
  R.check('the raise stands some up following the lich', c1.following >= 3, c1);
});
