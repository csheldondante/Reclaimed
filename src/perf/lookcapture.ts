// (looklab) One capture of the real world for the look lab (looklab.html): a 640 × 640 patch of the atlas's land round
// the start town (its raw ground — the ground citygen plans on: top z, water depth, top material, vegetation), the
// town's road raster and ground heights over its box, and its lot records (archgen makes the buildings from them in
// the lab). Posted to the dev server (perf-reports/lookpatch-<time>.json); the lab reads a copy from local/look/.
//   /?skipmenu=1&level=atlas&town=1&fresh=1&citygen=fields&arch=1&lookcapture=1
// A debugging read, never in play.

import { postDev } from './report-io';
import { Panel } from './bench';
import type { FieldTowns } from '../citygen/towns';
import { ROW_H } from '../world/lattice';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SIDE = 640;

interface RawGround {
  ground: Float32Array;
  water: Float32Array;
  top: Uint8Array;
  veg: Float32Array;
}
interface Rec {
  core: { host: { gpu: { device: GPUDevice } } };
  atlas: { rawGround(x0: number, y0: number, w: number, h: number): Promise<RawGround>; p: { sea: number } };
  stream: { oz: number };
  scene: { fieldTowns?: FieldTowns; opts: { atlas?: { startTown?: string } } };
}

async function read(dev: GPUDevice, buf: GPUBuffer, bytes: number): Promise<Uint8Array> {
  const b = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const e = dev.createCommandEncoder();
  e.copyBufferToBuffer(buf, 0, b, 0, bytes);
  dev.queue.submit([e.finish()]);
  await b.mapAsync(GPUMapMode.READ);
  const out = new Uint8Array(b.getMappedRange().slice(0));
  b.destroy();
  return out;
}

function b64(a: ArrayBufferView): string {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function lookCapture(): Promise<void> {
  const panel = new Panel(document.body);
  panel.say('look capture — waiting for the start town…');
  let R: Rec | undefined;
  while (!(R = (window as unknown as { reclaimed?: Rec }).reclaimed)?.scene?.fieldTowns) await sleep(250);
  const ft = R.scene.fieldTowns!;
  const id = R.scene.opts.atlas?.startTown ?? 's84';
  while (!ft.live.get(id)?.times) await sleep(250);
  await sleep(4000);
  const town = ft.live.get(id)!;
  const dev = R.core.host.gpu.device;
  const at = town.site.at;
  const x0 = Math.round(at[0]) - SIDE / 2;
  const y0 = 2 * Math.floor((at[1] / ROW_H - SIDE / 2) / 2);
  const land = await R.atlas.rawGround(x0, y0, SIDE, SIDE);
  const box = town.box;
  const routes = town.routes;
  const n = box.w * box.h;
  const roads = await read(dev, routes.roads, n * 4);
  const heights = await read(dev, routes.heights, n * 4);
  const counts = await read(dev, town.lots.counts, 16);
  const c = new Uint32Array(counts.buffer);
  const lots = Math.max(Math.min(c[0], c[3]), 1);
  const records = await read(dev, town.lots.records, lots * 96);
  const centre = town.centre;
  const body = JSON.stringify({
    kind: 'reclaimed-lookpatch',
    url: location.href,
    town: id,
    sea: R.atlas.p.sea,
    oz: R.stream.oz,
    patch: { x0, y0, w: SIDE, h: SIDE, ground: b64(land.ground), water: b64(land.water), top: b64(land.top), veg: b64(land.veg) },
    // the town's grid frame: world = local + origin; its columns' (0, 0) the box's first
    townGrid: { origin: [at[0] - centre[0], at[1] - centre[1]], box, centre, roads: b64(roads), heights: b64(heights) },
    lots: { n: lots, counts: b64(counts), records: b64(records) },
  });
  const kept = await postDev(body, 'lookpatch');
  panel.say(kept ? `look capture ${kept}` : 'look capture: not on the dev server');
}
