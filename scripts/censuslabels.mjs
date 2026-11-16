// phone-idle: a census report's labels under the named systems (node scripts/censuslabels.mjs file.json state sys1,sys2)
import fs from 'node:fs';
const [file, state, systems] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
const key = Object.keys(r).find((k) => k.startsWith(state));
for (const s of r[key].systems) {
  if (systems && !systems.split(',').includes(s.system)) continue;
  console.log(`${s.system}  est ${s.phoneMs}`);
  for (const l of s.labels.slice(0, 40)) console.log('   ', JSON.stringify(l));
}
