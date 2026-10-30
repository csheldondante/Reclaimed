// ---- api/atlas-map.ts ---------------------------------------------------------
// The atlas as a map a game can open (round 80, the user: "a way to access the atlas map so I can see where
// I am or maybe warp. I'm curious to see different locations and it will help with debugging"). The whole
// world drawn once from what the atlas keeps on the CPU — its ground (hmac: hill-shaded, the sea by depth,
// snow by latitude and height), its roads and sites — then shown panned and zoomed: the window a box, the
// player a dot. Drag to pan, wheel or ± to zoom, tap a place to warp there (AtlasWorld.warp), × or Esc to
// close. Nothing runs while it's closed.
// (Round 91, the user: "the map needs to show you names of place and a directional compas for the way your are
// facing") Names from label sources (api/map-labels.ts: the world wiki's, gm/map-names.ts), decluttered by the
// zoom; the player's dot has a wedge the way the camera faces and the view's footprint on the ground, both
// turning with the view; a compass rose in the corner. North is the map's up — world −y — and the map is drawn
// as the world is seen from above (world +x to the left of north: before round 91 the map was the world's mirror
// image, x to the right, which the game's turned view and a compass would have made plain).
//
//   const map = new AtlasMap(aw, parent, { labels: [atlasWikiLabels(atlas)] })   // map.toggle() from a button
//   map.onWarp = (cx, cy) => …          // optional: before the warp (the game's own bookkeeping)

import type { AtlasWorld } from './atlas-world';
import { LAKE_IN } from '../atlas/rivers';
import type { LabelKind, LabelSource, MapLabel } from './map-labels';

/** each kind's look, and the zooms it shows at: from `min` up to `max` texels a css pixel, and only while what it
 *  names is `px` css pixels across or more (√weight texels: an area's side) when `px` is set */
const LABEL_STYLE: Record<LabelKind, { font: string; size: number; fill: string; halo: string; max: number; px?: number; min?: number; caps?: boolean }> = {
  continent: { font: '600 22px Georgia, "Times New Roman", serif', size: 22, fill: 'rgba(255,243,214,0.8)', halo: 'rgba(30,20,10,0.6)', max: 99, min: 0.6, px: 40, caps: true },
  metropolis: { font: '700 16px Georgia, "Times New Roman", serif', size: 16, fill: '#fbefcf', halo: '#24180c', max: 99 },
  city: { font: '600 14px Georgia, "Times New Roman", serif', size: 14, fill: '#f8ecc8', halo: '#24180c', max: 3 },
  town: { font: '13px Georgia, "Times New Roman", serif', size: 13, fill: '#f3e6c2', halo: '#24180c', max: 1.4 },
  lake: { font: 'italic 12px Georgia, "Times New Roman", serif', size: 12, fill: '#cfe8f7', halo: '#0d2230', max: 2, px: 14 },
  region: { font: 'italic 12px Georgia, "Times New Roman", serif', size: 12, fill: '#efe2c4', halo: 'rgba(28,20,12,0.85)', max: 2, px: 34 },
  village: { font: '12px Georgia, "Times New Roman", serif', size: 12, fill: '#eadcb8', halo: '#24180c', max: 0.7 },
  sea: { font: 'italic 12px Georgia, "Times New Roman", serif', size: 12, fill: '#bcdcf0', halo: '#0b1e2b', max: 2, px: 34 },
};
/** who's placed first where two would overlap (the continents are under everything: they only avoid each other) */
const LABEL_ORDER: LabelKind[] = ['metropolis', 'city', 'town', 'lake', 'region', 'village', 'sea'];
const SITE_KINDS = new Set<LabelKind>(['metropolis', 'city', 'town', 'village']);

/** what the map needs of an atlas world (the API's, or the atlas level's own) */
export type MapWorld = Pick<AtlasWorld, 'atlas' | 'core' | 'stream' | 'warp' | 'toWorld'> & {
  /** (round 102) the land of a warp there asked for ahead (its window and a ring round it, into the pool) */
  precache?: (cx: number, cy: number) => number;
};

/** (round 94) a pin on the map: a world cell, its name, its colour */
export interface MapMark {
  at: [number, number];
  name: string;
  colour?: string;
}

