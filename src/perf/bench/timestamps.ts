// GPU timestamps judged (reliable or not, per mode) and the pan bench's thresholds (PAN_*: speeds, budgets, the
// background flags). API: judgeTimestamps, timestampModes.
import { r3, stat } from './defs';
import { urlFlags } from '../../flags';

/**
 * (v2) Are this GPU's per-pass timestamps to be trusted? Round 101's Pixel 9a (Mali, Valhall): each pass read
 * 20–100 ms though frames came every 16.7 ms — the passes' sum many frames long, and a frame's first-to-last span
 * (gpuFrame) longer than the frame interval. Untrusted when the passes' sum (p50) is over 1.5 frame intervals, or
 * the span (p50) over 1.25.
 */
export function judgeTimestamps(passSum: number[], span: number[], frames: number[]): { reliable: boolean | null; passSumP50: number | null; spanP50: number | null; frameP50: number | null; why: string } {
  const p = stat(passSum, 'ms')?.p50 ?? null;
  const g = stat(span, 'ms')?.p50 ?? null;
  const f = stat(frames, 'ms')?.p50 ?? null;
  if (p === null || g === null || f === null) return { reliable: null, passSumP50: p, spanP50: g, frameP50: f, why: 'no timestamps read back' };
  const bad: string[] = [];
  if (p > 1.5 * f) bad.push(`the passes sum to ${p} ms a frame, ${(p / f).toFixed(1)} frame intervals`);
  if (g > 1.25 * f) bad.push(`a frame's first-to-last span is ${g} ms against frames every ${f}`);
  return { reliable: !bad.length, passSumP50: p, spanP50: g, frameP50: f, why: bad.length ? `${bad.join('; ')}: per-pass GPU numbers unreliable (cumulative or overlapping) — use the A/B` : 'ok' };
}

/**
 * (v2) Timestamps three ways over the same work (six dispatches of a fixed kernel): each in its own compute pass
 * of one encoder (as the engine times its passes), each in its own encoder and submit, and all six in one pass —
 * against the wall clock of each. Shows whether a GPU's per-pass timestamps add up (Mali's didn't in the game).
 */
