// An interior played in the live world (`?interior=1` on the atlas level, with `&town=`): the town's hall (or `&ib=<id>`)
// planned inside from its structures plan, drawn in its place, entered from the street — the camera comes down to the
// real doorway, the outside dithers away (its pieces veiled) and the inside assembles where it stood. One storey shown
// at a time (the slice at its ceiling; the storey buttons or [ and ]); the people who live there (people.ts).
import type { Camera, LocalLight } from '../render/camera';
import type { Renderer } from '../render/renderer';
import type { Settlements } from '../settle/settlements';
import type { SettlementsView } from '../settle/view';
import type { InteriorPlan, V2 } from '../api/contracts/interiors';
import { planInterior, type PlannedInterior } from './plan';
import { propSize } from './props';
import { InteriorDraw } from './draw';
import type { WalkGrid } from './grid';

export interface InteriorHost {
  device: GPUDevice;
  renderer: Renderer;
  camera: Camera;
  settlements: Settlements;
  view: SettlementsView;
  ui: HTMLElement;
  params: URLSearchParams;
  /** 0 by day .. 1 at night (the day/night cycle) */
  night: () => number;
  /** seconds since the start (the world's clock) */
  time: () => number;
  /** toward the sun (world) */
  sun: () => [number, number, number];
}

type Phase = 'street' | 'entering' | 'inside' | 'leaving';

export interface ActiveInterior {
  settlement: string;
  building: number;
  plan: InteriorPlan;
  grids: WalkGrid[];
  draw: InteriorDraw;
  /** plan frame → window */
  toWindow(p: V2, z: number): [number, number, number];
  storey: number;
}

export class InteriorScene {
  phase: Phase = 'street';
  active: ActiveInterior | null = null;
  private t = 0;
  private from = { x: 0, y: 0, z: 0, zoom: 1 };
  private ui: HTMLElement;
  private label: HTMLElement;
  /** what the interior adds each frame after its own update (the people) */
  readonly onFrame: ((dt: number, it: ActiveInterior) => void)[] = [];
  readonly onEnter: ((it: ActiveInterior) => void)[] = [];
  stats = { planMs: 0, meshMs: 0, tris: 0, propTris: 0, props: 0, storeys: 0 };

