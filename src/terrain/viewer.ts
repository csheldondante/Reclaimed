// Terrain track (round 117): the terrain viewer — `?terrain=view` (the user, round 117 part 4: "If we are making
// generators … just having a way to view that sounds great"). The atlas viewer (scenes/atlas-view.ts: seed and the
// atlas's sliders, its layers 1–9, pan and zoom, double-click to walk in) with the terrain's own over it:
//  - the region graph over the view's middle ("Graph here"): rooms filled by colour, features outlined, borders by
//    their barrier's colour, doors and passes as dots; pick a controller (walker, bike, lich) and tap a room to see what
//    it reaches (the rest dimmed) and its exits;
//  - requests: "2 exits" / "1 exit" for the picked room (ramps, fords, walls drawn as edits; bridges and vegetation
//    as needs);
//  - masks: what the controller can't stand in (deep water, lava, thick vegetation), the vegetation's density;
//  - flood: arm water, sand or magma, tap a basin — it fills to its spill height (a GPU flood fill), drawn at once.
// Phone and PC: everything is a button; taps pick.

import type { Host, Scene } from '../scenes/world-core';
import { AtlasView } from '../scenes/atlas-view';
import { CAPS_PRESETS, type BarrierKind, type BuriedProp, type ExcavationSite, type FloodFluid, type PassCaps } from '../api/contracts/terrain';
import { clearFor, partition, RegionGraph, type TerrainSamples } from './partition';
import { TerrainSystem } from './terrain';
import { cellAt } from '../world/lattice';

const KIND_COLOUR: Record<BarrierKind, string> = {
  open: '#7fdc6a',
  cliff: '#ff9a3c',
  steep: '#d7b25a',
  ravine: '#c0392b',
  ridge: '#a0522d',
  river: '#3fa9f5',
  lake: '#2f6fd6',
  sea: '#1b3f8b',
  lava: '#ff3b1f',
  vegetation: '#1e8a3c',
  tar: '#222',
  hostile: '#d33682',
  storm: '#8e7cc3',
  distance: '#999',
};

export class TerrainView implements Scene {
  private terrain: TerrainSystem;
  private overlay: HTMLCanvasElement;
  private panel: HTMLDivElement;
  private info: HTMLDivElement;
  private graph: RegionGraph | null = null;
  private img: HTMLCanvasElement | null = null;
  private caps: PassCaps = CAPS_PRESETS.walker;
  private picked = -1;
  private reach = new Set<number>();
  private arm: FloodFluid | null = null;
  private show = { rooms: true, borders: true, passes: true, mask: false, veg: false, edits: true, props: true };
  private props: { props: BuriedProp[]; sites: ExcavationSite[] } | null = null;
  private busy = false;
  private needs: { kind: string; at: [number, number] }[] = [];

  private constructor(
    private host: Host,
    readonly view: AtlasView,
  ) {
    this.terrain = new TerrainSystem(view.atlas);
    this.overlay = document.createElement('canvas');
    this.overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
    host.ui.appendChild(this.overlay);
    this.panel = this.makePanel();
    this.info = this.panel.querySelector('.tv-info') as HTMLDivElement;
    view.onPick = (e) => this.pick(e);
    (window as unknown as { reclaimed: Record<string, unknown> }).reclaimed = { atlas: view.atlas, view, terrain: this.terrain, viewer: this };
    if (host.params.get('graph') === '1') void this.makeGraph();
  }

  static async create(host: Host): Promise<TerrainView> {
    return new TerrainView(host, await AtlasView.create(host));
  }

