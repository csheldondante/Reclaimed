// Round 120 (runsit): the situation template filled for a seed's world (src/runsit/fill.ts), checked
// (src/gm/situationcheck.ts) and printed — or written as data (a GM's starting point, a fixture).
//   node scripts/situation.mjs [--seed 1] [--from <region>] [--out data/situations/<id>.json]
// (the TS is loaded through Vite's SSR loader: fill.ts reaches play's controller library through runplan's heroes)
import fs from 'node:fs';
import { createServer } from 'vite';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
try {
  const { fillSituation } = await vite.ssrLoadModule('/src/runsit/fill.ts');
  const { loadAtlasGraph, runGraph } = await vite.ssrLoadModule('/src/runplan/graph.ts');
  const { checkSituation, situationSummary, situationWorldFrom } = await vite.ssrLoadModule('/src/gm/situationcheck.ts');
  const seed = Number(arg('seed', '1'));
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const facts = read(`data/atlas/seed${seed}.json`);
  const wiki = read(`data/wiki/seed${seed}.json`);
  const graph = runGraph(loadAtlasGraph(read(`data/atlas/seed${seed}-graph.json`)), { names: { regions: wiki.regions, settlements: wiki.snapshot.settlements }, facts });
  const from = Number(arg('from', String(wiki.spawn.region)));
  const t0 = performance.now();
  const sit = fillSituation({ graph, world: wiki.snapshot, seed, from, at: from === wiki.spawn.region ? wiki.spawn.at : undefined });
  const ms = performance.now() - t0;
  const sw = situationWorldFrom(wiki);
  const problems = checkSituation(sit, sw);
  console.log(`${sit.id} "${sit.title}" filled in ${ms.toFixed(1)} ms`);
  console.log(sit.premise);
  for (const a of sit.areas) console.log(`  ${a.id} ${a.name} (${a.region}${a.settlement ? ' ' + a.settlement : ''}) ${a.play.kind}`);
  console.log(`  threat route ${sit.threat.route.join(' → ')}; arrives ${sit.threat.arrives} min; refuge ${sit.refuge.name}`);
  console.log(situationSummary(sit, sw));
  if (problems.length) {
    for (const p of problems) console.log(p);
    process.exitCode = 1;
  } else {
    const out = arg('out', '');
    if (out) {
      fs.writeFileSync(out, JSON.stringify(sit, null, 2) + '\n');
      console.log(`wrote ${out}`);
    }
  }
} finally {
  await vite.close();
}
