// (card-table; docs/design/PACK_FORMAT.md) Check outside-authored opportunity packs:
//   node scripts/packcheck.mjs packs/sample.json [more.json ...]
// Each file is checked alone; with two or more, the set is then checked TOGETHER (ids two packs share, a tag declared
// differently, rules about an event kind nobody has, crowded sites, too many threats). Prints every problem in plain
// words. Exit 1 if anything is to fix. No browser, no build: the validator (src/packs/check.ts) imports nothing at run
// time, so Node (22.18 or newer) runs it as it is.
import fs from 'node:fs';
import { checkPack, checkTogether, reportText } from '../src/packs/check.ts';

const files = process.argv.slice(2);
if (!files.length) {
  console.log('usage: node scripts/packcheck.mjs <pack.json> [more.json ...]');
  process.exit(2);
}
let bad = false;
const packs = [];
for (const f of files) {
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.log(`${f}: not readable as JSON. ${e.message}`);
    bad = true;
    continue;
  }
  const ps = checkPack(pack);
  console.log(reportText(f, ps));
  if (ps.some((p) => p.level === 'error')) bad = true;
  else packs.push(pack);
}
if (files.length > 1) {
  if (packs.length < files.length) console.log('TOGETHER: not checked for the files with errors above.');
  const ps = checkTogether(packs);
  console.log(reportText(`TOGETHER (${packs.map((p) => p.pack.id).join(', ')})`, ps));
  if (ps.some((p) => p.level === 'error')) bad = true;
}
process.exit(bad ? 1 : 0);
