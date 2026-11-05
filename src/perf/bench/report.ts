// The bench's report: every page's results put together, and its summary lines. API: makeReport, summary.
import { BENCH_VERSION, r3, AB_WINDOW, WINDOWS } from './defs';
import { BenchState } from './state';

// ---------- the report ----------

export function makeReport(s: BenchState): Record<string, unknown> {
  const res = s.results as Record<string, any>;
  // (v4: the sandbox is two pages now — the pans page's numbers alongside the main page's)
  const main = { ...(res.pans ?? {}), ...(res.main ?? {}), ...Object.fromEntries(Object.entries(res.pans ?? {}).filter(([k]) => /^(pan\d+|maxPan|warp|meteor|abMeteor)$/.test(k))) };
  const idle = main.idle ?? {};
  // (v2: not from timestamps a GPU got wrong; the budget is then the frame interval's and the A/B's)
  const gpuIdle = typeof idle.gpuFrame === 'object' && idle.timestamps?.reliable !== false ? idle.gpuFrame.p50 : null;
  const frameIdle = idle.frames?.p50 ?? null;
  const W = main.window?.w ?? 320;
  const R = main.window?.region ?? 64;
  const derived: Record<string, unknown> = { window: W, region: R };
  // the region rate at each tile count, and the camera speed it sustains: a move of R cells along an axis brings W/R regions
  const tiles = main.tiles ?? {};
  const speeds: Record<string, unknown> = {};
  let best = 0;
  let bestK = 0;
  for (const k of [1, 2, 4, 8]) {
    const t = tiles[`k${k}`];
    if (!t?.regionsPerSecond) continue;
    // (the tile rate's regions: a region is (R/32)^2 tiles — plan batches counted as the work they are)
    const rate = t.regionsPerSecondFromTiles ?? t.regionsPerSecond;
    const v = (rate * R * R) / W;
    speeds[`k${k}`] = { regionsPerSecond: rate, measuredRegionsPerSecond: t.regionsPerSecond, maxCameraCellsPerSecondAxis: +v.toFixed(1), maxCameraCellsPerSecondDiagonal: +((rate * R * R) / (2 * W - R) * Math.SQRT2).toFixed(1), frameP95: t.frames?.p95 ?? null };
    if (rate > best) {
      best = rate;
      bestK = k;
    }
  }
  derived.cameraSpeed = { unit: 'cells/s, the camera moving straight on with no prefetch beyond the window', rule: 'regions/s x R^2 / W (axis); diagonal: a strip and a column a region moved', ...speeds };
  const tileMs = tiles.k1?.gpuColFinishPerTile?.p50 ?? null;
  const regGpu = main.regionStages?.gpu;
  const fixedRegionMs = typeof regGpu === 'object' ? (regGpu.colHeight?.p50 ?? 0) + (regGpu.formSeed?.p50 ?? 0) : null;
  const budget = (fps: number) => (gpuIdle !== null ? +(1000 / fps - gpuIdle).toFixed(2) : null);
  derived.gpuBudget = {
    unit: 'GPU ms a frame',
    parkedGpuFrameP50: gpuIdle,
    parkedFrameIntervalP50: frameIdle,
    leftAt60: budget(60),
    leftAt30: budget(30),
    note: gpuIdle === null ? 'no timestamp-query: the frame interval only' : 'the frame period less the parked GPU frame (p50)',
  };
  const suggest = (left: number | null) => (left !== null && tileMs ? Math.max(1, Math.floor((left * 0.5) / tileMs)) : null);
  derived.tilesPerFrame = {
    gpuMsPerTile: tileMs,
    regionFixedGpuMs: fixedRegionMs,
    suggestedAt60: suggest(budget(60)),
    suggestedAt30: suggest(budget(30)),
    rule: 'half the GPU time left at that rate / colFinish ms a 32x32 tile (the other half for play); a region is 4 tiles + colHeight + formSeed once',
    measuredBest: bestK ? { tilesPerFrame: bestK, regionsPerSecond: best } : null,
  };
  if (best) {
    const cells = best * R * R;
    derived.precache = {
      unit: 'at the measured best region rate',
      cellsPerSecond: Math.round(cells),
      areaSidePerSecond: +Math.sqrt(cells).toFixed(0),
      windowSecondsToFill: +((W / R) ** 2 / best).toFixed(1),
      ringOf1RegionAroundWindowSeconds: +((4 * (W / R) + 4) / best).toFixed(1),
      note: 'how much land could be made ahead of a ride or round a warp target a second, if generation had the GPU to itself at that tile rate',
    };
  }
  const t0 = res.thermalStart?.gpu?.p50 ?? res.thermalStart?.wall?.p50;
  const t1 = res.thermalEnd?.gpu?.p50 ?? res.thermalEnd?.wall?.p50;
  derived.thermal = t0 && t1 ? { startMs: t0, endMs: t1, driftPct: +((100 * (t1 - t0)) / t0).toFixed(1), how: res.thermalStart?.gpu?.p50 ? 'GPU (timestamp)' : 'wall' } : null;
  const hero = res.hero ?? {};
  derived.heroVsSandbox = {
    sandboxRide: main.ride?.frames ?? null,
    heroWalking: hero.walking?.frames ?? null,
    sandboxView: main.ride?.view ?? main.view ?? null,
    heroView: hero.walking?.view ?? hero.viewStanding ?? null,
    sandboxGpuGroups: main.ride?.gpuGroups ?? null,
    heroGpuGroups: hero.walking?.gpuGroups ?? null,
  };
  const ride = main.ride ?? {};
  derived.mesh = main.mesh ? { unit: 'GPU ms', perChunk: main.mesh.perChunk, slotsPerFrame: main.mesh.slotsPerFrame, parkedPerFrame: main.mesh.parkedMeshPerFrame?.p50 ?? null, ridingPerFrame: ride.meshFrame?.p50 ?? null } : null;
  derived.sims = { parked: idle.simPerAwakeChunk ?? null, riding: ride.simPerAwakeChunk ?? null };
  derived.judge = main.meteor ? { judgePass: main.meteor.judgePass, rockBodiesStep: main.meteor.rockBodiesStep, rockBodiesPerBody: main.meteor.rockBodiesPerBody, bodies: main.meteor.rockBodies } : null;
  // (v2) the A/B: the costliest systems; and what scales with the window (its cost at each window size)
  const abSys = (main.ab?.systems ?? {}) as Record<string, any>;
  const costs = Object.entries(abSys)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => [k, v.costFrameMs, v.costDrainMs] as [string, number, number])
    .sort((a, b) => b[1] - a[1]);
  derived.ab = { unit: 'ms a frame (frame interval with it on - off; drain)', top: costs.slice(0, 12).map(([k, f, d]) => `${k} ${f} / ${d}`) };
  const wins: Record<string, Record<string, any>> = { [String(W)]: abSys };
  for (const k of Object.keys(res)) if (/^win\d+$/.test(k) && res[k]?.ab?.systems) wins[k.slice(3)] = res[k].ab.systems;
  const sizes = Object.keys(wins).map(Number).sort((a, b) => a - b);
  const scaling: Record<string, unknown> = {};
  for (const k of AB_WINDOW) {
    const by = sizes.map((w) => wins[String(w)]?.[k]?.costFrameMs ?? null);
    const fps = sizes.map((w) => wins[String(w)]?.[k]?.fpsOn ?? null);
    if (by.every((v) => v === null)) continue;
    const a = by[0];
    const b = by[by.length - 1];
    scaling[k] = { costFrameMs: Object.fromEntries(sizes.map((w, i) => [w, by[i]])), fpsOn: Object.fromEntries(sizes.map((w, i) => [w, fps[i]])), ratioLargestToSmallest: a && b && a > 0.2 ? r3(b / a) : null };
  }
  derived.windowScaling = { sizes, areaRatio: sizes.length > 1 ? r3((sizes[sizes.length - 1] / sizes[0]) ** 2) : null, note: 'a system that scales with the window costs about areaRatio times more at the largest; costs under ~0.3 ms are noise', systems: scaling };
  // (v3) per window size: rendered fps parked and riding, the fastest pan it sustains
  const table: Record<string, unknown> = {};
  const pageOf = (w: number) => (w === W ? { parked: main.idle, ride: main.ride, maxPan: main.maxPan } : res[`win${w}`]);
  for (const w of [...WINDOWS].sort((a, b) => a - b)) {
    const pg = pageOf(w);
    if (!pg || (w === W && !main.idle)) continue;
    table[w] = pg.error
      ? { error: pg.error }
      : {
          parkedFps: pg.parked?.fps ?? null,
          rideFps: pg.ride?.fps ?? null,
          rideP95: pg.ride?.frames?.p95 ?? null,
          maxPan: pg.maxPan?.maxSustainable ?? null,
          stoppedBy: pg.maxPan?.stoppedBy ?? null,
          // (v4) the share of the screen in the window's detail: parked, riding, and over the pans (the main page's)
          detailParked: pg.parked?.screenInDetail?.mean ?? null,
          detailRiding: pg.ride?.screenInDetail?.mean ?? null,
          simsGpuMs: pg.systemGpu?.systems ? r3(Object.entries(pg.systemGpu.systems as Record<string, { gpuMs: number | null }>).filter(([k]) => k !== 'agents').reduce((a, [, v]) => a + (v.gpuMs ?? 0), 0)) : null,
          awakeChunks: pg.systemGpu?.awakeChunks ?? null,
          windowChunks: pg.systemGpu?.windowChunks ?? null,
        };
  }
  // (v4) the window the screen needs (95% of it in detail at the sandbox's zoom), and what a frame costs there: measured
  // if it's one of the sizes, else the frame time's line in the window's area through the sizes measured
  const need = (main.ride?.view?.windowFor95 ?? main.view?.windowFor95 ?? null) as number | null;
  const pts = Object.entries(table)
    .map(([w, v]: [string, any]) => [Number(w), v?.rideFps ?? v?.parkedFps] as [number, number])
    .filter(([, f]) => f > 0)
    .map(([w, f]) => [w * w, 1000 / f] as [number, number]);
  let at: unknown = null;
  if (need && pts.length >= 2) {
    const n = pts.length;
    const mx = pts.reduce((a, [x]) => a + x, 0) / n;
    const my = pts.reduce((a, [, y]) => a + y, 0) / n;
    const b = pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / Math.max(1e-9, pts.reduce((a, [x]) => a + (x - mx) ** 2, 0));
    const ms = my + b * (need * need - mx);
    at = { window: need, frameMs: r3(ms), fps: +(1000 / ms).toFixed(1), how: (table as Record<string, unknown>)[need] ? 'measured' : 'extrapolated: frame ms linear in the window\'s area through the sizes measured (riding, else parked)', msPerMillionCells: r3(b * 1e6) };
  }
  derived.coverage = { unit: 'share of the screen in the window\'s detail', windowFor95AtSandboxZoom: need, heroWindowFor95: res.hero?.walking?.view?.windowFor95 ?? null, costThere: at };
  derived.byWindow = { unit: 'rendered fps; maxPan cells/s; detail = share of the screen in the window\'s detail; simsGpuMs = the sims\' GPU ms a tick, one pass each', table };
  const tsJ = main.timestampsJudged as { reliable: boolean | null; why: string }[] | undefined;
  const tsBad = tsJ?.find((t) => t.reliable === false);
  const tsSum = { reliable: tsJ?.length ? !tsBad : null, why: tsBad?.why ?? tsJ?.[0]?.why ?? 'n/a', modes: res.timestampModes ? Object.fromEntries(['onePassEach', 'ownEncoderEach', 'allInOnePass'].map((m) => [m, res.timestampModes[m] ? { sumP50: res.timestampModes[m].sum?.p50, wallP50: res.timestampModes[m].wall?.p50, sumOverWall: res.timestampModes[m].sumOverWall } : null])) : null };
  const fpsOf = (c: any) => (c?.fps ?? null);
  const head = {
    note: 'the headline numbers; everything below is detail',
    device: `${res.device?.adapter?.vendor ?? '?'} ${res.device?.adapter?.architecture ?? ''}, dpr ${res.device?.devicePixelRatio}, css ${res.device?.css?.w}x${res.device?.css?.h}`,
    timestamps: tsSum,
    window: W,
    fps: { parked: fpsOf(idle), ride: fpsOf(main.ride), pan120: fpsOf(main.pan120), warp: fpsOf(main.warp), hero: fpsOf(res.hero?.walking), ...Object.fromEntries(Object.keys(res).filter((k) => /^win\d+$/.test(k)).map((k) => [k, fpsOf(res[k]?.parked)])) },
    frameP95: { parked: idle.frames?.p95 ?? null, ride: main.ride?.frames?.p95 ?? null, pan120: main.pan120?.frames?.p95 ?? null, hero: res.hero?.walking?.frames?.p95 ?? null },
    byWindow: table,
    coverage: derived.coverage,
    pansDetail: Object.fromEntries([80, 120, 160, 240, 320].map((v) => [v, main[`pan${v}`]?.screenInDetail?.mean ?? null])),
    systemGpu: main.systemGpu?.systems ? Object.fromEntries(Object.entries(main.systemGpu.systems as Record<string, { gpuMs: number | null }>).sort((a, b) => (b[1].gpuMs ?? 0) - (a[1].gpuMs ?? 0)).slice(0, 10).map(([k, v]) => [k, v.gpuMs])) : null,
    pans: Object.fromEntries([80, 120, 160, 240, 320].map((v) => [v, main[`pan${v}`] ? { fps: main[`pan${v}`].fps, p95: main[`pan${v}`].frames?.p95 ?? null, lowDetailP95: main[`pan${v}`].lowDetail?.p95 ?? null } : null])),
    abTop: derived.ab,
    abBound: main.ab?.bound ?? null,
    windowScaling: Object.fromEntries(Object.entries(scaling).map(([k, v]: [string, any]) => [k, v.costFrameMs])),
    region: { wallMs: main.regionStages?.cpu?.total?.p50 ?? null, cutPackMs: main.regionStages?.cpu?.cutPack?.p50 ?? null, columnsWallMs: main.regionStages?.cpu?.columnsWall?.p50 ?? null, mainThreadMs: main.regionStages?.cpu?.mainThread?.p50 ?? null, path: main.regionStages?.path ?? 'cpu', cpuPathWallMs: main.regionStagesCpu?.cpu?.total?.p50 ?? null },
    tilesRegionsPerSecond: Object.fromEntries([1, 2, 4, 8].map((k) => [k, main.tiles?.[`k${k}`]?.regionsPerSecondFromTiles ?? null])),
    warp: { landMs: main.warp?.warpMs ?? null, settledMs: main.warp?.settledMs ?? null },
    hero: { movedBy: res.hero?.walking?.movedBy ?? null, walkedCells: res.hero?.walking?.walkedCells ?? null, zoom: res.hero?.walking?.view?.zoom ?? null, footprint: res.hero?.walking?.view?.footprintCells?.w ?? null, sandboxZoom: main.ride?.view?.zoom ?? null, sandboxFootprint: main.ride?.view?.footprintCells?.w ?? null },
    thermalDriftPct: (derived.thermal as { driftPct?: number } | null)?.driftPct ?? null,
    errors: s.errors.length,
  };
  return {
    kind: 'reclaimed-bench',
    version: BENCH_VERSION,
    summary: head,
    id: s.id,
    startedAt: s.startedAt,
    finishedAt: new Date().toISOString(),
    build: location.origin + location.pathname,
    errors: s.errors,
    derived,
    ...s.results,
  };
}

