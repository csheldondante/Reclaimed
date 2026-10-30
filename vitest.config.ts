// The test pyramid's Node tiers (docs/TESTING.md). Both run in Node — no browser, no page:
//   unit  test/unit/**, src/**/*.test.ts (beside their code: tilecal's round 115)   pure TS (contracts, planners, the tick clock, the rigid rock on CPU columns, records, hashes);
//                        parallel across files, each file isolated
//   gpu   test/gpu/**    real WGSL kernels on real Dawn (the npm `webgpu` package: navigator.gpu in Node, D3D12 here)
//                        through the game's own pipeline/bind-group code, on tiny worlds; the files in turn, each in
//                        a fresh worker (round 117: a shared one crashed Dawn)
// Both extend vite.config.ts: the same defines (__GEN_HASH__, …) and `?raw` WGSL imports as the game's build.
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        // (the pyramid's order: unit first, then gpu — sequence.groupOrder)
        { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts', 'src/**/*.test.ts'], environment: 'node', sequence: { groupOrder: 0 } } },
        {
          extends: true,
          test: {
            name: 'gpu',
            include: ['test/gpu/**/*.test.ts'],
            environment: 'node',
            setupFiles: ['test/gpu/setup.ts'],
            sequence: { groupOrder: 1 },
            // (one file at a time, each in a fresh worker — round 117, terrain: in one shared worker Dawn's process died
            // ("Worker exited unexpectedly") as soon as a second file made a WorldCore, in some worktrees and not others,
            // and after a whole atlas was built; isolated, every file pays its own pipelines' compile (the tier ~16 s
            // instead of ~13) and none can take another down — docs/TESTING.md, BACKLOG TK12)
            fileParallelism: false,
            isolate: true,
            testTimeout: 60_000,
            hookTimeout: 60_000,
          },
        },
      ],
    },
  }),
);
