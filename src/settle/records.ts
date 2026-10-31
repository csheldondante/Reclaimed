// The settlements' records from the world wiki (round 88): one per atlas site, with the wiki's stable id
// (`s<n>`), name, region and realm; its people's profile picked from the realm's era and the site's setting;
// whether it stands on an older people's ruin; whether raiders camp near it (and whose); the box of land
// it's planned over (whole streamer regions). Pure data: the planner (plan.ts) does the rest on arrival.
import type { Settlement } from '../api/contracts/settlement';
import type { FactionId } from '../api/contracts/world';
import type { WorldWiki } from '../gm/wiki';
import { ROW_H } from '../world/lattice';
import { campCiv, pickCiv, type CivEntry } from './catalogue';
import { BOX_PAD, builtRadius } from './plan';
import { rand } from './grids';

/** the streamer's region: a settlement's box is whole ones */
const REGION = 64;

/** the camp faction when no hostile power holds the region */
export const OUTLAWS: FactionId = 'f-outlaws';

export interface SettlementSeed {
  rec: Settlement;
  civ: CivEntry;
  camp: CivEntry | null;
  campId?: string;
  campFaction?: FactionId;
  seed: number;
  setting: string;
  ruin: boolean;
  box: { x0: number; y0: number; w: number; h: number };
  /** (round 120) the ways its roads leave by (unit vectors toward the settlements they join): a trading post's caravan
   *  yards stand by them */
  approaches: [number, number][];
  /** (the level's ?city=) its town planned with another tile system or style */
  override?: Partial<import('../api/contracts/structures').CitySpec>;
}

export function recordsFrom(wiki: WorldWiki, seed: number): SettlementSeed[] {
  const facs = new Map(wiki.factions.map((f) => [f.id, f]));
  const byId = new Map(wiki.snapshot.settlements.map((x) => [x.id, x]));
  const W = wiki.world.w;
  const H = wiki.world.h;
  return wiki.snapshot.settlements.map((s, i) => {
    const site = wiki.sites[i];
    if (site.id !== s.id) throw new Error(`wiki: site ${i} is ${site.id}, its settlement ${s.id}`);
    const r = rand(seed * 7919 + i * 104729 + 17);
    const fac = s.faction ? facs.get(s.faction) : undefined;
    const region = wiki.snapshot.regions[s.region];
    const presence = region?.state.presence ?? {};
    // the people: the realm's era; where an industrial power works the land (the Ashwrights), its foundry
    // towns; the cliff cities half the time the keepers of old law's (until the GM's eras say otherwise)
    let era = fac?.type === 'realm' ? fac.era : 'free';
    const eraRoll = r();
    const works = Object.entries(presence).some(([f, v]) => facs.get(f)?.era === 'industrial' && (v ?? 0) >= 0.25);
    if (works && eraRoll < 0.8) era = 'industrial';
    else if (site.setting === 'cliffside' && eraRoll < 0.45) era = 'ancient';
    const civ = pickCiv(era, site.setting, r());
    // raiders: the region's hostile powers (the Court, the Fleet at the ports), else outlaws, near some
    const hostile = Object.entries(presence)
      .filter(([f, v]) => (facs.get(f)?.attitude ?? 0) < 0 && (v ?? 0) > 0.15)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    const roll = r();
    const campFaction = hostile.length && roll < 0.5 ? (hostile[0][0] as FactionId) : roll < 0.2 ? OUTLAWS : undefined;
    const ruin = (region?.state.ruin ?? 0) > 0.3 || r() < 0.25;
    const rec: Settlement = { ...structuredClone(s), grids: [], buildings: [], people: [], stores: {}, needs: [] };
    const reach = builtRadius(rec.size) + BOX_PAD;
    const [cx, cy] = site.cell;
    const rows = reach / ROW_H;
    const x0 = Math.floor((cx - reach) / REGION) * REGION;
    const x1 = Math.ceil((cx + reach) / REGION) * REGION;
    const y0 = Math.floor((cy - rows) / REGION) * REGION;
    const y1 = Math.ceil((cy + rows) / REGION) * REGION;
    // (the roads' ways out: toward each neighbour, the world wrapping)
    const approaches = site.roads.map((id): [number, number] => {
      const o = byId.get(id)!;
      let dx = o.at[0] - s.at[0];
      let dy = o.at[1] - s.at[1];
      dx -= Math.round(dx / W) * W;
      dy -= Math.round(dy / H) * H;
      const L = Math.hypot(dx, dy) || 1;
      return [+(dx / L).toFixed(4), +(dy / L).toFixed(4)];
    });
    return {
      rec,
      approaches,
      civ,
      camp: campFaction ? campCiv() : null,
      campId: campFaction ? `${s.id}-camp` : undefined,
      campFaction,
      seed: (seed * 1000003 + i * 7907) >>> 0,
      setting: site.setting,
      ruin,
      box: { x0, y0, w: x1 - x0, h: y1 - y0 },
    };
  });
}
