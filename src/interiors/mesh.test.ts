// The interior's mesh from a planned hall (vitest, Node): every storey has geometry, nothing is NaN, the props' faces
// are greedy-merged (far fewer than a face a voxel), the window frame applied.
import { describe, expect, it } from 'vitest';
import { planCity } from '../structures/plan';
import { planInterior } from './plan';
import { propSize, prop } from './props';
import { buildInteriorMesh } from './mesh';

describe('interiors: the mesh', () => {
  it('a hall: geometry on every storey, finite, merged faces, in the window frame', () => {
    const city = planCity({ seed: 7, system: 'irregular', style: 'hearth', at: [500, 500], radius: 40 }, () => 10);
    const b = city.buildings.filter((x) => !x.mega && x.quads.length >= 2 && city.quadBuilding[x.quads[0]] === x.id).sort((a, c) => c.quads.length * c.storeys - a.quads.length * a.storeys)[0];
    const { plan } = planInterior(city, b.id, 'hall', propSize);
    const m = buildInteriorMesh(plan, { dx: -480, dy: -470, oz: 5 });
    expect(m.vertices % 3).toBe(0);
    expect(m.storeys.length).toBe(plan.storeys.length);
    for (const s of m.storeys) expect(s.count).toBeGreaterThan(100);
    const f = new Float32Array(m.data.buffer);
    let lo = Infinity;
    let hi = -Infinity;
    let bad = 0;
    for (let v = 0; v < m.vertices; v++) {
      for (const k of [0, 1, 2, 4, 5, 6]) if (!Number.isFinite(f[v * 8 + k])) bad++;
      lo = Math.min(lo, f[v * 8]);
      hi = Math.max(hi, f[v * 8]);
    }
    expect(bad).toBe(0);
    // (moved by the frame: the town at ~500 is now near 20)
    expect(lo).toBeGreaterThan(-10);
    expect(hi).toBeLessThan(80);
    // greedy faces: a prop's quads are far fewer than its surface voxels' faces
    const voxels = plan.storeys.flatMap((s) => s.props).reduce((a, p) => a + prop(p.prop).vox.length / 4, 0);
    expect(m.stats.propTris / 2).toBeLessThan(voxels * 1.2);
    console.log(`mesh: ${m.stats.tris} tris (${m.stats.propTris} props'), ${m.vertices * 32 / 1024 | 0} KB, ${m.stats.ms} ms; props' voxels ${voxels}`);
  });
});
