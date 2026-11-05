// The bench's pages, each a load of the level: main, pans, hero, a pan page per zoom (its ramps), the window
// sizes. API: mainPage, pansPage, heroPage, panPage, winPage (Bench's), panRamp.
import { GPUGEN } from '../../atlas/finish';
import { warpWindow } from '../../api/atlas-world';
import { BGCHECK, bgShares, type BgShares } from '../../render/bgcheck';
import { capture, paceProbe, settle } from './pace';
import { ab, lowDetail, missingWhere, view, writtenShare } from './ab';
import { agentsSweep, maxPan, meteor, renderScales, storm, systemGpu, tileSweep, warp } from './sweeps';
import { regionStages, regionStagesGpu, storeIO } from './regions';
import { ROW_H, Stat, r3, stat, AB_WINDOW, AB_RIDE, AB_METEOR } from './defs';
import { PAN_SPEEDS, PAN_STEP_S, PAN_BUDGET, PAN_FPS, PAN_MAX_FRAME, PAN_P99, PAN_BG_FAILS, PAN_BG_FLAG } from './timestamps';
import { tileStepOf } from './pan-report';
import { sleep, frame, waitFor } from '../bench';
import type { Bench } from '../bench';

/** Bench.mainPage (the class keeps the method, documented there) */
export async function mainPage(bn: Bench, out: Record<string, unknown>): Promise<void> {
  const sc = bn.R.scene;
  const S0 = bn.R.stream;
  bn.startAt = [S0.origin[0] + S0.W / 2, S0.origin[1] + S0.H / 2];
  const drive = sc.drive;
  sc.drive = null;
  sc.pan = null;
  bn.say('settling…');
  out.settleMs = await settle(bn, 6000);
  out.window = { w: bn.W, h: bn.R.stream.H, region: bn.R.stream.R, layoutBytes: bn.R.stream.layout.bytes };
  out.view = view(bn);
  bn.say('parked frames…');
  bn.framesHook = (f) => (bn.idleFrames = f);
  out.idle = await capture(bn, 5);
  bn.framesHook = null;
  bn.idleP50 = (out.idle as { frames?: Stat }).frames?.p50 ?? 17;
  // (v4: the A/B runs on an active scene — riding in a storm, and at a meteor's lava — not parked)
  bn.say('region generation, stage by stage…');
  // (round 102: the GPU's way when it's on — and the CPU's, to compare, in the same run)
  out.regionStages = GPUGEN ? await regionStagesGpu(bn, 5) : await regionStages(bn, 5);
  if (GPUGEN) out.regionStagesCpu = await regionStages(bn, 5);
  bn.say('regions/s at 1, 2, 4, 8 tiles a frame…');
  out.tiles = await tileSweep(bn);
  bn.say('agents…');
  out.agents = await agentsSweep(bn);
  bn.say('render scales…');
  out.renderScale = await renderScales(bn);
  bn.say('the disk store…');
  out.store = await storeIO(bn, 4);
  // the scenarios
  bn.say('scenario: riding the road (20 s)…');
  await settle(bn, 1500, 15000);
  if (drive) {
    sc.drive = drive;
    out.ride = { ...(await capture(bn, 20)), view: view(bn) };
    // (v4) the A/B while it rides on, a storm over the camera
    out.abRideStorm = storm(bn);
    await sleep(1500);
    out.ab = await ab(bn, AB_RIDE, 1.5, `riding at 18 cells/s, ${out.abRideStorm}`);
    bn.say('each system\'s GPU time, one pass each (riding in the storm)…');
    out.systemGpu = await systemGpu(bn, `riding at 18 cells/s, ${out.abRideStorm}`);
    sc.drive = null;
  } else out.ride = { error: 'no road near the start (?drive found none)' };
  out.timestampsJudged = bn.tsChecks;
}

