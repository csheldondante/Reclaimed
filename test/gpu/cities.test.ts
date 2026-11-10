// Cities (round 120, `cities`; BACKLOG STR30-STR36) on Dawn in Node: a real (small) atlas's settlements have purposes
// and stories. (Switchover: the old towns' structures shaders and the ships between ports went with the old towns.)
import { describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import { Atlas, DEFAULT_ATLAS } from '../../src/atlas/atlas';
import { Settlements } from '../../src/settle/settlements';

describe('cities on the GPU', () => {
  it('a small atlas: every settlement has a purpose and a story', async () => {
    const g = await testGpu();
    const a = await Atlas.build(g.device, { ...DEFAULT_ATLAS, n: 512, cols: 4096, rows: 4736, sites: 30, craters: 4, oddities: 2, seed: 3 });
    const st = new Settlements(a);
    for (const s of st.all()) {
      expect(s.purpose, s.id).toBeTruthy();
      expect(s.story?.events[0].what).toBe('founded');
    }
    expect(g.takeErrors()).toEqual([]);
  });
});
