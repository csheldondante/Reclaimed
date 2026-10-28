// Round 100 (hitchrec): `?hitch=1` boots the hitch recorder (hitch.ts), its HUD (hitch-hud.ts) and the GPU memory
// count (gpumem.ts). `?hitchms=N` the threshold (20), `?hitchgpu=0` no GPU timestamps (a readback a frame),
// `?hitchhud=0` the recorder without its HUD (scripts read window.reclaimedHitch).

import { cpuStats } from '../gpu/cpustat';
import type { Profiler } from '../gpu/profiler';
import { GpuMemTrack } from './gpumem';
import { HitchRecorder } from './hitch';
import { HitchHud } from './hitch-hud';

export interface HitchBoot {
  gpuTiming: boolean;
  rec?: HitchRecorder;
  hud?: HitchHud;
  mem: GpuMemTrack;
  attach(profiler: Profiler, scene: () => unknown): void;
  frameEnd(cpuMs: number): void;
}

export function startHitch(params: URLSearchParams, device: GPUDevice, ui: HTMLElement): HitchBoot | null {
  if (params.get('hitch') !== '1') return null;
  const ms = Number(params.get('hitchms') ?? 20);
  if (!(ms > 0)) throw new Error(`?hitchms=${params.get('hitchms')}: a positive number of ms`);
  const mem = new GpuMemTrack(device);
  const boot: HitchBoot = {
    gpuTiming: params.get('hitchgpu') !== '0' && device.features.has('timestamp-query'),
    mem,
    attach(profiler, scene) {
      const sc = () => scene() as { stream?: { busy?: boolean; stats?: unknown } } | null;
      const rec = (boot.rec = new HitchRecorder({ thresholdMs: ms, profiler, gpuMem: mem, busy: () => !!sc()?.stream?.busy }));
      const extra = () => {
        const passes: Record<string, { mean: number; max: number }> = {};
        const n = Math.max(1, profiler.framesResolved);
        for (const [k, v] of profiler.totalMs) passes[k] = { mean: +(v / n).toFixed(3), max: +(profiler.maxMs.get(k) ?? 0).toFixed(2) };
        return {
          adapter: (device as unknown as { adapterInfo?: { vendor?: string; architecture?: string; description?: string } }).adapterInfo ?? null,
          quality: params.get('q') ?? 'low',
          cpuSteps: Object.fromEntries([...cpuStats].sort((a, b) => b[1].max - a[1].max).slice(0, 30).map(([k, v]) => [k, { max: +v.max.toFixed(1), mean: +(v.sum / Math.max(1, v.n)).toFixed(2), n: v.n }])),
          gpuPasses: profiler.enabled && profiler.active ? { framesResolved: profiler.framesResolved, frameMeanMs: +(profiler.gpuTotalMs / n).toFixed(2), passes } : 'n/a',
          stream: sc()?.stream?.stats ?? null,
          gpuMem: { liveMB: +(mem.liveBytes() / 1048576).toFixed(1), created: mem.created, destroyed: mem.destroyed, collected: mem.collected, top: mem.top() },
        };
      };
      if (params.get('hitchhud') !== '0') boot.hud = new HitchHud(ui, rec, extra);
      (window as unknown as { reclaimedHitch: unknown }).reclaimedHitch = { rec, mem, report: () => rec.report(extra()), extra };
    },
    frameEnd(cpuMs) {
      boot.rec?.frameEnd(cpuMs);
      boot.hud?.update(performance.now());
    },
  };
  return boot;
}
