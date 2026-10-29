// (round 112) the wall probe: one ring laid a column at a time (hs.lay) on the ground under the screen's middle, then,
// every 250 ms for 6 s, its columns read three ways: the world API's mirror (heightAt, layersAt) and the GPU (the
// layers buffer read back): "not written" (the GPU's columns unchanged) told from "not seen" (the mirror stale).
const r = window.reclaimed;
const hs = r.heroSandbox;
const api = hs.d.api;
const t = api.terrain;
const { readColumn } = await import('/src/world/layout.ts');
const { cellAt } = await import('/src/world/lattice.ts');
const { perColumn } = await import('/src/hero/gauntlet.ts');
await api.refresh();
const cam = r.camera;
const g = cam.groundAt(cam.viewportW / 2, cam.viewportH / 2, (x, y) => t.heightAt(x, y) ?? 0);
const c = [g[0], g[1]];
const ring = [];
for (let a = 0; a < 48; a++) ring.push({ kind: 'build', at: [c[0] + Math.cos((a * Math.PI) / 24) * 5.8, c[1] + Math.sin((a * Math.PI) / 24) * 5.8], material: 'concrete', radius: 1.1, layers: 6 });
const cols = perColumn(ring);
const cells = cols.map((q) => cellAt(q.at[0], q.at[1]));
const top = (ivs) => (ivs.length ? ivs[ivs.length - 1].z1 : 0);
const gpuTops = async () => {
  const lay = new Uint32Array((await r.core.readBuffer('layers')).buffer);
  return cells.map(([x, y]) => top(readColumn(r.core.packed, lay, x, y)));
};
const before = await gpuTops();
const mir0 = cols.map((q) => t.heightAt(q.at[0], q.at[1]));
hs.lay(ring);
const queued0 = r.globals.events.length;
const out = [{ t: 0, queued: queued0, cols: cols.length, centre: c.map((v) => +v.toFixed(1)), tick: r.globals.tick }];
for (let k = 1; k <= 24; k++) {
  await new Promise((res) => setTimeout(res, 250));
  await api.refresh();
  const gpu = await gpuTops();
  const mir = cols.map((q) => t.heightAt(q.at[0], q.at[1]));
  const layMir = cols.map((q) => top(t.layersAt(q.at[0], q.at[1]) ?? []));
  out.push({
    t: k * 0.25,
    tick: r.globals.tick,
    queued: r.globals.events.length,
    gpuUp: gpu.filter((z, i) => z >= before[i] + 4.5).length,
    gpuRaised: gpu.filter((z, i) => z > before[i] + 0.5).length,
    mirrorUp: mir.filter((z, i) => z !== null && z >= mir0[i] + 4.5).length,
    layersMirrorUp: layMir.filter((z, i) => z >= before[i] + 4.5).length,
    sample: [0, 1, 2, 47].map((i) => ({ cell: cells[i], before: +before[i].toFixed(1), gpu: +gpu[i].toFixed(1), mirror: mir[i] === null ? null : +mir[i].toFixed(1), layersMirror: +layMir[i].toFixed(1) })),
  });
}
return out.filter((o, i) => i === 0 || i % 4 === 0 || i === 24).map((o) => `${o.t}s queued ${o.queued} gpuUp ${o.gpuUp} mirrorUp ${o.mirrorUp} layersMirrorUp ${o.layersMirrorUp}`).join(' | ');