export async function timestampModes(device: GPUDevice): Promise<Record<string, unknown>> {
  if (!device.features.has('timestamp-query')) return { error: 'no timestamp-query' };
  const N = 1 << 18;
  const buf = device.createBuffer({ size: N * 16, usage: GPUBufferUsage.STORAGE });
  const mod = device.createShaderModule({
    code: `@group(0) @binding(0) var<storage, read_write> d: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= arrayLength(&d)) { return; }
  var v = d[i] + vec4f(f32(i & 255u) * 0.001);
  for (var k = 0u; k < 256u; k++) { v = fract(v * 1.37 + vec4f(0.11, 0.23, 0.31, 0.47)); }
  d[i] = v;
}`,
  });
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
  const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
  const K = 6;
  const qs = device.createQuerySet({ type: 'timestamp', count: 2 * K });
  const res = device.createBuffer({ size: 2 * K * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const read = async (n: number): Promise<number[]> => {
    const st = device.createBuffer({ size: n * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.resolveQuerySet(qs, 0, n, res, 0);
    enc.copyBufferToBuffer(res, 0, st, 0, n * 8);
    device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const w = new Uint32Array(st.getMappedRange().slice(0));
    st.unmap();
    st.destroy();
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(w[k * 2] + w[k * 2 + 1] * 4294967296);
    return out;
  };
  const pass = (enc: GPUCommandEncoder, k: number | null, dispatches = 1) => {
    const p = enc.beginComputePass(k === null ? {} : { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 2 * k, endOfPassWriteIndex: 2 * k + 1 } });
    p.setPipeline(pipe);
    p.setBindGroup(0, bg);
    for (let j = 0; j < dispatches; j++) p.dispatchWorkgroups(N / 64);
    p.end();
  };
  const modes: Record<string, { perPass: number[]; sum: number[]; span: number[]; wall: number[] }> = { onePassEach: { perPass: [], sum: [], span: [], wall: [] }, ownEncoderEach: { perPass: [], sum: [], span: [], wall: [] }, allInOnePass: { perPass: [], sum: [], span: [], wall: [] } };
  for (let rep = 0; rep < 6; rep++) {
    for (const m of Object.keys(modes)) {
      await device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      if (m === 'onePassEach') {
        const enc = device.createCommandEncoder();
        for (let k = 0; k < K; k++) pass(enc, k);
        device.queue.submit([enc.finish()]);
      } else if (m === 'ownEncoderEach') {
        for (let k = 0; k < K; k++) {
          const enc = device.createCommandEncoder();
          pass(enc, k);
          device.queue.submit([enc.finish()]);
        }
      } else {
        const enc = device.createCommandEncoder();
        pass(enc, 0, K);
        device.queue.submit([enc.finish()]);
      }
      await device.queue.onSubmittedWorkDone();
      const wall = performance.now() - t0;
      const n = m === 'allInOnePass' ? 2 : 2 * K;
      const t = await read(n);
      const per: number[] = [];
      for (let k = 0; k < n / 2; k++) per.push((t[2 * k + 1] - t[2 * k]) / 1e6);
      // (the first warms up)
      if (rep === 0) continue;
      const mm = modes[m];
      mm.perPass.push(...per);
      mm.sum.push(per.reduce((a, v) => a + v, 0));
      mm.span.push((Math.max(...t) - Math.min(...t)) / 1e6);
      mm.wall.push(wall);
    }
  }
  buf.destroy();
  res.destroy();
  qs.destroy();
  const out: Record<string, unknown> = { what: `${K} dispatches of 2^18 threads x 256 fract-FMAs: timed per pass in one encoder, per pass each in its own encoder+submit, and as one pass` };
  for (const [m, v] of Object.entries(modes)) {
    const sum = stat(v.sum, 'GPU ms, the passes summed');
    const wall = stat(v.wall, 'ms wall, submit to onSubmittedWorkDone');
    out[m] = { perPass: stat(v.perPass, 'GPU ms a pass'), sum, span: stat(v.span, 'GPU ms first start to last end'), wall, sumOverWall: sum && wall ? r3(sum.p50 / wall.p50) : null };
  }
  return out;
}

// ---------- the pan benchmark (round 104) ----------

/**
 * (round 104) The user (verbatim): "Let's build a test of just panning in a straight line as fast as we can at zooms
 * that always keep all regions on screen drawn. I want to try both generating and intelligently streaming from disc to
 * memory to the GPU. I want to know on each device and at each zoom what is a max speed that is smooth, hitch free and
 * never lags behind the camera." From the hero's close zoom (14) to the sandbox's (2.76) and wider.
 */
/** (round 112, ?benchzooms=5_2.2: only these — a headless run's shorter ramp) */
export const PAN_ZOOMS = typeof location !== 'undefined' && urlFlags().get('benchzooms') ? urlFlags().get('benchzooms')!.split('_').map(Number) : [14, 8, 5, 3.5, 2.76, 2.2];
/** the widest window a page asks for (more and a phone's memory goes: the zoom is reported as not run) */
// (round 104: 640 — window 768 is ~650 MB of GPU memory before the pool and the meshes, ~1.1 KB a column (slidehitch's
// estimate): past what Chrome gives a Pixel 9a's GPU process; the phone's pan768 never finished loading)
export const PAN_MAX_WINDOW = 640;
/** speeds (cells/s), each held PAN_STEP_S */
export const PAN_SPEEDS = [10, 20, 40, 80, 120, 160, 240, 320, 480, 640];
export const PAN_STEP_S = 3;
/** (round 104) a frame over this (ms) is over a 60 fps frame's budget, with room */
export const PAN_BUDGET = 20;
/** the pass criteria: rendered fps, the longest frame, the p99, the screen in detail (none lost against parked) */
export const PAN_FPS = 58;
export const PAN_MAX_FRAME = 33;
export const PAN_P99 = 20;
/**
 * (round 112, bgcheck) The user: "Can we do a pan test for the phone that fails if any bg color shows?" / "Or flags it
 * anyway". Each step's background share (render/bgcheck.ts: the clear colour, nothing drawn) is flagged when any sample
 * shows it; ?bgfail=1 also fails the step's smooth criterion with it (default: flagged only).
 * Flagged over PAN_BG_FLAG of the worst frame's samples (?bgflag=, default 0.001 — scripts/tilegate.mjs's threshold;
 * ?bgflag=0 any at all): measured, every parked view of the atlas shows the background through 1-pixel pinholes on
 * ~0.01-0.03% of the screen (2-3 of the 8192 samples, every frame), so "any" would flag every step.
 */
export const PAN_BG_FAILS = typeof location !== 'undefined' && urlFlags().get('bgfail') === '1';
export const PAN_BG_FLAG = typeof location !== 'undefined' ? Number(urlFlags().get('bgflag') ?? 0.001) : 0.001;
