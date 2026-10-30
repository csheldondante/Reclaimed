// (round 117, revive) The noise lab's pure parts in Node (no browser): a lab record's column with a gap becomes the
// world's intervals with that gap open (columns.ts labColumns), whatever the strata and the chunk's room.
//   node scripts/noiselabunit.mjs
import { createServer } from 'vite';

const v = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) fails++;
  return cond;
};
try {
  const { labColumns } = await v.ssrLoadModule('/src/noiselab/columns.ts');
  const { LAB_TUNING } = await v.ssrLoadModule('/src/noiselab/params.ts');
  const { PRESETS } = await v.ssrLoadModule('/src/noiselab/presets.ts');
  const { readSlot, SLOT_WORDS, CHUNK } = await v.ssrLoadModule('/src/world/layout.ts');
  LAB_TUNING.apply(PRESETS['TG3: coastal mesas, sea caves']);
  const w = 32, h = 32, k = 12;
  // the chunk table: chunk ci at slot base ci·CHUNK²·k, k slots a column
  const chunksX = w / CHUNK, chunks = chunksX * (h / CHUNK);
  const chunkTable = new Uint32Array(chunks * 2);
  for (let c = 0; c < chunks; c++) {
    chunkTable[c * 2] = c * CHUNK * CHUNK * k;
    chunkTable[c * 2 + 1] = k;
  }
  const lay = { chunksX, chunkTable, slots: chunks * CHUNK * CHUNK * k };
  const cols = new Float32Array(w * h * 8);
  const mats = 1 + 2 * 64; // a top, a rock
  for (let i = 0; i < w * h; i++) {
    cols[i * 8] = 50;
    cols[i * 8 + 3] = mats;
  }
  // a gap 15–27 in (20, 18), two in (5, 5)
  const at = (x, y) => (y * w + x) * 8;
  cols[at(20, 18) + 1] = 14.9;
  cols[at(20, 18) + 2] = 27.1;
  cols[at(5, 5) + 1] = 10;
  cols[at(5, 5) + 2] = 16;
  cols[at(5, 5) + 4] = 30;
  cols[at(5, 5) + 5] = 38;
  const r = { w, h, cols, thumbs: new Float32Array(0), tw: 0, th: 0, ms: 0, passes: 0 };
  const out = labColumns(r, lay);
  const column = (x, y) => {
    const ci = (y >> 4) * chunksX + (x >> 4);
    const base = chunkTable[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * k;
    const iv = [];
    for (let s = 0; s < k; s++) {
      const v = readSlot(out.slots, base + s);
      if (!v) break;
      iv.push([v.z0, v.z1]);
    }
    return iv;
  };
  const open = (iv, z) => !iv.some(([a, b]) => z >= a && z < b);
  const c1 = column(20, 18);
  ok(open(c1, 20) && !open(c1, 10) && !open(c1, 40), `a gap 15–27 is open in the world's column: ${JSON.stringify(c1)}`);
  const c2 = column(5, 5);
  ok(open(c2, 12) && open(c2, 34) && !open(c2, 20) && !open(c2, 45), `two gaps both open: ${JSON.stringify(c2)}`);
  const c3 = column(1, 1);
  ok(!open(c3, 20), `a solid column stays solid: ${JSON.stringify(c3)}`);
  ok(out.gapCols === 2, `gap columns counted: ${out.gapCols}`);
} catch (e) {
  console.log(`FAIL threw: ${e?.stack ?? e}`);
  fails++;
} finally {
  await v.close();
}
console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
