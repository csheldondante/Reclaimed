import { Ambience } from './audio/ambience';
import { COSTS, Nature, worldHealth } from './game/nature';
import { initGpu, showFatal, UnsupportedError } from './gpu/device';
import { Profiler } from './gpu/profiler';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { EventKind, type GlobalsState } from './sim/globals';
import { Simulation, TICK_DT } from './sim/simulation';
import { WorldGpu } from './sim/world-gpu';
import { Hud } from './ui/hud';
import { PerfOverlay } from './ui/perf-overlay';
import { CHUNK, packColumns } from './world/layout';
import { generateMap } from './world/mapgen';
import { Weather } from './weather/weather';

// A few broad quality tiers (design doc §10), chosen explicitly — no auto-detection heuristics.
const QUALITY = {
  low: { renderScale: 0.5, maxDpr: 1, rain: 1500, maxTicksPerFrame: 2 },
  medium: { renderScale: 0.75, maxDpr: 1.5, rain: 3000, maxTicksPerFrame: 3 },
  high: { renderScale: 1, maxDpr: 2, rain: 6000, maxTicksPerFrame: 4 },
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
  const world = new WorldGpu(device, profiler, packed, map);
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
    windX: weather.params.windX,
    windY: weather.params.windY,
    sun: SUN,
    pollution: 1,
    storms: [],
    events: [],
    collapseEnabled: false,
    flash: 0,
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

  const hud = new Hud(ui, (t) => {
    if (t === 'storm') hud.say('Tap the land to gather a storm. Drag a storm to nudge it; tap it for a downpour.');
    if (t === 'lightning') hud.say('Tap beneath a storm to call down lightning.');
  });
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

  // ---- input ----
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { kind: 'pan' | 'storm'; x0: number; y0: number; cx?: number; cy?: number; moved: boolean; storm?: ReturnType<Weather['nearest']>; sx?: number; sy?: number } | null = null;
  let pinchDist = 0;

  const stormAtScreen = (x: number, y: number) => {
    let best: ReturnType<Weather['nearest']> = null;
    let bd = 60;
    for (const s of weather.storms) {
      const [px, py] = camera.project(s.x, s.y, 20);
      const d = Math.hypot(px - x, py - y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  };
  const screenToRender = (x: number, y: number): [number, number] => [
    (x / camera.viewportW) * renderW,
    (y / camera.viewportH) * renderH,
  ];

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      drag = null;
      return;
    }
    const storm = e.button === 0 && hud.tool !== 'lightning' ? stormAtScreen(e.clientX, e.clientY) : null;
    if (storm) drag = { kind: 'storm', x0: e.clientX, y0: e.clientY, moved: false, storm, sx: storm.x, sy: storm.y };
    else drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
      pinchDist = d;
      return;
    }
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) drag.moved = true;
    drag.cx = e.clientX;
    drag.cy = e.clientY;
    if (drag.kind === 'pan') {
      const [wx, wy] = camera.screenDeltaToWorld(dx, dy);
      camera.target[0] -= wx;
      camera.target[1] -= wy;
    } else if (drag.storm && drag.moved) {
      const [wx, wy] = camera.screenDeltaToWorld(e.clientX - drag.x0, e.clientY - drag.y0);
      weather.nudge(drag.storm, drag.sx! + wx, drag.sy! + wy);
    }
  });
  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) return;
    if (d.kind === 'storm' && d.storm) {
      if (nature.trySpend(COSTS.downpour)) {
        d.storm.downpour = Math.min(2, d.storm.downpour + 1.2);
      } else hud.say('Not enough Nature for a downpour.');
      return;
    }
    if (hud.tool === 'lightning') {
      const [rx, ry] = screenToRender(e.clientX, e.clientY);
      renderer.pick(rx, ry).then((cell) => {
        if (cell !== null) strike(cell);
      });
      return;
    }
    if (hud.tool === 'storm') {
      const [rx, ry] = screenToRender(e.clientX, e.clientY);
      renderer.pick(rx, ry).then((cell) => {
        if (cell === null) return;
        if (!weather.canSpawn()) return hud.say('The sky can only hold a few storms at once.');
        if (!nature.trySpend(COSTS.storm)) return hud.say('Not enough Nature. Living land restores it.');
        const x = cell % dims.w;
        const y = Math.floor(cell / dims.w);
        // storms gather upwind of the chosen point so they pass over it
        weather.spawn(x - weather.params.windX * 6, y - weather.params.windY * 6);
        hud.setTool('none');
        if (!told.lightning) {
          told.lightning = true;
          setTimeout(() => hud.say('While it rains, Lightning can be called down beneath the storm.', 7), 6000);
        }
      });
    }
  };
  let lastStrike = -10;
  /** One-time contextual hints already shown. */
  const told = { lightning: false, cascade: false };
  /**
   * Lightning seeks the highest point near where the player asked for it
   * (score = height − 0.4·distance within 7 cells), read from a one-off
   * surface readback. The bolt is drawn to that exact point.
   */
  const strike = async (cell: number) => {
    const tx = cell % dims.w;
    const ty = Math.floor(cell / dims.w);
    if (weather.rainAt(tx + 0.5, ty + 0.5) < 0.15) return hud.say('Lightning needs a storm overhead.');
    if (globals.time - lastStrike < 0.8) return;
    if (!nature.trySpend(COSTS.lightning)) return hud.say('Not enough Nature for lightning.');
    lastStrike = globals.time;
    const surf = new Uint32Array((await readBuffer('surface')).buffer);
    let bx = tx;
    let by = ty;
    let best = -Infinity;
    const R = 7;
    for (let y = Math.max(0, ty - R); y <= Math.min(dims.h - 1, ty + R); y++)
      for (let x = Math.max(0, tx - R); x <= Math.min(dims.w - 1, tx + R); x++) {
        const d = Math.hypot(x - tx, y - ty);
        if (d > R) continue;
        const score = (surf[y * dims.w + x] & 0xff) - 0.4 * d;
        if (score > best) {
          best = score;
          bx = x;
          by = y;
        }
      }
    const bz = surf[by * dims.w + bx] & 0xff;
    globals.events.push({ kind: EventKind.Lightning, x: bx + 0.5, y: by + 0.5, radius: 5, strength: 20 });
    globals.flash = 1;
    const [sx, sy] = camera.project(bx + 0.5, by + 0.5, bz);
    hud.bolt(sx, sy);
    audio.thunder(1);
    if (!told.cascade) {
      told.cascade = true;
      setTimeout(() => hud.say('Damaged structures can fail on their own. Water and gravity do the rest.', 7), 2500);
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const zoomAt = (sx: number, sy: number, factor: number) => {
    const before = camera.screenDeltaToWorld(sx - camera.viewportW / 2, sy - camera.viewportH / 2);
    camera.zoom = Math.max(0.8, Math.min(24, camera.zoom * factor));
    const after = camera.screenDeltaToWorld(sx - camera.viewportW / 2, sy - camera.viewportH / 2);
    camera.target[0] += before[0] - after[0];
    camera.target[1] += before[1] - after[1];
  };
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
    if (e.key === '`') perf.toggle();
    if (e.key === '1') hud.setTool(hud.tool === 'storm' ? 'none' : 'storm');
    if (e.key === '2') hud.setTool(hud.tool === 'lightning' ? 'none' : 'lightning');
    if (e.key === 'Escape') hud.setTool('none');
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
    setTimeout(() => hud.say('The valley is quiet. Rain would wash it clean. Choose Storm.', 7), 1500);
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
      rainParticles: globals.storms.length ? quality.rain * globals.storms.length : 0,
    });
    const afterProfile = profiler.endFrame(enc);
    device.queue.submit([enc.finish()]);
    renderer.afterSubmit();
    afterProfile?.();

    hud.update(nature.value, nature.max);
    hud.drawStorms(
      weather.storms.map((s) => {
        const [x, y] = camera.project(s.x, s.y, 20);
        return { x, y, a: s.intensity };
      }),
      drag?.kind === 'storm' && drag.moved && drag.storm
        ? (() => {
            const [x0, y0] = camera.project(drag.storm.x, drag.storm.y, 20);
            return { x0, y0, x1: drag.cx ?? drag.x0, y1: drag.cy ?? drag.y0 };
          })()
        : undefined,
    );
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
      wind: 0.45 + Math.min(0.55, weather.storms.reduce((a, s) => a + s.intensity * 0.4, 0)),
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
  (window as unknown as { reclaimed: unknown }).reclaimed = { sim, world, weather, camera, nature, renderer, map, readBuffer, probe, strike, globals, packed };
}

main().catch((e) => {
  if (e instanceof UnsupportedError) showFatal(e.message);
  else showFatal(`Startup failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
});