/** a few headline numbers for the screen (the JSON has the rest) */
export function summary(r: Record<string, any>): string {
  const d = r.derived ?? {};
  const f = (x: any) => (x && typeof x === 'object' ? `${x.p50}/${x.p95}/${x.max}` : '–');
  const lines = [
    `GPU: ${r.device?.adapter?.vendor ?? '?'} ${r.device?.adapter?.architecture ?? ''}  timestamps: ${r.device?.timestampQuery ? 'yes' : 'no'}`,
    `parked frame p50/p95/max: ${f(r.main?.idle?.frames)} ms; GPU ${f(r.main?.idle?.gpuFrame)} ms`,
    `ride: ${f(r.main?.ride?.frames)} ms  hero: ${f(r.hero?.walking?.frames)} ms`,
    `regions/s at 1/2/4/8 tiles: ${[1, 2, 4, 8].map((k) => r.main?.tiles?.[`k${k}`]?.regionsPerSecondFromTiles ?? r.main?.tiles?.[`k${k}`]?.regionsPerSecond ?? '–').join(' / ')}`,
    `warp: land in ${r.main?.warp?.warpMs ?? '–'} ms, settled ${r.main?.warp?.settledMs ?? '–'}`,
    `view: sandbox zoom ${r.main?.ride?.view?.zoom ?? '–'} (${r.main?.ride?.view?.footprintCells?.w ?? '–'} cells across), hero zoom ${r.hero?.walking?.view?.zoom ?? '–'} (${r.hero?.walking?.view?.footprintCells?.w ?? '–'})`,
    `timestamps: ${r.summary?.timestamps?.reliable === false ? 'UNRELIABLE (A/B used)' : r.summary?.timestamps?.reliable ? 'ok' : 'n/a'}`,
    `A/B top: ${(d.ab?.top ?? []).slice(0, 4).join(', ')}`,
    `by window (parked / ride fps, max pan): ${Object.entries(d.byWindow?.table ?? {}).map(([w, v]: [string, any]) => `${w}: ${v.parkedFps ?? '–'}/${v.rideFps ?? '–'}, ${v.maxPan ?? '–'}`).join('; ')}`,
    `screen in detail: window ${d.coverage?.windowFor95AtSandboxZoom ?? '–'} for 95% at the sandbox zoom (${d.coverage?.costThere?.fps ?? '–'} fps there, ${d.coverage?.costThere?.how ?? ''})`,
    `thermal drift: ${d.thermal?.driftPct ?? '–'}%   errors: ${r.errors?.length ?? 0}`,
  ];
  return lines.join('\n');
}
