// The structures viewer (structures.html; round 117 part 4: a viewer per generator — "seed, a few parameters, turn
// and zoom"). Pick a tile system and a style, a seed and a size; see a building, a district or the city; turn (drag),
// zoom (wheel, pinch), pan (right-drag, two fingers); the time of day (the windows light at dusk); overlays for the
// tiles and the baked nav. Every setting is in the URL (scripts and screenshots open the same view).
import type { CitySpec, CityPlan, GroundFn, StructurePieces } from '../../api/contracts/structures';
import type { GridStyle } from '../../api/contracts/settlement';
import { planCity, isolate } from '../plan';
import { piecesOf, PIECE_FLOATS } from '../pieces';
import { fbm } from '../rng';
import { quadCorners, quadCentre } from '../tiles/builder';
import { STYLE_IDS } from '../styles';
import { ViewerRenderer, type FrameView } from './render';
import { perspective, lookAt, mul } from './mat';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

const state = {
  system: (q.get('system') ?? 'irregular') as GridStyle,
  style: (q.get('style') ?? 'hearth') as CitySpec['style'],
  seed: num('seed', 7),
  r: num('r', 56),
  storeys: num('storeys', 0),
  density: num('density', 0.8),
  view: (q.get('view') ?? 'city') as 'building' | 'district' | 'city',
  ground: (q.get('ground') ?? 'hill') as 'flat' | 'hill' | 'slope' | 'gorge',
  roads: num('roads', 3),
  walls: q.get('walls') === '1',
  tod: num('tod', 0.35),
  tiles: q.get('tiles') === '1',
  nav: q.get('nav') === '1',
  yaw: num('yaw', 0.75),
  pitch: num('pitch', 0.62),
  zoom: num('zoom', 1),
  px: num('px', 0),
  py: num('py', 0),
};

const GROUNDS: Record<string, GroundFn> = {
  flat: () => 10,
  hill: (x, y) => 10 + 30 * fbm(x * 0.006 + 3.1, y * 0.006 + 1.7, 11, 4) + 0.06 * x,
  slope: (x, y) => 10 + 0.22 * x + 3 * fbm(x * 0.02, y * 0.02, 5, 3),
  // (a gorge round the town: the roads out cross it on viaducts)
  gorge: (x, y) => {
    const d = Math.hypot(x, y) + 12 * (fbm(x * 0.01, y * 0.01, 3, 2) - 0.5);
    const g = Math.abs(d - 120);
    return 26 + 6 * fbm(x * 0.008, y * 0.008, 9, 3) - 24 * Math.max(0, 1 - (g / 22) ** 2);
  },
};

class UnsupportedError extends Error {}

