// Round 107 (`pages`, docs/PAGES.md P2.1-P2.2; was ringunit.mjs): the CPU's Pages (src/sim/pages.ts) checked
// without a browser, for window sizes, ring offsets (whole pages) and page permutations (identity, shuffled): i / of
// / xy are inverse and match a JS copy of common.wgsl's colIdx / colXY (the ring's computed slots and the table's,
// packed as Globals.pages / pageInv), t / texAt / idxHalf match texCol / texCol2, toStore / toWindow and
// texToStore / texToWindow undo each other and put each column where i / t say, runs / texRects / pieces cover a
// rectangle exactly, and regionRowsToPages undoes itself.
//   node --experimental-transform-types scripts/pageunit.mjs
const { Pages, COLS_PAGE, regionRowsToPages } = await import('../src/sim/pages.ts');
let bad = 0;
let checks = 0;
const kinds = new Map();
const fail = (m) => {
  bad++;
  const k = m.split(' ')[0];
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
  if (kinds.get(k) <= 3) console.log('FAIL', m);
};
const P = COLS_PAGE;
// common.wgsl's helpers, as written there: `table` false computes the ring's place, true reads the packed table
const wgsl = (pg, table) => {
  const { W, H } = pg;
  const nx = W / P;
  const ny = H / P;
  const u32 = new Uint32Array(1024);
  new Uint16Array(u32.buffer).set(pg.table);
  const inv32 = new Uint32Array(1024);
  new Uint16Array(inv32.buffer).set(pg.inv);
  const word = (t, i) => ((t === 0 ? u32 : inv32)[(i >> 3) * 4 + ((i >> 1) & 3)] >>> ((i & 1) * 16)) & 0xffff;
  const colSlot = (cx, cy) => {
    if (table) return word(0, cy * nx + cx);
    const x = cx + pg.x / P;
    const y = cy + pg.y / P;
    return (y >= ny ? y - ny : y) * nx + (x >= nx ? x - nx : x);
  };
  const slotChunk = (s) => {
    if (table) {
      const e = word(1, s);
      return [e & 0xff, e >> 8];
    }
    const px = s % nx;
    const py = Math.floor(s / nx);
    const rx = pg.x / P;
    const ry = pg.y / P;
    return [px >= rx ? px - rx : px + nx - rx, py >= ry ? py - ry : py + ny - ry];
  };
  const texPage = (s) => [(s % nx) * P, Math.floor(s / nx) * P];
  const colIdx = (x, y) => colSlot(Math.floor(x / P), Math.floor(y / P)) * P * P + (y % P) * P + (x % P);
  const colXY = (i) => {
    const l = i % (P * P);
    const [cx, cy] = slotChunk(Math.floor(i / (P * P)));
    return [cx * P + (l % P), cy * P + Math.floor(l / P)];
  };
  const texCol = (x, y) => {
    const [tx, ty] = texPage(colSlot(Math.floor(x / P), Math.floor(y / P)));
    return [tx + (x % P), ty + (y % P)];
  };
  const texCol2 = (tx, ty) => {
    const h = P / 2;
    const [ax, ay] = texPage(colSlot(Math.floor(tx / h), Math.floor(ty / h)));
    return [ax / 2 + (tx % h), ay / 2 + (ty % h)];
  };
  return { colIdx, colXY, texCol, texCol2 };
};

