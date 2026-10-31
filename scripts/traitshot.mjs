// LW1 (traits): the playground's traits station, headless, with every system in play (q=low, 1x speed): the crowd, the
// lich's smite (bodies lying), the raise (the fallen stand up green and bone, and gather on the lich), a sanctuary (the
// living glow, the undead spark and fall), fear (the village flees its well), petrify (the walking dead turn to stone).
// Shots and GIFs, and the census after each step from the traits buffer.
//   node scripts/traitshot.mjs [--out C:/Projects/shots88/traits] [--size 412x915 --dpr 2] [--zoom 3.6]
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'traitshot', kind: 'behaviour', size: '412x915', dpr: 2 }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/traits');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.level({ level: 'playground', q: R.opt('q', 'low') });
  // (the first load after a server start is slow: judge nothing for 30 s)
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
  const click = (label) =>
    p.evaluate((label) => {
      const b = [...document.querySelectorAll('.stations button')].find((x) => x.textContent === label);
      if (!b) throw new Error(`no button ${label}`);
      b.click();
    }, label);
  const census = async (what) => {
    const c = await p.evaluate(async () => {
      const r = window.reclaimed;
      const t = await r.traitStation().census();
      return { ...t, corpses: r.agents.corpseCount, effects: r.traits.effects.length, stage: r.traits.stats };
    });
    R.log(`[${what}] ${JSON.stringify(c)}`);
    return c;
  };
  await p.evaluate((zoom) => {
    const r = window.reclaimed;
    r.scene.tunePanel?.toggle(false);
    // (the sandbox's tool panel covers half a phone's screen: out of the pictures)
    for (const el of document.querySelectorAll('.editor')) el.style.display = 'none';
    const i = r.scene.level.stations.findIndex((s) => s.id === 'traits');
    r.scene.stationsBar.pick(i);
    if (zoom) r.camera.zoom = zoom;
  }, Number(R.opt('zoom', 0)) || 0);
  await sleep(2500);
  await shot('00-station.png');

  await click('crowd');
  await R.simSeconds(p, 4);
  await shot('01-crowd.png');
  const c0 = await census('crowd');

  await click('smite');
  await R.simSeconds(p, 2);
  await shot('02-smite.png');
  const c1 = await census('smite');

  await click('raise');
  await gif('03-raise.gif', 24, 200);
  await shot('03-raised.png');
  const c2 = await census('raise');

  await click('sanctuary');
  await gif('04-sanctuary.gif', 32, 250);
  await shot('04-sanctuary.png');
  const c3 = await census('sanctuary');
  // close: the halos on the living, the sparks on the undead, the raised (green and bone) round the lich
  const far = await p.evaluate(() => {
    const c = window.reclaimed.camera;
    const was = { target: [...c.target], zoom: c.zoom };
    const [x, y, z] = c.target;
    c.target = [x - 3, y + 2, z];
    c.zoom = 26;
    return was;
  });
  await sleep(1200);
  await gif('04-sanctuary-close.gif', 20, 200);
  await shot('04-sanctuary-close.png');
  await p.evaluate((was) => {
    const c = window.reclaimed.camera;
    c.target = was.target;
    c.zoom = was.zoom;
  }, far);

  await click('fear');
  await gif('05-fear.gif', 20, 250);

  await click('petrify');
  await R.simSeconds(p, 2);
  await shot('06-petrify.png');
  const c4 = await census('petrify');

  R.check('the crowd stands: living and undead', (c0.living ?? 0) >= 150 && (c0.undead ?? 0) >= 80, c0);
  R.check('the smite leaves bodies', (c1.corpse ?? 0) > 5, c1);
  R.check('the raise stands them up undead', (c2.raised ?? 0) > 5, c2);
  R.check('the sanctuary heals and harms', (c3.healing ?? 0) + (c3.harmed ?? 0) > 5, c3);
  R.check('petrify turns the dead to stone', (c4.petrified ?? 0) > 5, c4);
});
