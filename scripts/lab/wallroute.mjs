// (U2-WALLSTAIR, SL19) The wall-walk routes against the surfaces citygen claims: on the gputown recipe (Muru's walls
// risen), each run's baked route from routeread's wall table (wallWalkRoute: the stair's foot, up its steps, along the
// deck, down the other stair), checked point by point against the agents' own nav surfaces (Agents.reader: the
// columns peeled on the GPU, the claimed wall and stairs in them):
//   - off:    a point with no surface within STEP (1.1) of its z under it (it floats or clips);
//   - jumps:  consecutive points more than STEP apart in z;
//   - unreachable: (info) deck points a field seeded at the run's foot doesn't reach by the agents' step rule — units
//     ride the route (Track B's route mode) and only need the deck under them when knocked off or fighting.
// A debug read for the test only (the route buffer and the nav): nothing in the game reads it.
//   node scripts/lab.mjs run scripts/lab/wallroute.mjs [--args '{"rows":true,"strict":true}'] [--flags "&town=s53"]
export const recipe = 'gputown';
export default async function (lab, args) {
  if (lab.recipeError) throw new Error(lab.recipeError);
  const STEP = 1.1;
  const id = lab.town;
  const living = lab.living;
  const dev = living.io.device;
  const read = async (buf) => {
    const tmp = dev.createBuffer({ size: buf.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, tmp, 0, buf.size);
    dev.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const u = new Uint32Array(tmp.getMappedRange().slice(0));
    tmp.destroy();
    return u;
  };
  const tt = lab.towns.live.get(id);
  const [cx, cy] = tt.centreInWindow();
  lab.look(cx, cy, 6, 0.5);
  await lab.run(args.settle ?? 3, 4, { renderEvery: 8 });
  // (the route buffer as routeread.wgsl lays it out: header, heads at [8], points at [3], 5 words a point)
  const rb = await read(living.routeRead(id).buffer);
  const f = new Float32Array(rb.buffer);
  const place = [f[4], f[5], f[6]];
  const routes = [];
  for (let i = 0; i < rb[9]; i++) {
    const idg = rb[rb[12] + 2 * i];
    const run = rb[rb[12] + 2 * i + 1];
    const info = { run: [run & 0xff, (run >> 8) & 0xff], reached: (run >> 16) & 1 };
    if (idg === 0xffffffff) { routes.push({ ...info, pts: [] }); continue; }
    const ho = rb[8] + (idg & 0xffff) * 4;
    const pts = [];
    for (let k = 0; k < rb[ho + 1]; k++) {
      const o = rb[3] + (rb[ho] + k) * 5;
      pts.push([f[o] + place[0], f[o + 1] + place[1], f[o + 2] + place[2], f[o + 4]]);
    }
    routes.push({ ...info, pts });
  }
  const agents = lab.units.agents;
  const FLD = args.field ?? 12;
  const out = { town: id, name: tt.site.name, runs: [], points: 0, off: 0, jumps: 0, deck: 0, unreachable: 0 };
  for (const R of routes) {
    if (!R.pts.length) { out.runs.push({ run: R.run, n: 0 }); continue; }
    const foot = R.pts[0];
    // (the nav is kept fresh only in the agents' scope: the route's points in it, a while to rebuild and relax)
    agents.keepInScope('wallroute', R.pts.map((p) => [p[0], p[1]]));
    agents.seed(FLD, [{ x: foot[0], y: foot[1], z: foot[2] + 0.5 }]);
    await lab.run(args.relax ?? 4, 4, { renderEvery: 16 });
    const rd = agents.reader(FLD);
    await rd.refresh();
    const rows = R.pts.map((p, k) => {
      const s = rd.sample(p[0], p[1], p[2] + 0.5);
      const surf = s && s.z > 0 ? s.z : null;
      return { k, at: `${p[0].toFixed(1)},${p[1].toFixed(1)}`, deck: p[3] > 1.5, z: +p[2].toFixed(2), surf: surf === null ? null : +surf.toFixed(2), d: s && s.dist < 1e8 ? +s.dist.toFixed(1) : 'FAR' };
    });
    const off = rows.filter((x) => x.surf === null || Math.abs(x.surf - x.z) > STEP);
    let jumps = 0;
    let maxJump = 0;
    for (let k = 1; k < rows.length; k++) {
      const dz = Math.abs(rows[k].z - rows[k - 1].z);
      maxJump = Math.max(maxJump, dz);
      if (dz > STEP) jumps++;
    }
    const deck = rows.filter((x) => x.deck);
    const un = deck.filter((x) => x.d === 'FAR');
    out.points += rows.length;
    out.off += off.length;
    out.jumps += jumps;
    out.deck += deck.length;
    out.unreachable += un.length;
    out.runs.push({
      run: R.run,
      n: rows.length,
      off: off.length,
      jumps,
      maxJump: +maxJump.toFixed(2),
      deck: deck.length,
      unreachable: un.length,
      offAt: off.map((x) => `#${x.k} ${x.at} z ${x.z} surface ${x.surf}`).slice(0, 8),
      rows: args.rows ? rows : undefined,
    });
  }
  agents.keepInScope('wallroute', []);
  agents.seed(FLD, []);
  if (args.strict && (out.off || out.jumps)) throw new Error(`wall routes off their surfaces: ${JSON.stringify(out)}`);
  return out;
}