async function boot(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  if (!navigator.gpu) throw new UnsupportedError('This page needs WebGPU (Chrome or Edge 113+, Safari 18+).');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new UnsupportedError('No WebGPU adapter.');
  // (timestamps for the perf test's GPU time, when the adapter has them: instrumentation, not needed to draw)
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
  device.addEventListener('uncapturederror', (e) => fatal(`GPU error: ${(e as GPUUncapturedErrorEvent).error.message}`));
  const ctx = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const phone = Math.min(screen.width, screen.height) < 600;
  const r = new ViewerRenderer(device, ctx, format, num('msaa', 4));
  let plan: CityPlan | null = null;
  let all: StructurePieces | null = null;
  let focusAt: [number, number, number] = [0, 0, 10];
  let reach = 60;
  let dist = 100;

  const ui = panel();
  const rebuild = () => {
    const t0 = performance.now();
    const ground = GROUNDS[state.ground];
    const spec: CitySpec = { seed: state.seed, system: state.system, style: state.style, at: [0, 0], radius: state.r, density: state.density, roads: state.roads, walls: state.walls || undefined };
    if (state.storeys > 0) spec.storeys = [state.storeys, Math.max(1, state.storeys * 0.4)];
    plan = planCity(spec, ground);
    all = piecesOf(plan);
    const ms = performance.now() - t0;
    showView();
    // the ground under it all
    const G = state.r * (state.roads ? 2.5 : 1) + 50;
    const step = G > 120 ? 2 : 1;
    const n = Math.floor((2 * G) / step) + 1;
    const verts = new Float32Array(n * n * 4);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = -G + i * step;
        const y = -G + j * step;
        const o = (j * n + i) * 4;
        verts[o] = x;
        verts[o + 1] = y;
        verts[o + 2] = ground(x, y);
        verts[o + 3] = Math.max(0, 1 - Math.hypot(x, y) / (state.r * 1.05)) * 0.5;
      }
    const index = new Uint32Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let j = 0; j + 1 < n; j++)
      for (let i = 0; i + 1 < n; i++) {
        const a = j * n + i;
        index.set([a, a + 1, a + n + 1, a, a + n + 1, a + n], k);
        k += 6;
      }
    r.setGround(verts, index);
    r.setLines(lines(plan));
    r.showLines = state.tiles || state.nav;
    ui.stats.textContent = `${plan.stats.tiles} tiles · ${plan.stats.buildings} buildings · ${r.sg.stats.pieces} pieces · ${(r.sg.stats.tris / 1000).toFixed(0)}k tris · ${r.sg.stats.draws} draws · planned in ${ms.toFixed(0)} ms`;
    writeUrl();
  };

  const showView = () => {
    if (!plan || !all) return;
    const ground = GROUNDS[state.ground];
    if (state.view === 'building') {
      // the building nearest the middle with a few tiles to it (a landmark tower if that's all there is)
      const b = [...plan.buildings].sort((a, c) => score(c) - score(a))[0];
      function score(x: (typeof plan & {})['buildings'][number]) {
        const [cx, cy] = quadCentre(plan!.tiles, x.quads[0]);
        return Math.min(x.quads.length, 5) * 10 + x.storeys * 3 - Math.hypot(cx, cy) * 0.2 - (x.mega ? 30 : 0);
      }
      const solo = piecesOf(isolate(plan, b.id));
      r.sg.set(filter(solo, (i) => solo.building[i] === b.id));
      const c = centroid(plan, b.quads);
      focusAt = [c[0], c[1], b.base + b.storeys * b.storeyH * 0.5];
      reach = 24;
      dist = 34;
    } else if (state.view === 'district') {
      const R = Math.min(state.r, 34);
      r.sg.set(filter(all, (i) => Math.hypot(all!.data[i * PIECE_FLOATS], all!.data[i * PIECE_FLOATS + 1]) < R));
      focusAt = [0, 0, ground(0, 0) + 4];
      reach = R + 12;
      dist = R * 2.6;
    } else {
      r.sg.set(all);
      focusAt = [0, 0, ground(0, 0) + 4];
      reach = state.r * (state.roads ? 2.4 : 1) + 30;
      dist = state.r * (state.roads ? 3.4 : 2.7);
    }
  };

  // ---- the camera: turn (drag), zoom (wheel, pinch), pan (right-drag, two fingers)
  let pan: [number, number] = [state.px, state.py];
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch0 = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (pointers.size === 1 && !(e.buttons & 2)) {
      state.yaw -= dx * 0.006;
      state.pitch = Math.min(1.45, Math.max(0.12, state.pitch + dy * 0.005));
    } else {
      // pan in the ground plane, scaled by the view's size
      const k = (dist * state.zoom) / canvas.clientHeight / (pointers.size === 2 ? 2 : 1);
      const c = Math.cos(state.yaw);
      const s = Math.sin(state.yaw);
      pan[0] += (-dx * c + dy * s) * k * 0.9;
      pan[1] += (-dx * s - dy * c) * k * 0.9;
      state.px = pan[0];
      state.py = pan[1];
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0 > 0) state.zoom = Math.min(4, Math.max(0.15, state.zoom * (pinch0 / d)));
      pinch0 = d;
    }
  });
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinch0 = 0;
    writeUrl();
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.zoom = Math.min(4, Math.max(0.15, state.zoom * Math.exp(e.deltaY * 0.001)));
  }, { passive: false });

  ui.onChange = (k) => {
    if (k === 'view') {
      pan = [0, 0];
      state.px = state.py = 0;
      state.zoom = 1;
      showView();
    } else if (k === 'tod') {
      /* per frame */
    } else if (k === 'overlay') {
      r.showLines = state.tiles || state.nav;
      if (plan) r.setLines(lines(plan));
    } else rebuild();
    writeUrl();
  };
  rebuild();

  const frame = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, phone ? 2 : 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const D = dist * state.zoom;
    const at = [focusAt[0] + pan[0], focusAt[1] + pan[1], focusAt[2]];
    const eye: [number, number, number] = [at[0] + Math.cos(state.yaw) * Math.cos(state.pitch) * D, at[1] + Math.sin(state.yaw) * Math.cos(state.pitch) * D, at[2] + Math.sin(state.pitch) * D];
    const vp = mul(perspective((32 * Math.PI) / 180, w / h, Math.max(0.5, D * 0.02), D * 8 + 500), lookAt(eye, at, [0, 0, 1]));
    r.frame({ viewProj: vp, eye, centre: [at[0], at[1], at[2]], reach, fog: 900 + D * 2, ...sky(state.tod) }, w, h);
    // (a GPU error stops the loop: one message, not a flood)
    if (!document.querySelector('.fatal')) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (window as unknown as { structures: unknown }).structures = { state, plan: () => plan, stats: () => ({ ...r.sg.stats, ...plan?.stats }), rebuild, gpuMs: () => r.gpuMs.slice(), adapter: `${adapter.info?.vendor ?? ''} ${adapter.info?.architecture ?? ''} ${adapter.info?.description ?? ''}`.trim() };
  document.body.dataset.ready = '1';

  function writeUrl() {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) p.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? String(+v.toFixed(3)) : String(v));
    history.replaceState(null, '', `?${p}`);
  }
}

