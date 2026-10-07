import { Ambience } from './audio/ambience';
import { Nature, worldHealth } from './game/nature';
import { Powers } from './game/powers';
import { Controls } from './input/controls';
import { initGpu, showFatal, UnsupportedError } from './gpu/device';
import { Profiler } from './gpu/profiler';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import type { GlobalsState } from './sim/globals';
import { Simulation, TICK_DT } from './sim/simulation';
import { WorldGpu } from './sim/world-gpu';
import { Hud } from './ui/hud';
import { PerfOverlay } from './ui/perf-overlay';
import { CHUNK, packColumns } from './world/layout';
import { generateMap } from './world/mapgen';
import { Weather } from './weather/weather';

// A few broad quality tiers (design doc §10), chosen explicitly — no auto-detection heuristics.
const QUALITY = {
  low: { renderScale: 0.5, maxDpr: 1, rain: 1500, maxTicksPerFrame: 2, particles: 16384 },
  medium: { renderScale: 0.75, maxDpr: 1.5, rain: 3000, maxTicksPerFrame: 3, particles: 32768 },
  high: { renderScale: 1, maxDpr: 2, rain: 6000, maxTicksPerFrame: 4, particles: 65536 },
} as const;
type QualityName = keyof typeof QUALITY;

const WARMUP_TICKS = 1800; // ~30 s of sim: rivers reach equilibrium before the player looks
const SUN: [number, number, number] = [0.75, -0.3, 0.62];

