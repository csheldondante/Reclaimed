// The frame census's page side (phone-idle, 2026-11-15): `?census=1` wraps the WebGPU prototypes with the engine's
// counter (gpu/census.ts — what is counted, who a call belongs to, the phone's cost model), prints its table and gives
// scripts `window.__census`. Off by default: nothing is wrapped.
// API: startCensus, censusTable; censusFrame and the rest re-exported for the page's loop.
import { Census, censusUse, installCensus, PHONE_MODEL, type CensusReport, type Counts, type Field } from '../gpu/census';

export { censusFrame } from '../gpu/census';

const COLS: [string, Field][] = [
  ['ind', 'indirect'],
  ['dir', 'direct'],
  ['cpass', 'computePasses'],
  ['rpass', 'renderPasses'],
  ['draw', 'draws'],
  ['drawInd', 'drawsIndirect'],
  ['reads', 'reads'],
  ['readB', 'readBytes'],
  ['upl', 'uploads'],
  ['uplB', 'uploadBytes'],
  ['copy', 'copies'],
  ['copyB', 'copyBytes'],
  ['clr', 'clears'],
  ['bg', 'bindGroups'],
  ['pipe', 'pipelines'],
];

/** a report as rows for console.table: a system a row, per-frame averages, by estimated phone ms */
export function censusTable(r: CensusReport): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const row = (c: Counts & { phoneMs: number }) => ({ phoneMs: c.phoneMs, ...Object.fromEntries(COLS.map(([k, f]) => [k, c[f]])) });
  out.TOTAL = row(r.total);
  for (const s of r.systems) out[s.system] = row(s);
  return out;
}

/**
 * ?census=1: the prototypes wrapped (before the device is asked for, so the boot is counted too), `window.__census`
 * for scripts — `take()` the report since the last take, `table()` it printed, `download()` it saved — and a table
 * printed every `?censusevery=` seconds (10; 0 never).
 */
export function startCensus(params: URLSearchParams): Census | null {
  if (params.get('census') !== '1' || typeof GPUBuffer === 'undefined') return null;
  const c = new Census(() => performance.now());
  censusUse(c);
  installCensus(c, { GPUCommandEncoder, GPUComputePassEncoder, GPURenderPassEncoder, GPUQueue, GPUBuffer, GPUDevice }, GPUMapMode.READ);
  const table = (r = c.take()) => {
    console.log(`census: ${r.frames} frames in ${r.seconds} s, ${r.ticksPerFrame} ticks a frame, est. phone ${r.total.phoneMs} ms a frame (per-frame averages, by system)`);
    console.table(censusTable(r));
    return r;
  };
  (window as unknown as { __census: unknown }).__census = {
    census: c,
    take: (reset = true) => c.take(reset),
    table,
    download: async () => {
      const io = await import('./report-io');
      return io.downloadJson(JSON.stringify({ kind: 'reclaimed-census', url: location.href, at: new Date().toISOString(), model: PHONE_MODEL, report: c.take(false) }, null, 1), `reclaimed-census-${io.stamp()}.json`);
    },
  };
  const every = Number(params.get('censusevery') ?? 10);
  if (every > 0) setInterval(() => table(), every * 1000);
  return c;
}
