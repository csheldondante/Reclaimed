// Round 125 (forest): the understory's dither mask (understory.wgsl underHide) on Dawn — the shipped function, the
// shipped Camera struct and the camera's own uniform write (render/camera.ts), probed at points round a hero: what
// hides the floor round the hero goes, the near trunks' feet stay (stumps), the trunks beyond stay, and nothing is
// touched with the look off.
import { describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import { makeBindGroup, makeCompute } from '../../src/gpu/pipeline';
import commonWgsl from '../../src/shaders/common.wgsl?raw';
import renderWgsl from '../../src/shaders/render.wgsl?raw';
import understoryWgsl from '../../src/shaders/understory.wgsl?raw';
import { Camera, CAMERA_BYTES, CAMERA_CUT_BYTES } from '../../src/render/camera';
import { ALL_TREATMENTS } from '../../src/api/contracts/understory';
import { GLOBALS_BYTES } from '../../src/sim/globals';

/** a declaration's source out of a WGSL text (from `head` to the closing brace at the start of a line) */
function block(src: string, head: string): string {
  const s = src.replace(/\r\n/g, '\n');
  const i = s.indexOf(head);
  if (i < 0) throw new Error(`no ${head}`);
  const j = s.indexOf('\n}', i);
  return s.slice(i, j + 2) + (s[j + 2] === ';' ? ';' : '') + '\n';
}

const CAM_BYTES = CAMERA_BYTES + 64 + 16 + CAMERA_CUT_BYTES;

describe('the understory dither (understory.wgsl underHide)', () => {
  it('opens the floor round the hero, keeps stumps and the trunks beyond, and is off at weight 0', async () => {
    const g = await testGpu();
    const dev = g.device;
    const probe = `
${block(renderWgsl, 'struct Camera {')};
@group(0) @binding(10) var<uniform> CAM: Camera;
${block(renderWgsl, 'fn toEye(')}
${block(understoryWgsl, 'fn underHide(')}
@group(0) @binding(40) var<storage, read_write> outP: array<f32>;
@group(0) @binding(41) var<storage, read> pts: array<vec4<f32>>;
@compute @workgroup_size(8)
fn probe(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&pts)) { return; }
  let q = pts[id.x];
  // (w: the tree's foot along the eye's ground way from the hero, cells — the foot on the floor there)
  let e = normalize(CAM.eye.xy);
  let foot = vec3<f32>(CAM.under[0].xy + e * q.w, CAM.under[0].z);
  outP[id.x] = underHide(q.xyz, foot);
}
`;
    const k = makeCompute(dev, 'understory probe', [commonWgsl, probe], { 0: 'uniform', 10: 'uniform', 40: 'rw', 41: 'read' }, 'probe');
    const cam = new Camera();
    cam.viewportW = 412;
    cam.viewportH = 915;
    cam.zoom = 40;
    cam.target = [100, 100, 10];
    cam.update();
    const hero: [number, number, number] = [100, 100, 10];
    const e = cam.eye;
    const eh = Math.hypot(e[0], e[1]);
    const ex = [e[0] / eh, e[1] / eh];
    // a point at `d` cells toward the eye from the hero (along the ground) and `z` over the floor, on a tree whose foot is there
    const P: number[] = [];
    const at = (d: number, z: number, foot = d) => P.push(hero[0] + ex[0] * d, hero[1] + ex[1] * d, hero[2] + z, foot);
    at(3, 6); // 0 a trunk 3 cells in front of the hero, over head height: hides the hero's floor
    at(3, 1); // 1 the same trunk at its foot: a stump, kept
    at(-6, 6); // 2 a trunk 6 cells beyond the hero: kept (it frames the scene)
    // 3 a crown leaf high in front: its line from the eye lands on the hero (z / tan(elevation) cells on)
    const tanE = e[2] / eh;
    at(18 * (1 / tanE), 18, 18 * (1 / tanE));
    at(40, 18, 40); // 4 a crown far in front at the canopy's height: the canopy in front goes too (the floor opens)
    at(-12, 18, -12); // 5 a crown beyond the hero: kept (the canopy overhead, at the top of the screen)
    at(40, 4, 40); // 6 a trunk far in front, under the canopy: kept
    const pts = dev.createBuffer({ size: P.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(pts, 0, new Float32Array(P));
    const out = dev.createBuffer({ size: (P.length / 4) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const camBuf = dev.createBuffer({ size: CAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const glob = dev.createBuffer({ size: GLOBALS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const runWith = async (weight: number, canopy = 1): Promise<Float32Array> => {
      cam.understory = weight > 0 ? { weight, at: hero, canopyZ: hero[2] + 12, radius: 7, leaf: [0.8, 0.3, 0.1], treatments: { ...ALL_TREATMENTS, canopy } } : null;
      const data = new ArrayBuffer(CAM_BYTES);
      cam.write(data);
      dev.queue.writeBuffer(camBuf, 0, data);
      const enc = dev.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(k.pipeline);
      cp.setBindGroup(0, makeBindGroup(dev, 'understory probe', k.layout, { 0: glob, 10: camBuf, 40: out, 41: pts }));
      cp.dispatchWorkgroups(1);
      cp.end();
      dev.queue.submit([enc.finish()]);
      return new Float32Array(await g.read(out, (P.length / 4) * 4));
    };
    const on = await runWith(1);
    const kept = await runWith(1, 0);
    const off = await runWith(0);
    if (process.env.FOREST_LOG) console.log('underHide on', [...on], 'off', [...off]);
    expect(g.takeErrors()).toEqual([]);
    // the canopy left out (meshinst.wgsl's cut): only the keyhole through what stands in front of the hero
    expect(on[0]).toBeGreaterThan(0.9);
    expect(on[1]).toBe(0);
    expect(on[2]).toBe(0);
    // (3: on the eye's line through the hero — in the keyhole whatever it is)
    expect(on[3]).toBeGreaterThan(0.9);
    expect(on[4]).toBe(0);
    expect(on[5]).toBe(0);
    expect(on[6]).toBe(0);
    // the canopy kept: the crowns in front of the hero go, the ones beyond stay
    expect(kept[0]).toBeGreaterThan(0.9);
    expect(kept[3]).toBeGreaterThan(0.9);
    expect(kept[4]).toBeGreaterThan(0.9);
    expect(kept[5]).toBe(0);
    expect(kept[6]).toBe(0);
    for (const v of off) expect(v).toBe(0);
  });
});
