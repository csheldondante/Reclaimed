// Round 105 (`ringwin`): the CPU's ring (src/sim/ring.ts) checked without a browser: for window sizes and offsets
// (whole pages), Ring.idx / at / idxHalf put window column (x, y) at ((x + ring) mod W, (y + ring) mod H) — the
// plain wrap the page table stands for today — and toRing / fromRing move whole arrays the same way (per values a
// column, planes) and undo each other. A JS copy of common.wgsl's colIdx / colXY / texCol2 is checked against it too.
//   node --experimental-transform-types scripts/ringunit.mjs
// (run with node --experimental-transform-types: the module is TypeScript)
const { Ring, COLS_PAGE } = await import('../src/sim/ring.ts');
let bad = 0;
const fail = (m) => {
  bad++;
  if (bad < 20) console.log('FAIL', m);
};
// common.wgsl's helpers, as written there
const wgsl = (W, H, rx, ry) => {
  const P = COLS_PAGE;
  const pagesX = W / P;
  const pagesY = H / P;
  const colPage = (cx, cy) => {
    const x = cx + rx / P;
    const y = cy + ry / P;
    return [x >= pagesX ? x - pagesX : x, y >= pagesY ? y - pagesY : y];
  };
  const colIdx = (x, y) => {
    const [px, py] = colPage(Math.floor(x / P), Math.floor(y / P));
    return py * P * W + px * P + (y % P) * W + (x % P);
  };
  const colXY = (i) => {
    const qx = i % W;
    const qy = Math.floor(i / W);
    const pgx = Math.floor(qx / P);
    const pgy = Math.floor(qy / P);
    const kx = rx / P;
    const ky = ry / P;
    const cx = pgx >= kx ? pgx - kx : pgx + pagesX - kx;
    const cy = pgy >= ky ? pgy - ky : pgy + pagesY - ky;
    return [cx * P + (qx % P), cy * P + (qy % P)];
  };
  const texCol2 = (tx, ty) => {
    const h = P / 2;
    const [px, py] = colPage(Math.floor(tx / h), Math.floor(ty / h));
    return [px * h + (tx % h), py * h + (ty % h)];
  };
  return { colIdx, colXY, texCol2 };
};
let checks = 0;
for (const [W, H] of [
  [256, 256],
  [320, 320],
  [512, 384],
  [96, 64],
]) {
  for (const [rx, ry] of [
    [0, 0],
    [64, 0],
    [0, 64],
    [128, 64],
    [W - 64, H - 64],
    [16, 48],
  ]) {
    if (rx >= W || ry >= H) continue;
    const r = new Ring(W, H);
    r.x = rx;
    r.y = ry;
    const g = wgsl(W, H, rx, ry);
    const seen = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const want = ((y + ry) % H) * W + ((x + rx) % W);
        const i = r.idx(x, y);
        checks++;
        if (i !== want) fail(`idx ${W}x${H} ring ${rx},${ry} (${x},${y}): ${i} not ${want}`);
        if (g.colIdx(x, y) !== want) fail(`colIdx ${W}x${H} ring ${rx},${ry} (${x},${y}): ${g.colIdx(x, y)} not ${want}`);
        const [bx, by] = g.colXY(want);
        if (bx !== x || by !== y) fail(`colXY ${W}x${H} ring ${rx},${ry} ${want}: (${bx},${by}) not (${x},${y})`);
        const [ax, ay] = r.at(x, y);
        if (ay * W + ax !== want) fail(`at ${W}x${H} (${x},${y})`);
        if (seen[i]++) fail(`idx ${W}x${H} ring ${rx},${ry}: ${i} twice`);
      }
    // the half-size grid (the wind field)
    const tw = W / 2;
    const th = H / 2;
    for (let ty = 0; ty < th; ty++)
      for (let tx = 0; tx < tw; tx++) {
        const want = ((ty + ry / 2) % th) * tw + ((tx + rx / 2) % tw);
        const [hx, hy] = g.texCol2(tx, ty);
        if (r.idxHalf(tx, ty, tw) !== want || hy * tw + hx !== want) fail(`half ${W}x${H} ring ${rx},${ry} (${tx},${ty})`);
      }
    // rectangles cut at the seam (pieces): every texel of each piece where idx / idxHalf says, all of the rectangle once
    for (const half of [false, true]) {
      const gw = half ? W / 2 : W;
      const gh = half ? H / 2 : H;
      for (let n = 0; n < 40; n++) {
        const x0 = Math.floor(Math.random() * gw);
        const y0 = Math.floor(Math.random() * gh);
        const x1 = x0 + 1 + Math.floor(Math.random() * (gw - x0));
        const y1 = y0 + 1 + Math.floor(Math.random() * (gh - y0));
        let area = 0;
        for (const q of r.pieces(x0, y0, x1, y1, half)) {
          area += q.w * q.h;
          if (q.px + q.w > gw || q.py + q.h > gh) fail(`pieces ${W}x${H} half ${half}: a piece past the edge`);
          for (let y = 0; y < q.h; y++)
            for (let x = 0; x < q.w; x++) {
              checks++;
              const want = half ? r.idxHalf(q.x + x, q.y + y, gw) : r.idx(q.x + x, q.y + y);
              if ((q.py + y) * gw + q.px + x !== want) fail(`pieces ${W}x${H} half ${half} (${q.x + x},${q.y + y})`);
            }
        }
        if (area !== (x1 - x0) * (y1 - y0)) fail(`pieces ${W}x${H}: area ${area}`);
      }
    }
    // whole arrays: per 1, 4 and 2 planes
    for (const [per, planes] of [
      [1, 1],
      [4, 1],
      [1, 2],
      [6, 1],
    ]) {
      const a = new Float32Array(W * H * per * planes + 3).map((_, k) => k);
      const on = r.toRing(a, per, planes);
      for (let p = 0; p < planes; p++)
        for (let y = 0; y < H; y += 7)
          for (let x = 0; x < W; x += 5)
            for (let k = 0; k < per; k++) {
              checks++;
              if (on[p * W * H * per + r.idx(x, y) * per + k] !== a[p * W * H * per + (y * W + x) * per + k]) fail(`toRing ${W}x${H} per ${per} planes ${planes} (${x},${y})`);
            }
      const back = r.fromRing(on, per, planes);
      for (let k = 0; k < a.length; k++)
        if (back[k] !== a[k]) {
          fail(`fromRing(toRing) ${W}x${H} per ${per} planes ${planes} at ${k}`);
          break;
        }
    }
  }
}
console.log(`${bad ? 'FAIL' : 'ok  '} ring: ${checks} checks, ${bad} wrong`);
if (bad) process.exit(1);
