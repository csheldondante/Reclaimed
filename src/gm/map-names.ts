// (round 91) The world wiki's names as the atlas map's labels (api/map-labels.ts): the same names the GM's
// stories use, because they're made by the same code from the same atlas — atlasFacts (gm/atlas-facts.ts) then
// buildWiki (gm/wiki.ts), here in the page from the live atlas instead of from data/wiki's cache, so a world of
// any seed is named as its wiki would name it. Continents (at the land nearest the middle of their regions),
// every region (the seas, the lakes, the land), the atlas's lakes, every settlement by its size.

// (Runs in Node too, for scripts: type imports only.)
import type { LabelKind, MapLabel } from '../api/map-labels';
import type { WorldWiki } from './wiki';

/** the labels of a wiki; `area` a region's area (texels: atlasFacts' RegionFacts.area) */
export function wikiLabels(w: WorldWiki, area: (region: number) => number): MapLabel[] {
  const out: MapLabel[] = [];
  const W = w.world.w;
  const H = w.world.h;
  // continents: the circular mean of their regions' centres (a torus), weighted by area, moved to the
  // nearest of their own regions' centres (a crescent's mean is in the sea)
  for (const c of w.continents) {
    const rs = w.regions.filter((r) => r.land && r.continent === c.name);
    if (!rs.length) continue;
    let sx = 0;
    let cx = 0;
    let sy = 0;
    let cy = 0;
    for (const r of rs) {
      const k = area(r.id);
      sx += Math.sin((2 * Math.PI * r.centre[0]) / W) * k;
      cx += Math.cos((2 * Math.PI * r.centre[0]) / W) * k;
      sy += Math.sin((2 * Math.PI * r.centre[1]) / H) * k;
      cy += Math.cos((2 * Math.PI * r.centre[1]) / H) * k;
    }
    const mx = ((Math.atan2(sx, cx) / (2 * Math.PI)) * W + W) % W;
    const my = ((Math.atan2(sy, cy) / (2 * Math.PI)) * H + H) % H;
    const d = (r: (typeof rs)[number]) => {
      const dx = Math.abs(r.centre[0] - mx) % W;
      const dy = Math.abs(r.centre[1] - my) % H;
      return Math.hypot(Math.min(dx, W - dx), Math.min(dy, H - dy));
    };
    const at = rs.reduce((b, r) => (d(r) < d(b) ? r : b));
    out.push({ name: c.name, kind: 'continent', x: at.centre[0], y: at.centre[1], weight: c.area });
  }
  for (const r of w.regions) {
    const kind: LabelKind = r.kind === 'ocean' ? 'sea' : r.kind === 'lake' ? 'lake' : 'region';
    out.push({ name: r.name, kind, x: r.centre[0], y: r.centre[1], weight: area(r.id), region: r.id });
  }
  // the atlas's own lakes (round 90, named by the wiki since the lakes merge)
  for (const l of w.lakes ?? []) out.push({ name: l.name, kind: 'lake', x: l.at[0], y: l.at[1], weight: l.area });
  const RANK: Record<string, number> = { village: 1, town: 2, city: 3, metropolis: 4 };
  w.sites.forEach((site, i) => {
    const s = w.snapshot.settlements[i];
    const kind = (RANK[site.atlasSize] ? site.atlasSize : 'village') as LabelKind;
    out.push({ name: s.name, kind, x: s.at[0], y: s.at[1], weight: s.radius });
  });
  return out;
}