export class AtlasMap {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private img: HTMLCanvasElement | null = null;
  /** the view: its middle in map texels, texels a css pixel */
  private vx = 0;
  private vy = 0;
  private scale = 1;
  private timer = 0;
  private note: HTMLDivElement;
  private busy = false;
  /** the labels (made when the map is first opened), by kind, heaviest first */
  private labels: Map<LabelKind, MapLabel[]> | null = null;
  /** the names of the atlas regions the labels name (the note says where the player is) */
  private regionName = new Map<number, string>();
  /** how many labels, and the ms they took to make (the first open) */
  labelStats: { count: number; ms: number } | null = null;
  /** called with the world cell before a warp */
  onWarp?: (cx: number, cy: number) => void;
  /** (round 94) a tap warps (off during a run: travel is on foot) */
  canWarp = true;
  /** (round 94) where the player is (world cell), when it isn't the camera's target (a hero) */
  playerAt?: () => [number, number] | null;
  /** (round 94) the way the player faces (world radians: 0 is +x), for the wedge; else the camera's look */
  facing?: () => number | null;
  /** (round 94) pins on the map: where to go (a story's objective), each with its name */
  marks?: () => MapMark[];
  /** (round 117, runplan) drawn over the map, under the player's dot: a planned run's legs and stages. `px` a world
   *  cell → css px (the nearest copy on the torus), `scale` texels a css px */
  overlay?: (ctx: CanvasRenderingContext2D, px: (cx: number, cy: number) => [number, number], scale: number) => void;

