// The world state's reference implementation (round 83): in memory, one RegionState a region, the events
// applied in order and kept. Enough for the GM, the overmap and the region generator to code against; the
// atlas's own (the coarse world for shaped events, saving) replaces its insides, not its API.

import { freshRegion, type AtlasEvent, type Faction, type FactionId, type RegionId, type RegionState, type WorldSnapshot, type WorldState } from './world';
import type { RunRecord } from './run';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export class MemoryWorldState implements WorldState {
  private regions = new Map<RegionId, RegionState>();
  private events: AtlasEvent[] = [];
  private factions = new Map<FactionId, Faction>();
  readonly runs: RunRecord[] = [];
  /** the world's settlements (the region generator and the city game keep them) */
  readonly settlements: import('./settlement').Settlement[] = [];
  version = 0;
  run = 0;
  onChange: ((region: RegionId, before: RegionState, after: RegionState) => void)[] = [];

  constructor(
    /** the atlas's seed */
    readonly seed: number,
    /** the regions' names and kinds (the atlas's defs) */
    private names: { id: RegionId; name: string; kind: string }[] = [],
    factions: Faction[] = [],
  ) {
    for (const f of factions) this.factions.set(f.id, f);
  }

  region(id: RegionId): RegionState {
    let r = this.regions.get(id);
    if (!r) this.regions.set(id, (r = freshRegion()));
    return r;
  }

  faction(id: FactionId): Faction | undefined {
    return this.factions.get(id);
  }

  apply(e: AtlasEvent): void {
    if (!e.regions.length) throw new Error(`AtlasEvent ${e.id}: no regions`);
    for (const id of e.regions) {
      const before = structuredClone(this.region(id));
      const r = this.region(id);
      const m = e.magnitude;
      const d = e.detail ?? {};
      switch (e.kind) {
        case 'sink': r.sunk = clamp01(r.sunk + m); break;
        case 'raise': r.sunk = clamp01(r.sunk - m); break;
        case 'bury': r.buried = { depth: r.buried.depth + m, material: (d.material as RegionState['buried']['material']) ?? r.buried.material }; break;
        case 'overgrow': r.overgrowth = clamp01(r.overgrowth + m); break;
        case 'freeze': r.frozen = clamp01(r.frozen + m); break;
        case 'thaw': r.frozen = clamp01(r.frozen - m); break;
        case 'storm': r.storm = { kind: (d.storm as RegionState['storm']['kind']) ?? 'rain', strength: clamp01(m) }; break;
        case 'clear-storm': r.storm = { ...r.storm, strength: 0 }; break;
        case 'shadow': r.shadow = clamp01(r.shadow + m); break;
        case 'light': r.shadow = clamp01(r.shadow - m); break;
        case 'raise-dead': r.undead = clamp01(r.undead + m); break;
        case 'lay-dead': r.undead = clamp01(r.undead - m); break;
        case 'flood': {
          if (e.level === undefined) throw new Error(`AtlasEvent ${e.id}: a flood needs its level`);
          r.flooded = Math.max(r.flooded ?? -Infinity, e.level);
          break;
        }
        case 'drain': r.flooded = null; break;
        case 'burn': r.ruin = clamp01(r.ruin + m * 0.5); r.overgrowth = clamp01(r.overgrowth - m); break;
        case 'ruin': r.ruin = clamp01(r.ruin + m); break;
        case 'rebuild': r.ruin = clamp01(r.ruin - m); break;
        case 'faction-presence': {
          const f = d.faction as FactionId | undefined;
          if (!f) throw new Error(`AtlasEvent ${e.id}: faction-presence needs detail.faction`);
          r.presence[f] = clamp01((r.presence[f] ?? 0) + Math.max(-1, Math.min(1, m)));
          break;
        }
        case 'faction-attitude': {
          const f = this.factions.get(d.faction as FactionId);
          if (!f) throw new Error(`AtlasEvent ${e.id}: faction-attitude needs detail.faction, a known faction`);
          f.attitude = Math.max(-1, Math.min(1, f.attitude + m));
          break;
        }
        case 'mark': {
          if (!d.name || !d.kind) throw new Error(`AtlasEvent ${e.id}: a mark needs detail.name and detail.kind`);
          r.marks.push({ id: e.id, name: String(d.name), kind: String(d.kind), at: d.at as [number, number] | undefined, cause: e.id });
          break;
        }
      }
      for (const cb of this.onChange) cb(id, before, r);
    }
    this.events.push(e);
    this.version++;
  }

  record(run: RunRecord): void {
    this.runs.push(run);
    this.run = run.run + 1;
    this.version++;
  }

  history(region?: RegionId): AtlasEvent[] {
    return region === undefined ? [...this.events] : this.events.filter((e) => e.regions.includes(region));
  }

  snapshot(): WorldSnapshot {
    return {
      version: this.version,
      seed: this.seed,
      run: this.run,
      regions: this.names.map((n) => ({ ...n, state: structuredClone(this.region(n.id)), settlements: [] })),
      factions: [...this.factions.values()],
      settlements: [...this.settlements],
      history: this.history(),
      runs: [...this.runs],
    };
  }
}
