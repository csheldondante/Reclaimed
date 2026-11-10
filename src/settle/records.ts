// The settlements' records from the world wiki (round 88): one per atlas site, with the wiki's stable id (`s<n>`),
// name, region, realm, size and purpose; whether raiders camp near it (and whose). Pure data.
// (Switchover, 2026-11-10: the old planner's parts of a record — its people's profile, its ruin, its box of land, its
// roads' ways out, a planner override, structures placed — went with the planner.)
import type { Settlement } from '../api/contracts/settlement';
import type { FactionId } from '../api/contracts/world';
import type { WorldWiki } from '../gm/wiki';

/** the camp faction when no hostile power holds the region */
export const OUTLAWS: FactionId = 'f-outlaws';

export interface SettlementSeed {
  rec: Settlement;
  /** the raider camp near it, if any: its id and its faction */
  campId?: string;
  campFaction?: FactionId;
  /** the town generator's seed for it */
  seed: number;
  setting: string;
}

/** a site's draws (xorshift; the records' own stream a site — kept as it was so the camps stay where they were) */
function rand(seed: number): () => number {
  let s = (seed >>> 0) * 2654435761 + 1013904223;
  s = s >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function recordsFrom(wiki: WorldWiki, seed: number): SettlementSeed[] {
  const facs = new Map(wiki.factions.map((f) => [f.id, f]));
  return wiki.snapshot.settlements.map((s, i) => {
    const site = wiki.sites[i];
    if (site.id !== s.id) throw new Error(`wiki: site ${i} is ${site.id}, its settlement ${s.id}`);
    const r = rand(seed * 7919 + i * 104729 + 17);
    const region = wiki.snapshot.regions[s.region];
    const presence = region?.state.presence ?? {};
    // (the site's first two draws were the old planner's people's profile — its era and its civ — before the switchover;
    // drawn still, so each site's camp roll is the one it always had: ?town=1 lands on the same town, Muru)
    r();
    r();
    // raiders: the region's hostile powers (the Court, the Fleet at the ports), else outlaws, near some
    const hostile = Object.entries(presence)
      .filter(([f, v]) => (facs.get(f)?.attitude ?? 0) < 0 && (v ?? 0) > 0.15)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    const roll = r();
    const campFaction = hostile.length && roll < 0.5 ? (hostile[0][0] as FactionId) : roll < 0.2 ? OUTLAWS : undefined;
    const rec: Settlement = { ...structuredClone(s), grids: [], buildings: [], people: [], stores: {}, needs: [] };
    return {
      rec,
      campId: campFaction ? `${s.id}-camp` : undefined,
      campFaction,
      seed: (seed * 1000003 + i * 7907) >>> 0,
      setting: site.setting,
    };
  });
}