  constructor(
    private aw: MapWorld,
    parent: HTMLElement = document.body,
    private opts: { labels?: LabelSource[] } = {},
  ) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(10,14,20,0.92);display:none;touch-action:none;user-select:none;';
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    el.appendChild(this.canvas);
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;gap:6px;';
    const btn = (t: string, f: () => void) => {
      const b = document.createElement('button');
      b.textContent = t;
      b.style.cssText = 'min-width:44px;height:44px;font:20px system-ui,sans-serif;border-radius:8px;border:1px solid #888;background:rgba(20,22,24,0.85);color:#eee;';
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        f();
      });
      bar.appendChild(b);
    };
    btn('+', () => this.zoom(0.5));
    btn('−', () => this.zoom(2));
    btn('◎', () => this.centre());
    btn('×', () => this.close());
    el.appendChild(bar);
    this.note = document.createElement('div');
    this.note.style.cssText = 'position:absolute;left:8px;bottom:8px;color:#ddd;font:13px system-ui,sans-serif;text-shadow:0 1px 2px #000;';
    el.appendChild(this.note);
    parent.appendChild(el);
    this.el = el;
    this.listen();
  }

  get isOpen(): boolean {
    return this.el.style.display !== 'none';
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.img ??= this.paint();
    if (!this.labels) {
      const t0 = performance.now();
      this.labels = new Map();
      for (const l of (this.opts.labels ?? []).flatMap((f) => f())) {
        if (!this.labels.has(l.kind)) this.labels.set(l.kind, []);
        this.labels.get(l.kind)!.push(l);
        if (l.region !== undefined) this.regionName.set(l.region, l.name);
      }
      for (const ls of this.labels.values()) ls.sort((x, y) => y.weight - x.weight);
      this.labelStats = { count: [...this.labels.values()].reduce((n, ls) => n + ls.length, 0), ms: Math.round(performance.now() - t0) };
    }
    this.el.style.display = '';
    this.scale = this.scale === 1 ? Math.max(0.5, 800 / Math.max(innerWidth, 1)) : this.scale;
    this.centre();
    this.timer = window.setInterval(() => this.draw(), 500);
  }

  close(): void {
    this.el.style.display = 'none';
    window.clearInterval(this.timer);
  }

  /** the map image (paintAtlasImage) */
  private paint(): HTMLCanvasElement {
    return paintAtlasImage(this.aw.atlas);
  }

  /** the player's world cell: the camera's target */
  private player(): [number, number] {
    const p = this.playerAt?.();
    if (p) return p;
    const t = this.aw.core.camera.target;
    return this.aw.toWorld(t[0], t[1]);
  }

  /** (round 117, runplan) draw now (the run's travel animates every frame, not on the map's half-second timer) */
  redraw(): void {
    this.draw();
  }

  /** (round 117, runplan) the view's middle on world cell (cx, cy); its zoom (texels a css px) when given */
  centreOn(cx: number, cy: number, scale?: number): void {
    const a = this.aw.atlas;
    if (scale !== undefined) this.scale = Math.min(8, Math.max(0.05, scale));
    this.vx = (cx / a.p.cols) * a.p.n;
    this.vy = (cy / a.p.rows) * a.p.n;
  }

  private centre(): void {
    const a = this.aw.atlas;
    const [cx, cy] = this.player();
    this.vx = (cx / a.p.cols) * a.p.n;
    this.vy = (cy / a.p.rows) * a.p.n;
    this.draw();
  }

  private zoom(f: number): void {
    this.scale = Math.min(8, Math.max(0.05, this.scale * f));
    this.draw();
  }

  /** texels (the map image's) → css pixels on the canvas, the nearest copy on the torus: world +x to the left */
  private toPx(tx: number, ty: number, W: number, H: number): [number, number] {
    const n = this.aw.atlas.p.n;
    let dx = tx - this.vx;
    let dy = ty - this.vy;
    dx -= Math.round(dx / n) * n;
    dy -= Math.round(dy / n) * n;
    const k = 1 / this.scale;
    return [W / 2 - dx * k, H / 2 + dy * k];
  }

  private draw(): void {
    if (!this.isOpen || !this.img) return;
    const c = this.canvas;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = this.scale > 1;
    const a = this.aw.atlas;
    const n = a.p.n;
    const k = 1 / this.scale;
    // (the torus: the image again either side, where the view runs past an edge; mirrored in x — +x to the left)
    const ox = W / 2 + this.vx * k;
    const oy = H / 2 - this.vy * k;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const x = ox - i * n * k;
        const y = oy + j * n * k;
        if (x - n * k > W || y > H || x < 0 || y + n * k < 0) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(-1, 1);
        ctx.drawImage(this.img, 0, 0, n * k, n * k);
        ctx.restore();
      }
    const cellPx = (cx: number, cy: number) => this.toPx((cx / a.p.cols) * n, (cy / a.p.rows) * n, W, H);
    // the window
    const S = this.aw.stream;
    const dims = this.aw.core.dims;
    const [wx, wy] = cellPx(S.origin[0], S.origin[1]);
    const ww = (dims.w / a.p.cols) * n * k;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(wx - ww, wy, ww, (dims.h / a.p.rows) * n * k);
    this.drawLabels(ctx, W, H);
    this.overlay?.(ctx, cellPx, this.scale);
    // the player: the view's footprint on the ground (the screen's corners at the target's height), a wedge
    // the way the camera faces, the dot
    const cam = this.aw.core.camera;
    const t = cam.target;
    const corner = (sx: number, sy: number) => {
      const [dx, dy] = cam.screenDeltaToWorld(sx, sy);
      return cellPx(...this.aw.toWorld(t[0] + dx, t[1] + dy));
    };
    const hw = cam.viewportW / 2;
    const hh = cam.viewportH / 2;
    const box = [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)];
    ctx.beginPath();
    box.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,80,60,0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,120,100,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const [px, py] = cellPx(...this.player());
    // (the camera looks along (−cos az, −sin az) in the world: on the map, +x to the left, (cos az, −sin az))
    // (a facing given — a hero's heading θ, world (cos θ, sin θ) — is on the map (−cos θ, sin θ))
    const face = this.facing?.();
    const fa = face != null ? Math.atan2(Math.sin(face), -Math.cos(face)) : Math.atan2(-Math.sin(cam.azimuth), Math.cos(cam.azimuth));
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, 30, fa - 0.5, fa + 0.5);
    ctx.closePath();
    const g = ctx.createRadialGradient(px, py, 4, px, py, 30);
    g.addColorStop(0, 'rgba(255,60,48,0.9)');
    g.addColorStop(1, 'rgba(255,60,48,0)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = '#ff3030';
    ctx.strokeStyle = '#2a0a06';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // (round 94) the pins: a drop on a stalk, its name in a tag over it
    for (const m of this.marks?.() ?? []) {
      const [mx, my] = cellPx(m.at[0], m.at[1]);
      const c = m.colour ?? '#f2c14e';
      ctx.strokeStyle = '#1a1206';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx, my - 14);
      ctx.stroke();
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(mx, my - 20, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1a1206';
      ctx.beginPath();
      ctx.arc(mx, my - 20, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '600 14px system-ui,sans-serif';
      const tw = ctx.measureText(m.name).width;
      ctx.fillStyle = 'rgba(20,16,10,0.85)';
      ctx.fillRect(mx - tw / 2 - 6, my - 50, tw + 12, 20);
      ctx.fillStyle = c;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.name, mx, my - 40);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
    this.drawRose(ctx);
    const [pcx, pcy] = this.player();
    const tx = ((Math.floor((pcx / a.p.cols) * n) % n) + n) % n;
    const ty = ((Math.floor((pcy / a.p.rows) * n) % n) + n) % n;
    const here = this.regionName.get(a.regionOf[ty * n + tx]);
    this.note.textContent = this.busy ? 'warping…' : `${here ? `${here}  ·  ` : ''}${pcx.toFixed(0)}, ${pcy.toFixed(0)}  ·  drag to pan${this.canWarp ? ', tap to warp' : ''}`;
  }

  /** the names: each kind that shows at this zoom, heaviest first, none over one already placed */
  private drawLabels(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    if (!this.labels) return;
    const a = this.aw.atlas;
    const n = a.p.n;
    const sx = n / a.worldW;
    const sy = n / a.worldH;
    type Box = [number, number, number, number];
    const free = (b: Box, among: Box[]) => !among.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    ctx.lineJoin = 'round';
    ctx.textAlign = 'center';
    const put = (kind: LabelKind, among: Box[]) => {
      const st = LABEL_STYLE[kind];
      const ls = this.labels!.get(kind);
      if (!ls || this.scale > st.max || this.scale < (st.min ?? 0)) return;
      ctx.font = st.font;
      ctx.letterSpacing = st.caps ? '4px' : '0px';
      const site = SITE_KINDS.has(kind);
      ctx.textBaseline = site ? 'bottom' : 'middle';
      for (const l of ls) {
        // (heaviest first: once one is too small to show, so are the rest)
        if (st.px && Math.sqrt(l.weight) / this.scale < st.px) break;
        const [x, yc] = this.toPx(l.x * sx, l.y * sy, W, H);
        if (x < -300 || x > W + 300 || yc < -40 || yc > H + 40) continue;
        // (a settlement's name over its dot)
        const y = site ? yc - 5 : yc;
        const text = st.caps ? l.name.toUpperCase() : l.name;
        const w = ctx.measureText(text).width;
        const b: Box = site ? [x - w / 2 - 2, y - st.size - 1, x + w / 2 + 2, y + 1] : [x - w / 2 - 2, y - st.size / 2 - 1, x + w / 2 + 2, y + st.size / 2 + 1];
        if (b[2] < 0 || b[0] > W || b[3] < 0 || b[1] > H || !free(b, among)) continue;
        among.push(b);
        ctx.strokeStyle = st.halo;
        ctx.lineWidth = 3;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = st.fill;
        ctx.fillText(text, x, y);
      }
    };
    // (kept clear: the rose, the buttons, the note)
    const ui: Box[] = [[0, 0, 70, 76], [W - 200, 0, W, 60], [0, H - 30, W, H]];
    // the continents under everything, avoiding only each other
    put('continent', [...ui]);
    const placed: Box[] = [...ui];
    for (const kind of LABEL_ORDER) put(kind, placed);
    ctx.letterSpacing = '0px';
  }

  /** a compass rose in the corner: north is the map's up */
  private drawRose(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.translate(34, 40);
    ctx.fillStyle = 'rgba(20,16,10,0.6)';
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, -18);
      ctx.lineTo(4.5, 0);
      ctx.lineTo(-4.5, 0);
      ctx.closePath();
      ctx.fillStyle = i === 0 ? '#e0483a' : '#e9dcb8';
      ctx.fill();
      ctx.rotate(Math.PI / 2);
    }
    ctx.fillStyle = '#fbefcf';
    ctx.font = '700 11px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, -22 + 0.5);
    ctx.restore();
  }

  private listen(): void {
    let down: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    const c = this.el;
    c.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, vx: this.vx, vy: this.vy, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) > 6) down.moved = true;
      // (+x to the left: the land follows the finger)
      this.vx = down.vx + dx * this.scale;
      this.vy = down.vy - dy * this.scale;
      this.draw();
    });
    c.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || d.moved || this.busy || !this.canWarp) return;
      // a tap: warp to the world cell under it
      const [cx, cy] = this.cellAt(e);
      void this.warpTo(cx, cy);
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY > 0 ? 1.25 : 0.8);
    }, { passive: false });
    // (open, the map takes the keys: the game's own — WASD, space — don't reach it; their key-ups still do,
    // so nothing stays held. Captured first, before the page's listeners.)
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.isOpen) return;
        e.stopImmediatePropagation();
        if (e.key === 'Escape') this.close();
      },
      { capture: true },
    );
  }

  /** the world cell under a pointer */
  private cellAt(e: PointerEvent): [number, number] {
    const a = this.aw.atlas;
    const n = a.p.n;
    const r = this.canvas.getBoundingClientRect();
    const tx = this.vx - (e.clientX - r.left - r.width / 2) * this.scale;
    const ty = this.vy + (e.clientY - r.top - r.height / 2) * this.scale;
    return [(((tx / n) % 1) + 1) % 1 * a.p.cols, (((ty / n) % 1) + 1) % 1 * a.p.rows];
  }

  private async warpTo(cx: number, cy: number): Promise<void> {
    this.busy = true;
    this.draw();
    this.onWarp?.(cx, cy);
    try {
      await this.aw.warp(cx, cy);
    } finally {
      this.busy = false;
    }
    this.centre();
    this.close();
  }
}

