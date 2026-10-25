// The atlas viewer (round 67): `?atlas=view` (and `?a.<param>=` for the
// atlas's parameters). Draws the world's ground per pixel from the macro maps
// (atlas/view.wgsl: the same ground the streamer's columns are made of), from
// the whole torus down to single cells. Drag to pan, wheel to zoom, 1–8 for
// the modes; double-click walks into the world there (?level=atlas&at=x,y).

import { Atlas, atlasParamsFrom, type AtlasParams } from '../atlas/atlas';
import { EDGE, KIND_IDS, KINDS } from '../atlas/regions';
import { TIER_NAMES } from '../atlas/landforms';
import { CROSS, CROSS_NAMES, SETTING_NAMES, SITE_NAMES } from '../atlas/sites';
import viewW from '../atlas/view.wgsl?raw';
import columnsW from '../atlas/columns.wgsl?raw';
import { makeBindGroup, makeLayout, makeModule } from '../gpu/pipeline';
import { cellAt } from '../world/lattice';
import type { Host, Scene } from './world-core';

const landformLine = (a: Atlas, id: number) => {
  const f = a.landforms[id];
  return f ? `${id}: ${TIER_NAMES[f.tier]}, level ${f.level.toFixed(0)}${f.peak ? `, peak ${f.peak.toFixed(0)} over ${f.rise.toFixed(0)}` : ''}, ${f.regions} regions` : 'none (water)';
};
const crossCounts = (a: Atlas) => {
  const k = CROSS_NAMES.map(() => 0);
  for (const r of a.settlement.roads) for (const c of r.crossings) k[c.kind]++;
  return CROSS_NAMES.map((n, i) => `${k[i]} ${n}`).join(', ');
};
const siteNear = (a: Atlas, x: number, y: number, r: number) => {
  const s = a.settlement.sites.find((s) => Math.hypot(s.x - x, s.y - y) < r);
  return s ? `
site: a ${SITE_NAMES[s.size]}, ${SETTING_NAMES[s.setting]}, ground ${s.h.toFixed(0)}` : '';
};
const CROSS_COLOUR = ['#5c5', '#ec3', '#e33', '#111', '#39f'];
const MODES = ['ground', 'regions', 'kinds', 'borders', 'coast', 'climate', 'pattern', 'caves', 'landforms'];

/** the sliders: key, label, min, max, step */
const SLIDERS: [keyof AtlasParams, string, number, number, number][] = [
  ['seed', 'seed', 1, 999, 1],
  ['style', 'style (earth, strange, flesh)', 0, 2, 1],
  ['landThresh', 'land (higher: less)', -0.3, 0.4, 0.01],
  ['landPer', 'continents (more, smaller)', 1, 10, 1],
  ['cellsPer', 'regions a turn', 20, 240, 4],
  ['jitter', 'region jitter', 0, 1, 0.05],
  ['faultPer', 'faults (more)', 1, 16, 1],
  ['faultHi', 'fault strip width', 0, 0.12, 0.005],
  ['warp', 'warp', 0, 0.2, 0.005],
  ['lift', 'continental lift', 0, 120, 1],
  ['liftReach', 'continental slope reach', 200, 6000, 100],
  ['formPer', 'landforms a turn (fewer: bigger)', 1, 12, 1],
  ['detail', 'region detail', 0, 1, 0.05],
  ['craters', 'impact craters', 0, 64, 1],
  ['warpCell', 'border wiggle', 0, 20, 1],
];

export class AtlasView implements Scene {
  private pipeline: GPURenderPipeline;
  private group: GPUBindGroup;
  private panel: HTMLDivElement;
  private info: HTMLDivElement;
  private mode = 0;
  /** the world point at the screen's centre, and world units a render pixel */
  private vc: [number, number];
  private scale: number;
  private size = { rw: 1, rh: 1, cw: 1, ch: 1 };
  private drag: { x: number; y: number } | null = null;
  private listeners: [EventTarget, string, EventListener][] = [];
  /** the sites, roads and crossings drawn over the map (round 78; O toggles) */
  private overlay: HTMLCanvasElement;
  private showOverlay = true;

