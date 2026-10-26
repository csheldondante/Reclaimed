// Fixed-angle orthographic isometric camera (design doc §14).
// Pan + zoom only. Rotation was removed (user decision 2026-10-07): a single
// fixed view keeps pixel art crisp and lets shading be stylised for one angle.
// Round 69 (atlas): a free-flying perspective camera beside it, to explore in
// 3D (`fly`: where it is, which way it looks) — the draw shaders get its
// position (render.wgsl Camera.pos), so what's drawn toward the eye is drawn
// toward where the eye is, not one fixed way.

export type Mat4 = Float32Array;

export const CAMERA_BYTES = 96;
/** where the eye is (render.wgsl Camera.pos: xyz, w 1 when flying), after the light's matrix the renderer writes at CAMERA_BYTES */
export const CAMERA_POS_OFFSET = CAMERA_BYTES + 64;
/** what's cut from the view after it (render.wgsl Camera.cut, see, boxes; round 83) */
export const CAMERA_CUT_OFFSET = CAMERA_POS_OFFSET + 16;
/** cut (a vec4), see (4 vec4s), boxes (4 boxes, 2 vec4s each) */
export const CAMERA_CUT_BYTES = 16 + 4 * 16 + 8 * 16;

/** What's cut from the view (api/cutaway.ts: Slice, Dither) — the sun's camera cuts nothing. */
export interface Cut {
  /** nothing over this height (world z) is drawn; null: no slice */
  slice: number | null;
  /** points kept seen: x, y, z (the point's base: what's over it in front is dithered) and a radius on screen (world units) */
  see: [number, number, number, number][];
  /** what may be dithered (lo xyz, hi xyz; world): none marked, anything */
  boxes: [number, number, number, number, number, number][];
}

/** the free camera: where it is (world), which way it looks (radians), its vertical field of view */
export interface Fly {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  fov: number;
}
const NEAR = 0.3;
const FAR = 3000;

const ELEVATION = (30 * Math.PI) / 180; // classic 2:1 pixel-art dimetric

export class Camera {
  /** World-space point at the centre of the screen. */
  target: [number, number, number] = [128, 128, 10];
  /** Screen pixels per world unit (cell). */
  zoom = 4;
  viewportW = 1;
  viewportH = 1;
  readonly viewProj: Mat4 = new Float32Array(16);
  readonly eye: [number, number, number] = [0, 0, 0];
  /** flying (perspective) when set */
  fly: Fly | null = null;
  /** (round 83, V21) what's cut from the view: api/cutaway.ts writes it */
  cut: Cut = { slice: null, see: [], boxes: [] };

  /** the way a flying camera looks, and its right and up */
  basis(): { f: [number, number, number]; r: [number, number, number]; u: [number, number, number] } {
    const { yaw, pitch } = this.fly!;
    const f: [number, number, number] = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
    const rl = Math.hypot(f[1], f[0]);
    const r: [number, number, number] = [f[1] / rl, -f[0] / rl, 0];
    const u: [number, number, number] = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return { f, r, u };
  }

  /** px a world unit at distance 1 (flying) */
  get focal(): number {
    return this.viewportH / 2 / Math.tan(this.fly!.fov / 2);
  }

  /** Move what the camera knows of the world by (−dx, −dy, −dz) (the streamed window slid that way). */
  shift(dx: number, dy: number, dz: number): void {
    this.target[0] -= dx;
    this.target[1] -= dy;
    this.target[2] -= dz;
    if (this.fly) {
      this.fly.pos[0] -= dx;
      this.fly.pos[1] -= dy;
      this.fly.pos[2] -= dz;
    }
  }

  /**
   * Which way the eye is round the target (radians; π/4 the fixed view). Round 82 (V21): the cutaway turns
   * it when a large obstacle hides the character (api/cutaway.ts) — the rest of the time it stays put.
   */
  azimuth = Math.PI / 4;

