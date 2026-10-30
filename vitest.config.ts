// The test pyramid's Node tiers (docs/TESTING.md). Both run in Node — no browser, no page:
//   unit  test/unit/**, src/**/*.test.ts (beside their code: tilecal's round 115)   pure TS (contracts, planners, the tick clock, the rigid rock on CPU columns, records, hashes);
//                        parallel across files, each file isolated
//   gpu   test/gpu/**    real WGSL kernels on real Dawn (the npm `webgpu` package: navigator.gpu in Node, D3D12 here)
//                        through the game's own pipeline/bind-group code, on tiny worlds; one worker, the files in
//                        turn on one device (what Dawn compiled for it shared)
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
            // (one worker, not isolated: the files share one Dawn device and what it compiled — test/gpu/dawn.ts)
            fileParallelism: false,
            isolate: false,
            testTimeout: 60_000,
            hookTimeout: 60_000,
          },
        },
      ],
    },
  }),
);
