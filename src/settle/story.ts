// A settlement's story (round 120, `cities`; BACKLOG STR30). The user: "towns should have stories". A founding reason
// (its purpose's: the land it was founded for), an owner (its realm, or nobody: a free town) and a history — what the
// world state says happened to it, shown in its fabric (plan.ts → contracts/structures.ts CityMark): a quarter burned
// (gutted houses, soot), walls raised after a raid (newer stone than the town), the lower town flooded (its low houses
// standing empty below a waterline).
//
// Where the history comes from, in order: the world state's events in its region (WorldState.history: burn, flood, ruin,
// rebuild, faction-presence — what runs and stories did), then what its standing in the world implies of the deep past
// (a hostile power strong in its region raided it, so it was walled; a port or river town low by the water flooded; a
// raid by a strong enough power burned a quarter). Deterministic: the same world, the same story. Pure, like purpose.ts:
// the wiki calls it while it's built, so the GM reads it.
import type { SettlementPurposeRec, SettlementStory, SettlementStoryEvent } from '../api/contracts/settlement';
import type { AtlasEvent } from '../api/contracts/world';
import type { FactionId } from '../api/contracts/world';

export interface StoryFacts {
  id: string;
  name: string;
  at: [number, number];
  size: string;
  setting: string;
  purpose: SettlementPurposeRec;
  owner: FactionId | null;
  ownerName: string | null;
  /** its ground and the sea's (world z) */
  ground: number;
  sea: number;
  /** the hostile powers present in its region, strongest first */
  hostiles: { id: FactionId; name: string; v: number }[];
  /** its region's state now (RegionState's ruin and flood level) */
  ruin: number;
  flooded: number | null;
  /** the world state's events in its region, oldest first */
  history: AtlasEvent[];
}

/** a deterministic hash of a string (the settlement's id): which quarter a fire took */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

const AGE: Record<string, number> = { village: 30, town: 60, city: 120, metropolis: 200 };

/** a quarter of the town (world units): its middle, a little out from the centre, and its reach */
function quarter(f: StoryFacts, salt: string): { at: [number, number]; radius: number } {
  const a = (hashStr(f.id + salt) * 2 - 1) * Math.PI;
  const off = f.size === 'village' ? 8 : 14;
  return { at: [Math.round(f.at[0] + Math.cos(a) * off), Math.round(f.at[1] + Math.sin(a) * off)], radius: f.size === 'village' ? 10 : 16 };
}

export function storyOf(f: StoryFacts): SettlementStory {
  const ev: SettlementStoryEvent[] = [];
  const age = AGE[f.size] ?? 60;
  const by = f.ownerName ? `by ${f.ownerName}` : 'by free folk';
  ev.push({ what: 'founded', run: -age, note: `founded ${by} for ${f.purpose.why}` });
  // the deep past, from where it stands in the world now
  const foe = f.hostiles[0];
  if (foe && foe.v > 0.25) {
    ev.push({ what: 'raided', run: -Math.round(age * 0.3), note: `raided by ${foe.name}` });
    if (foe.v > 0.4) {
      const q = quarter(f, 'fire');
      ev.push({ what: 'burned', run: -Math.round(age * 0.3), note: `a quarter burned when ${foe.name} raided it; it was never rebuilt`, ...q });
    }
    ev.push({ what: 'walled', run: -Math.round(age * 0.2), note: 'walls raised after the raid, newer stone than the town' });
  }
  if ((f.setting === 'port' || f.setting === 'river') && f.ground - f.sea < 2.5)
    ev.push({ what: 'flooded', run: -Math.round(age * 0.1), note: 'the water rose over the lower town; its low houses stand empty', level: +(f.ground + 1.2).toFixed(1) });
  // the world state: what runs and stories did to its region
  for (const e of f.history) {
    switch (e.kind) {
      case 'burn': {
        const q = quarter(f, e.id);
        ev.push({ what: 'burned', run: e.run ?? 0, note: `burned (${e.id})`, cause: e.id, ...q });
        break;
      }
      case 'flood':
        ev.push({ what: 'flooded', run: e.run ?? 0, note: `flooded to ${e.level} (${e.id})`, level: e.level, cause: e.id });
        break;
      case 'ruin':
        ev.push({ what: 'ruined', run: e.run ?? 0, note: `ruined (${e.id})`, cause: e.id });
        break;
      case 'rebuild':
        ev.push({ what: 'grew', run: e.run ?? 0, note: `rebuilt (${e.id})`, cause: e.id });
        break;
      default:
        break;
    }
  }
  // a region ruined or flooded with no event recorded (a snapshot made elsewhere): its state still shows
  if (f.ruin > 0.3 && !ev.some((e) => e.what === 'burned')) ev.push({ what: 'burned', run: 0, note: 'part of it lies in ruin', ...quarter(f, 'ruin') });
  if (f.flooded !== null && !ev.some((e) => e.what === 'flooded' && e.level === f.flooded)) ev.push({ what: 'flooded', run: 0, note: `the water stands at ${f.flooded}`, level: f.flooded });
  ev.sort((a, b) => a.run - b.run);
  const founding = `${f.name} was founded ${by} ${Math.round(age / 30)} generation${age >= 60 ? 's' : ''} ago for ${f.purpose.why}.`;
  return { founding, owner: f.owner, events: ev };
}
