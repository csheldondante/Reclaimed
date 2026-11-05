// The pan bench's plan and report: the window for a zoom, the zooms and speeds tried, tile steps, the headline and
// the summary. API: panWindowFor, panPlan, tileStepOf, makePanReport, panSummary.
import { BENCH_VERSION, ROW_H, r3 } from './defs';
import { PAN_ZOOMS, PAN_MAX_WINDOW, PAN_STEP_S, PAN_BUDGET, PAN_FPS, PAN_MAX_FRAME, PAN_P99, PAN_BG_FAILS, PAN_BG_FLAG } from './timestamps';
import { BenchState } from './state';

/**
 * The window a zoom needs: the screen's ground (the camera's view at the sandbox's turn, a quarter turn — its corners
 * as screenDeltaToWorld gives them) inside it, and a region more each side (the window slides a region at a time,
 * the camera off its middle by up to half of one) — whole regions, at least 256.
 */
export function panWindowFor(zoom: number, cssW: number, cssH: number, az = Math.PI / 4): number {
  const elev = Math.PI / 6;
  let mx = 0;
  let my = 0;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const wx = (sx * cssW) / 2 / zoom;
    const wy = (sy * cssH) / 2 / zoom / Math.sin(elev);
    const x = -Math.sin(az) * wx + Math.cos(az) * wy;
    const y = Math.cos(az) * wx + Math.sin(az) * wy;
    mx = Math.max(mx, Math.abs(x));
    my = Math.max(my, Math.abs(y));
  }
  const need = Math.max(2 * mx, (2 * my) / ROW_H) + 2 * 64;
  return Math.max(256, Math.ceil(need / 64) * 64);
}

export function panPlan(cssW: number, cssH: number, smoke: boolean, win = 0): { zooms: { zoom: number; window: number; run: boolean }[]; pages: { window: number; zooms: number[] }[] } {
  const zs = (smoke ? [14, 5] : PAN_ZOOMS).map((zoom) => {
    // (round 104, ?panwin=N: every zoom at window N — the tile cache's beyond it)
    const w = win || panWindowFor(zoom, cssW, cssH);
    return { zoom, window: w, run: w <= PAN_MAX_WINDOW };
  });
  const pages: { window: number; zooms: number[] }[] = [];
  for (const z of zs) {
    if (!z.run) continue;
    const pg = pages.find((p) => p.window === z.window) ?? (pages.push({ window: z.window, zooms: [] }), pages[pages.length - 1]);
    pg.zooms.push(z.zoom);
  }
  pages.sort((a, b) => a.window - b.window);
  return { zooms: zs, pages };
}

/**
 * (round 106, tilephone) The tiles' render-only land over a pan step: tiles baked a second, in flight now, each stage's
 * p50 / p95 ms (render/tilelandgpu.ts LandTimes: wanted to started — the queue; started to submitted — the land's GPU
 * work, paced; to baked; baked to drawn; all), of the regions drawn during the step, and the leading half's share out of
 * detail (mean, worst).
 */
export function tileStepOf(T: any, baked0: number, t0: number, secs: number, lead: number[]): Record<string, unknown> {
  const L = (T.land.latencies as { wanted: number; start: number; mapped: number; cur: number; baked: number; drawn: number }[]).filter((t) => t.drawn >= t0);
  const q = (a: number[], f: number) => (a.length ? r3(a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))]) : null);
  const st = (f: (t: (typeof L)[number]) => number) => {
    const a = L.map(f).filter((x) => Number.isFinite(x));
    return [q(a, 0.5), q(a, 0.95)];
  };
  return {
    perSecond: r3(((T.land.stats.baked as number) - baked0) / secs),
    inFlight: T.land.stats.inFlight,
    n: L.length,
    queue: st((t) => t.start - t.wanted),
    land: st((t) => t.mapped - t.start),
    landFrames: st((t) => (t as { frames?: number }).frames ?? NaN),
    toBake: st((t) => t.baked - t.mapped),
    toDrawn: st((t) => t.drawn - t.baked),
    total: st((t) => t.drawn - t.wanted),
    leadOut: lead.length ? [r3(lead.reduce((a, v) => a + v, 0) / lead.length), r3(Math.max(...lead))] : null,
  };
}

