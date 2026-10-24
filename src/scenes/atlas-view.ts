// The atlas viewer (round 67): `?atlas=view` (and `?a.<param>=` for the
// atlas's parameters). Draws the world's ground per pixel from the macro maps
// (atlas/view.wgsl: the same ground the streamer's columns are made of), from
// the whole torus down to single cells. Drag to pan, wheel to zoom, 1–8 for
// the modes; double-click walks into the world there (?level=atlas&at=x,y).

import { Atlas, atlasParamsFrom, type AtlasParams } from '../atlas/atlas';
import { EDGE, KIND_IDS, KINDS } from '../atlas/regions';
import viewW from '../atlas/view.wgsl?raw';
import columnsW from '../atlas/columns.wgsl?raw';
import { makeBindGroup, makeLayout, makeModule } from '../gpu/pipeline';
import { cellAt } from '../world/lattice';
import type { Host, Scene } from './world-core';

const MODES = ['ground', 'regions', 'kinds', 'borders', 'coast', 'climate', 'pattern', 'caves'];

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
  ['lift', 'continental lift', 0, 40, 1],
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

  private constructor(
    private host: Host,
    readonly atlas: Atlas,
    pipe: { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout },
  ) {
    const dev = host.gpu.device;
    this.pipeline = pipe.pipeline;
    this.group = makeBindGroup(dev, 'atlas view', pipe.layout, { 0: atlas.paramBuf, 20: atlas.region, 21: atlas.dist, 22: atlas.regs, 23: atlas.pat, 24: atlas.kcol });
    this.vc = [atlas.worldW / 2, atlas.worldH / 2];
    this.scale = 1;
    const mode = Number(host.params.get('mode') ?? 0);
    this.mode = MODES.includes(host.params.get('mode') ?? '') ? MODES.indexOf(host.params.get('mode')!) : mode;
    const at = host.params.get('view');
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
      const layout = makeLayout(dev, 'atlas view', { 0: 'uniform', 20: 'read', 21: 'read', 22: 'read', 23: 'read', 24: 'read' }, GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX);
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
    d.innerHTML = `<div style="font-size:14px;margin-bottom:4px">Atlas</div><div>${modes}</div>${sliders}<button data-rebuild style="margin-top:6px">Make this world</button><div class="atlas-info" style="margin-top:8px;white-space:pre-wrap"></div><div style="margin-top:6px">${legend}</div><div style="margin-top:6px;color:#aaa">Drag to pan, wheel to zoom, 1–8 modes, double-click to walk in.</div>`;
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
      `pattern ${d.words[1]}, area ${d.stat.area} texels, mode ${MODES[this.mode]}`;
  }

  frame(): void {
    const a = this.atlas;
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
  }

  resize(rw: number, rh: number, cw: number, ch: number): void {
    this.size = { rw, rh, cw, ch };
  }

  dispose(): void {
    for (const [t, ev, f] of this.listeners) t.removeEventListener(ev, f);
    this.panel.remove();
    this.atlas.dispose();
  }
}

