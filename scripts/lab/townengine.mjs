// (physics10-atlas, PA1) The physics engine's rigid rows in the real town: Muru on the atlas level under
// `?solver=engine`. A scouting probe (its one gate: with {"slide":true}, rows at rest move with the land): it drops blocks on open ground, on a street and on a roof, throws one
// at a wall, slides the window with rows awake and asleep, and reports where each row is (the engine's pose buffer, a
// debug read) against the surface there.
//   RECLAIMED_PORT=5871 node scripts/lab.mjs run scripts/lab/townengine.mjs --flags "&solver=engine" [--args '{"slide":true,"smash":true}']
export default async function (lab, args) {
  const R = window.reclaimed;
  const scene = R.scene;
  const core = R.core;
  const kit = scene.engine;
  const out = { installed: !!kit, sandbox: !!scene.level.sandbox, integrity: !!scene.integrity, integrityEngine: !!scene.integrity?.engine, level: scene.level.id };
  if (!kit) return out;
  const eng = kit.engine;
  const device = core.host.gpu.device;
  const ROW_H = Math.sqrt(3) / 2;
  const { w, h } = core.dims;
  const pos = (x, y) => [x + 0.5 + 0.5 * (y & 1), (y + 0.5) * ROW_H];
  const cellOf = (p) => { const y = Math.round(p[1] / ROW_H - 0.5); return [Math.round(p[0] - 0.5 - 0.5 * (y & 1)), y]; };
  const box = (x, y, z, sx, sy, sz, mat) => {
    const c = [];
    for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) c.push({ x: x + i, y: y + j, z: Math.round(z) + k, mat });
    return c;
  };
  const ball = (x, y, z, r, mat) => {
    const c = [];
    for (let k = -r; k <= r; k++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j + k * k <= r * r + 1) c.push({ x: x + i, y: y + j, z: Math.round(z) + k, mat });
    return c;
  };
  const surface = async () => new Uint32Array((await core.readBuffer('surface')).buffer);
  const sf = (S, x, y) => { const s = S[y * w + x]; return { z: (s & 0x1ffff) / 256, mat: (s >>> 17) & 0xff, gap: s >>> 31 }; };
  const read = async (buf, bytes) => {
    const st = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, st, 0, bytes);
    device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const a = st.getMappedRange().slice(0);
    st.destroy();
    return a;
  };
  const rows = async (bodies) => {
    const n = Math.max(...bodies.map((b) => b.row)) + 1;
    const D = eng.debugBuffers;
    const pose = new Float32Array(await read(D.pose, n * 64));
    const info = new Uint32Array(await read(D.info, n * 64));
    const vel = new Float32Array(await read(D.vel, n * 32));
    return bodies.map((b) => {
      const r = b.row;
      return { row: r, at: [pose[16 * r + 8], pose[16 * r + 9], pose[16 * r + 10]].map((v) => +v.toFixed(2)), speed: +Math.hypot(vel[8 * r], vel[8 * r + 1], vel[8 * r + 2]).toFixed(2), flags: info[16 * r + 3] };
    });
  };

  // (the camera on the town first: a look can slide the streamed window, and every window coordinate read before it
  // would be of the old one)
  const settle = async () => {
    for (let k = 0, still = 0, o = ''; k < 80 && still < 4; k++) {
      await lab.run(0.2, 1);
      const n = scene.stream.origin.join(',') + scene.stream.busy;
      still = n === o && !scene.stream.busy ? still + 1 : 0;
      o = n;
    }
  };
  lab.camera().zoom = 14;
  await settle();
  const EXT = 39;
  const isB = (x, y) => x >= 0 && y >= 0 && x < w && y < h && sf(S, x, y).mat === EXT;
  const z = (x, y) => sf(S, x, y).z;
  const isT = (x, y) => x >= 0 && y >= 0 && x < w && y < h && T[y * w + x] === 1;
  let S, T, centre, cx, cy, mx, my, roof, open, wall;
  const find = async () => {
  // where the town stands: its named places, and the External columns (buildings) round the market
  const N = (await lab.places(lab.town)).named;
  centre = [N.market, N.keep, N.stores].find((p) => p.status === 0)?.at ?? [w / 2, (h / 2) * ROW_H, 0];
  [cx, cy] = cellOf(centre);
  S = await surface();
  // (a building: an External column standing 4 or more over the lowest open column within 3; streets and yards are
  // External too, flush with the ground)
  const all = (x, y, r, f) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (!f(x + i, y + j)) return false; return true; };
  const tall = (x, y) => {
    if (!isB(x, y)) return false;
    let lo = Infinity;
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (x + i >= 0 && y + j >= 0 && x + i < w && y + j < h && !isB(x + i, y + j)) lo = Math.min(lo, z(x + i, y + j));
    return z(x, y) - lo >= 4 && z(x, y) - lo < 40;
  };
  T = new Uint8Array(w * h);
  for (let y = 8; y < h - 8; y++) for (let x = 8; x < w - 8; x++) T[y * w + x] = tall(x, y) ? 1 : 0;
  // (the built core: the middle of the building columns within 70 of the market)
  let sx = 0;
  let sy = 0;
  let sn = 0;
  for (let j = -70; j <= 70; j++) for (let i = -70; i <= 70; i++) if (isT(cx + i, cy + j)) { sx += cx + i; sy += cy + j; sn++; }
  [mx, my] = sn ? [Math.round(sx / sn), Math.round(sy / sn)] : [cx, cy];
  roof = open = wall = null;
  for (let r = 0; r < 90 && !(roof && open && wall); r++)
    for (let j = -r; j <= r; j++)
      for (let i = -r; i <= r; i++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        const x = mx + i;
        const y = my + j;
        if (x < 12 || y < 12 || x >= w - 12 || y >= h - 12) continue;
        if (!roof && all(x, y, 2, (a, b) => isT(a, b) && Math.abs(z(a, b) - z(x, y)) < 0.5)) roof = [x, y];
        if (!open && all(x, y, 4, (a, b) => !isT(a, b) && Math.abs(z(a, b) - z(x, y)) < 2)) open = [x, y];
        // (a wall to throw at: a building column with seven level open columns to its west)
        if (!wall && isT(x, y) && isT(x + 1, y)) {
          let ok = true;
          for (let k = 1; k <= 7; k++) ok = ok && !isT(x - k, y) && !isT(x - k, y + 1) && Math.abs(z(x - k, y) - z(x - 1, y)) < 1.5;
          if (ok) wall = [x, y];
        }
      }
  };
  const sheet = document.querySelector('.season-sheet');
  if (sheet && !sheet.classList.contains('folded')) sheet.querySelector('.s-fold').click();
  // (the look at the roof may slide the window again: the sites found again till it stays)
  for (let pass = 0; pass < 5; pass++) {
    await find();
    if (!roof) break;
    const o = scene.stream.origin.join(',');
    lab.look(...pos(roof[0], roof[1]), 14, 0.45);
    await settle();
    if (scene.stream.origin.join(',') === o) break;
    if (pass === 4) throw new Error('the window slid at every look');
  }
  let ext = 0;
  let tallN = 0;
  out.map = [];
  for (let j = -24; j <= 24; j++) {
    let l = '';
    for (let i = -30; i <= 30; i++) {
      const b = isB(mx + i, my + j);
      const t = isT(mx + i, my + j);
      if (b) ext++;
      if (t) tallN++;
      l += t ? '#' : b ? '.' : String(Math.max(0, Math.min(9, Math.round(z(mx + i, my + j) - centre[2]) + 5)));
    }
    out.map.push(l);
  }
  out.town = { centre: centre.map((v) => +v.toFixed(1)), core: [mx, my], externalColumnsNear: ext, buildingColumnsNear: tallN, roof, open, wall };
  if (!roof || !open || !wall) return out;
  const zRoof = z(roof[0], roof[1]);
  const zOpen = z(open[0], open[1]);
  const zWallTop = z(wall[0], wall[1]);
  const zWallFoot = z(wall[0] - 3, wall[1]);
  const colAt = async (x, y) => (await R.phys.column(...pos(x, y))).map((v) => [+v.z0.toFixed(1), +v.z1.toFixed(1), v.mat]);
  out.heights = { roof: zRoof, open: zOpen, wallTop: zWallTop, wallFoot: zWallFoot, groundApiOpen: lab.ground(...pos(open[0], open[1])), groundApiRoof: lab.ground(...pos(roof[0], roof[1])) };
  out.columns = { roof: await colAt(roof[0], roof[1]), open: await colAt(open[0], open[1]), wall: await colAt(wall[0], wall[1]), wallFoot: await colAt(wall[0] - 3, wall[1]) };

  const STONE = 1;
  const t0 = performance.now();
  const base = await lab.run(3, 1);
  const bodies = {
    ground: kit.drop(box(open[0] - 1, open[1] - 1, zOpen + 10, 3, 3, 3, STONE)),
    boulder: kit.drop(ball(open[0] + 3, open[1] + 2, zOpen + 14, 2, STONE)),
    roof: kit.drop(box(roof[0] - 1, roof[1] - 1, zRoof + 8, 2, 2, 2, STONE)),
    thrown: kit.drop(box(wall[0] - 6, wall[1], zWallFoot + 2, 2, 2, 2, STONE), [9, 0, 2.5]),
  };
  const list = Object.values(bodies);
  const half = [1.5, 2.5, 1, 1];
  await lab.shot('engine-0-dropped');
  const trace = [];
  for (let k = 0; k < 8; k++) {
    await lab.run(0.5, 1);
    const r = await rows([bodies.thrown]);
    trace.push(r[0].at);
  }
  out.thrownTrace = trace;
  const busy = await lab.run(4, 1);
  await lab.shot('engine-1-rest');
  S = await surface();
  const rest = await rows(list);
  const name = Object.keys(bodies);
  out.rest = rest.map((r, i) => {
    return { what: name[i], ...r, cell: cellOf(r.at), bottom: +(r.at[2] - half[i]).toFixed(2) };
  });
  for (const r of out.rest) r.column = await colAt(r.cell[0], r.cell[1]);
  out.frame = { baseMsPerFrame: +(base.wallMs / base.frames).toFixed(2), withRowsMsPerFrame: +(busy.wallMs / busy.frames).toFixed(2) };

  if (args.slide) {
    // (the window slid under the camera: pan till the stream's origin moves, with one row awake — dropped just before)
    const o0 = [...scene.stream.origin];
    const awake = kit.drop(box(open[0] - 6, open[1] + 4, zOpen + 30, 2, 2, 2, STONE));
    const before = await rows([...list, awake]);
    const cam = core.camera;
    let moved = false;
    for (let k = 0; k < 40 && !moved; k++) {
      cam.target = [cam.target[0] - 6, cam.target[1], cam.target[2]];
      await lab.run(0.1, 1);
      moved = scene.stream.origin[0] !== o0[0] || scene.stream.origin[1] !== o0[1];
    }
    const o1 = [...scene.stream.origin];
    const after = await rows([...list, awake]);
    await lab.run(4, 1);
    const later = await rows([...list, awake]);
    S = await surface();
    out.slide = {
      moved,
      origin: [o0, o1],
      expectedRowShift: [o0[0] - o1[0], +((o0[1] - o1[1]) * ROW_H).toFixed(2)],
      rows: before.map((b, i) => {
        return { what: name[i] ?? 'awake', before: b.at, after: after[i].at, later: later[i].at, flags: later[i].flags, cell: cellOf(later[i].at), bottom: +(later[i].at[2] - (half[i] ?? 1)).toFixed(2) };
      }),
    };
    // (the gate, PA1: a row at rest moved with the land — by minus the window's move — at the first tick after the slide)
    if (!moved) throw new Error('the pan slid no window');
    for (const r of out.slide.rows.slice(0, list.length)) {
      const d = [r.after[0] - r.before[0], r.after[1] - r.before[1]];
      if (Math.abs(d[0] - out.slide.expectedRowShift[0]) > 0.1 || Math.abs(d[1] - out.slide.expectedRowShift[1]) > 0.1) throw new Error(`the window slid and ${r.what} did not move with the land: moved ${d}, the land ${out.slide.expectedRowShift}`);
    }
    for (const r of out.slide.rows) r.column = r.cell[0] >= 0 && r.cell[1] >= 0 && r.cell[0] < w && r.cell[1] < h ? await colAt(r.cell[0], r.cell[1]) : null;
    await lab.shot('engine-2-slid');
  }
  if (args.smash) {
    // (a terrain edit beside the town: the sandbox's meteor landing, if this level has it)
    const p = pos(open[0], open[1]);
    const n0 = eng.rows;
    let err = null;
    try {
      R.meteorNow(p[0], p[1], zOpen);
    } catch (e) {
      err = String(e?.message ?? e);
    }
    await lab.run(4, 1);
    out.smash = { err, rowsBefore: n0, rowsAfter: eng.rows, damaged: [...(lab.towns.live.get(lab.town)?.damaged ?? [])] };
    await lab.shot('engine-3-smashed');
  }
  out.wallS = +((performance.now() - t0) / 1000).toFixed(1);
  return out;
}