/** (v6) the pacing probe's phases in a line: fps, slow frames and how close together, rAF lag, the tick clock (v8) */
export function paceHeadline(out: Record<string, any>): string {
  const one = (k: string) => {
    const r = out[k];
    if (!r || !r.frames) return null;
    const c = r.clusters ?? {};
    const tc = r.tickClock ? ` [${r.tickClock.mode}: locked ${r.tickClock.lockedFrames}/${r.tickClock.frames}, extra ${r.tickClock.extra}, skipped ${r.tickClock.skipped}, missed ${r.tickClock.missedS ?? '-'} s, cut ${r.tickClock.cutS ?? '-'} s, paused ${r.tickClock.pausedFrames ?? '-'}f]` : '';
    const held = r.simHeld && Object.keys(r.simHeld).length ? ` held ${Object.entries(r.simHeld).map(([a, n]) => `${a}:${n}`).join(' ')}` : '';
    return `${k}${tc} ${r.fps} fps, slow ${c.slow ?? r.slow?.n ?? 0}/${r.frames} (${c.verdict ?? '?'}; longest run ${c.longestRun ?? '-'}, within 100 ms ${c.within100ms ?? '-'}, min gap ${c.minGapMs ?? '-'} ms / ${c.minGapFrames ?? '-'} frames, at ${JSON.stringify(c.at ?? [])}), lag p50/p95 ${r.lag?.p50}/${r.lag?.p95}, ticks ${JSON.stringify(r.ticksPerFrame)}${held}, gpu p50/p95 ${r.gpu?.p50 ?? '-'}/${r.gpu?.p95 ?? '-'}`;
  };
  const keys = (out.order as string[] | undefined) ?? ['timed', 'untimed', 'tickAccum', 'inFlight1', 'inFlight3', 'simOff'];
  return `settled ${out.settle?.ms ?? '?'} ms${out.settle?.timedOut ? ' (TIMED OUT)' : ''} | ` + keys.map(one).filter(Boolean).join(' | ');
}

/** (v8) the slow frames of every pacing phase and pan step: how close together (the user's question) */
export function slowTogether(res: Record<string, any>): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(res))
    if (/^pan\d+$/.test(k) && v?.zooms)
      for (const z of v.zooms as any[]) {
        const p = z.pace;
        if (p)
          for (const key of (p.order as string[] | undefined) ?? []) {
            const c = p[key]?.clusters;
            if (c) lines.push(`zoom ${z.zoom} parked ${key}: ${c.slow}/${c.frames} slow — ${c.verdict}; longest run ${c.longestRun}, within 100 ms ${c.within100ms}, min gap ${c.minGapMs ?? '-'} ms`);
          }
        for (const src of ['pool', 'generated', 'disk'])
          for (const st of (z[src]?.steps ?? []) as any[]) {
            const c = st.slowClusters;
            if (c) lines.push(`zoom ${z.zoom} ${src} ${st.speed} c/s: ${c.slow}/${c.frames} slow — ${c.verdict}; longest run ${c.longestRun}, within 100 ms ${c.within100ms}, min gap ${c.minGapMs ?? '-'} ms`);
          }
      }
  return lines;
}