  private makePanel(): HTMLDivElement {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;right:8px;top:8px;width:250px;max-height:calc(100% - 16px);overflow:auto;background:rgba(20,22,24,0.88);color:#e8e2d4;font:12px/1.35 system-ui,sans-serif;padding:10px;border-radius:6px;';
    const btn = (attr: string, label: string) => `<button ${attr} style="margin:2px;padding:4px 7px">${label}</button>`;
    const tog = (k: keyof TerrainView['show'], label: string) => `<label style="margin-right:6px;white-space:nowrap"><input type="checkbox" data-show="${k}" ${this.show[k] ? 'checked' : ''}> ${label}</label>`;
    const legend = (Object.keys(KIND_COLOUR) as BarrierKind[]).map((k) => `<span style="display:inline-block;margin:1px 4px 1px 0"><i style="display:inline-block;width:9px;height:9px;background:${KIND_COLOUR[k]};margin-right:3px"></i>${k}</span>`).join('');
    d.innerHTML =
      `<div style="font-size:14px;margin-bottom:4px"><button data-fold style="padding:2px 8px">▾</button> Terrain <button data-atlas style="padding:2px 6px;font-size:11px">atlas panel</button></div><div data-body>` +
      `<div>${btn('data-graph', 'Graph here')}</div>` +
      `<div style="margin-top:4px">controller: ${(['walker', 'bike', 'lich'] as const).map((k) => btn(`data-caps="${k}"`, k)).join('')}</div>` +
      `<div style="margin-top:4px">picked room: ${btn('data-exits="1"', '1 exit')}${btn('data-exits="2"', '2 exits')}${btn('data-exits="3"', '3 exits')}</div>` +
      `<div style="margin-top:4px">flood (then tap a basin): ${(['water', 'sand', 'magma'] as const).map((k) => btn(`data-flood="${k}"`, k)).join('')}</div>` +
      `<label style="display:block">depth over the tap (0: the basin's spill height) <input data-depth type="number" min="0" max="200" value="0" style="width:56px"></label>` +
      `<div style="margin-top:6px">${tog('rooms', 'rooms')}${tog('borders', 'borders')}${tog('passes', 'passes')}${tog('edits', 'edits')}${tog('mask', "can't stand")}${tog('veg', 'vegetation')}${tog('props', 'buried')}</div>` +
      `<div class="tv-info" style="margin-top:8px;white-space:pre-wrap"></div>` +
      `<div style="margin-top:6px">${legend}</div>` +
      `<div style="margin-top:6px;color:#aaa">Zoom in (a graph covers ≤ 2048 world units), Graph here, tap a room. Double-click walks in.</div></div>`;
    // (a phone: the panel folds — ▾ — and the atlas's own panel hides, so the map shows; both start folded on a narrow screen)
    const body = d.querySelector<HTMLDivElement>('[data-body]')!;
    const fold = d.querySelector<HTMLButtonElement>('[data-fold]')!;
    const setFold = (f: boolean) => {
      body.style.display = f ? 'none' : '';
      fold.textContent = f ? '▸' : '▾';
    };
    fold.onclick = () => setFold(body.style.display !== 'none');
    const atlasPanel = () => this.host.ui.querySelector<HTMLDivElement>('.atlas-info')?.parentElement ?? null;
    d.querySelector<HTMLButtonElement>('[data-atlas]')!.onclick = () => {
      const p = atlasPanel();
      if (p) p.style.display = p.style.display === 'none' ? '' : 'none';
    };
    if (typeof innerWidth !== 'undefined' && innerWidth < 640) {
      setFold(true);
      queueMicrotask(() => {
        const p = atlasPanel();
        if (p) p.style.display = 'none';
      });
    }
    d.querySelector<HTMLButtonElement>('[data-graph]')!.onclick = () => void this.makeGraph();
    d.querySelectorAll<HTMLButtonElement>('[data-caps]').forEach((b) => (b.onclick = () => this.setCaps(CAPS_PRESETS[b.dataset.caps as 'walker'])));
    d.querySelectorAll<HTMLButtonElement>('[data-exits]').forEach((b) => (b.onclick = () => this.exits(Number(b.dataset.exits))));
    d.querySelectorAll<HTMLButtonElement>('[data-flood]').forEach((b) => (b.onclick = () => this.armFlood(b.dataset.flood as FloodFluid)));
    d.querySelectorAll<HTMLInputElement>('[data-show]').forEach((c) => (c.onchange = () => ((this.show[c.dataset.show as keyof TerrainView['show']] = c.checked), this.paintImage())));
    this.host.ui.appendChild(d);
    return d;
  }

  private say(t: string): void {
    this.info.textContent = t;
  }