  constructor(private host: InteriorHost) {
    this.ui = document.createElement('div');
    this.ui.className = 'interior-ui';
    this.ui.style.cssText = 'position:absolute;right:10px;bottom:84px;display:flex;flex-direction:column;gap:6px;z-index:20;font:600 13px system-ui;';
    const btn = (txt: string, f: () => void) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = 'min-width:44px;min-height:40px;border:1px solid #5a4d3d;background:#1d1915e0;color:#e9dcc4;border-radius:6px;';
      b.onclick = (e) => {
        e.stopPropagation();
        f();
      };
      this.ui.appendChild(b);
      return b;
    };
    btn('▲', () => this.setStorey(this.storey + 1));
    this.label = document.createElement('div');
    this.label.style.cssText = 'text-align:center;color:#e9dcc4;text-shadow:0 1px 2px #000;';
    this.ui.appendChild(this.label);
    btn('▼', () => this.setStorey(this.storey - 1));
    btn('⏏', () => (this.phase === 'inside' ? this.leave() : this.enter()));
    host.ui.appendChild(this.ui);
    window.addEventListener('keydown', (e) => {
      if (e.key === ']') this.setStorey(this.storey + 1);
      if (e.key === '[') this.setStorey(this.storey - 1);
      if (e.key === 'Enter' && this.active) this.phase === 'inside' ? this.leave() : this.enter();
    });
  }

  get storey(): number {
    return this.active?.storey ?? 0;
  }

  setStorey(s: number): void {
    const a = this.active;
    if (!a) return;
    a.storey = Math.max(0, Math.min(a.plan.storeys.length - 1, s));
  }

  /** Plan the inside of a building of a planned settlement (the hall when none is named); ready to enter. */
  prepare(settlement: string, building?: number): ActiveInterior {
    const h = this.host;
    const sp = h.settlements.plan(settlement);
    const city = h.view.standing(settlement);
    const frame = h.view.planFrame(settlement);
    if (!sp || !city || !frame) throw new Error(`interiors: settlement ${settlement} isn't planned and shown yet`);
    let b = building;
    if (b === undefined) {
      for (const [k, u] of sp.lotUse) if (u === 'hall' && k.startsWith('b')) b = Number(k.slice(1));
      if (b === undefined) throw new Error(`interiors: ${settlement} has no hall (pass &ib=<building>)`);
    }
    const use = sp.lotUse.get(`b${b}`) ?? 'house';
    const t0 = performance.now();
    const planned: PlannedInterior = planInterior(city, b, use, propSize);
    this.stats.planMs = +(performance.now() - t0).toFixed(1);
    this.active?.draw.dispose();
    this.frame = frame;
    const draw = new InteriorDraw(h.device, h.renderer, planned.plan, frame);
    draw.view.assemble = 0;
    draw.on = false;
    this.stats.meshMs = draw.mesh.stats.ms;
    this.stats.tris = draw.mesh.stats.tris;
    this.stats.propTris = draw.mesh.stats.propTris;
    this.stats.props = planned.plan.storeys.reduce((a, s) => a + s.props.length, 0);
    this.stats.storeys = planned.plan.storeys.length;
    this.active = {
      settlement,
      building: b,
      plan: planned.plan,
      grids: planned.grids,
      draw,
      toWindow: (p, z) => [p[0] + this.frame.dx, p[1] + this.frame.dy, z - this.frame.oz],
      storey: 0,
    };
    for (const f of this.onEnter) f(this.active);
    return this.active;
  }

  /** the street in front of the door (window frame): where the walk in starts */
  doorStep(): [number, number, number] {
    const a = this.active!;
    const d = a.plan.doors[0];
    const [x, y, z] = a.toWindow([d.at[0] + d.out[0] * 2.5, d.at[1] + d.out[1] * 2.5], d.at[2]);
    return [x, y, z];
  }

  enter(): void {
    if (!this.active || this.phase === 'inside' || this.phase === 'entering') return;
    const c = this.host.camera;
    this.from = { x: c.target[0], y: c.target[1], z: c.target[2], zoom: c.zoom };
    this.phase = 'entering';
    this.t = 0;
    this.active.draw.on = true;
  }

  leave(): void {
    if (this.phase !== 'inside') return;
    this.phase = 'leaving';
    this.t = 0;
  }

  /** the building's middle and the zoom that frames it (window frame) */
  /** the shown storey's middle and the zoom that fills the screen with it (window frame) */
  private framing(): { x: number; y: number; z: number; zoom: number; r: number } {
    const a = this.active!;
    const st = a.plan.storeys[a.storey];
    const cs = st.tiles.map((q) => a.plan.corners.get(q)!);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cs) for (const p of c) (x0 = Math.min(x0, p[0])), (y0 = Math.min(y0, p[1])), (x1 = Math.max(x1, p[0])), (y1 = Math.max(y1, p[1]));
    const cam = this.host.camera;
    // its corners' spread across the screen (along the screen's right) and up it (along the view's ground forward, and
    // the storey's height); the zoom that fits both, a little margin; the middle of that box
    const rx = -Math.sin(cam.azimuth), ry = Math.cos(cam.azimuth);
    const fx = Math.cos(cam.azimuth), fy = Math.sin(cam.azimuth);
    let lo = Infinity, hi = -Infinity, flo = Infinity, fhi = -Infinity;
    for (const c of cs) for (const q of c) {
      const s = q[0] * rx + q[1] * ry, f = q[0] * fx + q[1] * fy;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
      flo = Math.min(flo, f);
      fhi = Math.max(fhi, f);
    }
    const el = Math.PI / 6;
    const w = hi - lo + 0.6;
    const h = (fhi - flo) * Math.sin(el) + 1.6 * Math.cos(el) + 0.6;
    // (the user: "we can zoom in more" — the storey edge to edge)
    const zoom = Math.min((cam.viewportW * 1.16) / w, (cam.viewportH * 0.95) / h);
    const sm = (lo + hi) / 2, fm = (flo + fhi) / 2;
    const m: V2 = [rx * sm + fx * fm, ry * sm + fy * fm];
    const [x, y, z] = a.toWindow(m, st.z);
    return { x, y, z, zoom, r: Math.hypot(x1 - x0, y1 - y0) / 2 + 0.5 };
  }

  /** where the plan's frame sits in the window (moves when the window slides) */
  private frame = { dx: 0, dy: 0, oz: 0 };

  update(dt: number): void {
    const a = this.active;
    const cam = this.host.camera;
    if (!a) return;
    // (the window slid: the inside made again in the window's new frame — the camera came with the window)
    const fr = this.host.view.planFrame(a.settlement);
    if (fr && (fr.dx !== this.frame.dx || fr.dy !== this.frame.dy || fr.oz !== this.frame.oz)) {
      const old = a.draw;
      this.frame = fr;
      a.draw = new InteriorDraw(this.host.device, this.host.renderer, a.plan, fr);
      a.draw.view = { ...old.view };
      a.draw.on = old.on;
      a.draw.shaftsOn = old.shaftsOn;
      old.dispose();
    }
    const d = a.draw;
    this.t += dt;
    const night = this.host.night();
    d.view.night = night;
    d.view.sun = this.host.sun();
    d.view.storey = a.storey;
    const st = a.plan.storeys[a.storey];
    const ceiling = st.ceiling - a.draw.frame.oz - 0.02;
    const f = this.framing();
    const ease = (k: number) => k * k * (3 - 2 * k);
    const door = this.doorStep();
    if (this.phase === 'entering') {
      // down to the door (1.4 s), the outside dithering away and the inside coming in as it lands (to 2.6 s)
      const k1 = ease(Math.min(1, this.t / 1.4));
      const k2 = ease(Math.min(1, Math.max(0, (this.t - 0.9) / 1.7)));
      const tx = this.from.x + (door[0] - this.from.x) * k1 * (1 - k2) + (f.x - this.from.x) * k2;
      const ty = this.from.y + (door[1] - this.from.y) * k1 * (1 - k2) + (f.y - this.from.y) * k2;
      cam.target[0] = tx;
      cam.target[1] = ty;
      cam.target[2] = f.z;
      const zDoor = f.zoom * 1.25;
      cam.zoom = Math.exp(Math.log(this.from.zoom) + (Math.log(zDoor) - Math.log(this.from.zoom)) * k1 + (Math.log(f.zoom) - Math.log(zDoor)) * k2);
      this.host.view.veil(a.settlement, a.building);
      cam.cut.veil = k2;
      d.view.assemble = k2;
      cam.cut.slice = k2 > 0.02 ? ceiling + (1 - k2) * 30 : null;
      cam.cut.sliceShape = { x: f.x, y: f.y, radius: f.r + 0.6, rim: 0, fade: 0.4, fadeR: 0.08 };
      if (this.t >= 2.6) this.phase = 'inside';
    } else if (this.phase === 'inside') {
      cam.cut.veil = 1;
      d.view.assemble = 1;
      cam.cut.slice = ceiling;
      cam.cut.sliceShape = { x: f.x, y: f.y, radius: f.r + 0.6, rim: 0, fade: 0.4, fadeR: 0.08 };
      // (the camera on the shown storey, framed to fill the screen; eased when the storey changes)
      const k = 1 - Math.exp(-dt * 6);
      cam.target[0] += (f.x - cam.target[0]) * k;
      cam.target[1] += (f.y - cam.target[1]) * k;
      cam.target[2] += (f.z - cam.target[2]) * k;
      cam.zoom = Math.exp(Math.log(cam.zoom) + (Math.log(f.zoom) - Math.log(cam.zoom)) * k);
    } else if (this.phase === 'leaving') {
      const k = ease(Math.min(1, this.t / 1.2));
      cam.cut.veil = 1 - k;
      d.view.assemble = 1 - k;
      cam.cut.slice = k < 0.98 ? ceiling + k * 30 : null;
      if (this.t >= 1.2) {
        this.phase = 'street';
        cam.cut.veil = 0;
        cam.cut.slice = null;
        cam.cut.sliceShape = null;
        this.host.view.veil(null);
        d.on = false;
      }
    }
    // the town round it falls into the dark as the inside comes in (a building entered holds the eye; nothing of the
    // town is dithered — the slice is tight to the building)
    const open = this.phase === 'street' ? 0 : d.view.assemble;
    // (the user: "hide outside the building" — wholly, once inside; the transition takes it away as you enter)
    const quads = a.plan.storeys[a.storey].tiles.map((q) => a.plan.corners.get(q)!.map((c) => [c[0] + this.frame.dx, c[1] + this.frame.dy] as [number, number]));
    cam.cut.focus = open > 0.01 ? { x: f.x, y: f.y, z: f.z, radius: f.r + 0.2, amount: open, margin: 0.15, quads } : null;
    this.hideUi(this.phase !== 'street');
    // the storey's lights
    const lights: LocalLight[] = [];
    if (this.phase !== 'street')
      for (const l of st.lights) {
        const [x, y, z] = a.toWindow([l.at[0], l.at[1]], l.at[2]);
        const k = d.view.assemble;
        // (warm pools against the dark: stronger and wider at night, when they carry the room)
        const s = k * (1.9 + 1.4 * night);
        lights.push({ at: [x, y, z], radius: l.radius * (1.25 + 0.3 * night), colour: [l.colour[0] * s, l.colour[1] * s, l.colour[2] * s], flicker: l.kind === 'candle' || l.kind === 'hearth' ? 1 : 0.4 });
      }
    cam.lights = lights;
    this.label.textContent = this.phase === 'street' ? 'street' : `${a.storey + 1}/${a.plan.storeys.length}`;
    d.update();
    for (const fn of this.onFrame) fn(dt, a);
  }

  private hidden: HTMLElement[] = [];
  /** inside: the level's panels and labels out of the way (the editor, the HUD's tools, the opportunity labels) */
  private hideUi(on: boolean): void {
    if (on && !this.hidden.length) {
      for (const el of Array.from(this.host.ui.children) as HTMLElement[]) {
        if (el === this.ui || el.dataset.interior === '1' || el.style.display === 'none') continue;
        el.dataset.interiorHid = '1';
        el.style.visibility = 'hidden';
        this.hidden.push(el);
      }
    } else if (!on && this.hidden.length) {
      for (const el of this.hidden) {
        el.style.visibility = '';
        delete el.dataset.interiorHid;
      }
      this.hidden = [];
    }
  }

  dispose(): void {
    this.hideUi(false);
    this.active?.draw.dispose();
    this.ui.remove();
    this.host.view.veil(null);
    this.host.camera.cut.veil = 0;
    this.host.camera.lights = [];
  }
}
