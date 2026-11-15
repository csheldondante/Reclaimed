// The fine collision pass's phone bench (docs/design/PHYSICS_ENGINE.md "Fine collision"): the same passes as
// test/gpu/sdf-fine-bench.test.ts (the model store's bake and SdfFine over shapes.ts benchScene), in Chrome on the
// phone, with a report to download. Its own page, sdfbench.html: no world, no level.
//   /sdfbench.html                         every format × side × pairs, the `touch` scene (about 5 minutes)
//   …?formats=grad8&sides=16&pairs=256     some
//   …&kind=deep                            the deep scene (a third of each body inside the other)
//   …&auto=1                               starts without the tap (headless: scripts/sdfbench.mjs)
//   …&window=1.2&windows=3                 the toggle's window, seconds, and how many each way
// A phone's GPU is a tiler and per-pass timestamps mislead there (the user, round 120: "You need to toggle systems
// to measure the diff"), so the cost is measured two ways, neither by timestamps:
//   toggle  frames alternate in windows with the pass on (run `reps` times a frame) and off; the cost is the
//           difference of the mean frame interval, and of the mean time from the frame's start to the GPU done
//           with it (onSubmittedWorkDone), over `reps`. A frame that stays inside the display's refresh shows no
//           interval difference: then the GPU-done difference is the number.
//   batch   `reps` × 4 passes submitted alone, wall time to onSubmittedWorkDone, per pass.
// Read at the end of each configuration: 16 B of counts (contacts, dropped). Nothing is read per frame.

import { initGpu } from '../gpu/device';
import { urlFlags } from '../flags';
import { COUNT_BRICKS, COUNT_BRICKS_DROPPED, COUNT_CONTACTS, COUNT_SAMPLE_CONTACTS, COUNTS_BYTES, packBodies, type SdfFormat } from '../engine/sdf/contract';
import { FINE_DEFAULT_CAP, FINE_DEFAULT_MARGIN, SdfFine } from '../engine/sdf/fine';
import { SdfModels } from '../engine/sdf/models';
import { benchScene, benchShapes, type BenchKind } from '../engine/sdf/shapes';
import { keepAwake, letSleep, Panel, wakeLog } from './bench/page';
import { copyText, deviceTag, downloadJson, postDev, shareJson, stamp } from './report-io';

declare const __BUILD_COMMIT__: string;

const VERSION = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const round = (v: number, d = 3) => (Number.isFinite(v) ? +v.toFixed(d) : null);