/** sun, sky and night from the time of day (0 morning … 0.5 afternoon … 0.8 dusk … 1 night) */
function sky(t: number): Pick<FrameView, 'sun' | 'night' | 'sunCol' | 'skyCol'> {
  const el = (1 - t) * 0.95 - 0.12;
  const az = 3.6 + t * 1.6;
  const sun: [number, number, number] = [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)];
  const se = Math.sin(el);
  const day = Math.min(1, Math.max(0, (se + 0.05) / 0.35));
  const low = 1 - Math.min(1, Math.max(0, se / 0.45));
  const sunCol: [number, number, number] = [2.7 * day, (2.45 - 0.9 * low) * day, (2.2 - 1.4 * low) * day];
  const dayCol = [0.32, 0.4, 0.55];
  const dusk = [0.36, 0.26, 0.28];
  const nightCol = [0.035, 0.05, 0.09];
  const mixc = (a: number[], b: number[], k: number) => a.map((x, i) => x + (b[i] - x) * k);
  const skyCol = mixc(mixc(dayCol, dusk, low), nightCol, 1 - day) as [number, number, number];
  // (the sun below the horizon: a moon's cool light from the same side, weak)
  if (se < 0) {
    sun[2] = Math.max(0.35, -sun[2]);
    sunCol[0] = 0.12;
    sunCol[1] = 0.16;
    sunCol[2] = 0.26;
  }
  return { sun, night: Math.min(1, Math.max(0, (0.22 - se) / 0.3)), sunCol, skyCol };
}

function centroid(p: CityPlan, quads: number[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const qq of quads) {
    const c = quadCentre(p.tiles, qq);
    x += c[0];
    y += c[1];
  }
  return [x / quads.length, y / quads.length];
}

function filter(p: StructurePieces, keep: (i: number) => boolean): StructurePieces {
  const ids: number[] = [];
  for (let i = 0; i < p.count; i++) if (keep(i)) ids.push(i);
  const data = new Float32Array(ids.length * PIECE_FLOATS);
  ids.forEach((s, d) => data.set(p.data.subarray(s * PIECE_FLOATS, (s + 1) * PIECE_FLOATS), d * PIECE_FLOATS));
  return { module: Uint16Array.from(ids, (i) => p.module[i]), data, building: Int32Array.from(ids, (i) => p.building[i]), count: ids.length };
}

/** overlay lines: tile outlines (lots white, streets yellow, walls red) and nav links (by kind) */
function lines(p: CityPlan): Float32Array {
  const out: number[] = [];
  const t = p.tiles;
  if (state.tiles)
    for (let qq = 0; qq < t.use.length; qq++) {
      const c = quadCorners(t, qq);
      const u = t.use[qq];
      const col = u === 'street' || u === 'plaza' ? 1 : u === 'wall' || u === 'gate' ? 3 : u === 'yard' ? 4 : 0;
      for (let k = 0; k < 4; k++) {
        const a = c[k];
        const b = c[(k + 1) % 4];
        const za = p.ground[t.quads[qq * 4 + k]] + 0.45;
        const zb = p.ground[t.quads[qq * 4 + ((k + 1) % 4)]] + 0.45;
        out.push(a[0], a[1], za, col, b[0], b[1], zb, col);
      }
    }
  if (state.nav) {
    const colOf: Record<string, number> = { walk: 2, door: 4, stairs: 1, lift: 5, gate: 3, ramp: 1, ladder: 1 };
    for (const l of p.nav.links) {
      const a = p.nav.nodes[l.a].at;
      const b = p.nav.nodes[l.b].at;
      out.push(a[0], a[1], a[2] + 0.3, colOf[l.kind] ?? 0, b[0], b[1], b[2] + 0.3, colOf[l.kind] ?? 0);
    }
  }
  return new Float32Array(out);
}

