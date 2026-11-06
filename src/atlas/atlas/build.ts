// Building the atlas (Atlas.build): the GPU passes from the macro height to rivers, lakes, settlements and ways, timed;
// craters, oddities and giants placed. API: run, makeCraters, makeOddities, makeGiants.
import { makeBindGroup, makeComputeAsync, makeModule, type BindSpec, type ComputeKernel } from '../../gpu/pipeline';
import { rng } from '../../world/noise';
import buildW from '../build.wgsl?raw';
import columnsW from '../columns.wgsl?raw';
import formsW from '../forms.wgsl?raw';
import { settle } from '../sites';
import { buildWays } from '../ways';
import { RegionFinish } from '../finish';
import { findRivers, LAKE_WORDS, NODE_WORDS } from '../rivers';
import { patterns, regionsCpu } from './regions';
import { STAMP, CRATER_WORDS, MAX_CRATERS, CRATER_BLOCK, GIANT_FLOATS, FLOOD_SPARE } from './defs';
import type { Atlas } from '../atlas';

export async function run(atl: Atlas): Promise<void> {
  const dev = atl.device;
  const p = atl.p;
  const n = p.n;
  const N = n * n;
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const mk = (label: string, size: number) => dev.createBuffer({ label: `atlas ${label}`, size, usage: S });
  const fieldA = mk('fieldA', N * 16);
  const key = mk('key', N * 4);
  const label = mk('label', N * 4);
  const size = mk('size', N * 4);
  const flag = mk('flag', 4);
  const flagRead = dev.createBuffer({ label: 'atlas flag read', size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const info = mk('info', N * 4);
  const cont = mk('cont', N * 4);
  const jfaA = mk('jfaA', N * 8);
  const jfaB = mk('jfaB', N * 8);
  const hmacB = mk('hmac', N * 4);
  // every pipeline at once, off the main thread (D3D compiles are the slow part of making the atlas)
  const bm = makeModule(dev, 'atlas build', atl.parts(buildW));
  // (perfopt, ?caves=mouths: only the caves that can open to the air — forms.wgsl LAZY_CAVES)
  const lazyCaves = new URLSearchParams(location.search).get('caves') === 'mouths';
  // (perfopt's ?riverhold=1, round 84: ?rivers=hold — RIVER_HOLD in parts())
  const cm = makeModule(dev, 'atlas columns', atl.parts(columnsW, `const LAZY_CAVES: bool = ${lazyCaves};
`, formsW));
  const K = (entry: string, spec: BindSpec, m = bm) => makeComputeAsync(dev, `atlas ${entry}`, m, { 0: 'uniform', ...spec }, entry);
  const [kBase, kInit, kHook, kJump, kCount, kClean, kKey, kSeedR, kSeedC, kStep, kOutR, kOutC, kMacro, colH, colF, fSeed, kSeedV, kOutV, kSeedL, kOutL] = await atl.time('compile', () =>
    Promise.all([
      K('base', { 1: 'rw', 2: 'rw', 25: 'read' }),
      K('ccInit', { 3: 'rw' }),
      K('ccHook', { 2: 'rw', 3: 'rw', 5: 'rw' }),
      K('ccJump', { 3: 'rw', 5: 'rw' }),
      K('ccCount', { 3: 'rw', 4: 'rw' }),
      K('clean', { 1: 'rw', 2: 'rw', 3: 'rw', 4: 'rw' }),
      K('regionKey', { 1: 'rw', 2: 'rw', 10: 'rw' }),
      K('jfaSeedR', { 6: 'rw', 7: 'rw' }),
      K('jfaSeedC', { 6: 'rw', 7: 'rw', 22: 'read' }),
      K('jfaStep', { 7: 'rw', 8: 'rw' }),
      K('jfaOutR', { 6: 'rw', 7: 'rw', 9: 'rw' }),
      K('jfaOutC', { 6: 'rw', 7: 'rw', 9: 'rw', 22: 'read' }),
      K('macroHeight', { 11: 'rw', 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read' }),
      K('colHeight', { 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read', 30: 'rw' }, cm),
      K('colFinish', { 22: 'read', 23: 'read', 30: 'rw', 31: 'rw', 32: 'rw', 33: 'rw', 34: 'rw' }, cm),
      K('formSeed', { 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read', 32: 'rw', 33: 'rw' }, cm),
      K('jfaSeedV', { 2: 'rw', 7: 'rw' }),
      K('jfaOutV', { 2: 'rw', 7: 'rw' }),
      K('jfaSeedL', { 6: 'rw', 7: 'rw', 22: 'read' }),
      K('jfaOutL', { 6: 'rw', 7: 'rw', 9: 'rw', 22: 'read' }),
    ]),
  );
  atl.colH = colH;
  atl.colF = colF;
  // (round 102) the GPU's finishing of a region (atlas/finish.ts); the tile pacer's device (its GPU budget)
  atl.finisher = await RegionFinish.create(dev);
  atl.pacer.device = dev;
  atl.formSeed = fSeed;
  const bg = (k: ComputeKernel, res: Record<number, GPUBuffer>) => makeBindGroup(dev, 'atlas', k.layout, { 0: atl.paramBuf, ...res });
  const groups = Math.ceil(n / 8);
  const pass = (enc: GPUCommandEncoder, k: ComputeKernel, g: GPUBindGroup) => {
    const cp = enc.beginComputePass();
    cp.setPipeline(k.pipeline);
    cp.setBindGroup(0, g);
    cp.dispatchWorkgroups(groups, groups);
    cp.end();
  };
  const one = async (k: ComputeKernel, g: GPUBindGroup) => {
    const enc = dev.createCommandEncoder();
    pass(enc, k, g);
    dev.queue.submit([enc.finish()]);
  };
  const gInit = bg(kInit, { 3: label });
  const gHook = bg(kHook, { 2: key, 3: label, 5: flag });
  const gJump = bg(kJump, { 3: label, 5: flag });
  // connected components of equal keys, to a fixed point
  const cc = async (): Promise<number> => {
    await one(kInit, gInit);
    const BATCH = 4;
    for (let it = 0; it < 4000; it += BATCH) {
      const enc = dev.createCommandEncoder();
      enc.clearBuffer(flag);
      for (let b = 0; b < BATCH; b++) {
        pass(enc, kHook, gHook);
        pass(enc, kJump, gJump);
        pass(enc, kJump, gJump);
      }
      enc.copyBufferToBuffer(flag, 0, flagRead, 0, 4);
      dev.queue.submit([enc.finish()]);
      await flagRead.mapAsync(GPUMapMode.READ);
      const changed = new Uint32Array(flagRead.getMappedRange())[0];
      flagRead.unmap();
      if (!changed) return it + BATCH;
    }
    throw new Error('atlas: connected components did not settle in 4000 iterations');
  };

  atl.writeParams();
  // the craters first (round 78): the continents' noise takes them
  makeCraters(atl);
  let lakeOff = [0, 0];
  const writeCraters = () => {
    const blk = new Float32Array(CRATER_BLOCK);
    new Uint32Array(blk.buffer)[0] = atl.craters.length / CRATER_WORDS;
    blk.set(atl.craters, 4);
    // (round 90: words 1 and 2 of the block — where the lakes' table and the per-texel lake ids start in the
    // buffer, words; 0 none: compose.wgsl lakeAt)
    new Uint32Array(blk.buffer).set(lakeOff, 1);
    dev.queue.writeBuffer(atl.riverBuf, N * 4, blk);
  };
  writeCraters();
  await atl.time('base', () => one(kBase, bg(kBase, { 1: fieldA, 2: key, 25: atl.riverBuf })));
  atl.stats.ccIters.push(await atl.time('cc land', cc));
  await atl.time('clean', async () => {
    const enc = dev.createCommandEncoder();
    enc.clearBuffer(size);
    pass(enc, kCount, bg(kCount, { 3: label, 4: size }));
    pass(enc, kClean, bg(kClean, { 1: fieldA, 2: key, 3: label, 4: size }));
    dev.queue.submit([enc.finish()]);
  });
  atl.stats.ccIters.push(await atl.time('cc continents', cc));
  await atl.time('keys', () => {
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(label, 0, cont, 0, N * 4);
    pass(enc, kKey, bg(kKey, { 1: fieldA, 2: key, 10: info }));
    dev.queue.submit([enc.finish()]);
  });
  atl.stats.ccIters.push(await atl.time('cc regions', cc));

  // ---- the CPU: dense ids, stats, tiny regions merged, the table -------------
  const [L, I, C] = await atl.time('readback', async () => [new Uint32Array(await atl.read(label)), new Uint32Array(await atl.read(info)), new Uint32Array(await atl.read(cont))]);
  await atl.time('regions (cpu)', () => regionsCpu(atl, L, I, C));
  // the oddities (round 78): on land, now that the land's known; in the ground from here on
  makeOddities(atl);
  writeCraters();
  dev.queue.writeBuffer(atl.region, 0, atl.regionOf);
  await atl.time('patterns', () => patterns(atl));

  // ---- jump flooding: the regions' borders, then the coast ---------------------
  const jfa = async (seed: ComputeKernel, seedRes: Record<number, GPUBuffer>, out: ComputeKernel, outRes: Record<number, GPUBuffer>) => {
    atl.writeParams();
    await one(seed, bg(seed, { ...seedRes, 7: jfaA }));
    let src = jfaA;
    let dst = jfaB;
    const steps: number[] = [];
    for (let k = n / 2; k >= 1; k /= 2) steps.push(k);
    steps.push(1);
    for (const k of steps) {
      atl.writeParams({ step: k });
      await one(kStep, bg(kStep, { 7: src, 8: dst }));
      [src, dst] = [dst, src];
    }
    atl.writeParams();
    await one(out, bg(out, { ...outRes, 7: src }));
  };
  await atl.time('jfa borders', () => jfa(kSeedR, { 6: atl.region }, kOutR, { 6: atl.region, 9: atl.dist }));
  await atl.time('jfa coast', () => jfa(kSeedC, { 6: atl.region, 22: atl.regs }, kOutC, { 6: atl.region, 9: atl.dist, 22: atl.regs }));
  await atl.time('jfa landforms', () => jfa(kSeedL, { 6: atl.region, 22: atl.regs }, kOutL, { 6: atl.region, 9: atl.dist, 22: atl.regs }));
  // (round 117: the macro ground — what the rivers and lakes are found on, the roads planned on — without the gorges:
  // a gorge cutting a lake's rim drained it and moved the rivers; compose.wgsl ground() asks AtlasP.macroPass)
  const macro = async () => {
    atl.writeParams({ macro: true });
    await one(kMacro, bg(kMacro, { 11: hmacB, 20: atl.region, 21: atl.dist, 22: atl.regs, 23: atl.pat, 25: atl.riverBuf, 26: atl.coarse.cells }));
    atl.writeParams();
  };
  await atl.time('ground', macro);
  atl.hmac = new Float32Array(await atl.time('readback ground', () => atl.read(hmacB)));

  // ---- the rivers: found on the ground, spread to every texel (JFA), the ground again with them ----
  const rv = await atl.time('rivers (cpu)', () => {
    const water = new Uint8Array(N);
    const volcanic = new Uint8Array(N);
    const lavaKinds = new Set(['lavafield', 'basalt', 'rift']);
    for (let i = 0; i < N; i++) {
      const d = atl.defs[atl.regionOf[i]];
      water[i] = d.stat.land ? 0 : 1;
      volcanic[i] = lavaKinds.has(d.kind) ? 1 : 0;
    }
    // (no lava out of an oddity's top: a crystal on a lava field isn't a vent)
    const ku = new Uint32Array(atl.craters.buffer);
    for (let o = 0; o < atl.craters.length; o += CRATER_WORDS) {
      if (ku[o + 6] === 0) continue;
      const R = atl.craters[o + 2] * 1.25;
      const tx = Math.floor((atl.craters[o] / atl.worldW) * n);
      const ty = Math.floor((atl.craters[o + 1] / atl.worldH) * n);
      const rt = Math.ceil((R / atl.worldW) * n);
      for (let dy = -rt; dy <= rt; dy++)
        for (let dx = -rt; dx <= rt; dx++) if (dx * dx + dy * dy <= rt * rt) volcanic[(((ty + dy) % n) + n) % n * n + ((((tx + dx) % n) + n) % n)] = 0;
    }
    return findRivers({ n, hmac: atl.hmac, water, volcanic, regionOf: atl.regionOf, sea: p.sea, worldW: atl.worldW, worldH: atl.worldH });
  });
  atl.riverStats = { nodes: rv.count, lava: rv.lava, waterfalls: rv.waterfalls, lakes: rv.lakes.length, ms: rv.ms, speed: rv.speed, discharge: rv.discharge, pipeSlope: rv.pipeSlope, shaped: rv.shaped };
  atl.riverNodes = rv.nodes;
  atl.riverCatchments = rv.catchments;
  atl.lakes = rv.lakes;
  atl.lakeAt = rv.lakeAt;
  // (round 90) after the nodes: the lakes' table (LAKE_WORDS each: the level), then the per-texel ids, two to a word
  const nodeBytes = Math.max(rv.nodes.byteLength, NODE_WORDS * 4);
  // (round 117, terrain track: FLOOD_SPARE more rows for the basins the terrain's flood tool fills — terrain/flood.ts,
  // Atlas.addBasin; a lake's second word is its fluid: 0 water, 1 sand, 2 magma, 3 ash)
  const lakeTab = new Float32Array((rv.lakes.length + FLOOD_SPARE) * LAKE_WORDS);
  for (const lk of rv.lakes) lakeTab[lk.id * LAKE_WORDS] = lk.level;
  const tabOff = N + CRATER_BLOCK + nodeBytes / 4;
  // (?lakes=0: the lakes found but not realised — the before of an A/B; the rivers' levels are the lakes' still)
  const realise = new URLSearchParams(location.search).get('lakes') !== '0';
  lakeOff = realise ? [tabOff, tabOff + lakeTab.length] : [0, 0];
  atl.basinTab = { tabOff, idsOff: tabOff + lakeTab.length, used: rv.lakes.length, cap: rv.lakes.length + FLOOD_SPARE, on: realise };
  atl.riverBuf.destroy();
  atl.riverBuf = dev.createBuffer({ label: 'atlas rivers', size: (N + CRATER_BLOCK) * 4 + nodeBytes + lakeTab.byteLength + rv.lakeAt.byteLength, usage: S });
  writeCraters();
  dev.queue.writeBuffer(atl.riverBuf, (N + CRATER_BLOCK) * 4, rv.nodes);
  dev.queue.writeBuffer(atl.riverBuf, tabOff * 4, lakeTab);
  dev.queue.writeBuffer(atl.riverBuf, (tabOff + lakeTab.length) * 4, rv.lakeAt);
  dev.queue.writeBuffer(key, 0, rv.nodeAt);
  await atl.time('jfa rivers', async () => {
    await jfa(kSeedV, { 2: key }, kOutV, { 2: key });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(key, 0, atl.riverBuf, 0, N * 4);
    dev.queue.submit([enc.finish()]);
  });
  await atl.time('ground with rivers', macro);
  atl.hmac = new Float32Array(await atl.read(hmacB));
  // sites and roads (round 78): on the ground with its rivers
  await atl.time('sites and roads (cpu)', () => {
    const contOf = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const d = atl.defs[atl.regionOf[i]];
      contOf[i] = d.stat.land ? d.stat.cont : -1;
    }
    const lfOf = new Int32Array(N);
    for (let i = 0; i < N; i++) lfOf[i] = atl.landformOf[atl.regionOf[i]];
    atl.settlement = settle({ n, seed: p.seed, hmac: atl.hmac, landformOf: lfOf, forms: atl.landforms, contOf, river: rv.nodeAt, lake: rv.lakeAt, craters: atl.craters, craterWords: CRATER_WORDS, worldW: atl.worldW, worldH: atl.worldH, sea: p.sea, count: p.sites });
  });
  await atl.time('ways (cpu)', () => {
    atl.ways = buildWays({ settlement: atl.settlement, ground: (x, y) => atl.macroAt(x, y), worldW: atl.worldW, worldH: atl.worldH, sea: p.sea });
  });
  await atl.time('coarse world', () => atl.coarse.init(atl.hmac, n, (t) => !atl.defs[atl.regionOf[t]].stat.land));
  await atl.time('giants (cpu)', () => makeGiants(atl));
  for (const b of [fieldA, key, label, size, flag, flagRead, info, cont, jfaA, jfaB, hmacB]) b.destroy();
}

/**
 * Impact craters (round 78: "adding impact craters at large scale to the heightmap you initially
 * sample"): a few dozen over the world, most a few hundred cells across, some huge with a central peak;
 * the older the more worn (a lower rim, a shallower bowl). Land or sea alike: a crater by a coast is a bay.
 */
export function makeCraters(atl: Atlas): void {
  const r = rng(atl.p.seed * 6151 + 29);
  const k = Math.min(Math.max(0, Math.round(atl.p.craters)), MAX_CRATERS);
  const out = new Float32Array(k * CRATER_WORDS);
  for (let i = 0; i < k; i++) {
    // (sizes: many small, a few huge)
    const R = 120 + 900 * r() ** 3;
    const age = r();
    out.set([r() * atl.worldW, r() * atl.worldH, R, Math.min(R * 0.07, 45) * (1 - 0.6 * age), 1 - age * 0.8, R > 450 ? Math.min(R * 0.05, 40) : 0, 0, 0], i * CRATER_WORDS);
    // (kind crater 0, material 0: the u32 words are zero either way)
  }
  atl.craters = out;
}

/**
 * Atlas-scale oddities (round 78: "atlas scale weird features like faceted crystals or bulbous bumps in
 * the height map"): clusters on land regions' middles — faceted crystal mountains (a main one and smaller
 * ones round it, quartz) or bulbous domes (granite in the earth style, coral in the strange, flesh in
 * the flesh), appended to the craters (STAMP).
 */
export function makeOddities(atl: Atlas): void {
  const r = rng(atl.p.seed * 3571 + 41);
  const room = MAX_CRATERS - atl.craters.length / CRATER_WORDS;
  const land = atl.defs.filter((d) => d.stat.land && d.stat.contArea > 2000);
  const out: number[] = [];
  const style = atl.p.style;
  const bulbMat = style === 2 ? 33 : style === 1 ? 34 : 1;
  for (let c = 0; c < Math.round(atl.p.oddities) && land.length; c++) {
    const d = land[Math.floor(r() * land.length)];
    const cx = d.stat.cx * atl.worldW;
    const cy = d.stat.cy * atl.worldH;
    const facet = r() < (style === 2 ? 0.3 : 0.55);
    // (round 78: a crystal cluster is a field of facets (the user: "large voronoi facets raised slightly
    // deeper in rather than a single large crystal but both should be possible") — a field alone, a
    // field with crystals in it, or crystals alone)
    const fr = r();
    if (facet && fr < 0.7 && out.length / CRATER_WORDS < room) {
      const RF = 220 + 380 * r();
      // (x, y, R, H, its noise's seed, a facet's size)
      out.push(cx, cy, RF, 14 + 30 * r(), Math.floor(r() * 1e6), 18 + 26 * r(), STAMP.field, 36);
      if (fr < 0.4) continue;
    }
    const k = facet ? 1 + Math.floor(r() * 4) : 3 + Math.floor(r() * 6);
    const R0 = facet ? 140 + 260 * r() : 70 + 140 * r();
    for (let i = 0; i < k; i++) {
      if (out.length / CRATER_WORDS >= room) break;
      const R = i === 0 ? R0 : R0 * (0.3 + 0.5 * r());
      const a = r() * Math.PI * 2;
      const dd = i === 0 ? 0 : R0 * (0.6 + 0.9 * r());
      const x = cx + Math.cos(a) * dd;
      const y = cy + Math.sin(a) * dd;
      if (facet) out.push(x, y, R, R * (0.9 + 0.8 * r()), r() * Math.PI * 2, 5 + Math.floor(r() * 4), STAMP.facet, 36);
      else out.push(x, y, R, R * (0.45 + 0.35 * r()), r(), 0, STAMP.bulb, bulbMat);
    }
  }
  const all = new Float32Array(atl.craters.length + out.length);
  all.set(atl.craters);
  all.set(out, atl.craters.length);
  // (the kind and material words are u32s)
  const u = new Uint32Array(all.buffer);
  for (let i = atl.craters.length; i < all.length; i += CRATER_WORDS) {
    u[i + 6] = all[i + 6];
    u[i + 7] = all[i + 7];
  }
  atl.craters = all;
}

/**
 * The giants (round 75: "faceted crystals the size of mountains or columns of crystal extending into
 * the sky at angles"): in the crystal regions, a few each — quartz prisms to a point, 150–420 tall,
 * 16–46 across, leaning up to 35°. The columns have them as forms (forms.wgsl PROF_PRISM: they're
 * handed to each batch they reach into), the far land as meshes (far.ts).
 */
export function makeGiants(atl: Atlas): void {
  const n = atl.p.n;
  const kinds = new Set(['crystals', 'crystalfield']);
  const texels = new Map<number, number[]>();
  for (let i = 0; i < n * n; i++) {
    const r = atl.regionOf[i];
    if (!kinds.has(atl.defs[r].kind)) continue;
    (texels.get(r) ?? texels.set(r, []).get(r)!).push(i);
  }
  const out: number[] = [];
  for (const [reg, ts] of texels) {
    const r = rng(atl.p.seed * 2741 + reg * 613 + 11);
    const count = Math.max(1, Math.min(10, Math.floor(ts.length / 180)));
    for (let k = 0; k < count; k++) {
      const t = ts[Math.floor(r() * ts.length)];
      const tx = t % n;
      const ty = (t - tx) / n;
      const x = ((tx + 0.2 + 0.6 * r()) / n) * atl.worldW;
      const y = ((ty + 0.2 + 0.6 * r()) / n) * atl.worldH;
      const H = 150 + 270 * r() * r();
      const rad = 16 + 30 * r();
      const tilt = ((r() * 35) / 180) * Math.PI;
      const dir = r() * 2 * Math.PI;
      const lean = Math.tan(tilt);
      out.push(x, y, atl.hmac[t] - 6, H, rad, Math.cos(dir) * lean, Math.sin(dir) * lean, r() * Math.PI);
    }
  }
  atl.giants = Float32Array.from(out);
  atl.stats.giants = atl.giants.length / GIANT_FLOATS;
}
