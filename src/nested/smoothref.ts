// Nested scales lab (round 14, NS-107, tests only): the GPU smooth draw against the reference (boxmesh.ts). A small chain
// of its own (root 64, level 1 64 wide, level 2 32 wide, so the plain-code reference runs in a second), carves across
// the level 2 rim and inside it; then every triangle the GPU draws (template + exceptions, read back by the draw's
// capture) is compared with the reference's collapse mesh after dropCapPairs, per level, as a multiset of triangles of
// placed points (local units; a parent's rim vertex in the child's units, flagged). Down caps on the bottom lattice are
// left out on both sides (the GPU bakes fans where the reference has two triangles a column; same rim edges).
import { GpuNest } from './gpu/nest';
import { Renderer } from './render';
import { boxMesh, collapseCols, dropCapPairs, place, type MeshScene } from './boxmesh';
import { manifold, rimJunctions } from './watertight';

export interface RefResult {
  name: string;
  pass: boolean;
  detail: string;
}

const K = 8;
const T = 2;

export async function smoothAgainstReference(device: GPUDevice, log: (s: string) => void = () => {}): Promise<RefResult[]> {
  const g = new GpuNest(device, K, 7, 256, { syncGrow: true });
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const render = new Renderer(device, canvas.getContext('webgpu')!, g);
  const must = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`smooth reference: ${what} refused`);
  };
  g.root(64);
  must(g.promote(1, { gx: 224, gy: 224, n: 64 }), 'promote 1');
  must(g.promote(2, { gx: 1888, gy: 1888, n: 32 }), 'promote 2');
  must(g.setSmooth(true), 'smooth');
  const top = async (L: number, X: number, Y: number) => {
    const s = await g.readAll();
    const r = s.records(L, X, Y);
    return r.top[r.top.length - 1];
  };
  // a carve on level 1 across level 2's rim (a pit under the surface), a tunnel-like carve at level 2, an add at level 1
  {
    const w = g.wins[1]!;
    const X = 236;
    const Y = 240;
    must(g.edit({ op: 'carve', radius: 0.5, amount: 0, at: { level: 1, x: X - w.gx, y: Y - w.gy, z: (await top(1, X, Y)) - 1 } }), 'carve 1');
  }
  {
    const w = g.wins[2]!;
    const X = 1900;
    const Y = 1900;
    must(g.edit({ op: 'carve', radius: 0.08, amount: 0, at: { level: 2, x: X - w.gx, y: Y - w.gy, z: (await top(2, X, Y)) - 6 } }), 'carve 2');
  }
  {
    const w = g.wins[1]!;
    const X = 270;
    const Y = 250;
    must(g.edit({ op: 'add', radius: 0.3, amount: 0, at: { level: 1, x: X - w.gx, y: Y - w.gy, z: (await top(1, X, Y)) + 1 } }), 'add 1');
  }
  await device.queue.onSubmittedWorkDone();
  const levels = [0, 1, 2].map((depth) => ({ depth, want: 0 }));
  const caps = await render.capture(levels);
  const s = await g.readAll();
  const scene: MeshScene = {
    k: K,
    levels: [0, 1, 2].map((L) => {
      const w = g.wins[L]!;
      const parts = [];
      for (let Y = w.gy; Y < w.gy + w.n; Y++) for (let X = w.gx; X < w.gx + w.n; X++) parts.push(s.records(L, X, Y));
      return { depth: L, gx: w.gx, gy: w.gy, n: w.n, zo: L ? s.zOrigin(L) : 0, parts };
    }),
  };
  const mesh = boxMesh(scene);
  const ref = dropCapPairs(mesh, place(mesh, collapseCols(mesh, T), scene));
  const out: RefResult[] = [];
  const fx = (v: number) => Math.fround(v).toString();
  const bottom = (z: number[]) => z[0] === z[1] && z[1] === z[2] && z[0] % 32 === 0;
  for (const cap of caps) {
    const L = cap.depth;
    const w = g.wins[L]!;
    const count = new Map<string, number>();
    const add = (pts: [number, number, number, boolean][], d: number) => {
      if (bottom(pts.map((p) => p[2]))) return;
      const key = pts.map((p) => `${p[0]},${p[1]},${fx(p[2])}${p[3] ? 'k' : ''}`).sort().join('|');
      count.set(key, (count.get(key) ?? 0) + d);
    };
    let gpu = 0;
    const t = cap.tris;
    for (let o = 0; o + 12 <= t.length; o += 12) {
      if (t[o + 3] === 0) continue;
      gpu++;
      add([0, 1, 2].map((v) => [t[o + v * 4], t[o + v * 4 + 1], t[o + v * 4 + 2], t[o + v * 4 + 3] === 2] as [number, number, number, boolean]), 1);
    }
    let nref = 0;
    for (const si of ref.src) {
      const tri = mesh.tris[si];
      if (tri.L !== L) continue;
      nref++;
      add(
        tri.v.map((vi) => {
          const id = mesh.ids[vi];
          const z = mesh.cluster(id, T).z;
          return id.L !== L ? ([id.cx / K - w.gx, id.cy / K - w.gy, z, true] as [number, number, number, boolean]) : ([id.cx - w.gx, id.cy - w.gy, z, false] as [number, number, number, boolean]);
        }),
        -1,
      );
    }
    // (the placed heights are an f32 mean: the GPU's division may differ from the correctly rounded one by an ulp or two,
    // so triangles left over are paired again with every vertex's x, y equal and z within 1e-5 relative)
    type V = { x: number; y: number; z: number; k: boolean };
    const parse = (key: string): V[] =>
      key
        .split('|')
        .map((s) => {
          const k = s.endsWith('k');
          const [x, y, z] = (k ? s.slice(0, -1) : s).split(',').map(Number);
          return { x, y, z, k };
        })
        .sort((a, b) => a.x - b.x || a.y - b.y || +a.k - +b.k || a.z - b.z);
    const left: [V[][], V[][]] = [[], []];
    for (const [k, c] of count) for (let i = 0; i < Math.abs(c); i++) left[c > 0 ? 0 : 1].push(parse(k));
    const close = (a: V[], b: V[]) => a.every((v, i) => v.x === b[i].x && v.y === b[i].y && v.k === b[i].k && Math.abs(v.z - b[i].z) <= 1e-5 * Math.max(1, Math.abs(v.z)));
    const used = new Set<number>();
    const gpuLeft: V[][] = [];
    for (const a of left[0]) {
      const j = left[1].findIndex((b, i) => !used.has(i) && close(a, b));
      if (j >= 0) used.add(j);
      else gpuLeft.push(a);
    }
    const refLeft = left[1].filter((_, i) => !used.has(i));
    const extra = gpuLeft.length;
    const missing = refLeft.length;
    const fmt = (t: V[]) => t.map((v) => `${v.x},${v.y},${v.z}${v.k ? 'k' : ''}`).join('|');
    const where = [...gpuLeft.slice(0, 2).map((t) => `gpu only ${fmt(t)}`), ...refLeft.slice(0, 2).map((t) => `reference only ${fmt(t)}`)];
    const m = manifold(cap);
    log(`L${L}: gpu ${gpu} triangles (${cap.ex} exception slots), reference ${nref}; gpu only ${extra}, reference only ${missing}; odd ${m.open}, degenerate ${m.degenerate}, coincident ${m.coincident} ${where.join('; ')}`);
    out.push({
      name: `smooth: level ${L}'s drawn triangles (template + exceptions) equal the reference collapse mesh after dropCapPairs (bottom-lattice down caps aside), closed`,
      pass: gpu > 0 && nref > 0 && extra === 0 && missing === 0 && m.open === 0 && m.degenerate === 0 && m.coincident === 0,
      detail: `gpu ${gpu}, reference ${nref}, gpu only ${extra}, reference only ${missing}, odd ${m.open}, degenerate ${m.degenerate}, coincident ${m.coincident}${where.length ? `: ${where.join('; ')}` : ''}`,
    });
  }
  const rim = rimJunctions(caps, g.wins.slice(0, 3) as { gx: number; gy: number; n: number }[], K);
  const j = rim.reduce((a, r) => a + r.junctions + r.unflagged, 0);
  out.push({ name: 'smooth: rim lines of the small chain, no junctions, every parent rim vertex in the child\'s units', pass: j === 0 && rim.every((r) => r.lines > 0), detail: JSON.stringify(rim.map((r) => ({ L: r.depth, lines: r.lines, junctions: r.junctions, unflagged: r.unflagged, where: r.where }))) });
  return out;
}
