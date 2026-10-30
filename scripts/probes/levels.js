// (round 112) is the world API's heightAt reading the levels texture at the right texel? For 400 columns: the GPU
// layers' top (read back) against the mirrored levels texture read at the per-column buffer index (what
// Terrain.col does: the ring's idx) and at the texture's own texel (the page's place in the texture, row-major)
const r = window.reclaimed;
const api = r.heroSandbox.d.api;
const t = api.terrain;
await api.refresh();
const { readColumn } = await import('/src/world/layout.ts');
const lay = new Uint32Array((await r.core.readBuffer('layers')).buffer);
const lv = t.mirror.f32('levels');
const ring = r.core.ring;
const { w: W, h: H } = r.core.dims;
let byBuf = 0, byTex = 0, byApi = 0, n = 0;
const bad = [];
for (let k = 0; k < 400; k++) {
  const cx = Math.floor(Math.random() * W);
  const cy = Math.floor(Math.random() * H);
  const ivs = readColumn(r.core.packed, lay, cx, cy);
  const top = ivs.length ? ivs[ivs.length - 1].z1 : 0;
  const bi = ring.idx(cx, cy);
  const s = ring.slot(cx >> 4, cy >> 4);
  const [px, py] = ring.texPage(s);
  const ti = (py + (cy & 15)) * W + px + (cx & 15);
  const vb = lv[bi * 4];
  const vt = lv[ti * 4];
  n++;
  if (Math.abs(vb - top) < 0.6) byBuf++;
  if (Math.abs(vt - top) < 0.6) byTex++;
  const { cellPos } = await import('/src/world/lattice.ts');
  const [wx, wy] = cellPos(cx, cy);
  if (Math.abs((t.heightAt(wx, wy) ?? -99) - top) < 0.6) byApi++;
  if (bad.length < 2 && Math.abs(vb - top) >= 0.6) bad.push({ cx, cy, top: +top.toFixed(1), byBuf: +vb.toFixed(1), byTex: +vt.toFixed(1) });
}
return { n, byBuf, byTex, byApi, W, H, nx: ring.nx, ny: ring.ny, ox: ring.ox, oy: ring.oy, bad };