  private setCaps(c: PassCaps): void {
    this.caps = c;
    this.pickRoom(this.picked);
    this.paintImage();
  }

  private armFlood(f: FloodFluid): void {
    this.arm = this.arm === f ? null : f;
    this.say(this.arm ? `tap a basin to flood it with ${this.arm}` : '');
  }

  /** a tap on the map: a flood if armed, else a room picked (true: taken from the atlas view) */
  private pick(e: PointerEvent): boolean {
    if (e.shiftKey || e.altKey) return false;
    const [x, y] = this.view.worldAt(e.clientX, e.clientY);
    if (this.arm) {
      const fluid = this.arm;
      this.arm = null;
      void this.flood(x, y, fluid);
      return true;
    }
    if (this.graph) {
      const r = this.graph.roomAt([x, y]);
      if (r >= 0) {
        this.pickRoom(r);
        this.paintImage();
      }
    }
    return false;
  }

  async flood(x: number, y: number, fluid: FloodFluid) {
    if (this.busy) return null;
    this.busy = true;
    try {
      // (a depth over the tapped ground: a level of its own — a new shallow sea, a valley buried; 0: the basin's spill)
      const depth = Number(this.panel.querySelector<HTMLInputElement>('[data-depth]')?.value ?? 0);
      const a = this.view.atlas;
      const n = a.p.n;
      const W = a.worldW;
      const H = a.worldH;
      const t = Math.floor((((y % H) + H) % H / H) * n) * n + Math.floor((((x % W) + W) % W / W) * n);
      const r = await this.terrain.flood({ at: [x, y], fluid, level: depth > 0 ? a.hmac[t] + depth : undefined });
      if (!r.area) {
        this.say(`no basin there: water poured at ${x.toFixed(0)}, ${y.toFixed(0)} runs away (its ground ${a.hmac[t].toFixed(1)} is its own spill height) — tap a hollow, or give a depth`);
        return r;
      }
      this.say(`flooded with ${fluid}: level ${r.level}, ${(r.area / 1e6).toFixed(3)} M world units², ${r.depth} deep, spill at ${r.spill?.map((v) => v.toFixed(0)).join(', ') ?? 'none'} (${r.ms} ms)`);
      return r;
    } finally {
      this.busy = false;
    }
  }

  private pickRoom(r: number): void {
    this.picked = r;
    const g = this.graph;
    if (!g || r < 0) return;
    this.reach = new Set(g.reach(r, this.caps));
    const R = g.region(r);
    const ex = g.exits(r, this.caps);
    const lines = g.borders(r).map((b) => {
      const c = g.cost(b.id, this.caps, r);
      return `  → ${b.a === r ? b.b : b.a}: ${b.kind}${b.causes.length > 1 ? ` (${b.causes.slice(1, 3).join(', ')})` : ''}, ${c === Infinity ? 'no way' : `cost ${c.toFixed(0)}`}; rise ${b.measure.rise}, climb ${b.measure.minClimb}, deep ${b.measure.minDeep}`;
    });
    this.say(`room ${r} (${R.screens} screens, floor ${R.floor.map((v) => v.toFixed(0)).join('/')}, open ${R.openness.toFixed(0)})\n${this.caps.id}: ${ex.length} exits, reaches ${this.reach.size} rooms\n${lines.join('\n')}`);
  }

  private exits(n: number): void {
    const g = this.graph;
    if (!g || this.picked < 0) return this.say('make a graph and tap a room first');
    const r = this.terrain.request(g, { kind: 'exits', room: this.picked, count: n, caps: this.caps });
    for (const k of r.needs) this.needs.push({ kind: k.kind, at: k.at });
    this.pickRoom(this.picked);
    this.say(`${r.ok ? 'done' : `not quite: ${r.reason}`}: ${r.edits.map((e) => e.kind).join(', ') || 'no edits'}${r.needs.length ? `; needs ${r.needs.map((k) => k.kind).join(', ')}` : ''}\n` + this.info.textContent);
  }

