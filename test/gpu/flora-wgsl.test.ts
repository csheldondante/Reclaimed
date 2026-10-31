// (round 117, flora) The shaders the flora track touches compile on real Dawn in Node (the gpu tier, docs/TESTING.md), assembled the way renderer.ts assembles them: a WGSL error is found here in a
// second instead of in a shared-browser run. Compile only (no dispatch): the kernels' behaviour is checked in the page.
import { beforeAll, describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import commonWgsl from '../../src/shaders/common.wgsl?raw';
import materialsWgsl from '../../src/shaders/materials.wgsl?raw';
import vegplanWgsl from '../../src/shaders/vegplan.wgsl?raw';
import terrainShapeWgsl from '../../src/shaders/terrainshape.wgsl?raw';
import meshStateWgsl from '../../src/shaders/meshstate.wgsl?raw';
import meshRegionWgsl from '../../src/shaders/meshregion.wgsl?raw';
import vegprepWgsl from '../../src/shaders/vegprep.wgsl?raw';
import floraPutWgsl from '../../src/shaders/floraput.wgsl?raw';
import floraFieldWgsl from '../../src/shaders/florafield.wgsl?raw';
import renderWgsl from '../../src/shaders/render.wgsl?raw';
import meshInstWgsl from '../../src/shaders/meshinst.wgsl?raw';
import floraLookWgsl from '../../src/shaders/floralook.wgsl?raw';
import { pagesCode } from '../../src/gpu/pages-mode';
import { FloraLibrary } from '../../src/flora/library';
import { buildScene, sceneWgsl } from '../../src/flora/scene';
import viewerWgsl from '../../src/flora/viewer.wgsl?raw';
import layersWgsl from '../../src/shaders/layers.wgsl?raw';
import meshSourceWgsl from '../../src/shaders/meshsource.wgsl?raw';
import meshDrawWgsl from '../../src/shaders/meshdraw.wgsl?raw';
import { MI_ARGS_WORD, MI_CAP } from '../../src/render/meshinst';

let device: GPUDevice;

beforeAll(async () => {
  device = (await testGpu()).device;
});

/** meshinst.ts MeshInstances.wgsl(), without a device */
function miWgsl(kinds: { verts: Float32Array }[]): string {
  let base = 0;
  const rows = kinds.map((k) => {
    const r = `vec2<u32>(${base}u, ${base + k.verts.length / 4}u)`;
    base += k.verts.length / 4;
    return r;
  });
  return `const MI_CAP: u32 = ${MI_CAP}u;\nconst MI_N: u32 = ${kinds.length}u;\nconst MI_ARGS: u32 = ${MI_ARGS_WORD}u;\nconst MI_KINDS = array<vec2<u32>, ${kinds.length}>(${rows.join(', ')});\n`;
}

async function errors(label: string, parts: string[]): Promise<string[]> {
  const code = pagesCode(parts.join('\n'), false);
  const m = device.createShaderModule({ label, code });
  const info = await m.getCompilationInfo();
  const lines = code.split('\n');
  return info.messages.filter((e) => e.type === 'error').map((e) => `${label}:${e.lineNum}:${e.linePos} ${e.message}\n  > ${lines[e.lineNum - 1]?.trim()}`);
}

describe('flora shaders compile (Dawn)', () => {
  const lib = new FloraLibrary();
  for (const flora of [true, false]) {
    const floraWgsl = `const FLORA: bool = ${flora};const FLORA_RPX: f32 = 0.5;\n${flora ? lib.wgsl() : FloraLibrary.stubWgsl()}`;
    const mi = flora ? miWgsl(lib.kinds) : 'const MI_CAP: u32 = 0u;\nconst MI_N: u32 = 1u;\nconst MI_ARGS: u32 = 24u;\n';
    it(`vegprep (flora ${flora})`, async () => {
      const treeMesh = `const TREE_MESH: bool = ${flora};\n${mi}${floraWgsl}`;
      expect(await errors('vegprep', [commonWgsl, materialsWgsl, vegplanWgsl, terrainShapeWgsl, meshStateWgsl, meshRegionWgsl, 'const TUFTS: bool = true;', treeMesh, floraPutWgsl, vegprepWgsl])).toEqual([]);
    });
    if (flora)
      it('florafield (reeds by water)', async () => {
        const treeMesh = `const TREE_MESH: bool = true;
${mi}${floraWgsl}`;
        expect(await errors('florafield', [commonWgsl, materialsWgsl, terrainShapeWgsl, meshStateWgsl, meshRegionWgsl, treeMesh, floraPutWgsl, floraFieldWgsl])).toEqual([]);
      });
  }
  it('meshinst (flora)', async () => {
    const riverFoam = 'const RIVER_FOAM_SPEED: bool = false;\n';
    const floraWgsl = `const FLORA: bool = true;const FLORA_RPX: f32 = 0.5;\n${lib.wgsl()}`;
    expect(await errors('meshinst', [commonWgsl, materialsWgsl, terrainShapeWgsl, riverFoam, miWgsl(lib.kinds), floraWgsl, renderWgsl, floraLookWgsl, meshInstWgsl])).toEqual([]);
  });
  it('the viewer page (ruin scene: hosts, ivy, moss)', async () => {
    const sc = buildScene('ruin', 1);
    expect(await errors('viewer', [commonWgsl, materialsWgsl, sceneWgsl(sc.kinds), floraLookWgsl, viewerWgsl])).toEqual([]);
  });
  it('the field mesh draw (the woodland floor in leaf litter)', async () => {
    const riverFoam = 'const RIVER_FOAM_SPEED: bool = false;' + String.fromCharCode(10);
    expect(await errors('mesh-draw', [commonWgsl, layersWgsl, materialsWgsl, terrainShapeWgsl, riverFoam, renderWgsl, meshStateWgsl, meshRegionWgsl, 'const MESH_LOOK: u32 = 0u;', 'const TUFTS_DRAWN: bool = true;', meshSourceWgsl, meshDrawWgsl])).toEqual([]);
  });
});
