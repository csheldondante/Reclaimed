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
import { PerfOverlay } from './ui/perf-overlay';

// A few broad quality tiers (design doc §10), chosen explicitly — no auto-detection heuristics.
const QUALITY: Record<string, Quality> = {
  low: { renderScale: 0.5, maxDpr: 1, rain: 1500, maxTicksPerFrame: 2, particles: 16384 },
  medium: { renderScale: 0.75, maxDpr: 1.5, rain: 3000, maxTicksPerFrame: 3, particles: 32768 },
  high: { renderScale: 1, maxDpr: 2, rain: 6000, maxTicksPerFrame: 4, particles: 65536 },
};

async function main() {
  const params = new URLSearchParams(location.search);
  // (low by default, for phones: round 54; ?q=medium|high on a desktop)
  const qualityName = params.get('q') ?? 'low';
  const quality = QUALITY[qualityName];
  if (!quality) throw new Error(`unknown quality "${qualityName}" (use low|medium|high)`);

  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  const gpu = await initGpu(canvas);
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

  const show = (next: Scene) => {
    scene?.dispose();
    scene = next;
    scene.resize(size.rw, size.rh, size.cw, size.ch);
  };

  const startLevel = async (levelId: string, map?: MapData, free?: boolean) => {
    const level = await LevelScene.create(host, audio, perf, levelId, () => void startMenu(), {
      map,
      free,
      onLoadMap: (m) => void startLevel(levelId, m),
    });
    show(level);
  };
  const startMenu = async () => {
    const menu = new MenuScene(host, audio, (id, free) => startLevel(id, undefined, free));
    await menu.init();
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
