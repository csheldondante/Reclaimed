// Boot: WebGPU, shared services, and switching between the menu diorama and
// the level. Each scene owns its world and is disposed when left.

import { Ambience } from './audio/ambience';
import { initGpu, showFatal, UnsupportedError } from './gpu/device';
import { Profiler } from './gpu/profiler';
import { LevelScene } from './scenes/level';
import { MenuScene } from './scenes/menu';
import type { MapData } from './world/mapgen';
import type { Host, Quality, Scene } from './scenes/world-core';
import { AudioDebug } from './ui/audio-debug';
import { Loader } from './ui/loader';
import { PerfOverlay } from './ui/perf-overlay';

// A few broad quality tiers (design doc §10), chosen explicitly — no auto-detection heuristics.
const QUALITY: Record<string, Quality> = {
  low: { renderScale: 0.5, maxDpr: 1, rain: 1500, maxTicksPerFrame: 2, particles: 16384 },
  medium: { renderScale: 0.75, maxDpr: 1.5, rain: 3000, maxTicksPerFrame: 3, particles: 32768 },
  high: { renderScale: 1, maxDpr: 2, rain: 6000, maxTicksPerFrame: 4, particles: 65536 },
};

// The loading bar's stages, placed by their measured share of the wait (DEVLOG
// 2026-10-30): where it stands once the script runs and once the GPU is up, and
// how much of a scene's own share goes to building it rather than settling it.
const BAR = { script: 0.03, gpu: 0.07, menuBuilt: 0.3, levelBuilt: 0.05 };

async function main() {
  const loader = new Loader();
  loader.set('script', BAR.script);
  const params = new URLSearchParams(location.search);
  const qualityName = params.get('q') ?? 'high';
  const quality = QUALITY[qualityName];
  if (!quality) throw new Error(`unknown quality "${qualityName}" (use low|medium|high)`);

  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  const gpu = await initGpu(canvas);
  loader.set('gpu', BAR.gpu);
  const profiler = new Profiler(gpu.device, gpu.hasTimestamps);
  const host: Host = { gpu, profiler, quality, qualityName, params, canvas, ui };
  const audio = new Ambience();
  if (params.get('audio') === '1') new AudioDebug(ui, audio);
  const perf = new PerfOverlay(ui, params.get('perf') === '1');
  window.addEventListener('keydown', (e) => {
    if (e.key === '`') perf.toggle();
  });

  let scene: Scene | null = null;
  let size = { rw: 1, rh: 1, cw: 1, ch: 1 };
  const resize = () => {
    const cw = Math.max(1, canvas.clientWidth);
    const ch = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, quality.maxDpr);
    const rw = Math.max(1, Math.floor(cw * dpr * quality.renderScale));
    const rh = Math.max(1, Math.floor(ch * dpr * quality.renderScale));
    const maxDim = gpu.device.limits.maxTextureDimension2D;
    if (rw > maxDim || rh > maxDim) throw new Error(`render target ${rw}×${rh} exceeds device limit ${maxDim}`);
    canvas.width = rw;
    canvas.height = rh;
    size = { rw, rh, cw, ch };
    scene?.resize(rw, rh, cw, ch);
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  // A scene loads behind the loading screen. At boot the screen is already up;
  // switching scenes brings it back and lets the old scene go first, so it
  // doesn't keep drawing (and taking GPU time from the new one's warmup).
  // Returns where the bar starts.
  const leave = async (): Promise<number> => {
    if (!scene) return BAR.gpu;
    await loader.show();
    scene.dispose();
    scene = null;
    return 0;
  };
  const show = (next: Scene) => {
    scene = next;
    scene.resize(size.rw, size.rh, size.cw, size.ch);
    loader.done();
  };

  const startLevel = async (levelId: string, map?: MapData) => {
    const from = await leave();
    const built = from + (1 - from) * BAR.levelBuilt;
    const level = await LevelScene.create(host, audio, perf, levelId, () => void startMenu(), {
      map,
      onLoadMap: (m) => void startLevel(levelId, m),
      progress: (f) => loader.set(`level:${f.toFixed(2)}`, built + (1 - built) * f),
    });
    show(level);
  };
  const startMenu = async () => {
    const from = await leave();
    const menu = new MenuScene(host, audio, (id) => startLevel(id));
    const built = from + (1 - from) * BAR.menuBuilt;
    loader.set('menu:built', built);
    await menu.init((f) => loader.set(`menu:${f.toFixed(2)}`, built + (1 - built) * f));
    show(menu);
  };

  // ?skipmenu=1 goes straight to the level (debugging, scripted tests)
  if (params.get('skipmenu') === '1') await startLevel(params.get('level') ?? 'valley');
  else await startMenu();

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    scene?.frame(now, dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((e) => {
  if (e instanceof UnsupportedError) showFatal(e.message);
  else showFatal(`Startup failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
});