// ---- the panel

function panel() {
  const el = document.getElementById('panel')!;
  const api = { stats: document.createElement('div'), onChange: (_k: string) => {} };
  const row = (label: string, ...kids: HTMLElement[]) => {
    const d = document.createElement('label');
    d.className = 'row';
    const s = document.createElement('span');
    s.textContent = label;
    d.append(s, ...kids);
    el.append(d);
  };
  const select = (k: 'system' | 'style' | 'ground', opts: string[]) => {
    const s = document.createElement('select');
    for (const o of opts) s.append(new Option(o, o, false, state[k] === o));
    s.onchange = () => {
      (state as Record<string, unknown>)[k] = s.value;
      api.onChange(k);
    };
    return s;
  };
  const slider = (k: 'r' | 'storeys' | 'density' | 'tod' | 'roads', lo: number, hi: number, step: number, live = false) => {
    const s = document.createElement('input');
    s.type = 'range';
    s.min = String(lo);
    s.max = String(hi);
    s.step = String(step);
    s.value = String(state[k]);
    const f = () => {
      state[k] = Number(s.value);
      api.onChange(k);
    };
    if (live) s.oninput = f;
    else s.onchange = f;
    return s;
  };
  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = 'Structures';
  const fold = document.createElement('button');
  fold.textContent = '–';
  fold.onclick = () => {
    el.classList.toggle('folded');
    fold.textContent = el.classList.contains('folded') ? '+' : '–';
  };
  head.append(fold);
  el.append(head);
  row('tiles', select('system', ['irregular', 'contour-voronoi', 'radial', 'orthogonal']));
  row('style', select('style', STYLE_IDS));
  const seed = document.createElement('input');
  seed.type = 'number';
  seed.value = String(state.seed);
  seed.onchange = () => {
    state.seed = Number(seed.value) | 0;
    api.onChange('seed');
  };
  const dice = document.createElement('button');
  dice.textContent = 'new';
  dice.onclick = () => {
    state.seed = Math.floor(Math.random() * 99999);
    seed.value = String(state.seed);
    api.onChange('seed');
  };
  row('seed', seed, dice);
  row('size', slider('r', 16, 160, 4));
  row('storeys', slider('storeys', 0, 9, 1));
  row('density', slider('density', 0.2, 1, 0.05));
  row('ground', select('ground', ['flat', 'hill', 'slope', 'gorge']));
  row('roads', slider('roads', 0, 6, 1));
  row('time', slider('tod', 0, 1, 0.01, true));
  const views = document.createElement('div');
  views.className = 'views';
  for (const v of ['building', 'district', 'city'] as const) {
    const b = document.createElement('button');
    b.textContent = v;
    b.className = state.view === v ? 'on' : '';
    b.onclick = () => {
      state.view = v;
      for (const x of views.children) x.className = x === b ? 'on' : '';
      api.onChange('view');
    };
    views.append(b);
  }
  el.append(views);
  const ov = document.createElement('div');
  ov.className = 'views';
  for (const k of ['walls', 'tiles', 'nav'] as const) {
    const b = document.createElement('button');
    b.textContent = k;
    b.className = state[k] ? 'on' : '';
    b.onclick = () => {
      state[k] = !state[k];
      b.className = state[k] ? 'on' : '';
      api.onChange(k === 'walls' ? 'walls' : 'overlay');
    };
    ov.append(b);
  }
  el.append(ov);
  api.stats.className = 'stats';
  el.append(api.stats);
  return api;
}

function fatal(msg: string): void {
  const d = document.createElement('div');
  d.className = 'fatal';
  d.textContent = msg;
  document.body.append(d);
}

boot().catch((e) => fatal(e instanceof UnsupportedError ? e.message : `structures viewer: ${e?.stack ?? e}`));
