// Boot: WebGPU, shared services, and switching between the menu diorama and
// the level. Each scene owns its world and is disposed when left.

// (perfopt: the phone's flags into the URL first — the modules below read it as they load; src/phone-flags.ts)
import './phone-flags-boot';

import { Ambience } from './audio/ambience';
import { initGpu, showFatal, UnsupportedError } from './gpu/device';
import { Profiler } from './gpu/profiler';
import { AtlasView } from './scenes/atlas-view';
import { LevelScene } from './scenes/level';
import { MenuScene } from './scenes/menu';
import type { MapData } from './world/mapgen';
import type { Host, Quality, Scene } from './scenes/world-core';
import { AudioDebug } from './ui/audio-debug';
import { RockPanel } from './ui/rockpanel';
import { PerfOverlay } from './ui/perf-overlay';
import { startHitch } from './perf/start';
import { benchLevel, benchLoadingNote, benchMode, benchSkip, benchStandalone } from './perf/bench';

// A few broad quality tiers (design doc §10), chosen explicitly — no auto-detection heuristics.
const QUALITY: Record<string, Quality> = {
  low: { renderScale: 0.5, maxDpr: 1, rain: 1500, maxTicksPerFrame: 2, particles: 16384, agentSweeps: 2, shadowSize: 1024, meshSlots: 1 },
  medium: { renderScale: 0.75, maxDpr: 1.5, rain: 3000, maxTicksPerFrame: 3, particles: 32768, agentSweeps: 4, meshSlots: 5 },
  high: { renderScale: 1, maxDpr: 2, rain: 6000, maxTicksPerFrame: 4, particles: 65536, agentSweeps: 8 },
};

async function main() {
  const params = new URLSearchParams(location.search);
  // (low by default, for phones: round 54; ?q=medium|high on a desktop)
  const qualityName = params.get('q') ?? 'low';
  const quality = QUALITY[qualityName];
  if (!quality) throw new Error(`unknown quality "${qualityName}" (use low|medium|high)`);
  // (round 82: ?slots=N — the mesh's rebuilds a frame, overriding the tier's, to A/B on the phone)
  // (perfopt: ?shadowsize=N — the sun's map's side, overriding the tier's: at low a cell is 1.3 pixels on screen
  // and 5 texels in a 1024² map, eleven times the screen's pixels drawn and stored every frame)
  const shadowSize = params.get('shadowsize');
  if (shadowSize !== null) {
    const n = Number(shadowSize);
    if (![256, 512, 1024, 2048].includes(n)) throw new Error(`?shadowsize=${shadowSize}: 256, 512, 1024 or 2048`);
    quality.shadowSize = n;
  }
  // (perfopt: ?ticks=N — the sim's ticks a frame at most, overriding the tier's (low 2). Below 60 fps a frame runs
  // two ticks, so a slow frame's GPU work grows by a whole tick; 1 tells how much of the phone's frame that is —
  // the sim then runs slower than real time whenever the frame rate is under 60)
  const ticks = params.get('ticks');
  if (ticks !== null) {
    const n = Number(ticks);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error(`?ticks=${ticks}: 1..8`);
    quality.maxTicksPerFrame = n;
  }
  const slots = params.get('slots');
  if (slots !== null) {
    const n = Number(slots);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error(`?slots=${slots}: 1..8`);
    quality.meshSlots = n;
  }

  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  const gpu = await initGpu(canvas);
  // (round 100, hitchrec: ?hitch=1 — the hitch recorder; its GPU memory count goes on the device before anything's made)
  const hitch = startHitch(params, gpu.device, ui);
  // (round 82, ?readback=0: no GPU readbacks every frame or few — no timestamps, the mesh's chunk records, the
  // draw counts — to tell whether they stall a phone's frames: render/renderer.ts READBACK)
  const profiler = new Profiler(gpu.device, gpu.hasTimestamps && params.get('readback') !== '0');
  const host: Host = { gpu, profiler, quality, qualityName, params, canvas, ui };
  const audio = new Ambience();
  if (params.get('audio') === '1') new AudioDebug(ui, audio);
  // (round 96) the rock's knobs: in the rock lab, or ?rockpanel=1
  if (params.get('level') === 'rocklab' || params.get('rockpanel') === '1') new RockPanel(ui);
  const perf = new PerfOverlay(ui, params.get('perf') === '1' || params.get('perf') === 'lite');
  // (round 82: the GPU's timings and the draw counts are read back only while the overlay is open; ?perf=lite
  // opens it with neither — the frame times without the readbacks)
  const lite = params.get('perf') === 'lite';
  profiler.active = (perf.visible && !lite) || !!hitch?.gpuTiming;
  hitch?.attach(profiler, () => scene);
  window.addEventListener('keydown', (e) => {
    if (e.key === '`') {
      perf.toggle();
      profiler.active = (perf.visible && !lite) || !!hitch?.gpuTiming;
    }
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

  // (round 101, ?bench=1: the calibration benchmark — src/perf/bench.ts. Its start and end pages run no level; its
  // level pages are the game as deployed, measured)
  const bench = benchMode(params);
  if (bench === 'start' || bench === 'final') {
    await benchStandalone(bench, host);
    return;
  }
  // (v3: a page that loaded again without finishing is skipped; a device lost on a level page goes on to the next)
  if (bench === 'skip') {
    benchSkip('the page loaded again without finishing (crashed, or the tab was killed)');
    return;
  }
  if (bench === 'level') benchLoadingNote(ui);
  if (bench === 'level') void gpu.device.lost.then((info) => info.reason !== 'destroyed' && benchSkip(`GPU device lost (${info.reason}): ${info.message}`));

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

  // ?atlas=view: the atlas viewer (round 67); ?skipmenu=1 goes straight to the level (debugging, scripted tests)
  if (params.get('atlas') === 'view') show(await AtlasView.create(host));
  else if (params.get('skipmenu') === '1') await startLevel(params.get('level') ?? 'valley');
  else await startMenu();
  if (bench === 'level')
    void benchLevel({
      host,
      scene: () => scene,
      hitch,
      setRenderScale: (s) => {
        quality.renderScale = s;
        resize();
      },
    });

  // (round 82: at most two frames on the GPU at once — a frame waits, its time carried to the next, while the
  // GPU catches up. Nothing held the CPU back before but the timing readbacks; without them (?perf=lite, or
  // the overlay closed) a phone's GPU fell behind and froze for up to a second. ?pace=0 turns it off.)
  const pace = params.get('pace') !== '0';
  let inFlight = 0;
  let last = performance.now();
  const frame = (now: number) => {
    if (pace && inFlight >= 2) {
      hitch?.rec?.heldFrame();
      requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // (round 100, hitchrec: the frame's interval and its callback's CPU time)
    hitch?.rec?.frameStart(now);
    const c0 = hitch ? performance.now() : 0;
    scene?.frame(now, dt);
    if (hitch) hitch.frameEnd(performance.now() - c0);
    if (pace) {
      inFlight++;
      gpu.device.queue.onSubmittedWorkDone().then(() => inFlight--);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((e) => {
  if (e instanceof UnsupportedError) showFatal(e.message);
  else showFatal(`Startup failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
});
