// (interiors) The shaders the interiors touch compile on real Dawn in Node, assembled as the game assembles them
// (renderer.ts addLitDraw / enableStructures, inhabitants' system, pixelpost.ts): a WGSL error found here in a second.
import { beforeAll, describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import commonWgsl from '../../src/shaders/common.wgsl?raw';
import materialsWgsl from '../../src/shaders/materials.wgsl?raw';
import terrainShapeWgsl from '../../src/shaders/terrainshape.wgsl?raw';
import renderWgsl from '../../src/shaders/render.wgsl?raw';
import interiorWgsl from '../../src/shaders/interior.wgsl?raw';
import structMeshWgsl from '../../src/shaders/structmesh.wgsl?raw';
import structGameWgsl from '../../src/shaders/structgame.wgsl?raw';
import lifeWgsl from '../../src/shaders/inhabitants.wgsl?raw';
import postWgsl from '../../src/shaders/pixelpost.wgsl?raw';
import { pagesCode } from '../../src/gpu/pages-mode';
import { StructureGpu } from '../../src/structures/gpu';

let device: GPUDevice;

beforeAll(async () => {
  device = (await testGpu()).device;
});

async function errors(label: string, parts: string[]): Promise<string[]> {
  const code = pagesCode(parts.join('\n'), false);
  const m = device.createShaderModule({ label, code });
  const info = await m.getCompilationInfo();
  const lines = code.split('\n');
  return info.messages.filter((e) => e.type === 'error').map((e) => `${label}:${e.lineNum}:${e.linePos} ${e.message}\n  > ${lines[e.lineNum - 1]?.trim()}`);
}

const head = [commonWgsl, materialsWgsl, terrainShapeWgsl, 'const RIVER_FOAM_SPEED: bool = false;\n', renderWgsl];

describe('interiors shaders compile (Dawn)', () => {
  it('interior (the draw and the shafts)', async () => {
    expect(await errors('interior', [...head, interiorWgsl])).toEqual([]);
  });
  it('structures (the veil, glass without a shadow)', async () => {
    const sg = new StructureGpu(device);
    expect(await errors('structures', [...head, sg.wgsl(), structMeshWgsl, structGameWgsl])).toEqual([]);
  });
  it('inhabitants (the puppets)', async () => {
    expect(await errors('inhabitants', [commonWgsl, lifeWgsl])).toEqual([]);
  });
  it('pixel post', async () => {
    expect(await errors('pixelpost', [postWgsl])).toEqual([]);
  });
});
