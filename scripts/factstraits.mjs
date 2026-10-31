// (round 120, `cities`) Adds each region's kind traits (gm/atlas-facts.ts kindTraits: what a settlement's purpose reads)
// to atlas facts cached before round 120, without the browser: node scripts/factstraits.mjs [data/atlas/seed1.json]
import fs from 'node:fs';
import { createServer } from 'vite';

const file = process.argv[2] ?? 'data/atlas/seed1.json';
const v = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { kindTraits } = await v.ssrLoadModule('/src/atlas/kind-traits.ts');
  const facts = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const r of facts.regions) r.traits = kindTraits(r.kind);
  fs.writeFileSync(file, JSON.stringify(facts));
  console.log(`${file}: traits for ${facts.regions.length} regions`);
} finally {
  await v.close();
}
