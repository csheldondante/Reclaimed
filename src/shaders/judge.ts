// Judge B, the method of sections on the GPU, in parts (2026-11-04, the monolith split; was judge.wgsl, 1890
// lines): joined here in the old order into the one module game/judge.ts compiles.
import defs from './judge/defs.wgsl?raw';
import build from './judge/build.wgsl?raw';
import pieces from './judge/pieces.wgsl?raw';
import sections from './judge/sections.wgsl?raw';
import release from './judge/release.wgsl?raw';

/** judge B's kernels (was judge.wgsl): its parts joined in order — one WGSL module, as before */
export const judgeWgsl = [defs, build, pieces, sections, release].join('');
