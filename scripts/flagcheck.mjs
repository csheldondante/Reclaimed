// (DA-B17) What a built page actually runs with on each tier: the phone's set (src/flags.ts) applied where the modules
// read it as they load — the production build is what GitHub Pages serves the phone. Before DA-B17 the built page ran
// the low tier without the shadow cache, prepEvery and in-place columns (the dev server had them). Checks, in the
// `town` lab on the build: the renderer's shadow cache and prep rate, the static shadow map's size, and whether the
// column passes copy the whole layers back over a second of ticks (none on any tier since DA-B14).
//   node scripts/flagcheck.mjs [--dev]
import { run } from './lib/runner.mjs';

await run({ name: 'flagcheck', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const cases = [
    { label: 'no q (the phone link without a tier)', params: {}, phone: true },
    { label: 'q=low', params: { q: 'low' }, phone: true },
    { label: 'q=high', params: { q: 'high' }, phone: false },
  ];
  for (const c of cases) {
    const p = await R.level({ level: 'lab', lab: 'town', ...c.params }, { noDefaultQ: true });
    const got = await p.evaluate(async () => {
      const api = window.reclaimed;
      const r = api.core.renderer;
      let copies = 0;
      const P = GPUCommandEncoder.prototype;
      const bb = P.copyBufferToBuffer;
      P.copyBufferToBuffer = function (s, so, d) {
        if (d.label === 'layers' && s.label === 'layersNext') copies++;
        return bb.apply(this, arguments);
      };
      const t0 = api.core.sim.tick;
      await api.lab.run(1, 1, { renderEvery: 1 });
      P.copyBufferToBuffer = bb;
      return {
        url: location.search,
        shadowCache: r.constructor.opts.shadowCache,
        prepEvery: r.constructor.opts.prepEvery,
        shadowStill: r.shadowStill.width,
        shadowLive: r.shadowTex.width,
        ticks: api.core.sim.tick - t0,
        layersCopies: copies,
      };
    });
    await p.close();
    R.log(`${c.label}: ${JSON.stringify(got)}`);
    const ok = c.phone
      ? got.shadowCache === 4 && got.prepEvery === 2 && got.shadowStill === got.shadowLive && got.shadowLive === 512
      : got.shadowCache === 0 && got.prepEvery === 1 && got.shadowStill === 1;
    // (DA-B14: the column passes write in place on every tier — no whole-layers copy-back on any)
    R.check(`${c.label}: ${c.phone ? "the phone's set applied (shadow cache 4, prep every 2, 512² maps)" : 'the desktop render path (no cache)'}; columns in place`, ok && got.ticks > 0 && got.layersCopies === 0, got);
  }
});
