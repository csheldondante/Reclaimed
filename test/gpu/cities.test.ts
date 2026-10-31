// Cities (round 120, `cities`; BACKLOG STR30-STR36) on Dawn in Node: the structures' shaders — the game's (render.wgsl +
// structmesh.wgsl + structgame.wgsl: the pieces, the flames, the light pools, the wind's banners and the turning wheels)
// and the viewer's — compile; a real (small) atlas's settlements have purposes and stories, and its ships' routes lie
// on its sea.
import { describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import { Atlas, DEFAULT_ATLAS } from '../../src/atlas/atlas';
import { Settlements } from '../../src/settle/settlements';
import { along } from '../../src/settle/ships';
import { StructureGpu } from '../../src/structures/gpu';
import { piecesOf } from '../../src/structures/pieces';
import { planCity } from '../../src/structures/plan';
import commonWgsl from '../../src/shaders/common.wgsl?raw';
import materialsWgsl from '../../src/shaders/materials.wgsl?raw';
import terrainShapeWgsl from '../../src/shaders/terrainshape.wgsl?raw';
import renderWgsl from '../../src/shaders/render.wgsl?raw';
import structMeshWgsl from '../../src/shaders/structmesh.wgsl?raw';
import structGameWgsl from '../../src/shaders/structgame.wgsl?raw';
import viewerWgsl from '../../src/structures/viewer/viewer.wgsl?raw';

async function errorsOf(device: GPUDevice, code: string): Promise<string[]> {
  const m = device.createShaderModule({ code });
  const info = await m.getCompilationInfo();
  return info.messages.filter((x) => x.type === 'error').map((x) => `${x.lineNum}:${x.linePos} ${x.message}`);
}

describe('cities on the GPU', () => {
  it('the structures shaders compile (the game’s and the viewer’s), and pieces with purposes upload', async () => {
    const g = await testGpu();
    const sg = new StructureGpu(g.device);
    const game = [commonWgsl, materialsWgsl, terrainShapeWgsl, 'const RIVER_FOAM_SPEED: bool = false;\n', renderWgsl, sg.wgsl(), structMeshWgsl, structGameWgsl].join('\n');
    expect(await errorsOf(g.device, game)).toEqual([]);
    expect(await errorsOf(g.device, sg.wgsl() + structMeshWgsl + viewerWgsl)).toEqual([]);
    // a port's pieces (ships, piers, pools) and a moving ship
    const ground = (x: number) => (x > 20 ? 12 - (x - 20) * 0.3 : 12);
    const plan = planCity({ seed: 3, system: 'irregular', style: 'hearth', at: [0, 0], radius: 40, purpose: 'port' }, ground, (x) => Math.max(0, 11 - ground(x)));
    sg.set(piecesOf(plan));
    expect(sg.glow.length).toBeGreaterThan(0);
    sg.setMoving({ module: new Uint16Array(0), data: new Float32Array(0), building: new Int32Array(0), count: 0 });
    expect(g.takeErrors()).toEqual([]);
    sg.destroy();
  });

  it('a small atlas: every settlement has a purpose and a story; the ships sail on its sea', async () => {
    const g = await testGpu();
    const a = await Atlas.build(g.device, { ...DEFAULT_ATLAS, n: 512, cols: 4096, rows: 4736, sites: 30, craters: 4, oddities: 2, seed: 3 });
    const st = new Settlements(a);
    for (const s of st.all()) {
      expect(s.purpose, s.id).toBeTruthy();
      expect(s.story?.events[0].what).toBe('founded');
    }
    const fleet = st.fleet;
    const n = a.p.n;
    const wet = (x: number, y: number) => {
      const tx = ((Math.floor((x / a.worldW) * n) % n) + n) % n;
      const ty = ((Math.floor((y / a.worldH) * n) % n) + n) % n;
      return a.hmac[ty * n + tx] < a.p.sea;
    };
    let bad = 0;
    let checked = 0;
    for (const r of fleet.routes)
      for (let d = 0; d <= r.length; d += 4) {
        const [x, y] = along(r, d);
        checked++;
        if (!wet(x, y)) bad++;
      }
    if (process.env.CITIES_LOG) console.log(`purposes: ${JSON.stringify(st.all().reduce((m, s) => ((m[s.purpose!.kind] = (m[s.purpose!.kind] ?? 0) + 1), m), {} as Record<string, number>))}; ${fleet.routes.length} routes, ${fleet.count} ships, ${checked} points checked, charted in ${st.stats.fleetMs} ms`);
    // (the route's points on the sea: string-pulled over the coarse chart, a corner may clip a texel of shore)
    expect(bad / Math.max(1, checked)).toBeLessThan(0.01);
    expect(g.takeErrors()).toEqual([]);
  });
});
