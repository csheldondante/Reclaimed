// Round 113 (tilesfirst, step 5.1): the mesh's look's sources moved out of meshdraw.wgsl into meshsource.wgsl must
// leave the window's image the same, pixel for pixel. WGSL's module scope is order-free, so the module is the same
// program when the two files' top-level declarations, together, are the old meshdraw.wgsl's — with the look's few
// reads through the source's names (srcStrata, srcAsleep, srcDriftMat, srcPickCol: one-line wrappers of the old calls)
// taken back to the calls they wrap. This compares them (comments and whitespace aside) against a git revision.
//   node scripts/srcsplit.mjs [--rev 53ef01c]
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const rev = argv.includes('--rev') ? argv[argv.indexOf('--rev') + 1] : 'HEAD';
const old = execSync(`git show ${rev}:src/shaders/meshdraw.wgsl`, { encoding: 'utf8', maxBuffer: 1 << 24 });
let now = fs.readFileSync('src/shaders/meshsource.wgsl', 'utf8') + '\n' + fs.readFileSync('src/shaders/meshdraw.wgsl', 'utf8');

const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
/** the top-level items: from the start of one to its `;` or closing `}` at depth 0, whitespace collapsed */
function items(t) {
  const s = strip(t);
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    cur += ch;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0 && /^\s*(@[^\n]*\s*)*fn\b/.test(cur)) {
        out.push(cur.replace(/\s+/g, ' ').trim());
        cur = '';
      }
    } else if (ch === ';' && depth === 0) {
      out.push(cur.replace(/\s+/g, ' ').trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.replace(/\s+/g, ' ').trim());
  return out;
}
// (the wrappers themselves out, their calls back to what they wrap)
const wrappers = ['srcStrata', 'srcAsleep', 'srcDriftMat', 'srcPickCol'];
let it = items(now).filter((x) => !wrappers.some((w) => x.startsWith(`fn ${w}(`)));
it = it.map((x) =>
  x
    .replace(/srcPickCol\(cell\)/g, 'winIdx(cell)')
    .replace(/srcAsleep\(cell\)/g, 'asleep(vec2<u32>(cell))')
    .replace(/srcStrata\(/g, 'strata(')
    .replace(/srcDriftMat\(/g, 'driftMatAt('),
);
const a = items(old).sort();
const b = it.sort();
const onlyOld = a.filter((x) => !b.includes(x));
const onlyNew = b.filter((x) => !a.includes(x));
const same = a.length === b.length && !onlyOld.length && !onlyNew.length;
console.log(`${same ? 'SAME' : 'DIFFERENT'}: ${a.length} declarations then, ${b.length} now`);
for (const x of onlyOld) console.log(`  only then: ${x.slice(0, 160)}`);
for (const x of onlyNew) console.log(`  only now:  ${x.slice(0, 160)}`);
process.exit(same ? 0 : 1);
