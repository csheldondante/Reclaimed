// The gpu tier's setup (docs/TESTING.md): real Dawn in Node (the npm `webgpu` package) — navigator.gpu and the WebGPU
// globals (GPUBufferUsage, GPUBuffer, …) the game's code uses, as a page has them. No browser, no canvas.
// If Dawn can't make an adapter here the tier fails loudly (UnsupportedError from the game's own requestGpu) — never
// skipped.
import { create, globals } from 'webgpu';

Object.assign(globalThis, globals);
// (Dawn's own toggles: none — the defaults are the browser's D3D12 backend on Windows)
const gpu = create(process.env.DAWN_FLAGS ? process.env.DAWN_FLAGS.split(' ') : []);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });
// (many modules read their ?switches from location.search at load: a page with no query — the deployed defaults)
if (typeof globalThis.location === 'undefined') Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/'), configurable: true });
// (the renderer — WorldCore makes one — sizes its tile cache from the viewport at load: the phone proxy's, 412 × 915)
Object.assign(globalThis, { innerWidth: 412, innerHeight: 915, devicePixelRatio: 1 });
