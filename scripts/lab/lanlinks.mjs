// (loop round 15) The owner's phone links checked from a headless browser on the LAN address: each loads to the leader
// screen (no fatal overlay). Point it at the HTTPS dev server and let Chrome take its self-signed cert:
//   node scripts/lab/lanlinks.mjs --server https://<lan ip>:<port> --chromeargs ignore-certificate-errors [--out dir]
//        [--links "/?a=1|/?b=2"]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'lanlinks', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'lanlinks');
  fs.mkdirSync(out, { recursive: true });
  const base = '/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low';
  const links = R.opt('links', `${base}|${base}&packs=frontier,ages,arena`).split('|');
  const p = await R.page();
  for (const [k, l] of links.entries()) {
    const url = `${R.url}${l}`;
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 400000, polling: 500 });
    await R.fatal(p);
    const packs = await p.evaluate(() => (window.rungame.packs ?? []).map((x) => x.id ?? x.name));
    await p.screenshot({ path: path.join(out, `link-${k}.png`) });
    R.check(`${url} loads to the leader screen`, true, { packs });
  }
});
