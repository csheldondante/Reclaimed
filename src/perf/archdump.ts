// (archgen, 2026-11-12) A debugging dump, not a bench: the start town's lot records and the parts the generator made
// from them, read back once and posted to the dev server (perf-reports/archdump-<time>.json), so the phone's output can
// be compared word for word with the desktop's (the phone drew roofs stretched into spikes; the desktop doesn't).
//   /?skipmenu=1&level=atlas&town=1&fresh=1&citygen=fields&arch=1&archdump=1
// Never in play: one readback, after the town is made.

import { postDev } from './report-io';
import { deviceFacts, Panel } from './bench';
import type { FieldTowns } from '../citygen/towns';
import type { TownBuildings } from '../archgen/townbuildings';
import { PART_WORDS } from '../archgen/archgen';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rec {
  core: { host: Parameters<typeof deviceFacts>[0] & { gpu: { device: GPUDevice } } };
  scene: { fieldTowns?: FieldTowns; opts: { atlas?: { startTown?: string } } };
}

async function read(dev: GPUDevice, buf: GPUBuffer, offset: number, bytes: number): Promise<Uint8Array> {
  const b = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const e = dev.createCommandEncoder();
  e.copyBufferToBuffer(buf, offset, b, 0, bytes);
  dev.queue.submit([e.finish()]);
  await b.mapAsync(GPUMapMode.READ);
  const out = new Uint8Array(b.getMappedRange().slice(0));
  b.destroy();
  return out;
}

function b64(a: Uint8Array): string {
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function archDump(): Promise<void> {
  const panel = new Panel(document.body);
  panel.say('building dump — waiting for the start town…');
  let R: Rec | undefined;
  while (!(R = (window as unknown as { reclaimed?: Rec }).reclaimed)?.scene?.fieldTowns) await sleep(250);
  const ft = R.scene.fieldTowns!;
  const tb = (globalThis as { archTowns?: TownBuildings }).archTowns;
  if (!tb) throw new Error('building dump: no building generator (the link needs &arch=1)');
  const start = R.scene.opts.atlas?.startTown ?? 's84';
  while (!ft.live.get(start)?.times) await sleep(250);
  await sleep(4000);
  const dev = R.core.host.gpu.device;
  const t = tb.townBuffers(start);
  if (!t) throw new Error(`building dump: town ${start} has no buildings`);
  const counts = await read(dev, t.counts, 0, 16);
  const cnt = new Uint32Array(counts.buffer);
  const n = Math.max(Math.min(cnt[0], cnt[3]), 1);
  const records = await read(dev, t.records, 0, n * 96);
  const parts = await read(dev, t.arch, t.partsWord * 4, t.slots * PART_WORDS * 4);
  const body = JSON.stringify({
    kind: 'reclaimed-archdump',
    url: location.href,
    device: await deviceFacts(R.core.host),
    town: start,
    lots: n,
    partWords: PART_WORDS,
    counts: b64(counts),
    records: b64(records),
    parts: b64(parts),
  });
  const kept = await postDev(body, 'archdump');
  panel.say(kept ? `building dump ${kept} — thanks, that's all` : 'building dump: not on the dev server, nothing sent');
}
