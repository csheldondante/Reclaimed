// (card-table; docs/design/PACK_FORMAT.md) Check an outside-authored opportunity pack:
//   node scripts/packcheck.mjs packs/sample.json [more.json ...]
// Prints every problem in plain words. Exit 1 if any pack has something to fix. No browser, no build: the validator
// (src/packs/check.ts) imports nothing at run time, so Node runs it as it is.
import fs from 'node:fs';
import { checkPack, reportText } from '../src/packs/check.ts';

const files = process.argv.slice(2);
if (!files.length) {
  console.log('usage: node scripts/packcheck.mjs <pack.json> [more.json ...]');
  process.exit(2);
}
let bad = false;
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
}
process.exit(bad ? 1 : 0);