/** Bench.pansPage (the class keeps the method, documented there) */
export async function pansPage(bn: Bench, out: Record<string, unknown>): Promise<void> {
  const sc = bn.R.scene;
  const S0 = bn.R.stream;
  bn.startAt = [S0.origin[0] + S0.W / 2, S0.origin[1] + S0.H / 2];
  sc.drive = null;
  sc.pan = null;
  bn.say('settling…');
  out.settleMs = await settle(bn, 5000);
  out.window = { w: bn.W, h: bn.R.stream.H };
  out.parked = await capture(bn, 3);
  bn.idleP50 = (out.parked as { frames?: Stat }).frames?.p50 ?? 17;
  // (v3: pans at 80 and 120, then 160, 240 and 320 — the user: "crank up pan speed and view distance")
  for (const v of [80, 120, 160, 240, 320]) {
    const secs = v <= 120 ? 12 : 10;
    bn.say(`scenario: a fast pan at ${v} cells/s (${secs} s)…`);
    await settle(bn, 1500, 15000);
    const [ux, uy] = bn.R.camera.screenDeltaToWorld(0, -1);
    const l = Math.hypot(ux, uy) || 1;
    bn.parkedCover = writtenShare(bn);
    sc.pan = { speed: v, dir: [ux / l, uy / l], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
    const pc = bn.R.atlas.pacer;
    const pz = () => ({ how: pc.how, tileMs: +pc.tileMs.toFixed(3), gpuMs: +pc.gpuMs.toFixed(2), budgetMs: +pc.budgetMs.toFixed(2), perFrame: pc.perFrame, tiles: pc.tiles });
    const pacerBefore = pz();
    const low: number[] = [];
    const cap = await capture(bn, secs, () => low.push(lowDetail(bn)));
    out[`pan${v}`] = { ...cap, lowDetail: stat(low, 'share of the screen that is detailed parked but not now (0..1)'), view: view(bn), pacerBefore, pacerAfter: pz() };
    sc.pan = null;
  }
  bn.say('the fastest pan it keeps up with…');
  out.maxPan = await maxPan(bn);
  // (v4: back to the start — the pans carried the window thousands of cells away, and v3's warp went a third of the
  // way round from there, to flat land; the user: "the atlas location it jumps to seems to have shifted and is less
  // interesting and has no cliffs". The start (RIDE_AT: a road among cliffs, a town) is where the warp lands now)
  bn.say('scenario: a warp back to the start…');
  await settle(bn, 1500, 15000);
  out.warp = await warp(bn, bn.startAt);
  // the integrity judge and the rock bodies: a meteor beside the camera (the bench's own world, cleared at the end)
  bn.say('a meteor: the judge and the rock bodies (12 s)…');
  await settle(bn, 1500, 15000);
  out.meteor = await meteor(bn);
  // (v4) the A/B at the meteor: its lava and debris awake
  out.abMeteor = await ab(bn, AB_METEOR, 1.5, 'parked by a meteor\'s crater (lava, debris)');
  out.systemGpuMeteor = await systemGpu(bn, 'parked by a meteor\'s crater (lava, debris)');
  out.timestampsJudged = bn.tsChecks;
}

/** Bench.heroPage (the class keeps the method, documented there) */
export async function heroPage(bn: Bench, out: Record<string, unknown>): Promise<void> {
  bn.say('waiting for the run…');
  const run = await waitFor(() => bn.R.run?.play && bn.R.run, 120000);
  out.settleMs = await settle(bn, 5000);
  out.window = { w: bn.W, h: bn.R.stream.H };
  out.viewStanding = view(bn);
  out.standing = await capture(bn, 6);
  bn.say('the hero walking (25 s)…');
  // (a talk open holds the hero still: closed, as a player would tap it away)
  out.atStart = { dialogOpen: !!run.play?.dialog?.isOpen, ended: !!run.ended, alive: run.hero?.alive ?? null };
  if (run.play?.dialog?.isOpen) run.play.dialog.close?.();
  let ang = -Math.PI / 2;
  // (a copy: position() hands back the hero's own array, moved in place — v1 compared it with itself and saw no walk)
  let prev = [...run.hero.position()];
  let walked = 0;
  let placed = 0;
  let mode = 'stick';
  let lastPut = 0;
  const capt = await capture(bn, 25, (t) => {
    if (run.play?.dialog?.isOpen) run.play.dialog.close?.();
    const h = run.hero.position();
    const d = Math.hypot(h[0] - prev[0], h[1] - prev[1]);
    if (d < 50) walked += d;
    prev = [h[0], h[1], h[2]];
    // (the pad's scripted stick, as runtest.mjs: up the screen, a quarter turn every 8 s)
    ang = -Math.PI / 2 + Math.floor(t / 8) * (Math.PI / 2);
    if (mode === 'stick') {
      // (the TouchPad's scripted stick: its intent() reads it as a held stick — the same path a thumb takes)
      run.pad.scripted = { stick: [Math.cos(ang) * 56, Math.sin(ang) * 56] };
      // (the stick didn't move it in 4 s: the hero put down ahead every 0.5 s at a hover bike's pace, as runtest.mjs's ride)
      if (t > 4 && walked < 3) mode = 'placed';
    } else if (t - lastPut > 0.5 && !bn.R.stream.busy && run.winOf && run.worldOf) {
      lastPut = t;
      const [ux, uy] = bn.R.camera.screenDeltaToWorld(Math.cos(ang), Math.sin(ang));
      const l = Math.hypot(ux, uy) || 1;
      const wv = run.worldOf([h[0], h[1]]);
      const to = run.winOf([wv[0] + (ux / l) * 8, wv[1] + (uy / l) * 8]);
      if (bn.R.api?.terrain?.heightAt?.(to[0], to[1]) !== null) {
        run.hero.place(to);
        placed++;
      }
    }
  });
  run.pad.scripted = null;
  out.walking = { ...capt, view: view(bn), movedBy: mode, walkedCells: Math.round(walked), placedSteps: placed };
}

// ---- the pan benchmark (round 104) ----

/** Bench.panPage (the class keeps the method, documented there) */
export async function panPage(bn: Bench, out: Record<string, unknown>, zooms: number[]): Promise<void> {
  const sc = bn.R.scene;
  const S = bn.R.stream;
  const a = bn.R.atlas;
  const cam = bn.R.camera;
  sc.drive = null;
  sc.pan = null;
  bn.say('settling…');
  out.settleMs = await settle(bn, 4000, 20000);
  out.window = { w: bn.W, h: S.H };
  const W = bn.W;
  // the line: up the screen from the start, in world cells (x) and world units (y)
  const [ux, uy] = cam.screenDeltaToWorld(0, -1);
  const l = Math.hypot(ux, uy) || 1;
  const dir: [number, number] = [ux / l, uy / l];
  const perp: [number, number] = [-dir[1], dir[0]];
  const start: [number, number] = [S.origin[0] + cam.target[0], (S.origin[1] * ROW_H + cam.target[1])];
  const toRows = (p: [number, number]): [number, number] => [p[0], p[1] / ROW_H];
  const dims = { w: S.W, h: S.H, zMax: bn.R.core.dims.zMax };
  const goToWorld = async (p: [number, number]) => {
    await warpWindow(a, S, dims, ...toRows(p));
    await settle(bn, 1500, 15000);
  };
  // the disk line, filled: every region the window holds marked touched as it pans (saved as it leaves)
  const fillLen = PAN_SPEEDS.reduce((t, v) => t + v * PAN_STEP_S, 0) + W;
  bn.say(`filling the disk line (${Math.round(fillLen)} cells)…`);
  const f0 = performance.now();
  const saved0 = S.stats.saved;
  cam.zoom = Math.min(...zooms);
  sc.pan = { speed: 300, dir, t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
  try {
    // (round 112, tilefix2: till the camera has gone the line's length, not till it was asked to — on the phone the
    // pan waited at the window's edge for its slides, the line saved a third as long as the disk ramp then went, and
    // its rows came 6 of ~250 from disk, the rest made: the disk rows measured generated land)
    const along = () => (S.origin[0] + cam.target[0] - start[0]) * dir[0] + (S.origin[1] * ROW_H + cam.target[1] - start[1]) * dir[1];
    while (along() < fillLen) {
      await frame();
      S.touch(0, 0, S.W, S.H);
      if (performance.now() - f0 > 180000) break;
    }
  } finally {
    sc.pan = null;
  }
  await settle(bn, 1500, 20000);
  await S.store?.flush?.();
  out.fill = { travelled: Math.round((S.origin[0] + cam.target[0] - start[0]) * dir[0] + (S.origin[1] * ROW_H + cam.target[1] - start[1]) * dir[1]), cells: Math.round(fillLen), ms: Math.round(performance.now() - f0), regionsSaved: S.stats.saved - saved0, storeRegions: S.store?.size ?? null };
  const rows: Record<string, unknown>[] = [];
  out.zooms = rows;
  let lane = 0;
  for (const z of zooms) {
    const row: Record<string, unknown> = { zoom: z };
    rows.push(row);
    for (const src of ['pool', 'generated', 'disk'] as const) {
      bn.say(`zoom ${z}, ${src}: placing…`);
      if (src === 'generated') await goToWorld([start[0] + perp[0] * (lane + 1) * (W + 512), start[1] + perp[1] * (lane + 1) * (W + 512)]);
      if (src === 'disk') await goToWorld(start);
      if (src === 'pool') {
        // (a first leg there and back: what the pings bring in is in the pool)
        await settle(bn, 1000, 10000);
      }
      cam.zoom = z;
      await sleep(600);
      bn.parkedCover = writtenShare(bn);
      row.coverParked = r3(bn.parkedCover);
      // (the window's own cost at this zoom, parked: what a pan's frames are measured against)
      if (!row.parked) {
        const pk = await capture(bn, 3);
        const fr = pk.frames as Stat | null;
        row.parked = { fps: pk.fps, p50: fr?.p50 ?? null, p99: pk.p99, max: fr?.max ?? null, overBudget: null, unit: 'rendered fps; ms' };
        bn.parkedFps = pk.fps as number;
        // (v6: the frame pacing parked — the A/B at the first zoom only)
        row.pace = await paceProbe(bn, 4, z === zooms[0]);
      }
      row[src] = await panRamp(bn, z, src, dir);
    }
    lane++;
  }
}

/** One speed ramp: each speed PAN_STEP_S s, measured; the last that passed, and why the next didn't */
export async function panRamp(bn: Bench, zoom: number, src: 'pool' | 'generated' | 'disk', dir: [number, number]): Promise<Record<string, unknown>> {
  const sc = bn.R.scene;
  const cam = bn.R.camera;
  const steps: Record<string, unknown>[] = [];
  let maxSmooth: number | null = null;
  let failedFirst: string | null = null;
  let failedAt: number | null = null;
  let causesAtFail: unknown = null;
  let maxNoPopIn: number | null = null;
  let popInAt: number | null = null;
  // (round 112, bgcheck: the speeds whose step showed the background)
  const bgAt: number[] = [];
  const BG = bn.R.core.renderer.bgCheck;
  let strict = true;
  const anchor: [number, number] = [cam.target[0], cam.target[1]];
  let sign = 1;
  let st0 = { ...bn.R.stream.stats };
  sc.pan = { speed: PAN_SPEEDS[0], dir: [...dir], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
  try {
    if (src === 'pool') {
      // (the pool warmed: once there and back over the three regions)
      sc.pan.speed = 120;
      for (const leg of [1, -1]) {
        sc.pan.dir = [dir[0] * leg, dir[1] * leg];
        const t0 = performance.now();
        while (performance.now() - t0 < 1800) await frame();
      }
      sc.pan.dir = [...dir];
    }
    // (a warm-up at the first speed, not measured: the streaming going, the window placed's own work done)
    sc.pan.speed = PAN_SPEEDS[0];
    {
      const t0 = performance.now();
      while (performance.now() - t0 < 2000) {
        await frame();
        if (src === 'pool') {
          const off = (cam.target[0] - anchor[0]) * dir[0] + (cam.target[1] - anchor[1]) * dir[1];
          if (off > 192 && sign > 0) sign = -1;
          else if (off < 0 && sign < 0) sign = 1;
          sc.pan.dir = [dir[0] * sign, dir[1] * sign];
        }
      }
    }
    // (where the land that came in came from, during the ramp: the source is what it says)
    st0 = { ...bn.R.stream.stats };
    for (const v of PAN_SPEEDS) {
      bn.say(`zoom ${zoom}, ${src}: ${v} cells/s…`);
      sc.pan.speed = v;
      bn.ctx.hitch?.rec?.reset();
      // (round 104) each slide's GPU time by onSubmittedWorkDone (Mali's sane clock), the queue's usual lag, the slide's CPU
      const S = bn.R.stream;
      const sd0 = S.slideDone?.length ?? 0;
      const bd0 = S.baseDone?.length ?? 0;
      const tr0 = S.trace.length;
      const frames: number[] = [];
      let low = 0;
      const fno0 = bn.prof.frameNo;
      let fno = fno0;
      const sl0 = bn.R.stream.stats.slides;
      const t0 = performance.now();
      // (v8: the step's slow frames, how close together — framepace.ts clusters)
      const pm = bn.ctx.pacer?.mark();
      let last = t0;
      // (round 106, tilephone: the tiles' render-only land during the step — what's baked, its stages, the leading half)
      const TL = bn.R.core.renderer.tiles;
      const baked0 = (TL?.land?.stats.baked as number | undefined) ?? 0;
      const lead: number[] = [];
      const miss = { win: 0, ahead: 0, side: 0, behind: 0 };
      // (round 112, tilefast: the worst frame's why, a share of the screen each; the atlas's slots; the pacer's turns)
      const why: Record<string, number> = {};
      const ts0 = TL ? { ...TL.stats, noSlot: (TL.land?.stats.noSlot as number | undefined) ?? 0 } : null;
      const pz = bn.R.atlas?.pacer;
      const pc0 = pz ? { tiles: pz.tiles, frames: pz.frames, chained: pz.chained } : null;
      let perFrameSum = 0;
      let usedMax = 0;
      let drawnMax = 0;
      // (round 113, tilesfirst: the geometric coverage check every frame — render/coverage.ts: the land the camera
      // sees not drawn this frame, neither the window's nor a tile's — its worst frame, mean, frames with any; with the
      // pixel check on, the mesh's built mirror read back every frame so the two judge the same frame)
      const geo = { max: 0, sum: 0, frames: 0, framesAny: 0, chunksMax: 0, regionsMax: 0 };
      const fmesh = TL?.host?.win?.mesh as { statPeriod: number } | undefined;
      const statWas = fmesh?.statPeriod;
      if (fmesh && BGCHECK) fmesh.statPeriod = 1;
      BG?.take();
      while (performance.now() - t0 < PAN_STEP_S * 1000) {
        const t = await frame();
        if (src === 'pool') {
          const off = (cam.target[0] - anchor[0]) * dir[0] + (cam.target[1] - anchor[1]) * dir[1];
          if (off > 192 && sign > 0) sign = -1;
          else if (off < 0 && sign < 0) sign = 1;
          sc.pan.dir = [dir[0] * sign, dir[1] * sign];
        }
        if (bn.prof.frameNo === fno) continue;
        fno = bn.prof.frameNo;
        frames.push(t - last);
        last = t;
        low = Math.max(low, bn.parkedCover - writtenShare(bn));
        const gc = TL?.coverCheck(cam);
        if (gc) {
          geo.frames++;
          geo.sum += gc.share;
          geo.max = Math.max(geo.max, gc.share);
          if (gc.chunksUndrawn + gc.regionsUndrawn > 0) geo.framesAny++;
          geo.chunksMax = Math.max(geo.chunksMax, gc.chunksUndrawn);
          geo.regionsMax = Math.max(geo.regionsMax, gc.regionsUndrawn);
        }
        if (TL) lead.push(1 - TL.coverageSplit(cam).lead);
        // (round 106: where what's not in detail is, the worst frame's of each kind)
        const fw: Record<string, number> = {};
        const mw = missingWhere(bn, sc.pan.dir, fw);
        for (const k of ['win', 'ahead', 'side', 'behind'] as const) miss[k] = Math.max(miss[k], mw[k]);
        for (const k in fw) why[k] = Math.max(why[k] ?? 0, fw[k]);
        if (pz) perFrameSum += pz.perFrame;
        if (TL) {
          usedMax = Math.max(usedMax, TL.stats.used);
          drawnMax = Math.max(drawnMax, TL.stats.drawn);
        }
      }
      if (fmesh && statWas !== undefined) fmesh.statPeriod = statWas;
      const secs = (performance.now() - t0) / 1000;
      const fps = (bn.prof.frameNo - fno0) / secs;
      // (round 112, bgcheck: the step's frames read back — a readback started after the step — then its shares)
      let bg: BgShares | null = null;
      if (BG) {
        await Promise.race([BG.sync(), sleep(2000)]);
        bg = bgShares(BG.take());
      }
      const bgShown = !!bg && bg.bgMax > PAN_BG_FLAG;
      if (bgShown) bgAt.push(v);
      const sorted = [...frames].sort((x, y) => x - y);
      const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? Infinity;
      const max = sorted[sorted.length - 1] ?? Infinity;
      const fails: string[] = [];
      if (fps < PAN_FPS) fails.push(`fps ${fps.toFixed(0)}`);
      if (max > PAN_MAX_FRAME) fails.push(`frame ${max.toFixed(0)} ms`);
      if (p99 > PAN_P99) fails.push(`p99 ${p99.toFixed(0)} ms`);
      // (round 113: pop-in is the geometric check's — what the camera sees that's drawn by neither the window nor a
      // tile. The old "out of detail" (writtenShare) counted the window's land as detailed once written, not drawn,
      // and missed the close-zoom holes; it's kept in the row as lowDetailMax to compare)
      const popIn = geo.max > 0.001;
      if (popIn) fails.push(`pop-in ${(geo.max * 100).toFixed(1)}% of the screen (geometric)`);
      if (bgShown && PAN_BG_FAILS) fails.push(`background ${(bg!.bgMax * 100).toFixed(2)}% of the screen`);
      const slides = bn.R.stream.stats.slides - sl0;
      const over = frames.filter((f) => f > PAN_BUDGET).length;
      // (the arrays keep their last 64 / 200: what came in during the step)
      const slideDone = S.slideDone ? S.slideDone.slice(Math.min(sd0, S.slideDone.length)) : null;
      const bd = S.baseDone ? [...S.baseDone.slice(Math.min(bd0, S.baseDone.length))].sort((x: number, y: number) => x - y) : [];
      const slideCpu = S.trace.slice(Math.min(tr0, S.trace.length)).map((t: { t0: number; sync: number }) => r3(t.sync - t.t0));
      const whyR: Record<string, number> = {};
      for (const k in why) whyR[k] = r3(why[k]);
      const slots = TL && ts0 ? { slots: TL.stats.slots, mb: TL.stats.mb, usedMax, drawnMax, evicted: TL.stats.evicted - ts0.evicted, noSlot: ((TL.land?.stats.noSlot as number | undefined) ?? 0) - ts0.noSlot, zoomFloor: TL.stats.zoomFloor, floorBound: TL.stats.floorBound, floorTiles: TL.stats.floorTiles, cal: { ...TL.cal.stats, rate: r3(TL.cal.stats.rate), measuredS: r3(TL.cal.stats.measuredS) } } : null;
      const pacer = pz && pc0 ? { perFrameMean: frames.length ? r3(perFrameSum / frames.length) : null, turnsPerFrame: r3((pz.tiles - pc0.tiles) / Math.max(1, frames.length)), chained: pz.chained - pc0.chained } : null;
      const tiles = TL?.land ? { ...tileStepOf(TL, baked0, t0, secs, lead), missMax: { win: r3(miss.win), ahead: r3(miss.ahead), side: r3(miss.side), behind: r3(miss.behind) }, missWhy: whyR, slots, pacer } : null;
      const geoR = { max: r3(geo.max), mean: geo.frames ? +(geo.sum / geo.frames).toFixed(5) : null, frames: geo.frames, framesAny: geo.framesAny, chunksMax: geo.chunksMax, regionsMax: geo.regionsMax };
      steps.push({ speed: v, fps: +fps.toFixed(1), p99: r3(p99), max: r3(max), lowDetailMax: r3(low), geo: geoR, tiles, slides, framesOverBudget: over, overBudgetPerSlide: slides ? r3(over / slides) : null, slideDoneMs: slideDone, baseDoneP50: bd.length ? bd[Math.floor(bd.length / 2)] : null, slideCpuMs: slideCpu, bg, slowClusters: pm !== undefined ? (bn.ctx.pacer!.report(pm).clusters ?? null) : null, ok: !fails.length });
      if (fails.length && strict) {
        strict = false;
        failedFirst = fails.join(', ');
        failedAt = v;
        const rep = bn.ctx.hitch?.rec?.report() as { causes?: unknown; worst?: { ms: number; cause: string; steps: { label: string; ms: number }[]; async: { label: string; ms: number }[] }[] } | undefined;
        causesAtFail = rep ? { causes: rep.causes, worst: (rep.worst ?? []).slice(0, 3).map((h) => `${h.ms} ${h.cause} ${[...h.steps, ...h.async].slice(0, 2).map((x) => `${x.label} ${x.ms}`).join(', ')}`) } : null;
      }
      if (strict) maxSmooth = v;
      // (the ramp goes on past frames over budget: the fastest it keeps the screen in detail, apart)
      if (popIn) {
        popInAt = v;
        break;
      }
      maxNoPopIn = v;
      if (fps < Math.max(8, bn.parkedFps / 4)) break;
    }
  } finally {
    sc.pan = null;
  }
  const st1 = bn.R.stream.stats;
  const came = { generated: st1.generated - st0.generated, fromPool: st1.thawed - st0.thawed, fromDisk: st1.loaded - st0.loaded, slides: st1.slides - st0.slides, storeMiss: st1.storeMiss - st0.storeMiss, mismatched: st1.mismatched - st0.mismatched, loadFailed: st1.loadFailed - st0.loadFailed, storeSize: bn.R.stream.store?.size ?? null };
  return { maxSmooth, failedFirst, failedAt, causesAtFail, maxNoPopIn, popInAt, bgAt, came, steps };
}

// ---- other window sizes ----

/** Bench.winPage (the class keeps the method, documented there) */
export async function winPage(bn: Bench, out: Record<string, unknown>): Promise<void> {
  const sc = bn.R.scene;
  // (the ride's road, kept for later — the smoke run found v3 dropped it before keeping it)
  const drive = sc.drive;
  sc.drive = null;
  sc.pan = null;
  bn.say('settling…');
  out.settleMs = await settle(bn, 5000);
  out.window = { w: bn.W, h: bn.R.stream.H };
  out.view = view(bn);
  bn.framesHook = (f) => (bn.idleFrames = f);
  out.parked = await capture(bn, 4);
  bn.framesHook = null;
  // (v3) a short ride; (v4) the A/B of what scales with the window while it rides on, a storm over it
  bn.say('a short ride (10 s)…');
  await settle(bn, 1000, 10000);
  if (drive) {
    sc.drive = drive;
    out.ride = { ...(await capture(bn, 10)), view: view(bn) };
    out.abStorm = storm(bn);
    await sleep(1000);
    out.ab = await ab(bn, AB_WINDOW, 1.5, `riding at 18 cells/s, ${out.abStorm}`);
    bn.say('each system\'s GPU time, one pass each…');
    out.systemGpu = await systemGpu(bn, `riding at 18 cells/s, ${out.abStorm}`);
    sc.drive = null;
  } else out.ab = await ab(bn, AB_WINDOW, 1.5, 'parked (no road)');
  out.maxPan = await maxPan(bn);
}
