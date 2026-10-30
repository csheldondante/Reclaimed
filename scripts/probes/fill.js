// (round 112) the fill probe: a ring laid on the ground under the screen's middle, waited for, then the basin search from
// its middle — the basin, or why not, with the heights round the seed and along a ray to the wall
const r = window.reclaimed;
const hs = r.heroSandbox;
const api = hs.d.api;
const t = api.terrain;
await api.refresh();
const cam = r.camera;
const g = cam.groundAt(cam.viewportW / 2, cam.viewportH / 2, (x, y) => t.heightAt(x, y) ?? 0);
const c = [g[0], g[1]];
const ring = [];
for (let a = 0; a < 48; a++) ring.push({ kind: 'build', at: [c[0] + Math.cos((a * Math.PI) / 24) * 5.8, c[1] + Math.sin((a * Math.PI) / 24) * 5.8], material: 'concrete', radius: 1.1, layers: 6 });
hs.lay(ring);
while (r.globals.events.length) await new Promise((res) => setTimeout(res, 100));
await new Promise((res) => setTimeout(res, 1500));
const ray = [];
await api.refresh();
for (let d = 0; d <= 9; d += 0.5) ray.push(+(t.heightAt(c[0] + d, c[1]) ?? -1).toFixed(1));
const f = await hs.fill(c, 'water');
return { centre: c.map((v) => +v.toFixed(1)), ray: ray.join(' '), fill: f.error ?? { cells: f.basin.cells.length, level: f.basin.level, fillTo: f.basin.fillTo, spill: f.basin.spill, bottom: f.basin.bottom } };