function filled(device: GPUDevice, label: string, bytes: ArrayBufferView | ArrayBuffer): GPUBuffer {
  const src = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const b = device.createBuffer({ label, size: Math.max(16, Math.ceil(src.byteLength / 4) * 4), usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
  new Uint8Array(b.getMappedRange()).set(src);
  b.unmap();
  return b;
}

async function readCounts(device: GPUDevice, counts: GPUBuffer): Promise<Uint32Array> {
  const rd = device.createBuffer({ label: 'sdfbench counts', size: COUNTS_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(counts, 0, rd, 0, COUNTS_BYTES);
  device.queue.submit([enc.finish()]);
  await rd.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(rd.getMappedRange().slice(0));
  rd.unmap();
  rd.destroy();
  return out;
}

export async function sdfBench(): Promise<void> {
  const params = urlFlags();
  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  const panel = new Panel(ui);
  const list = <T>(key: string, all: T[], parse: (s: string) => T): T[] => {
    const v = params.get(key);
    return v ? v.split(',').map(parse) : all;
  };
  const formats = list<SdfFormat>('formats', ['grad8', 'snorm8', 'f32'], (s) => s as SdfFormat);
  const sides = list('sides', [8, 16, 32], Number);
  const pairCounts = list('pairs', [64, 256, 1024, 4096], Number);
  const kind = (params.get('kind') ?? 'touch') as BenchKind;
  const windowS = Number(params.get('window') ?? 1.2);
  const windows = Number(params.get('windows') ?? 3);
  const configs = formats.length * sides.length * pairCounts.length;
  panel.say(`Fine collision bench v${VERSION} (${__BUILD_COMMIT__}): ${configs} configurations, about ${Math.ceil((configs * (windows * 2 * (windowS + 0.25) + 1.5)) / 60)} min. Keep the screen on and this tab in front.`);
  if (params.get('auto') !== '1') await new Promise<void>((go) => panel.button('Start', true, go));
  const awake = await keepAwake();
  const gpu = await initGpu(canvas);
  const dev = gpu.device;
  const info = gpu.adapter.info as unknown as Record<string, unknown>;
  const rows: Record<string, unknown>[] = [];
  const bakes: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const startedAt = new Date().toISOString();

  // (a frame for the toggle: the canvas cleared, so the browser presents something every frame)
  const present = (enc: GPUCommandEncoder) => {
    const p = enc.beginRenderPass({ colorAttachments: [{ view: gpu.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.05, g: 0.08, b: 0.07, a: 1 } }] });
    p.end();
  };
  const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

  let done = 0;
  for (const format of formats) {
    for (const n of sides) {
      // ---- the bake: one model, then 64 in a batch (wall time, the second run of each: the first compiles)
      const one: number[] = [];
      const many: number[] = [];
      let boxBytes: unknown = null;
      for (let k = 0; k < 3; k++) {
        const s = new SdfModels(dev, format);
        await dev.queue.onSubmittedWorkDone();
        let t0 = performance.now();
        const id = s.add(benchShapes(n)[0]);
        s.flush();
        await dev.queue.onSubmittedWorkDone();
        if (k) one.push(performance.now() - t0);
        boxBytes = s.info(id).bytes;
        const specs = Array.from({ length: 64 }, (_, i) => benchShapes(n)[i % 3]);
        t0 = performance.now();
        for (const spec of specs) s.add(spec);
        s.flush();
        await dev.queue.onSubmittedWorkDone();
        if (k) many.push(performance.now() - t0);
        s.destroy();
      }
      bakes.push({ format, side: n, bakeOneMs: round(Math.min(...one), 2), bake64Ms: round(Math.min(...many), 2), boxBytes });

      const store = new SdfModels(dev, format);
      const ids = benchShapes(n).map((s) => store.add(s));
      store.flush();
      for (const pairs of pairCounts) {
        panel.say(`${++done} / ${configs}: ${format}, ${n}³, ${pairs} pairs (${kind})…`);
        const scene = benchScene(pairs, n, ids, 7, kind);
        const packed = packBodies(scene.bodies);
        const inputs = {
          pairs: filled(dev, 'bench pairs', scene.pairs),
          pairCount: filled(dev, 'bench pair count', new Uint32Array([pairs, 0, 0, 0])),
          pose: filled(dev, 'bench pose', packed.pose),
          vel: filled(dev, 'bench vel', packed.vel),
          info: filled(dev, 'bench info', packed.info),
        };
        const fine = new SdfFine(dev, store, { maxPairs: pairs });
        fine.setParams(pairs, 0);
        const passes = (k: number) => {
          const enc = dev.createCommandEncoder();
          for (let i = 0; i < k; i++) fine.encode(enc, inputs, pairs);
          return enc;
        };
        // warm up, then a batch alone: wall ms a pass
        dev.queue.submit([passes(2).finish()]);
        await dev.queue.onSubmittedWorkDone();
        const batchOf = async (k: number) => {
          const t0 = performance.now();
          dev.queue.submit([passes(k).finish()]);
          await dev.queue.onSubmittedWorkDone();
          return (performance.now() - t0) / k;
        };
        const first = await batchOf(4);
        // (the toggle's load: about 6 ms of the pass a frame, so the difference stands clear of the noise)
        const reps = Math.max(1, Math.min(32, Math.round(6 / Math.max(first, 0.05))));
        const batch = Math.min(await batchOf(reps * 4), await batchOf(reps * 4));
        // the toggle: windows on and off in turn
        const sums = { on: { dt: [] as number[], gpu: [] as number[] }, off: { dt: [] as number[], gpu: [] as number[] } };
        for (let w = 0; w < windows; w++)
          for (const side of ['on', 'off'] as const) {
            const until = performance.now() + (windowS + 0.25) * 1000;
            let last = 0;
            // (the first quarter second of a window is left out: the switch settles)
            const begin = performance.now() + 250;
            while (performance.now() < until) {
              const t = await frame();
              const enc = side === 'on' ? passes(reps) : dev.createCommandEncoder();
              present(enc);
              const t0 = performance.now();
              dev.queue.submit([enc.finish()]);
              const took = dev.queue.onSubmittedWorkDone().then(() => performance.now() - t0);
              if (t >= begin) {
                if (last) sums[side].dt.push(t - last);
                last = t;
                void took.then((ms) => sums[side].gpu.push(ms));
              }
            }
            await dev.queue.onSubmittedWorkDone();
          }
        const c = await readCounts(dev, fine.counts);
        const on = { frameMs: mean(sums.on.dt), doneMs: mean(sums.on.gpu) };
        const off = { frameMs: mean(sums.off.dt), doneMs: mean(sums.off.gpu) };
        rows.push({
          format,
          side: n,
          kind,
          pairs,
          reps,
          // the pass's cost, ms: by the frame interval, by the GPU-done time, and by a batch alone
          toggleFrameMs: round((on.frameMs - off.frameMs) / reps),
          toggleDoneMs: round((on.doneMs - off.doneMs) / reps),
          batchMs: round(batch),
          on: { frameMs: round(on.frameMs, 2), doneMs: round(on.doneMs, 2), frames: sums.on.dt.length },
          off: { frameMs: round(off.frameMs, 2), doneMs: round(off.doneMs, 2), frames: sums.off.dt.length },
          threads: c[COUNT_BRICKS] * 16,
          contacts: c[COUNT_CONTACTS],
          sampleContacts: c[COUNT_SAMPLE_CONTACTS],
          dropped: c[COUNT_BRICKS_DROPPED],
          passBytes: fine.bytes,
        });
        fine.destroy();
        for (const b of Object.values(inputs)) b.destroy();
        await sleep(50);
      }
      store.destroy();
    }
  }
  await letSleep();
  if (document.querySelector('.fatal')) errors.push(`fatal overlay: ${document.querySelector('.fatal')!.textContent}`);
  let hints: unknown = null;
  try {
    const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<unknown> } }).userAgentData;
    if (uad) hints = await uad.getHighEntropyValues(['model', 'platform', 'platformVersion']);
  } catch {
    hints = null;
  }
  const report = {
    kind: 'sdfbench',
    version: VERSION,
    build: __BUILD_COMMIT__,
    startedAt,
    endedAt: new Date().toISOString(),
    what: 'fine collision (SDF, JFA bake; v2: samples culled by brick, four contact rows a pair at most): toggleFrameMs and toggleDoneMs are the pass on less off, per pass; batchMs a batch alone, wall, per pass. No timestamp queries.',
    scene: { kind, cap: FINE_DEFAULT_CAP, margin: FINE_DEFAULT_MARGIN, windowS, windows },
    device: { adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }, ua: navigator.userAgent, clientHints: hints, screen: [innerWidth, innerHeight, devicePixelRatio] },
    wakeLock: { held: awake, log: wakeLog },
    rows,
    bakes,
    errors,
  };
  const body = JSON.stringify(report);
  (window as unknown as { sdfBenchReport: string }).sdfBenchReport = body;
  panel.say(`Done: ${rows.length} configurations.`);
  const pad = (v: unknown, w: number) => String(v).padStart(w);
  panel.text(
    ['format side pairs  toggle ms (frame / GPU done)  batch ms  contacts', ...rows.map((r) => `${String(r.format).padEnd(6)} ${pad(r.side, 3)} ${pad(r.pairs, 5)}  ${pad(r.toggleFrameMs, 8)} / ${pad(r.toggleDoneMs, 8)}  ${pad(r.batchMs, 8)}  ${pad(r.contacts, 7)}${r.dropped ? ` (${r.dropped} bricks dropped)` : ''}`), '', 'bake ms: format side  one  64', ...bakes.map((b) => `${String(b.format).padEnd(6)} ${pad(b.side, 3)}  ${pad(b.bakeOneMs, 6)}  ${pad(b.bake64Ms, 7)}`)].join(String.fromCharCode(10)),
    true,
  );
  const status = panel.text('');
  const say = (m: string) => (status.textContent = m);
  const name = `reclaimed-sdfbench-${stamp()}-${await deviceTag(String(info.vendor ?? ''))}.json`;
  panel.button('Download report', true, () => say(downloadJson(body, name)));
  panel.button('Copy', false, () => void copyText(body).then(say, (e: Error) => say(`copy failed: ${e.message}`)));
  panel.button('Share…', false, () => void shareJson(body, name, 'Reclaimed SDF bench').then((m) => say(m || 'this browser can’t share files: use Download')));
  const saved = await postDev(body, 'sdfbench');
  if (saved) panel.text(`dev server: ${saved}`, true);
}

void sdfBench().catch((e: unknown) => {
  console.error(e);
  const el = document.createElement('pre');
  el.className = 'fatal';
  el.style.cssText = 'color:#f88;font:13px ui-monospace,monospace;white-space:pre-wrap;padding:12px';
  el.textContent = `sdfbench failed: ${(e as Error).stack ?? e}`;
  document.body.appendChild(el);
});
