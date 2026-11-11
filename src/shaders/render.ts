// The renderer's draw shader, in parts (2026-11-04, the monolith split; was render.wgsl, 2018 lines): each part
// a concern, joined here in the old order into the one module the pipelines compile (renderer.ts, mesh-draws.ts,
// features.ts). Shared snippets (common, materials, terrain shape) are still put in front by the pipelines' makers.
import common from './render/common.wgsl?raw';
import vertex from './render/vertex.wgsl?raw';
import light from './render/light.wgsl?raw';
import rock from './render/rock.wgsl?raw';
import fsBox from './render/fs-box.wgsl?raw';
import water from './render/water.wgsl?raw';
import bodies from './render/bodies.wgsl?raw';
import texbank from '../archgen/texbank.wgsl?raw';
import { urlFlags } from '../flags';

/** (ground branch) ?light=old: the old lighting (no specular, no texture roughness); ?groundtex=0: the terrain untextured */
const flags = urlFlags();
const switches = `const LIGHT_NEW: bool = ${flags.get('light') !== 'old'};
const GROUND_TEX: bool = ${flags.get('groundtex') !== '0'};
`;

/** the draw shader (was render.wgsl): its parts joined in order — one WGSL module, as before */
export const renderWgsl = [switches, texbank, common, vertex, light, rock, fsBox, water, bodies].join('');