  /** the region graph over the view's middle (≤ 2048 world units a side, ≤ 512 samples) */
  async makeGraph(): Promise<RegionGraph | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const { vc, scale, size } = this.view.viewport();
      const span = Math.min(2048, Math.max(256, Math.max(size.rw, size.rh) * scale));
      const step = Math.max(4, Math.ceil(span / 512));
      const t0 = performance.now();
      const S = await this.terrain.sample(vc[0] - span / 2, vc[1] - span / 2, Math.round(span / step), Math.round(span / step), step);
      const t1 = performance.now();
      this.graph = new RegionGraph(partition(S, { caps: CAPS_PRESETS.walker }));
      const t2 = performance.now();
      this.samples = S;
      this.picked = -1;
      this.reach.clear();
      const g = this.graph;
      const kinds = new Map<string, number>();
      for (const b of g.borders()) kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1);
      this.props = await this.terrain.buried({ x0: S.x0, y0: S.y0, x1: S.x0 + S.w * S.step, y1: S.y0 + S.h * S.step });
      this.say(`${this.props.props.length} buried props, ${this.props.sites.length} excavation sites; ${g.features().length} features, ${g.rooms().length} rooms, ${g.borders().length} borders (${[...kinds].map(([k, v]) => `${v} ${k}`).join(', ')})\nsampled ${S.w}×${S.h} at ${step} in ${(t1 - t0).toFixed(0)} ms, partitioned in ${(t2 - t1).toFixed(0)} ms`);
      this.paintImage();
      return g;
    } finally {
      this.busy = false;
    }
  }

  private samples: TerrainSamples | null = null;

  /** the graph's per-sample picture (rooms, masks), drawn into the view's frame each frame */
  private paintImage(): void {
    const g = this.graph;
    const S = this.samples;
    if (!g || !S) return;
    const c = (this.img ??= document.createElement('canvas'));
    c.width = S.w;
    c.height = S.h;
    const x = c.getContext('2d')!;
    const im = x.createImageData(S.w, S.h);
    const nFeat = g.features().length;
    const col = new Map<number, [number, number, number]>();
    const rgb = (id: number) => {
      let v = col.get(id);
      if (!v) {
        const h = (id * 137.508) % 360;
        const f = (n: number) => {
          const k = (n + h / 30) % 12;
          return Math.round(255 * (0.55 - 0.65 * 0.45 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
        };
        col.set(id, (v = [f(0), f(8), f(4)]));
      }
      return v;
    };
    for (let i = 0; i < S.w * S.h; i++) {
      const o = i * 4;
      const r = g.built.room[i];
      let a = 0;
      if (this.show.rooms && r >= 0) {
        const [R, G, B] = rgb(nFeat + r);
        const dim = this.picked >= 0 && !this.reach.has(nFeat + r);
        im.data[o] = R;
        im.data[o + 1] = G;
        im.data[o + 2] = B;
        a = dim ? 40 : nFeat + r === this.picked ? 170 : 95;
      }
      if (this.show.mask && !clearFor(S, i, this.caps)) {
        im.data[o] = 255;
        im.data[o + 1] = 30;
        im.data[o + 2] = 30;
        a = 150;
      }
      if (this.show.veg && S.veg[i] > 0) {
        im.data[o] = 20;
        im.data[o + 1] = 120;
        im.data[o + 2] = 40;
        a = Math.max(a, Math.round(200 * S.veg[i]));
      }
      im.data[o + 3] = a;
    }
    x.putImageData(im, 0, 0);
  }

  frame(): void {
    this.view.frame();
    this.drawOverlay();
  }

  private drawOverlay(): void {
    const o = this.overlay;
    const { vc, scale, size } = this.view.viewport();
    const { rw, rh, cw, ch } = size;
    if (o.width !== Math.round(cw) || o.height !== Math.round(ch)) {
      o.width = Math.round(cw);
      o.height = Math.round(ch);
    }
    const c = o.getContext('2d')!;
    c.clearRect(0, 0, o.width, o.height);
    const g = this.graph;
    const S = this.samples;
    if (!g || !S) return;
    const k = cw / rw / scale;
    const ky = k * (rh / rw) * (cw / ch);
    const sx = (x: number) => (x - vc[0]) * k + cw / 2;
    const sy = (y: number) => (y - vc[1]) * ky + ch / 2;
    if (this.img) {
      c.imageSmoothingEnabled = false;
      c.drawImage(this.img, sx(S.x0 - S.step / 2), sy(S.y0 - S.step / 2), S.w * S.step * k, S.h * S.step * ky);
    }
    if (this.show.borders) {
      c.lineWidth = Math.max(1.5, Math.min(4, S.step * k * 0.8));
      for (const B of g.borders()) {
        if (B.kind === 'open' && !this.show.passes) continue;
        c.strokeStyle = KIND_COLOUR[B.kind];
        const P = g.built.pairs[B.id];
        c.beginPath();
        for (let q = 0; q < P.length; q += 2) {
          const a = g.at(P[q]);
          const b = g.at(P[q + 1]);
          const mx = (a[0] + b[0]) / 2;
          const my = (a[1] + b[1]) / 2;
          // (a short tick across the pair: the border's line, drawn as its samples meet)
          const tx = (b[1] - a[1]) / 2;
          const ty = (a[0] - b[0]) / 2;
          c.moveTo(sx(mx - tx), sy(my - ty));
          c.lineTo(sx(mx + tx), sy(my + ty));
        }
        c.stroke();
      }
    }
    if (this.show.passes) {
      for (const B of g.borders())
        for (const pid of B.passes) {
          const P = g.pass(pid);
          c.fillStyle = P.edit >= 0 ? '#fff' : P.kind === 'opening' ? '#7fdc6a' : '#ffd700';
          c.strokeStyle = '#111';
          c.beginPath();
          c.arc(sx(P.at[0]), sy(P.at[1]), P.kind === 'opening' ? 3.5 : 5, 0, Math.PI * 2);
          c.fill();
          c.stroke();
        }
    }
    if (this.show.props && this.props) {
      // (buried things: stones grey, statues gold, columns and slabs pale, ruins brown; excavation sites ringed)
      const COL: Record<string, string> = { stone: '#9a9a9a', statue: '#f2c14e', column: '#e8e2d4', slab: '#cfc6b0', ruin: '#9b6b43' };
      for (const s of this.props.sites) {
        c.strokeStyle = '#f2c14e';
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(sx(s.at[0]), sy(s.at[1]), Math.max(4, s.radius * k), 0, Math.PI * 2);
        c.stroke();
      }
      for (const p of this.props.props) {
        c.fillStyle = COL[p.kind];
        c.fillRect(sx(p.at[0]) - 2, sy(p.at[1]) - 2, 4, 4);
      }
    }
    if (this.show.edits) {
      for (const e of this.terrain.edits()) {
        c.strokeStyle = e.kind === 'wall' ? '#ff4040' : e.kind === 'ramp' ? '#ffffff' : e.kind === 'ford' ? '#9fe8ff' : '#ffaa00';
        c.lineWidth = Math.max(3, e.half * 2 * k);
        c.beginPath();
        c.moveTo(sx(e.a[0]), sy(e.a[1]));
        c.lineTo(sx(e.b[0]), sy(e.b[1]));
        c.stroke();
      }
      c.font = '11px system-ui';
      for (const n of this.needs) {
        c.fillStyle = '#ffd700';
        c.fillText(`${n.kind}?`, sx(n.at[0]) + 6, sy(n.at[1]) - 6);
      }
    }
    // the rooms' ids at their middles (when they're big enough on screen to read)
    if (Math.sqrt(g.screen) * k > 50) {
      c.font = '11px system-ui';
      c.fillStyle = '#fff';
      for (const R of g.rooms()) c.fillText(String(R.id), sx(R.centre[0]) - 6, sy(R.centre[1]) + 4);
    }
  }

  /** a URL into the level at a world point (the walk-in) */
  walkIn(x: number, y: number): string {
    const [cx, cy] = cellAt(x, y);
    return `?skipmenu=1&level=atlas&at=${cx},${cy}`;
  }

  resize(rw: number, rh: number, cw: number, ch: number): void {
    this.view.resize(rw, rh, cw, ch);
  }

  dispose(): void {
    this.panel.remove();
    this.overlay.remove();
    this.view.dispose();
  }
}
