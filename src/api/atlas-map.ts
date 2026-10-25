// ---- api/atlas-map.ts ---------------------------------------------------------
// The atlas as a map a game can open (round 80, the user: "a way to access the atlas map so I can see where
// I am or maybe warp. I'm curious to see different locations and it will help with debugging"). The whole
// world drawn once from what the atlas keeps on the CPU — its ground (hmac: hill-shaded, the sea by depth,
// snow by latitude and height), its roads and sites — then shown panned and zoomed: the window a box, the
// player a dot. Drag to pan, wheel or ± to zoom, tap a place to warp there (AtlasWorld.warp), × or Esc to
// close. Nothing runs while it's closed.
//
//   const map = new AtlasMap(aw)        // a button or key in the game: map.toggle()
//   map.onWarp = (cx, cy) => …          // optional: before the warp (the game's own bookkeeping)

import type { AtlasWorld } from './atlas-world';

/** what the map needs of an atlas world (the API's, or the atlas level's own) */
export type MapWorld = Pick<AtlasWorld, 'atlas' | 'core' | 'stream' | 'warp' | 'toWorld'>;

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
  /** called with the world cell before a warp */
  onWarp?: (cx: number, cy: number) => void;

  constructor(
    private aw: MapWorld,
    parent: HTMLElement = document.body,
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
    this.el.style.display = '';
    this.scale = this.scale === 1 ? Math.max(0.5, 800 / Math.max(innerWidth, 1)) : this.scale;
    this.centre();
    this.timer = window.setInterval(() => this.draw(), 500);
  }

  close(): void {
    this.el.style.display = 'none';
    window.clearInterval(this.timer);
  }

  /** the map image: the atlas's ground texels coloured and shaded, the roads and sites over them */
  private paint(): HTMLCanvasElement {
    const a = this.aw.atlas;
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
        if (z < sea) {
          const t = Math.min(1, (sea - z) / 70);
          r = 40 - 22 * t;
          g = 92 - 50 * t;
          b = 128 - 40 * t;
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
          // the sun from the north-west: brighter on the slopes facing it
          const sh = Math.max(0.55, Math.min(1.35, 1 + ((at(x - 1, y - 1) - at(x + 1, y + 1)) * 0.012)));
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

  /** the player's world cell: the camera's target */
  private player(): [number, number] {
    const t = this.aw.core.camera.target;
    return this.aw.toWorld(t[0], t[1]);
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
    // (the torus: the image again either side, where the view runs past an edge)
    const ox = W / 2 - this.vx * k;
    const oy = H / 2 - this.vy * k;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const x = ox + i * n * k;
        const y = oy + j * n * k;
        if (x > W || y > H || x + n * k < 0 || y + n * k < 0) continue;
        ctx.drawImage(this.img, x, y, n * k, n * k);
      }
    // the window and the player
    const S = this.aw.stream;
    const toPx = (cx: number, cy: number): [number, number] => {
      let tx = (cx / a.p.cols) * n - this.vx;
      let ty = (cy / a.p.rows) * n - this.vy;
      tx -= Math.round(tx / n) * n;
      ty -= Math.round(ty / n) * n;
      return [W / 2 + tx * k, H / 2 + ty * k];
    };
    const dims = this.aw.core.dims;
    const [wx, wy] = toPx(S.origin[0], S.origin[1]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(wx, wy, (dims.w / a.p.cols) * n * k, (dims.h / a.p.rows) * n * k);
    const [px, py] = toPx(...this.player());
    ctx.fillStyle = '#ff3030';
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    const [pcx, pcy] = this.player();
    this.note.textContent = this.busy ? 'warping…' : `you: ${pcx.toFixed(0)}, ${pcy.toFixed(0)}  ·  drag to pan, tap to warp`;
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
      this.vx = down.vx - dx * this.scale;
      this.vy = down.vy - dy * this.scale;
      this.draw();
    });
    c.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || d.moved || this.busy) return;
      // a tap: warp to the world cell under it
      const a = this.aw.atlas;
      const n = a.p.n;
      const r = this.canvas.getBoundingClientRect();
      const tx = this.vx + (e.clientX - r.left - r.width / 2) * this.scale;
      const ty = this.vy + (e.clientY - r.top - r.height / 2) * this.scale;
      const cx = (((tx / n) % 1) + 1) % 1 * a.p.cols;
      const cy = (((ty / n) % 1) + 1) % 1 * a.p.rows;
      void this.warpTo(cx, cy);
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY > 0 ? 1.25 : 0.8);
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    });
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