  private constructor(
    private host: Host,
    readonly atlas: Atlas,
    pipe: { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout },
  ) {
    const dev = host.gpu.device;
    this.pipeline = pipe.pipeline;
    this.group = makeBindGroup(dev, 'atlas view', pipe.layout, { 0: atlas.paramBuf, 20: atlas.region, 21: atlas.dist, 22: atlas.regs, 23: atlas.pat, 24: atlas.kcol, 25: atlas.riverBuf, 26: atlas.coarse.cells });
    this.vc = [atlas.worldW / 2, atlas.worldH / 2];
    this.scale = 1;
    const mode = Number(host.params.get('mode') ?? 0);
    this.mode = MODES.includes(host.params.get('mode') ?? '') ? MODES.indexOf(host.params.get('mode')!) : mode;
    const at = host.params.get('view');
    this.overlay = document.createElement('canvas');
    this.overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
    host.ui.appendChild(this.overlay);
    this.showOverlay = host.params.get('overlay') !== '0';
    this.panel = this.makePanel();
    this.info = this.panel.querySelector('.atlas-info') as HTMLDivElement;
    if (at) {
      // ?view=x,y,unitsPerPixel
      const [x, y, s] = at.split(',').map(Number);
      this.vc = [x, y];
      this.scale = s;
    } else this.scale = -1;
    this.listen();
    (window as unknown as { reclaimed: unknown }).reclaimed = { atlas, view: this };
  }