async function main() {
  const params = new URLSearchParams(location.search);
  const qName = (params.get('q') ?? 'high') as QualityName;
  if (!(qName in QUALITY)) throw new Error(`unknown quality "${qName}" (use low|medium|high)`);
  const quality = QUALITY[qName];
  // debug: run simulation faster than real time (weather, ticks, nature all scale)
  const speed = Math.max(1, Number(params.get('speed') ?? 1));

  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  const gpu = await initGpu(canvas);
  const { device } = gpu;
  const profiler = new Profiler(device, gpu.hasTimestamps);

  const dims = { w: 256, h: 256, zMax: 64 };
  const map = generateMap(dims, 1);
  const packed = packColumns(map.grid);
  const world = new WorldGpu(device, profiler, packed, map, quality.particles);
  const sim = new Simulation(device, world, profiler);
  const renderer = new Renderer(device, gpu.format, world, profiler);
  const weather = new Weather(map.surface, dims.w, dims.h);
  const nature = new Nature();
  const audio = new Ambience();
  const camera = new Camera();
  camera.target = [dims.w * 0.55, dims.h * 0.5, 14];

  const globals: GlobalsState = {
    mapW: dims.w,
    mapH: dims.h,
    tick: 0,
    chunkSize: CHUNK,
    chunksX: packed.chunksX,
    zMax: dims.zMax,
    seed: 1,
    time: 0,
    dt: TICK_DT,
    windX: weather.windX,
    windY: weather.windY,
    sun: SUN,
    pollution: 1,
    storms: [],
    events: [],
    collapseEnabled: false,
    flash: 0,
    gusts: [],
    sky: [0.34, 0.33, 0.31, 0],
    sunCol: [2.4, 2.0, 1.55, 0.35],
  };

  // Settle the generated world with the real systems (granular slopes, rivers
  // filling) before the player sees it. Ecology is excluded so nothing grows.
  sim.prime(globals);
  // Structural support needs a few ticks to propagate before collapse can be
  // judged; anything genuinely unsupported in the generated ruins falls during
  // warmup, out of sight.
  for (let i = 0; i < WARMUP_TICKS; i++) {
    globals.collapseEnabled = i > 120;
    sim.step(globals, (s) => s.name !== 'ecology');
  }
  await device.queue.onSubmittedWorkDone();

  const perf = new PerfOverlay(ui, params.get('perf') === '1');

  // ---- sizing ----
  let renderW = 1;
  let renderH = 1;
  const resize = () => {
    const cssW = Math.max(1, canvas.clientWidth);
    const cssH = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, quality.maxDpr);
    renderW = Math.max(1, Math.floor(cssW * dpr * quality.renderScale));
    renderH = Math.max(1, Math.floor(cssH * dpr * quality.renderScale));
    const maxDim = device.limits.maxTextureDimension2D;
    if (renderW > maxDim || renderH > maxDim) throw new Error(`render target ${renderW}×${renderH} exceeds device limit ${maxDim}`);
    canvas.width = renderW;
    canvas.height = renderH;
    camera.viewportW = cssW;
    camera.viewportH = cssH;
    renderer.resize(renderW, renderH);
  };
  resize();
  camera.zoom = Math.max(1.5, Math.min(camera.viewportW, camera.viewportH * 1.6) / 300);
  new ResizeObserver(resize).observe(canvas);

  // CPU copy of surface heights for cursor → ground mapping (refreshed ~1 Hz, async)
  let surfaceCache: Uint32Array = new Uint32Array(dims.w * dims.h);
  for (let i = 0; i < surfaceCache.length; i++) surfaceCache[i] = Math.round(map.surface[i]);
  const heightAt = (x: number, y: number) => {
    const ix = Math.max(0, Math.min(dims.w - 1, Math.floor(x)));
    const iy = Math.max(0, Math.min(dims.h - 1, Math.floor(y)));
    return surfaceCache[iy * dims.w + ix] & 0xff;
  };
  const readSurface = async () => new Uint32Array((await readBuffer('surface')).buffer);
  let surfaceRefresh = 0;

  // ---- powers + diegetic controls ----
  let powers!: Powers;
  const hud = new Hud(ui, () => powers.summonStorm());
  powers = new Powers({
    weather,
    nature,
    audio,
    hud,
    particles: sim.particles,
    globals,
    camera,
    dims,
    readSurface,
  });
  const screenToRender = (x: number, y: number): [number, number] => [
    (x / camera.viewportW) * renderW,
    (y / camera.viewportH) * renderH,
  ];
  let hoverWorld: [number, number] | null = null;
  const zoomAt = (sx: number, sy: number, factor: number) => {
    const before = camera.screenDeltaToWorld(sx - camera.viewportW / 2, sy - camera.viewportH / 2);
    camera.zoom = Math.max(0.8, Math.min(24, camera.zoom * factor));
    const after = camera.screenDeltaToWorld(sx - camera.viewportW / 2, sy - camera.viewportH / 2);
    camera.target[0] += before[0] - after[0];
    camera.target[1] += before[1] - after[1];
  };
  new Controls(canvas, {
    tap: (sx, sy) => {
      const [wx, wy] = camera.groundAt(sx, sy, heightAt);
      const [rx, ry] = screenToRender(sx, sy);
      renderer.pick(rx, ry).then((hit) => powers.tap(hit, wx, wy, sx, sy));
    },
    dragStart: (sx, sy) => {
      const [wx, wy] = camera.groundAt(sx, sy, heightAt);
      return powers.gustStart(wx, wy);
    },
    dragMove: (sx, sy) => {
      const [wx, wy] = camera.groundAt(sx, sy, heightAt);
      powers.gustMove(wx, wy);
    },
    dragEnd: () => powers.gustEnd(),
    hover: (sx, sy) => {
      const [wx, wy] = camera.groundAt(sx, sy, heightAt);
      hoverWorld = [wx, wy];
    },
    pan: (dx, dy) => {
      const [wx, wy] = camera.screenDeltaToWorld(dx, dy);
      camera.target[0] -= wx;
      camera.target[1] -= wy;
    },
    zoomAt,
  });

  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
    if (e.key === '`') perf.toggle();
    if (e.key.toLowerCase() === 'r') powers.summonStorm();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // ---- intro ----
  const intro = document.createElement('div');
  intro.className = 'intro';
  intro.innerHTML = `<div><h1>RECLAIMED</h1><p>click to listen</p></div>`;
  ui.appendChild(intro);
  intro.addEventListener('click', () => {
    audio.start();
    intro.classList.add('gone');
    setTimeout(() => intro.remove(), 1300);
    setTimeout(() => hud.say('The valley is quiet. Touch things. Call a storm with ☁ or R. Right-drag to look around.', 8), 1500);
  });

  // ---- loop ----
  let last = performance.now();
  let acc = 0;
  let fps = 60;
  let ticksAvg = 1;
  let initialContam = 0;
  let lastCollapsed = -1;
  let nextGroan = 20;
  let pollution = 1;
  let life = 0;
  const t0 = performance.now();

  const frame = (now: number) => {
    const cpu0 = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fps = fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
    profiler.beginFrame();

    // keyboard pan
    const panSpeed = 500 / camera.zoom;
    let kx = 0;
    let ky = 0;
    if (keys.has('a') || keys.has('arrowleft')) kx -= 1;
    if (keys.has('d') || keys.has('arrowright')) kx += 1;
    if (keys.has('w') || keys.has('arrowup')) ky -= 1;
    if (keys.has('s') || keys.has('arrowdown')) ky += 1;
    if (kx || ky) {
      const [wx, wy] = camera.screenDeltaToWorld(kx * panSpeed * dt, ky * panSpeed * dt);
      camera.target[0] += wx;
      camera.target[1] += wy;
    }
    camera.target[0] = Math.max(0, Math.min(dims.w, camera.target[0]));
    camera.target[1] = Math.max(0, Math.min(dims.h, camera.target[1]));
    camera.update();

    const simDt = dt * speed;
    weather.update(simDt);
    globals.windX = weather.windX;
    globals.windY = weather.windY;
    if (hoverWorld) powers.hover(hoverWorld[0], hoverWorld[1], dt);
    powers.update(dt);
    // keep the cursor→ground height map roughly current as the world changes
    surfaceRefresh -= dt;
    if (surfaceRefresh <= 0) {
      surfaceRefresh = 1;
      void readSurface().then((s) => (surfaceCache = s));
    }
    const stats = sim.stats.latest;
    if (stats && initialContam === 0) initialContam = stats.soilContam;
    if (stats) {
      // structural failures since the last stats readback → crumbling sound
      if (lastCollapsed >= 0 && stats.collapsed > lastCollapsed) audio.crumble(stats.collapsed - lastCollapsed);
      lastCollapsed = stats.collapsed;
    }
    const health = worldHealth(stats, initialContam);
    pollution += (health.pollution - pollution) * Math.min(1, dt * 0.5);
    life += (health.life - life) * Math.min(1, dt * 0.5);
    nature.update(simDt, stats);

    globals.time = (now - t0) / 1000;
    globals.storms = weather.uniforms();
    globals.pollution = pollution;
    globals.flash = Math.max(0, globals.flash - dt * 2.5);

    acc += simDt;
    let ticks = 0;
    while (acc >= TICK_DT && ticks < quality.maxTicksPerFrame * speed) {
      sim.step(globals);
      acc -= TICK_DT;
      ticks++;
    }
    if (ticks === quality.maxTicksPerFrame * speed) acc = Math.min(acc, TICK_DT); // drop time instead of spiralling
    ticksAvg = ticksAvg * 0.95 + ticks * 0.05;

    sim.uploadGlobals(globals);
    const enc = device.createCommandEncoder({ label: 'frame' });
    renderer.encode(enc, gpu.context.getCurrentTexture().createView(), camera, {
      rainParticles: Math.round(weather.storms.reduce((a, st) => a + quality.rain * 0.55 * st.intensity * (st.radius / 26), 0)),
    });
    const afterProfile = profiler.endFrame(enc);
    device.queue.submit([enc.finish()]);
    renderer.afterSubmit();
    afterProfile?.();

    hud.update(nature.value, nature.max, powers.stormReady());
    const arrow = powers.gustArrow();
    if (arrow) {
      const [x0, y0] = camera.project(arrow.x0, arrow.y0, heightAt(arrow.x0, arrow.y0));
      const [x1, y1] = camera.project(arrow.x1, arrow.y1, heightAt(arrow.x0, arrow.y0));
      hud.drawGust({ x0, y0, x1, y1 });
    } else hud.drawGust();
    // The dam groans now and then while it still holds water back: a sparse,
    // diegetic pointer at the map's main leverage (§3, §7).
    if (globals.time > nextGroan) {
      nextGroan = globals.time + 14 + Math.random() * 16;
      const [dx, dy] = map.poi.dam;
      const near = 1 - Math.min(1, Math.hypot(camera.target[0] - dx, camera.target[1] - dy) / 120);
      const holding = stats ? Math.min(1, stats.waterVolume / 20000) : 1;
      audio.groan(near * holding);
    }
    audio.update({
      pollution,
      life,
      rain: weather.rainAt(camera.target[0], camera.target[1]),
      flow: stats ? Math.min(1, stats.flow / 40) : 0,
      wind: Math.min(1, Math.hypot(weather.windX, weather.windY) / 6 + weather.storms.reduce((a, s) => a + s.intensity * 0.3, 0)),
    });
    perf.update(
      {
        fps,
        cpuFrameMs: performance.now() - cpu0,
        ticksPerFrame: ticksAvg,
        instancesOpaque: renderer.instanceCounts.opaque,
        instancesWater: renderer.instanceCounts.water,
        renderW,
        renderH,
        stats,
        adapter: gpu.adapterInfo,
        quality: qName,
      },
      profiler,
      sim,
    );
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // expose for debugging in devtools
  /** Debug: read a whole world buffer back (slow; devtools / test scripts only). */
  const readBuffer = async (name: keyof WorldGpu): Promise<Float32Array> => {
    const src = world[name] as unknown as GPUBuffer;
    const tmp = device.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, tmp, 0, src.size);
    device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(tmp.getMappedRange()).slice();
    tmp.destroy();
    return out;
  };
  /** Debug: mean of a per-column field over a square region. */
  const probe = async (name: keyof WorldGpu, x: number, y: number, r = 6, stride = 1, comp = 0) => {
    const f = await readBuffer(name);
    let s = 0;
    let n = 0;
    for (let yy = y - r; yy <= y + r; yy++)
      for (let xx = x - r; xx <= x + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= dims.w || yy >= dims.h) continue;
        s += f[(yy * dims.w + xx) * stride + comp];
        n++;
      }
    return s / n;
  };
  (window as unknown as { reclaimed: unknown }).reclaimed = { sim, world, weather, camera, nature, renderer, map, readBuffer, probe, powers, globals, packed };
}

main().catch((e) => {
  if (e instanceof UnsupportedError) showFatal(e.message);
  else showFatal(`Startup failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
});
