// Round 128b (playmodes): the canyon run, one full pass — the course's canyon experiment with ▶ on (the game rides),
// the player's sideways push held on the first long straight (up the wall) — as a GIF at the phone's size, stills at
// the push, a hairpin and the exit, and the bike's numbers each frame (crashes, height over the floor, bank).
//   node scripts/canyonrun.mjs [--out C:/Projects/shots88/playmodes2] [--every 200] [--push a] [--tag canyon]
import fs from 'node:fs';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'canyonrun', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/playmodes2');
  const tag = R.opt('tag', 'canyon');
  const every = Number(R.opt('every', '200'));
  const pushKey = R.opt('push', 'a');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.level({ level: 'herocourse', try: 'canyon', auto: '1' });
  await p.waitForFunction(() => window.reclaimed?.course, { timeout: 60000, polling: 250 });
  await sleep(1500);
  const read = () =>
    p.evaluate(() => {
      const c = window.reclaimed.course;
      const h = c.session.hero;
      const b = h.b;
      const top = c.session.world.top(b.x, b.y);
      const rs = c.rivals.map((r) => r.hero.position()).map((q) => Math.hypot(q[0] - b.x, q[1] - b.y));
      return { riders: rs.length, near: rs.length ? Math.min(...rs) : -1, mode: c.live.mode, area: c.live.area, x: b.x, y: b.y, v: Math.hypot(b.vx, b.vy), up: c.live.overRoad, off: c.live.off, push: c.live.push, line: c.live.line, gap: b.z - top, bank: b.bank, crashed: b.crashed, drive: h.params.drive, wall: h.params.wallRide };
    });
  const enc = GIFEncoder();
  const log = [];
  let crashes = 0;
  let wasCrashed = false;
  let left = 0;
  let pushed = false;
  const stills = { push: null, hairpin: null, exit: null };
  for (let i = 0; i < 220; i++) {
    const st = await read();
    log.push(st);
    if (st.crashed > 0 && !wasCrashed && st.area === 'canyon') crashes++;
    wasCrashed = st.crashed > 0;
    // (the push: on the second long run, east, held 1.3 s)
    if (!pushed && st.area === 'canyon' && st.y > 82 && st.y < 90 && st.x < 214 && st.x > 204) {
      pushed = true;
      await p.keyboard.down(pushKey);
      setTimeout(() => p.keyboard.up(pushKey), 1300);
      setTimeout(async () => {
        stills.push = `${out}/${tag}-1-wall.png`;
        await p.screenshot({ path: stills.push });
      }, 1000);
    }
    const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
    const pal = quantize(png.data, 256);
    enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: every });
    // (a hairpin: the second west one, round x 182-186; the exit: the run north past y 125)
    if (!stills.hairpin && st.area === 'canyon' && st.x < 186 && st.y > 88) {
      stills.hairpin = `${out}/${tag}-2-hairpin.png`;
      fs.writeFileSync(stills.hairpin, PNG.sync.write(png));
    }
    if (!stills.exit && st.area === 'canyon' && st.x > 236 && st.y > 128) {
      stills.exit = `${out}/${tag}-3-exit.png`;
      fs.writeFileSync(stills.exit, PNG.sync.write(png));
    }
    if (i % 8 === 0) fs.writeFileSync(`${out}/${tag}-f${String(i).padStart(3, '0')}.png`, PNG.sync.write(png));
    if (st.area === 'canyon') left = 1;
    else if (left && st.area === 'river') break;
    await sleep(every);
  }
  enc.finish();
  fs.writeFileSync(`${out}/${tag}-pass.gif`, enc.bytes());
  fs.writeFileSync(`${out}/${tag}-pass.json`, JSON.stringify(log));
  const canyon = log.filter((s) => s.area === 'canyon');
  const maxUp = Math.max(...canyon.map((s) => s.up));
  const maxBank = Math.max(...canyon.map((s) => Math.abs(s.bank)));
  const meanV = canyon.reduce((a, s) => a + s.v, 0) / Math.max(1, canyon.length);
  R.log(`frames ${log.length}, canyon ${canyon.length}, crashes ${crashes}, passed, mean v ${meanV.toFixed(1)}, max up ${maxUp.toFixed(1)}, max bank ${maxBank.toFixed(2)}, drive ${log[log.length - 1]?.drive}/${canyon[0]?.drive} wall ${canyon[0]?.wall}`);
  R.log(`stills ${JSON.stringify(stills)}`);
  if (crashes > 0) R.fail?.(`${crashes} crashes in the canyon`);
});
