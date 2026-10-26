// The world wiki (docs/GM.md): the GM's facts about the world, as JSON (a WorldSnapshot and the atlas's
// settlements and roads) and as markdown (what the GM reads).
//
//   node scripts/worldwiki.mjs --pull [--url http://localhost:5231] [--seed 1]
//       builds the atlas in headless Chrome (?atlas=view), runs src/gm/atlas-facts.ts on it and caches
//       the result to data/atlas/seed<seed>.json. (The browser is shared: ask "main" first.)
//   node scripts/worldwiki.mjs [--seed 1] [--around x,y] [--radius 2600]
//       makes data/wiki/seed<seed>.json and data/wiki/seed<seed>.md from the cache (no browser). The
//       markdown details the land around a world point (default: the atlas's spawn).
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const seed = Number(arg('seed', 1));
const cache = path.join(root, 'data', 'atlas', `seed${seed}.json`);

if (argv.includes('--pull')) {
  const { default: puppeteer } = await import('puppeteer-core');
  const url = arg('url', 'http://localhost:5231');
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
    protocolTimeout: 600000,
  });
  try {
    const p = await browser.newPage();
    let err = null;
    p.on('pageerror', (e) => (err = e.message));
    await p.goto(`${url}/?atlas=view&a.seed=${seed}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.atlas?.defs?.length, { timeout: 300000 });
    if (err) throw new Error(`page error: ${err}`);
    const facts = await p.evaluate(async () => {
      const { atlasFacts } = await import('/src/gm/atlas-facts.ts');
      return atlasFacts(window.reclaimed.atlas);
    });
    if (facts.params.seed !== seed) throw new Error(`the page built seed ${facts.params.seed}, not ${seed}`);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(facts));
    console.log(`cached ${cache}: ${facts.regions.length} regions, ${facts.sites.length} sites, ${facts.roads.length} roads; spawn ${facts.spawn.cell} (region ${facts.spawn.region})`);
  } finally {
    await browser.close();
  }
  process.exit(0);
}

if (!fs.existsSync(cache)) throw new Error(`no atlas cache at ${cache}: run with --pull first (it needs the headless browser)`);
const facts = JSON.parse(fs.readFileSync(cache, 'utf8'));
const { buildWiki, wikiMarkdown } = await import('../src/gm/wiki.ts');
const around = arg('around', null);
const wiki = buildWiki(facts);
const md = wikiMarkdown(wiki, {
  around: around ? around.split(',').map(Number) : undefined,
  radius: Number(arg('radius', 2600)),
});
const out = path.join(root, 'data', 'wiki');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `seed${seed}.json`), JSON.stringify(wiki));
fs.writeFileSync(path.join(out, `seed${seed}.md`), md);
console.log(`wrote data/wiki/seed${seed}.json (${wiki.snapshot.regions.length} regions, ${wiki.settlements.length} settlements, ${wiki.snapshot.factions.length} factions) and data/wiki/seed${seed}.md (${md.length} chars)`);