  static async create(host: Host): Promise<AtlasView> {
    const p = atlasParamsFrom(host.params);
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'Making the world…';
    host.ui.appendChild(note);
    try {
      const dev = host.gpu.device;
      const atlas = await Atlas.build(dev, p);
      const layout = makeLayout(dev, 'atlas view', { 0: 'uniform', 20: 'read', 21: 'read', 22: 'read', 23: 'read', 24: 'read', 25: 'read', 26: 'read' }, GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX);
      const module = makeModule(dev, 'atlas view', atlas.parts(columnsW, viewW));
      const t0 = performance.now();
      const pipeline = await dev.createRenderPipelineAsync({
        label: 'atlas view',
        layout: dev.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: host.gpu.format }] },
        primitive: { topology: 'triangle-list' },
      });
      atlas.timings['compile view'] = +(performance.now() - t0).toFixed(1);
      return new AtlasView(host, atlas, { pipeline, layout });
    } finally {
      note.remove();
    }
  }

  private makePanel(): HTMLDivElement {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:8px;top:8px;width:270px;max-height:calc(100% - 16px);overflow:auto;background:rgba(20,22,24,0.86);color:#e8e2d4;font:12px/1.35 system-ui,sans-serif;padding:10px;border-radius:6px;';
    const p = this.atlas.p;
    const modes = MODES.map((m, i) => `<button data-mode="${i}" style="margin:1px;padding:2px 5px">${i + 1} ${m}</button>`).join('');
    const sliders = SLIDERS.map(([k, label, lo, hi, st]) => `<label style="display:block;margin-top:4px">${label}: <b data-v="${k}">${p[k]}</b><input data-k="${k}" type="range" min="${lo}" max="${hi}" step="${st}" value="${p[k]}" style="width:100%"></label>`).join('');
    const legend = KIND_IDS.map((k) => {
      const c = KINDS[k].colour.map((v) => Math.round(v * 255)).join(',');
      return `<span style="display:inline-block;margin:1px 4px 1px 0"><i style="display:inline-block;width:9px;height:9px;background:rgb(${c});margin-right:3px"></i>${k}</span>`;
    }).join('');
    d.innerHTML = `<div style="font-size:14px;margin-bottom:4px">Atlas</div><div>${modes}</div>${sliders}<button data-rebuild style="margin-top:6px">Make this world</button><div class="atlas-info" style="margin-top:8px;white-space:pre-wrap"></div><div style="margin-top:6px">${legend}</div><div style="margin-top:6px;color:#aaa">Drag to pan, wheel to zoom, 1–9 modes, O the sites and roads (crossings: ramp green, switchbacks yellow, lift red, tunnel black, bridge blue), double-click to walk in; shift-click a meteor, alt-click an eruption.</div>`;
    d.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => (b.onclick = () => (this.mode = Number(b.dataset.mode))));
    d.querySelectorAll<HTMLInputElement>('[data-k]').forEach((inp) => (inp.oninput = () => (d.querySelector(`[data-v="${inp.dataset.k}"]`)!.textContent = inp.value)));
    (d.querySelector('[data-rebuild]') as HTMLButtonElement).onclick = () => {
      const q = new URLSearchParams(location.search);
      d.querySelectorAll<HTMLInputElement>('[data-k]').forEach((inp) => {
        const k = inp.dataset.k!;
        if (k === 'faultHi') {
          q.set('a.faultHi', inp.value);
          q.set('a.faultLo', String(-Number(inp.value)));
        } else q.set(`a.${k}`, inp.value);
      });
      q.set('mode', MODES[this.mode]);
      location.search = q.toString();
    };
    this.host.ui.appendChild(d);
    return d;
  }

  private on(t: EventTarget, ev: string, f: EventListener): void {
    t.addEventListener(ev, f, { passive: false } as AddEventListenerOptions);
    this.listeners.push([t, ev, f]);
  }

  /** a CSS pixel on the canvas → the world point there */
  private worldAt(cx: number, cy: number): [number, number] {
    const { rw, rh, cw, ch } = this.size;
    const sx = (cx / cw) * rw;
    const sy = (cy / ch) * rh;
    return [this.vc[0] + (sx - rw / 2) * this.scale, this.vc[1] + (sy - rh / 2) * this.scale];
  }

  private listen(): void {
    const c = this.host.canvas;
    this.on(c, 'pointerdown', (e) => {
      const p = e as PointerEvent;
      // (round 71) shift-click: a great meteor there; alt-click: an eruption
      if (p.shiftKey || p.altKey) {
        const [x, y] = this.wrap(this.worldAt(p.clientX, p.clientY));
        if (p.shiftKey) this.atlas.coarse.meteor(x, y);
        else this.atlas.coarse.erupt(x, y);
        return;
      }
      this.drag = { x: p.clientX, y: p.clientY };
    });
    this.on(window, 'pointerup', () => (this.drag = null));
    this.on(window, 'pointermove', (e) => {
      const p = e as PointerEvent;
      if (this.drag) {
        const k = (this.size.rw / this.size.cw) * this.scale;
        this.vc[0] -= (p.clientX - this.drag.x) * k;
        this.vc[1] -= (p.clientY - this.drag.y) * k;
        this.drag = { x: p.clientX, y: p.clientY };
      }
      this.hover(p.clientX, p.clientY);
    });
    this.on(c, 'wheel', (e) => {
      const w = e as WheelEvent;
      w.preventDefault();
      const before = this.worldAt(w.clientX, w.clientY);
      this.scale *= Math.exp(w.deltaY * 0.0015);
      this.scale = Math.min(Math.max(this.scale, 0.05), this.atlas.worldW / 200);
      const after = this.worldAt(w.clientX, w.clientY);
      this.vc[0] += before[0] - after[0];
      this.vc[1] += before[1] - after[1];
    });
    this.on(c, 'dblclick', (e) => {
      const m = e as MouseEvent;
      const [x, y] = this.wrap(this.worldAt(m.clientX, m.clientY));
      const [cx, cy] = cellAt(x, y);
      const q = new URLSearchParams(location.search);
      q.delete('atlas');
      q.delete('view');
      q.delete('mode');
      q.set('skipmenu', '1');
      q.set('level', 'atlas');
      q.set('at', `${cx},${cy}`);
      location.search = q.toString();
    });
    this.on(window, 'keydown', (e) => {
      const k = Number((e as KeyboardEvent).key);
      if (k >= 1 && k <= MODES.length) this.mode = k - 1;
      if ((e as KeyboardEvent).key === 'o') this.showOverlay = !this.showOverlay;
    });
  }

  private wrap([x, y]: [number, number]): [number, number] {
    const W = this.atlas.worldW;
    const H = this.atlas.worldH;
    return [((x % W) + W) % W, ((y % H) + H) % H];
  }

  private hover(cx: number, cy: number): void {
    const a = this.atlas;
    const [x, y] = this.wrap(this.worldAt(cx, cy));
    const d = a.regionAt(x, y);
    const n = a.p.n;
    const t = Math.floor((y / a.worldH) * n) * n + Math.floor((x / a.worldW) * n);
    const edge = Object.keys(EDGE)[d.words[12]];
    const coast = Object.keys(EDGE)[d.words[16]];
    const s = a.stats;
    const tm = Object.entries(a.timings)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    this.info.textContent =
      `${s.continents} continents, ${s.islands} islands, ${s.waters} waters; ${s.regions} regions (${s.merged} merged)\n` +
      `cc iterations ${s.ccIters.join(' / ')}\nms: ${tm}\n\n` +
      `at ${x.toFixed(0)}, ${y.toFixed(0)}: ${d.kind}${d.stat.fault ? ' (fault strip)' : ''}\n` +
      `ground ${a.hmac[t]?.toFixed(1)} (sea ${a.p.sea}); border ${edge}, coast ${coast}\n` +
      `pattern ${d.words[1]}, area ${d.stat.area} texels, mode ${MODES[this.mode]}\n` +
      `landform ${landformLine(a, d.words[48])}
` +
      `${a.settlement.sites.length} sites, ${a.settlement.roads.length} roads (${a.settlement.ms} ms), crossings: ${crossCounts(a)}` +
      siteNear(a, x, y, 12 * Math.max(this.scale, 1));
  }

  frame(): void {
    const a = this.atlas;
    // the coarse world goes on (round 71): a few steps a frame, to watch it at the world's scale
    a.coarse.step(4);
    const { rw, rh } = this.size;
    if (this.scale < 0) this.scale = Math.max(a.worldW / rw, a.worldH / rh);
    a.writeParams({ vc: this.vc, vscale: this.scale, mode: this.mode, vsize: [rw, rh] });
    const dev = this.host.gpu.device;
    const enc = dev.createCommandEncoder({ label: 'atlas view' });
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: this.host.gpu.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    rp.setPipeline(this.pipeline);
    rp.setBindGroup(0, this.group);
    rp.draw(3);
    rp.end();
    dev.queue.submit([enc.finish()]);
    this.drawOverlay();
  }

  /** the sites, roads and their crossings (round 78), each drawn at its copy nearest the view's middle */
  private drawOverlay(): void {
    const o = this.overlay;
    const { rw, rh, cw, ch } = this.size;
    if (o.width !== Math.round(cw) || o.height !== Math.round(ch)) {
      o.width = Math.round(cw);
      o.height = Math.round(ch);
    }
    const g = o.getContext('2d')!;
    g.clearRect(0, 0, o.width, o.height);
    if (!this.showOverlay) return;
    const a = this.atlas;
    const W = a.worldW;
    const H = a.worldH;
    const k = cw / rw / this.scale;
    // (a world point → CSS pixels, its copy nearest the view's middle; dx, dy keep a road's points together)
    const near = (x: number, y: number): [number, number] => [x - Math.round((x - this.vc[0]) / W) * W, y - Math.round((y - this.vc[1]) / H) * H];
    const sx = (x: number) => (x - this.vc[0]) * k + cw / 2;
    const sy = (y: number) => (y - this.vc[1]) * k * (rh / rw) * (cw / ch) + ch / 2;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const r of a.settlement.roads) {
      const p = r.path;
      const [x0, y0] = near(p[0], p[1]);
      const dx = x0 - p[0];
      const dy = y0 - p[1];
      g.strokeStyle = 'rgba(70,45,25,0.85)';
      g.lineWidth = Math.max(1.2, Math.min(3, 30 * k));
      g.beginPath();
      for (let i = 0; i < p.length; i += 2) {
        const X = sx(p[i] + dx);
        const Y = sy(p[i + 1] + dy);
        if (i) g.lineTo(X, Y);
        else g.moveTo(X, Y);
      }
      g.stroke();
      for (const c of r.crossings) {
        g.strokeStyle = CROSS_COLOUR[c.kind];
        g.lineWidth = Math.max(3, Math.min(7, 60 * k));
        g.beginPath();
        g.moveTo(sx(c.x0 + dx), sy(c.y0 + dy));
        g.lineTo(sx(c.x1 + dx), sy(c.y1 + dy));
        g.stroke();
        if (c.kind === CROSS.lift) {
          g.fillStyle = CROSS_COLOUR[c.kind];
          g.fillRect(sx((c.x0 + c.x1) / 2 + dx) - 3, sy((c.y0 + c.y1) / 2 + dy) - 3, 6, 6);
        }
      }
    }
    for (const s of a.settlement.sites) {
      const [x, y] = near(s.x, s.y);
      const rad = 2.5 + s.size * 1.6;
      g.fillStyle = ['#fff', '#fde7a8', '#ffb347', '#ff5a36'][s.size];
      g.strokeStyle = '#222';
      g.lineWidth = 1.2;
      g.beginPath();
      if (s.setting === 0) {
        // (cliffside: a diamond)
        g.moveTo(sx(x), sy(y) - rad * 1.3);
        g.lineTo(sx(x) + rad * 1.3, sy(y));
        g.lineTo(sx(x), sy(y) + rad * 1.3);
        g.lineTo(sx(x) - rad * 1.3, sy(y));
        g.closePath();
      } else g.arc(sx(x), sy(y), rad, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }

  resize(rw: number, rh: number, cw: number, ch: number): void {
    this.size = { rw, rh, cw, ch };
  }

  dispose(): void {
    for (const [t, ev, f] of this.listeners) t.removeEventListener(ev, f);
    this.panel.remove();
    this.overlay.remove();
    this.atlas.dispose();
  }
}

