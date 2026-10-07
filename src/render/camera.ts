// Fixed-angle orthographic isometric camera (design doc §14).
// Pan + zoom only. Rotation was removed (user decision 2026-10-07): a single
// fixed view keeps pixel art crisp and lets shading be stylised for one angle.

export type Mat4 = Float32Array;

export const CAMERA_BYTES = 96;

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

  get azimuth(): number {
    return Math.PI / 4;
  }

  update(): void {
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

  /** World point → CSS pixel coordinates. */
  project(x: number, y: number, z: number): [number, number] {
    const m = this.viewProj;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    return [((cx + 1) / 2) * this.viewportW, ((1 - cy) / 2) * this.viewportH];
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
    f.set([this.viewportW, this.viewportH, this.zoom, 0], 20);
  }
}
