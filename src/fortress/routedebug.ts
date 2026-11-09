// ?routedebug=1 (diagnostic, Track A): the fortress town's edge network over the view — every edge the routes treat as
// not walkable, coloured by why (build/edgecuts.ts: wall red, water blue, cliff magenta, a structure's side with no door
// at grade yellow), the stairs (steep) green, and the grid's vertices off the route network's connected part
// (RouteNet.main) as orange dots; a panel with the counts. Built from the CPU net when the roads are laid again
// (Fortress.roads changes); each frame only compares that and the camera's matrix, and projects the lines again when the
// camera moved. No GPU work, no readback. Changes nothing the net decides.
import type { Camera } from '../render/camera';
import type { Fortress } from './fortress';
import type { TownRoads } from '../build/townroads';
import { edgeCutsOf, summariseEdgeCuts, SHOW_CLIFF, SHOW_NONE, SHOW_STEEP, SHOW_TERRACE, SHOW_WALL, SHOW_WATER, type EdgeCutSummary } from '../build/edgecuts';

const NEAR = 3;
const LIFT = 0.3;
const STYLE: Record<number, { colour: string; width: number; dash?: string }> = {
  [SHOW_WALL]: { colour: '#ff3b30', width: 2.2 },
  [SHOW_WATER]: { colour: '#2aa8ff', width: 2.2 },
  [SHOW_CLIFF]: { colour: '#ff2bd6', width: 2.6 },
  [SHOW_TERRACE]: { colour: '#ffd400', width: 1.6, dash: '3 2' },
  [SHOW_STEEP]: { colour: '#3dff6a', width: 1.4 },
};

export class RouteDebug {
  private svg: SVGSVGElement;
  private panel: HTMLDivElement;
  private paths = new Map<number, SVGPathElement>();
  private dots: SVGPathElement;
  private of: TownRoads | null = null;
  /** per shown edge its two ends (window x, y, z), by what it shows as; the off-network vertices */
  private segs = new Map<number, Float32Array>();
  private off = new Float32Array(0);
  private cam = new Float32Array(18);
  summary: EdgeCutSummary | null = null;
  private on = true;

  constructor(ui: HTMLElement, private fort: Fortress, private camera: Camera) {
    const NS = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
    this.svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5');
    for (const k of [SHOW_STEEP, SHOW_TERRACE, SHOW_WATER, SHOW_WALL, SHOW_CLIFF]) {
      const p = document.createElementNS(NS, 'path');
      const s = STYLE[k];
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', s.colour);
      p.setAttribute('stroke-width', String(s.width));
      p.setAttribute('stroke-linecap', 'round');
      if (s.dash) p.setAttribute('stroke-dasharray', s.dash);
      this.svg.appendChild(p);
      this.paths.set(k, p);
    }
    this.dots = document.createElementNS(NS, 'path');
    this.dots.setAttribute('fill', '#ff8a00');
    this.dots.setAttribute('stroke', '#000');
    this.dots.setAttribute('stroke-width', '0.4');
    this.dots.setAttribute('fill-opacity', '0.75');
    this.svg.appendChild(this.dots);
    ui.appendChild(this.svg);
    this.panel = document.createElement('div');
    this.panel.setAttribute('style', 'position:absolute;left:4px;top:96px;max-width:250px;font:9px/1.25 monospace;color:#fff;background:#0009;padding:6px 8px;border-radius:4px;pointer-events:none;z-index:6;white-space:pre-wrap');
    ui.appendChild(this.panel);
  }

  /** shown or not (reclaimed.routeDebug.show(false) for a clean shot) */
  show(on: boolean): void {
    this.on = on;
    this.svg.style.display = on ? '' : 'none';
    this.panel.style.display = on ? '' : 'none';
  }

  draw(): void {
    if (!this.on) return;
    const r = this.fort.roads;
    let moved = false;
    if (r !== this.of) {
      this.of = r;
      this.rebuild();
      moved = true;
    }
    const m = this.camera.viewProj;
    for (let i = 0; i < 16; i++) if (this.cam[i] !== m[i]) ((moved = true), (this.cam[i] = m[i]));
    if (this.cam[16] !== this.camera.viewportW || this.cam[17] !== this.camera.viewportH) {
      moved = true;
      this.cam[16] = this.camera.viewportW;
      this.cam[17] = this.camera.viewportH;
    }
    if (moved) this.project();
  }