  update(): void {
    if (this.fly) {
      this.updateFly();
      return;
    }
    const az = this.azimuth;
    const ex = Math.cos(az) * Math.cos(ELEVATION);
    const ey = Math.sin(az) * Math.cos(ELEVATION);
    const ez = Math.sin(ELEVATION);
    this.eye[0] = ex;
    this.eye[1] = ey;
    this.eye[2] = ez;
    // camera basis: forward = -eye, right = normalize(forward × up), up' = right × forward
    const fx = -ex;
    const fy = -ey;
    const fz = -ez;
    let rx = fy * 1 - fz * 0;
    let ry = fz * 0 - fx * 1;
    const rl = Math.hypot(rx, ry);
    rx /= rl;
    ry /= rl;
    const rz = 0;
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;
    const [tx, ty, tz] = this.target;
    const halfW = this.viewportW / 2 / this.zoom;
    const halfH = this.viewportH / 2 / this.zoom;
    const depthRange = 2000;
    // view: project onto (right, up, forward) relative to target; ortho maps to clip.
    // clip.x = dot(p - t, r) / halfW ; clip.y = dot(p - t, u) / halfH
    // clip.z = 0.5 + dot(p - t, f) / depthRange   (larger = farther)
    const m = this.viewProj;
    const sx = 1 / halfW;
    const sy = 1 / halfH;
    const sz = 1 / depthRange;
    // column-major
    m[0] = rx * sx; m[4] = ry * sx; m[8] = rz * sx;  m[12] = -(rx * tx + ry * ty + rz * tz) * sx;
    m[1] = ux * sy; m[5] = uy * sy; m[9] = uz * sy;  m[13] = -(ux * tx + uy * ty + uz * tz) * sy;
    m[2] = fx * sz; m[6] = fy * sz; m[10] = fz * sz; m[14] = 0.5 - (fx * tx + fy * ty + fz * tz) * sz;
    m[3] = 0;       m[7] = 0;       m[11] = 0;       m[15] = 1;
  }

  /** perspective: clip = (dot(d, r)·g/aspect, dot(d, u)·g, A·depth + B, depth), d = p − pos, depth along f */
  private updateFly(): void {
    const { f, r, u } = this.basis();
    const [px, py, pz] = this.fly!.pos;
    this.eye[0] = -f[0];
    this.eye[1] = -f[1];
    this.eye[2] = -f[2];
    const g = 1 / Math.tan(this.fly!.fov / 2);
    const sx = g / (this.viewportW / this.viewportH);
    const A = FAR / (FAR - NEAR);
    const B = (-FAR * NEAR) / (FAR - NEAR);
    const dot = (a: number[]) => a[0] * px + a[1] * py + a[2] * pz;
    const m = this.viewProj;
    // column-major
    m[0] = r[0] * sx; m[4] = r[1] * sx; m[8] = r[2] * sx;  m[12] = -dot(r) * sx;
    m[1] = u[0] * g;  m[5] = u[1] * g;  m[9] = u[2] * g;   m[13] = -dot(u) * g;
    m[2] = f[0] * A;  m[6] = f[1] * A;  m[10] = f[2] * A;  m[14] = -dot(f) * A + B;
    m[3] = f[0];      m[7] = f[1];      m[11] = f[2];      m[15] = -dot(f);
  }

  /** World point → CSS pixel coordinates. */
  project(x: number, y: number, z: number): [number, number] {
    const m = this.viewProj;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const w = Math.max(m[3] * x + m[7] * y + m[11] * z + m[15], 1e-4);
    return [((cx / w + 1) / 2) * this.viewportW, ((1 - cy / w) / 2) * this.viewportH];
  }