/**
 * The map image: the atlas's ground texels coloured and shaded, the roads and sites over them (n × n texels, north up,
 * not yet mirrored — AtlasMap draws it with x flipped). (Round 117, runplan: exported from AtlasMap's private painter so
 * the run-plan viewer draws the same map; nothing else changed.)
 */
export function paintAtlasImage(a: MapWorld['atlas']): HTMLCanvasElement {
  const n = a.p.n;
  const h = a.hmac;
  const sea = a.p.sea;
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  const ctx = c.getContext('2d')!;
  const im = ctx.createImageData(n, n);
  const d = im.data;
  const at = (x: number, y: number) => h[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
  for (let y = 0; y < n; y++) {
    // (0 at the poles, 1 at the equator: the torus's v)
    const warm = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / n);
    for (let x = 0; x < n; x++) {
      const z = h[y * n + x];
      const k = (y * n + x) * 4;
      let r: number;
      let g: number;
      let b: number;
      // (round 90: a lake, inside its extent where its level is over the ground)
      const lk = a.lakeAt.length ? a.lakeAt[y * n + x] : 0;
      const lv = lk & LAKE_IN ? a.lakes[(lk & 0x7fff) - 1].level : -Infinity;
      if (z < sea) {
        const t = Math.min(1, (sea - z) / 70);
        r = 40 - 22 * t;
        g = 92 - 50 * t;
        b = 128 - 40 * t;
      } else if (lv > z) {
        const t = Math.min(1, (lv - z) / 20);
        r = 56 - 26 * t;
        g = 112 - 44 * t;
        b = 150 - 30 * t;
      } else {
        const e = z - sea;
        // lowland green → upland tan → rock grey; snow where it's cold
        const t = Math.min(1, e / 260);
        r = 96 + 90 * t;
        g = 128 + 30 * t - 40 * t * t;
        b = 70 + 70 * t;
        const cold = warm * 34 - 8 - e * 0.05;
        if (cold < 0) {
          const s = Math.min(1, -cold / 6);
          r += (236 - r) * s;
          g += (240 - g) * s;
          b += (244 - b) * s;
        }
        // the sun from the north-west — the screen's upper left: north is −y, west +x (drawn as seen from
        // above: world +x to the left) — brighter on the slopes facing it
        const sh = Math.max(0.55, Math.min(1.35, 1 + ((at(x + 1, y - 1) - at(x - 1, y + 1)) * 0.012)));
        r *= sh;
        g *= sh;
        b *= sh;
      }
      d[k] = r;
      d[k + 1] = g;
      d[k + 2] = b;
      d[k + 3] = 255;
    }
  }
  ctx.putImageData(im, 0, 0);
  // the roads and the sites
  const sx = n / a.worldW;
  const sy = n / a.worldH;
  ctx.strokeStyle = 'rgba(150,60,40,0.85)';
  ctx.lineWidth = 1.2;
  for (const road of a.settlement.roads) {
    ctx.beginPath();
    for (let k = 0; k < road.path.length; k += 2) {
      const px = road.path[k] * sx;
      const py = road.path[k + 1] * sy;
      // (a step over the torus's seam: a new line)
      if (k > 0 && (Math.abs(px - road.path[k - 2] * sx) > n / 2 || Math.abs(py - road.path[k - 1] * sy) > n / 2)) ctx.moveTo(px, py);
      else if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#f3e2b0';
  ctx.strokeStyle = '#3a2a18';
  for (const s of a.settlement.sites) {
    ctx.beginPath();
    ctx.arc(s.x * sx, s.y * sy, 1.5 + s.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  return c;
}