for (const [W, H] of [
  [256, 256],
  [320, 320],
  [512, 384],
  [96, 64],
]) {
  for (const seed of [null, 7, 12345]) {
    for (const [rx, ry] of [
      [0, 0],
      [64, 0],
      [0, 64],
      [128, 64],
      [W - 64, H - 64],
      [16, 48],
    ]) {
      if (rx >= W || ry >= H) continue;
      const r = new Pages(W, H, seed);
      r.set(rx, ry);
      const ways = seed === null ? [wgsl(r, false), wgsl(r, true)] : [wgsl(r, true)];
      const seen = new Uint8Array(W * H);
      const seenT = new Uint8Array(W * H);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = r.i(x, y);
          checks++;
          if (r.idx(x, y) !== i || r.of(y * W + x) !== i) fail(`idx/of ${W}x${H} ${seed} ${rx},${ry} (${x},${y})`);
          const [bx, by] = r.xy(i);
          if (bx !== x || by !== y) fail(`xy ${W}x${H} ${seed} ${rx},${ry} ${i}: (${bx},${by}) not (${x},${y})`);
          for (const g of ways) {
            if (g.colIdx(x, y) !== i) fail(`colIdx ${W}x${H} ${seed} ${rx},${ry} (${x},${y}): ${g.colIdx(x, y)} not ${i}`);
            const [cx, cy] = g.colXY(i);
            if (cx !== x || cy !== y) fail(`colXY ${W}x${H} ${seed} ${rx},${ry} ${i}`);
            const [tx, ty] = g.texCol(x, y);
            if (ty * W + tx !== r.t(x, y)) fail(`texCol ${W}x${H} ${seed} ${rx},${ry} (${x},${y})`);
          }
          if (seen[i]++) fail(`i ${W}x${H} ${seed}: ${i} twice`);
          if (seenT[r.t(x, y)]++) fail(`t ${W}x${H} ${seed}: ${r.t(x, y)} twice`);
          // (seed null, offset 0: the atlas is window order)
          if (seed === null && rx === 0 && ry === 0 && r.t(x, y) !== y * W + x) fail(`t identity (${x},${y})`);
        }
      // a texel a 2 x 2
      for (let ty = 0; ty < H / 2; ty++)
        for (let tx = 0; tx < W / 2; tx++)
          for (const g of ways) {
            const [ax, ay] = g.texCol2(tx, ty);
            checks++;
            if (r.idxHalf(tx, ty, W / 2) !== ay * (W / 2) + ax) fail(`idxHalf ${W}x${H} ${seed} ${rx},${ry} (${tx},${ty})`);
          }
      // whole arrays
      for (const [per, planes] of [
        [1, 1],
        [4, 1],
        [1, 2],
      ]) {
        const a = new Float32Array(W * H * per * planes + 3).map((_, k) => k);
        const st = r.toStore(a, per, planes);
        for (let p = 0; p < planes; p++)
          for (let y = 0; y < H; y += 7)
            for (let x = 0; x < W; x += 5)
              for (let k = 0; k < per; k++) {
                checks++;
                if (st[p * W * H * per + r.i(x, y) * per + k] !== a[p * W * H * per + (y * W + x) * per + k]) fail(`toStore ${W}x${H} ${seed} per ${per} planes ${planes}`);
              }
        const back = r.toWindow(st, per, planes);
        for (let k = 0; k < a.length; k++) if (back[k] !== a[k]) {
          fail(`toWindow(toStore) ${W}x${H} ${seed} at ${k}`);
          break;
        }
        if (planes === 1) {
          const ts = r.texToStore(a, per);
          for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) if (ts[r.t(x, y) * per] !== a[(y * W + x) * per]) fail(`texToStore ${W}x${H} ${seed} (${x},${y})`);
          const tb = r.texToWindow(ts, per);
          for (let k = 0; k < a.length; k++) if (tb[k] !== a[k]) {
            fail(`texToWindow(texToStore) ${W}x${H} ${seed} at ${k}`);
            break;
          }
          const h = new Float32Array((W / 2) * (H / 2) * per).map((_, k) => k);
          const hs = r.texToStore(h, per, true);
          for (let ty = 0; ty < H / 2; ty += 3) for (let tx = 0; tx < W / 2; tx += 3) if (hs[r.idxHalf(tx, ty, W / 2) * per] !== h[(ty * (W / 2) + tx) * per]) fail(`texToStore half ${W}x${H} ${seed}`);
        }
      }
      // a region's runs and texture rectangles: every page once
      for (const R of [32, 64]) {
        if (W % R || H % R) continue;
        for (let ly = 0; ly < H; ly += R)
          for (let lx = 0; lx < W; lx += R) {
            const sl = r.slots(lx, ly, R, R);
            const rc = R / P;
            const got = new Map();
            for (const run of r.runs(sl, rc))
              for (let q = 0; q < run.rows; q++) for (let n = 0; n < run.n; n++) got.set(run.k + q * rc + n, run.slot + q * run.rowSlots + n);
            checks++;
            if (got.size !== sl.length || [...got].some(([k, s]) => sl[k] !== s)) fail(`runs ${W}x${H} ${seed} ${rx},${ry} region ${lx},${ly}`);
            if (seed === null && rx % R === 0 && ry % R === 0 && r.runs(sl, rc).length !== 1) fail(`runs: the identity's region ${lx},${ly} isn't one rectangle`);
            const cover = new Set();
            for (const q of r.texRects(lx, ly, R, R))
              for (let j = 0; j < q.ph; j++)
                for (let i = 0; i < q.pw; i++) {
                  const [tx, ty] = r.texAt(q.wx + i * P, q.wy + j * P);
                  if (tx !== (q.px + i) * P || ty !== (q.py + j) * P) fail(`texRects ${W}x${H} ${seed} region ${lx},${ly}`);
                  cover.add(`${q.wx + i * P},${q.wy + j * P}`);
                }
            if (cover.size !== rc * rc) fail(`texRects cover ${W}x${H} ${seed} region ${lx},${ly}`);
          }
      }
      // pieces of a rectangle (and of the half grid)
      for (const half of [false, true]) {
        const w = half ? W / 2 : W;
        const h = half ? H / 2 : H;
        const [x0, y0, x1, y1] = [3, 5, Math.min(w, 61), Math.min(h, 40)];
        const cover = new Uint8Array(w * h);
        for (const q of r.pieces(x0, y0, x1, y1, half))
          for (let j = 0; j < q.h; j++)
            for (let i = 0; i < q.w; i++) {
              const x = q.x + i;
              const y = q.y + j;
              cover[y * w + x]++;
              const want = half ? r.idxHalf(x, y, w) : r.t(x, y);
              if ((q.py + j) * w + q.px + i !== want) fail(`pieces ${W}x${H} ${seed} half ${half} (${x},${y})`);
            }
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (cover[y * w + x] !== (x >= x0 && x < x1 && y >= y0 && y < y1 ? 1 : 0)) fail(`pieces cover ${W}x${H} half ${half} (${x},${y})`);
      }
    }
  }
}
// a region's bytes, rows <-> pages
for (const [R, stride, planes] of [
  [64, 4, 1],
  [64, 16, 1],
  [32, 4, 2],
]) {
  const a = new Uint8Array(R * R * stride * planes).map((_, k) => (k * 31) & 255);
  const pg = regionRowsToPages(a, R, stride, planes, true);
  const back = regionRowsToPages(pg, R, stride, planes, false);
  checks++;
  if (back.some((v, k) => v !== a[k])) fail(`regionRowsToPages ${R} ${stride} ${planes}`);
  // column (x, y)'s first byte, page-major
  const x = 37 % R;
  const y = 21 % R;
  const k = (Math.floor(y / P) * (R / P) + Math.floor(x / P)) * P * P + (y % P) * P + (x % P);
  if (pg[k * stride] !== a[(y * R + x) * stride]) fail(`regionRowsToPages place ${R}`);
}
console.log(`${bad ? 'FAIL' : 'ok  '} pages: ${checks} checks, ${bad} wrong`);
if (bad) process.exit(1);