  /**
   * CSS pixel delta (x right, y down) → world XY delta of a point on the ground.
   * Screen right = r = (-sin az, cos az); moving a ground point along the
   * horizontal forward h = (-cos az, -sin az) raises it on screen by sin(elev).
   */
  screenDeltaToWorld(dx: number, dy: number): [number, number] {
    const az = this.azimuth;
    const rx = -Math.sin(az);
    const ry = Math.cos(az);
    const hx = -Math.cos(az);
    const hy = -Math.sin(az);
    const wx = dx / this.zoom;
    const wy = dy / this.zoom / Math.sin(ELEVATION);
    return [rx * wx - hx * wy, ry * wx - hy * wy];
  }

  /**
   * CSS pixel → world point on the terrain, given a height lookup. Raising a
   * point by dz moves it up the screen by dz·cos(elev)·zoom, so we solve for the
   * ground under the cursor by fixed-point iteration on z.
   */
  groundAt(sx: number, sy: number, heightAt: (x: number, y: number) => number): [number, number, number] {
    if (this.fly) {
      // (flying: along the ray through the pixel until it's under the ground)
      const { f, r, u } = this.basis();
      const g = 1 / Math.tan(this.fly.fov / 2);
      const nx = ((sx / this.viewportW) * 2 - 1) * (this.viewportW / this.viewportH) / g;
      const ny = (1 - (sy / this.viewportH) * 2) / g;
      const d = [0, 1, 2].map((i) => f[i] + r[i] * nx + u[i] * ny);
      const dl = Math.hypot(d[0], d[1], d[2]);
      const [px, py, pz] = this.fly.pos;
      let prev = 0;
      for (let t = 0.5; t < 1500; t += Math.max(0.5, t * 0.01)) {
        const x = px + (d[0] / dl) * t;
        const y = py + (d[1] / dl) * t;
        const z = pz + (d[2] / dl) * t;
        if (z <= heightAt(x, y)) {
          // (back to halfway between the last two steps)
          const tm = (t + prev) / 2;
          return [px + (d[0] / dl) * tm, py + (d[1] / dl) * tm, heightAt(px + (d[0] / dl) * tm, py + (d[1] / dl) * tm)];
        }
        prev = t;
      }
      return [px + f[0] * 50, py + f[1] * 50, heightAt(px + f[0] * 50, py + f[1] * 50)];
    }
    const [tx, ty, tz] = this.target;
    const dx = sx - this.viewportW / 2;
    const dy = sy - this.viewportH / 2;
    let z = tz;
    let x = tx;
    let y = ty;
    for (let i = 0; i < 6; i++) {
      const [wx, wy] = this.screenDeltaToWorld(dx, dy + (z - tz) * Math.cos(ELEVATION) * this.zoom);
      x = tx + wx;
      y = ty + wy;
      z = heightAt(x, y);
    }
    return [x, y, z];
  }

  write(out: ArrayBuffer): void {
    const f = new Float32Array(out);
    f.set(this.viewProj, 0);
    f.set([this.eye[0], this.eye[1], this.eye[2], 0], 16);
    // (flying: px a unit at distance 1 — what's sized by it divides by its depth)
    f.set([this.viewportW, this.viewportH, this.fly ? this.focal : this.zoom, 0], 20);
    if (out.byteLength >= CAMERA_POS_OFFSET + 16) f.set(this.fly ? [...this.fly.pos, 1] : [0, 0, 0, 0], CAMERA_POS_OFFSET / 4);
    if (out.byteLength >= CAMERA_CUT_OFFSET + CAMERA_CUT_BYTES) {
      const c = this.cut;
      const o = CAMERA_CUT_OFFSET / 4;
      f.fill(0, o, o + CAMERA_CUT_BYTES / 4);
      f.set([c.slice ?? 0, c.see.length, c.boxes.length, c.slice === null ? 0 : 1], o);
      c.see.forEach((p, i) => f.set(p, o + 4 + i * 4));
      c.boxes.forEach((b, i) => f.set([b[0], b[1], b[2], 0, b[3], b[4], b[5], 0], o + 20 + i * 8));
    }
  }
}