export function makePanReport(s: BenchState): Record<string, unknown> {
  const res = s.results as Record<string, any>;
  const rows: Record<string, unknown>[] = [];
  for (const [k, v] of Object.entries(res))
    if (/^pan\d+$/.test(k) && v?.zooms)
      for (const z of v.zooms as any[])
        for (const src of ['generated', 'disk', 'pool'])
          if (z[src]) {
            const st = (z[src].steps ?? []) as any[];
            const worstSlide = st.reduce((m, x) => Math.max(m, x.max ?? 0), 0);
            rows.push({ zoom: z.zoom, window: v.window?.w ?? null, source: src, parked: z.parked ?? null, pace: z.pace?.headline ?? null, maxSmooth: z[src].maxSmooth, failedFirst: z[src].failedFirst, at: z[src].failedAt, maxNoPopIn: z[src].maxNoPopIn, popInAt: z[src].popInAt, worstFrameMs: r3(worstSlide), overBudgetPerSlide: st.map((x) => `${x.speed}:${x.overBudgetPerSlide ?? '-'}`).join(' '), tilesPerSecond: st.map((x) => `${x.speed}:${x.tiles?.perSecond ?? '-'}`).join(' '), tileLatency: st.map((x) => `${x.speed}:${x.tiles?.total?.[0] ?? '-'}/${x.tiles?.total?.[1] ?? '-'}`).join(' '), leadOut: st.map((x) => `${x.speed}:${x.tiles?.leadOut?.[0] ?? '-'}`).join(' '), causesAtFail: z[src].causesAtFail, coverParked: z.coverParked, bgAt: z[src].bgAt ?? null, bg: st.map((x) => `${x.speed}:${x.bg ? `${r3(x.bg.bgMax * 100)}%/${x.bg.bgFrames}f` : '-'}`).join(' '), far: st.map((x) => `${x.speed}:${x.bg ? `${r3(x.bg.farMax * 100)}%` : '-'}`).join(' ') });
          }
  const plan = res.panPlan as { zooms: { zoom: number; window: number; run: boolean }[] } | undefined;
  return {
    kind: 'reclaimed-bench-pan',
    version: BENCH_VERSION,
    id: s.id,
    startedAt: s.startedAt,
    finishedAt: new Date().toISOString(),
    build: location.origin + location.pathname,
    summary: {
      note: 'per zoom and land source: the fastest straight pan (cells/s) that held every criterion, and the criterion that failed first one step above',
      criteria: `smooth: rendered fps >= ${PAN_FPS}, no frame over ${PAN_MAX_FRAME} ms, p99 <= ${PAN_P99} ms and no pop-in${PAN_BG_FAILS ? ' and no background' : ''}, each step ${PAN_STEP_S} s; no pop-in: none of the screen out of detail against parked, frames as they come; overBudgetPerSlide: frames over ${PAN_BUDGET} ms per slide at each speed; bg: the share of the screen showing the background colour (nothing drawn), the step's worst frame / frames with any — flagged when the worst frame's over ${PAN_BG_FLAG * 100}%${PAN_BG_FAILS ? ', and fails smooth (?bgfail=1)' : ' (flag only; ?bgfail=1 fails smooth too)'}; far: the worst frame's share showing the flat far land`,
      device: `${res.device?.adapter?.vendor ?? '?'} ${res.device?.adapter?.architecture ?? ''}, dpr ${res.device?.devicePixelRatio}, css ${res.device?.css?.w}x${res.device?.css?.h}`,
      // (v6) the frame pacing parked at each zoom (rows.pace in pan256.zooms[].pace in full)
      // (v8) the slow frames' clustering per parked phase and pan step: back to back or within 100 ms, or apart
      slowTogether: slowTogether(res),
      pace: [...new Map(rows.filter((r: any) => r.pace).map((r: any) => [r.zoom, `zoom ${r.zoom}: ${r.pace}`])).values()],
      table: rows.map((r: any) => `zoom ${r.zoom} window ${r.window} ${r.source}: parked ${r.parked?.fps ?? '?'} fps p99 ${r.parked?.p99 ?? '?'}; smooth to ${r.maxSmooth ?? 'none'} c/s${r.failedFirst ? ` (then ${r.failedFirst} at ${r.at})` : ''}; no pop-in to ${r.maxNoPopIn ?? 'none'} c/s${r.popInAt ? ` (pop-in at ${r.popInAt})` : ''}; worst frame ${r.worstFrameMs} ms; tiles/s ${r.tilesPerSecond}; tile ms p50/p95 ${r.tileLatency}; leading half out ${r.leadOut}; bg ${r.bg}${r.bgAt?.length ? ` (BACKGROUND at ${r.bgAt.join(', ')} c/s)` : ''}; far ${r.far}`),
      // (round 112, bgcheck: the rows whose steps showed the background — the panel's red note)
      bgFlagged: rows.filter((r: any) => r.bgAt?.length).map((r: any) => `zoom ${r.zoom} ${r.source}: background at ${r.bgAt.join(', ')} c/s`),
      notRun: plan?.zooms.filter((z) => !z.run).map((z) => `zoom ${z.zoom} needs window ${z.window} (over ${PAN_MAX_WINDOW})`) ?? [],
      errors: s.errors.length,
    },
    rows,
    errors: s.errors,
    ...s.results,
  };
}

export function panSummary(r: Record<string, any>): string {
  // (v5) a page whose screen lock was let go or whose tab was hidden: its numbers may hold the screen going off
  const slept = Object.values(r).filter((p: any) => p && typeof p === 'object' && (p.hiddenDuring || (p.wakeLog ?? []).some((l: string) => !l.includes('no wake lock')))).map((p: any) => p.page);
  const warn = slept.length ? [`screen lock lost or tab hidden on: ${slept.join(', ')} (see wakeLog)`] : [];
  const bg = r.summary?.bgFlagged?.length ? [`BACKGROUND SHOWED: ${r.summary.bgFlagged.join('; ')}`] : [];
  return [`device: ${r.summary?.device}`, ...warn, ...bg, ...(r.summary?.table ?? []), ...(r.summary?.notRun ?? []), `errors: ${r.errors?.length ?? 0}`].join('\n');
}