  private rebuild(): void {
    this.segs.clear();
    this.off = new Float32Array(0);
    const r = this.of;
    if (!r) {
      this.summary = null;
      this.panel.textContent = 'route debug: no roads laid yet';
      return;
    }
    const f = this.fort;
    const { site } = f;
    const { grid, plan } = site;
    const net = r.net;
    const ground = (x: number, y: number) => site.groundAt(x, y);
    const cuts = edgeCutsOf(net, grid, plan, ground, NEAR);
    const nv = grid.verts.length / 2;
    const main = f.routeNet()?.main.subarray(0, nv);
    this.summary = summariseEdgeCuts(net, cuts, NEAR, main);
    const oz = f.zShift;
    const at = (v: number): [number, number, number] => {
      const x = grid.verts[v * 2];
      const y = grid.verts[v * 2 + 1];
      const [wx, wy] = f.toWindow(x, y);
      return [wx, wy, ground(x, y) - oz + LIFT];
    };
    const lists = new Map<number, number[]>();
    for (let e = 0; e < cuts.show.length; e++) {
      const k = cuts.show[e];
      if (k === SHOW_NONE) continue;
      const l = lists.get(k) ?? lists.set(k, []).get(k)!;
      l.push(...at(net.ends[e * 2]), ...at(net.ends[e * 2 + 1]));
    }
    for (const [k, l] of lists) this.segs.set(k, Float32Array.from(l));
    if (main) {
      const has = new Uint8Array(nv);
      for (let e = 0; e < net.inner.length; e++) if (!net.inner[e]) has[net.ends[e * 2]] = has[net.ends[e * 2 + 1]] = 1;
      const off: number[] = [];
      for (let v = 0; v < nv; v++) if (has[v] && !main[v]) off.push(...at(v));
      this.off = Float32Array.from(off);
    }
    const s = this.summary;
    const q = (xs: number[]) => (xs.length ? xs.map((x) => x.toFixed(2)).join(' / ') : '-');
    this.panel.textContent = [
      `route debug: ${s.edges} edges (SLOPE ${s.slope})`,
      `cut  cliff ${s.cut.cliff} (magenta; ${s.cliffAlso} also water/wall)  water ${s.cut.water} (blue)`,
      `     wall ${s.cut.wall} (red)  no door at grade ${s.cut.terrace} (yellow)`,
      `stairs ${s.steep} (green)   off network ${s.offMain} (orange dots)`,
      `cliff over SLOPE: <=10% ${s.cliffOver.within10}, <=25% ${s.cliffOver.within25}, <=50% ${s.cliffOver.within50}, >50% ${s.cliffOver.beyond50}`,
      `cliff drop < 1 m: ${s.cliffUnder1m}`,
      `cliff rise  ${q(s.cliffRise)}`,
      `cliff drop  ${q(s.cliffDz)} m`,
      `cliff length ${q(s.cliffLength)} m`,
      `within ${NEAR} cells of a structure: ${s.nearCut} cut, ${s.nearCliff} cliff`,
    ].join('\n');
  }

  private project(): void {
    const c = this.camera;
    const P = (a: Float32Array, i: number) => {
      const [x, y] = c.project(a[i], a[i + 1], a[i + 2]);
      return `${x.toFixed(1)} ${y.toFixed(1)}`;
    };
    for (const [k, p] of this.paths) {
      const a = this.segs.get(k);
      if (!a) {
        p.setAttribute('d', '');
        continue;
      }
      const d: string[] = [];
      for (let i = 0; i < a.length; i += 6) d.push(`M${P(a, i)}L${P(a, i + 3)}`);
      p.setAttribute('d', d.join(''));
    }
    const d: string[] = [];
    for (let i = 0; i < this.off.length; i += 3) {
      const [x, y] = c.project(this.off[i], this.off[i + 1], this.off[i + 2]);
      d.push(`M${(x - 1.5).toFixed(1)} ${y.toFixed(1)}a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0`);
    }
    this.dots.setAttribute('d', d.join(''));
  }

  dispose(): void {
    this.svg.remove();
    this.panel.remove();
  }
}
