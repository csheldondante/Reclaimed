// The interior's draw (interior.wgsl through Renderer.addLitDraw): its mesh after a header in one storage buffer, two
// draws — the inside itself (opaque, casting into the sun's shadow map) and the sun's shafts with their dust (added).
import type { InteriorPlan, V3 } from '../api/contracts/interiors';
import type { LitDraw, Renderer } from '../render/renderer';
import interiorWgsl from '../shaders/interior.wgsl?raw';
import { buildInteriorMesh, type InteriorMesh, type MeshFrame } from './mesh';
import { inQuad, sideAxes } from './frame';

const IH = 64;
const WMAX = 18;

export interface InteriorView {
  /** the storey shown (the ones over it aren't drawn; the camera's slice follows its ceiling) */
  storey: number;
  /** 0..1: the inside assembling in place (each object by its own share of a dither) */
  assemble: number;
  /** the cut walls' stub (m over the floor) */
  stub: number;
  /** 0 by day .. 1 at night */
  night: number;
  /** the dark ambient's strength, and the shafts' */
  ambient: number;
  shafts: number;
  /** toward the sun (world; the day/night's light.dir) */
  sun: V3;
}

export class InteriorDraw {
  readonly mesh: InteriorMesh;
  private buf: GPUBuffer;
  private header = new ArrayBuffer(IH * 16);
  private draws: LitDraw[];
  private windows: { at: V3; out: [number, number]; hw: number; hh: number; storey: number }[] = [];
  view: InteriorView = { storey: 0, assemble: 1, stub: 0.75, night: 0, ambient: 1, shafts: 1, sun: [0, 0, 1] };
  /** (perf toggles: ?ishafts=0, the measurement's) */
  shaftsOn = true;
  on = true;

  constructor(private device: GPUDevice, private renderer: Renderer, readonly plan: InteriorPlan, readonly frame: MeshFrame) {
    this.mesh = buildInteriorMesh(plan, frame);
    this.buf = device.createBuffer({ label: 'interior', size: IH * 16 + this.mesh.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.buf, IH * 16, this.mesh.data);
    // the windows (every storey's: the draw keeps the shown one's), in the window frame
    for (const st of plan.storeys)
      for (const w of st.walls) {
        if (!w.outer) continue;
        const { dir, inward } = sideAxes(plan.corners.get(w.tile)!, w.side);
        const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
        for (const o of w.openings) {
          if (o.kind !== 'window' && o.kind !== 'shop' && o.kind !== 'balcony') continue;
          const um = ((o.u0 + o.u1) / 2) * L;
          const x = w.a[0] + dir[0] * um + frame.dx, y = w.a[1] + dir[1] * um + frame.dy;
          this.windows.push({ at: [x, y, st.z + (o.z0 + o.z1) / 2 - frame.oz], out: [-inward[0], -inward[1]], hw: ((o.u1 - o.u0) * L) / 2, hh: (o.z1 - o.z0) / 2, storey: st.level });
        }
      }
    this.draws = [
      // (drawn: the shown storey and the one under it — the stair's hole; the sun's map: every storey, they all cast)
      { label: 'interior', wgsl: interiorWgsl, vs: 'vsInterior', fs: 'fsInterior', shadowVs: 'vsInteriorShadow', data: () => this.buf, count: () => (this.on ? this.range()[1] : 0), first: () => this.range()[0], shadowCount: () => (this.on ? this.mesh.vertices : 0), cull: 'none' },
      { label: 'interior-shafts', wgsl: interiorWgsl, vs: 'vsShaft', fs: 'fsShaft', data: () => this.buf, count: () => (this.on && this.shaftsOn ? this.shownWindows() * 36 : 0), blend: 'add' },
    ];
    for (const d of this.draws) renderer.addLitDraw(d);
  }

  private shownList: InteriorDraw['windows'] = [];
  /** the shown storey's vertices and the one under it: first, count */
  private range(): [number, number] {
    const st = this.mesh.storeys;
    const s = Math.max(0, Math.min(st.length - 1, this.view.storey));
    const a = st[Math.max(0, s - 1)];
    const b = st[s];
    return [a.first, b.first + b.count - a.first];
  }
  private shownWindows(): number {
    return this.shownList.length;
  }

  /** each frame: the header (what's shown, the light) */
  update(): void {
    const v = this.view;
    const f = new Float32Array(this.header);
    const st = this.plan.storeys;
    const s = Math.max(0, Math.min(st.length - 1, v.storey));
    const ceiling = st[s].ceiling - this.frame.oz - 0.02;
    f.fill(0);
    f.set([st.length, s, ceiling, v.assemble], 0);
    st.slice(0, 8).forEach((x, i) => (f[4 + i] = x.z - this.frame.oz));
    // (darker at night: the windows give little, the candles carry the room)
    f.set([v.stub, v.ambient, v.night, 0], 12);
    const ambDay: V3 = [0.045, 0.047, 0.06];
    const ambNight: V3 = [0.012, 0.014, 0.024];
    f.set([ambDay[0] + (ambNight[0] - ambDay[0]) * v.night, ambDay[1] + (ambNight[1] - ambDay[1]) * v.night, ambDay[2] + (ambNight[2] - ambDay[2]) * v.night, v.shafts], 16);
    this.shownList = this.windows.filter((w) => w.storey === s).slice(0, WMAX);
    f[15] = this.shownList.length;
    // (how far the sun gets in from each window: the storey's floor walked along −sun until it leaves the building)
    const sx = -v.sun[0], sy = -v.sun[1];
    const sl = Math.hypot(sx, sy) || 1;
    const quads = st[s].tiles.map((q) => this.plan.corners.get(q)!);
    this.shownList.forEach((w, i) => {
      let reach = 0;
      const px = w.at[0] - this.frame.dx, py = w.at[1] - this.frame.dy;
      for (let d = 0.3; d < 9; d += 0.15) {
        const q: [number, number] = [px + (sx / sl) * d, py + (sy / sl) * d];
        if (!quads.some((c) => inQuad(c, q, 0.3))) break;
        reach = d;
      }
      f.set([w.at[0], w.at[1], w.at[2], w.hw, w.out[0], w.out[1], w.hh, w.storey, reach, 0, 0, 0], 32 + i * 12);
    });
    this.device.queue.writeBuffer(this.buf, 0, this.header);
  }

  dispose(): void {
    for (const d of this.draws) this.renderer.removeLitDraw(d);
    this.buf.destroy();
  }
}
