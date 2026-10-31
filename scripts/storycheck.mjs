// Checks a SessionStory against story.ts and the world it was written for (src/gm/storycheck.ts), or a Situation
// (round 120, runsit: a file with a `threat` and `areas`) against situation.ts (src/gm/situationcheck.ts).
//   node scripts/storycheck.mjs data/stories/<id>.json [--wiki data/wiki/seed1.json]
//   node scripts/storycheck.mjs data/situations/<id>.json [--wiki data/wiki/seed1.json]
// Prints every problem and exits 1 if there are any; prints "ok" and a summary and exits 0 if none.
// The GM runs this on its own output until it's clean (docs/GM.md).
import fs from 'node:fs';
import path from 'node:path';
import { checkStory, checkWorldFrom } from '../src/gm/storycheck.ts';
import { checkSituation, situationSummary, situationWorldFrom } from '../src/gm/situationcheck.ts';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--wiki');
if (!file) {
  console.error('usage: node scripts/storycheck.mjs <story.json> [--wiki data/wiki/seed1.json]');
  process.exit(2);
}
const wikiPath = argv.includes('--wiki') ? argv[argv.indexOf('--wiki') + 1] : 'data/wiki/seed1.json';
const read = (p, what) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`${what} ${p}: ${e.message}`);
    process.exit(1);
  }
};
const story = read(file, 'story');
const wiki = read(wikiPath, 'world');
if (story && typeof story === 'object' && 'threat' in story && 'areas' in story) {
  const sw = situationWorldFrom(wiki);
  const problems = checkSituation(story, sw);
  if (typeof story.id === 'string' && path.basename(file, '.json') !== story.id) problems.push(`file: ${path.basename(file)} should be named ${story.id}.json`);
  if (problems.length) {
    for (const p of problems) console.log(p);
    console.log(`
${problems.length} problem${problems.length === 1 ? '' : 's'} in ${file}`);
    process.exit(1);
  }
  console.log(`ok: ${file} — situation "${story.title}": ${story.areas.length} areas, ${story.choices.length} choices, ${story.items.length} items; the threat (${story.threat.count} ${story.threat.role}) at ${story.target.name} in ${story.threat.arrives} min`);
  console.log(situationSummary(story, sw));
  process.exit(0);
}
const world = checkWorldFrom(wiki);
const problems = checkStory(story, world);
if (story && typeof story.id === 'string' && path.basename(file, '.json') !== story.id) problems.push(`file: ${path.basename(file)} should be named ${story.id}.json`);
if (problems.length) {
  for (const p of problems) console.log(p);
  console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} in ${file}`);
  process.exit(1);
}
const nodes = story.dialogs.reduce((n, d) => n + Object.keys(d.nodes).length, 0);
console.log(`ok: ${file} — "${story.title}": ${story.locations.length} locations, ${story.cast.length} cast, ${story.dialogs.length} dialogs (${nodes} nodes), ${story.objectives.length} objectives, ${story.happenings.length} happenings`);
