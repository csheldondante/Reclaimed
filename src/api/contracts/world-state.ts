// The world state's reference implementation (round 83): in memory, one RegionState a region, the events
// applied in order and kept. Enough for the GM, the overmap and the region generator to code against; the
// atlas's own (the coarse world for shaped events, saving) replaces its insides, not its API.

import { freshRegion, type AtlasEvent, type Faction, type FactionId, type RegionId, type RegionState, type WorldSnapshot, type WorldState } from './world';
import type { CharacterChange, CharacterRecord, RunRecord } from './run';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export class MemoryWorldState implements WorldState {
  private regions = new Map<RegionId, RegionState>();
  private events: AtlasEvent[] = [];
  private factions = new Map<FactionId, Faction>();
  readonly runs: RunRecord[] = [];
  /** the world's settlements (the region generator and the city game keep them) */
  readonly settlements: import('./settlement').Settlement[] = [];
  /** (round 117, runplan) the characters the world remembers (heroes and the people they met), by id */
  private chars = new Map<string, CharacterRecord>();
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

  /**
   * (round 97, heroapi) The world as a snapshot left it (a save between runs): the regions' states, the factions,
   * the history and the runs, so the next run starts on what the last one changed.
   */
  static restore(s: WorldSnapshot): MemoryWorldState {
    const w = new MemoryWorldState(
      s.seed,
      s.regions.map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
      structuredClone(s.factions),
    );
    for (const r of s.regions) w.regions.set(r.id, structuredClone(r.state));
    w.events.push(...structuredClone(s.history));
    w.runs.push(...structuredClone(s.runs));
    w.settlements.push(...structuredClone(s.settlements));
    for (const c of structuredClone(s.characters ?? [])) w.chars.set(c.id, c);
    w.version = s.version;
    w.run = s.run;
    return w;
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
        case 'faction-attitude':
          // (a faction's, not a region's: applied once, below)
          break;
        case 'mark': {
          if (!d.name || !d.kind) throw new Error(`AtlasEvent ${e.id}: a mark needs detail.name and detail.kind`);
          r.marks.push({ id: e.id, name: String(d.name), kind: String(d.kind), at: d.at as [number, number] | undefined, cause: e.id });
          break;
        }
      }
      for (const cb of this.onChange) cb(id, before, r);
    }
    if (e.kind === 'faction-relation' || e.kind === 'faction-power') {
      const f = this.factions.get(e.detail?.faction as FactionId);
      if (!f) throw new Error(`AtlasEvent ${e.id}: ${e.kind} needs detail.faction, a known faction`);
      const m = Math.max(-1, Math.min(1, e.magnitude));
      if (e.kind === 'faction-power') f.power = clamp01((f.power ?? 0.5) + m);
      else {
        const t = e.detail?.toward as FactionId | undefined;
        if (!t || !this.factions.has(t)) throw new Error(`AtlasEvent ${e.id}: faction-relation needs detail.toward, a known faction`);
        f.relations[t] = Math.max(-1, Math.min(1, (f.relations[t] ?? 0) + m));
      }
    }
    if (e.kind === 'faction-attitude') {
      const f = this.factions.get(e.detail?.faction as FactionId);
      if (!f) throw new Error(`AtlasEvent ${e.id}: faction-attitude needs detail.faction, a known faction`);
      f.attitude = Math.max(-1, Math.min(1, f.attitude + e.magnitude));
    }
    this.events.push(e);
    this.version++;
  }

  /** (round 117, runplan) a character the world remembers */
  character(id: string): CharacterRecord | undefined {
    return this.chars.get(id);
  }

  characters(): CharacterRecord[] {
    return [...this.chars.values()];
  }

  /** (round 117, runplan) what a run did to a character; an unknown id (other than a 'meet') is the caller's bug */
  applyCharacter(c: CharacterChange, run = this.run): void {
    if (c.kind === 'meet') {
      const had = this.chars.get(c.character.id);
      if (had) {
        had.alive = c.character.alive;
        had.region = c.character.region;
      } else this.chars.set(c.character.id, { relationships: {}, gear: [], statuses: [], ...structuredClone(c.character), history: [] });
      this.version++;
      return;
    }
    const r = this.chars.get(c.id);
    if (!r) throw new Error(`character change ${c.kind}: no character ${c.id}`);
    switch (c.kind) {
      case 'history': r.history.push({ run, text: c.text }); break;
      case 'relationship': r.relationships[c.toward] = Math.max(-1, Math.min(1, (r.relationships[c.toward] ?? 0) + c.delta)); break;
      case 'motivation': r.motivation = c.motivation; break;
      case 'gear': r.gear = [...r.gear.filter((g) => !c.remove?.includes(g)), ...(c.add ?? []).filter((g) => !r.gear.includes(g))]; break;
      case 'status': r.statuses = [...r.statuses.filter((g) => !c.remove?.includes(g)), ...(c.add ?? []).filter((g) => !r.statuses.includes(g))]; break;
      case 'move': r.region = c.region; break;
      case 'die': r.alive = false; r.history.push({ run, text: c.text }); break;
    }
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
      // (round 118, testkit: copies — a snapshot is a save between runs; the live factions' attitudes moved it after)
      factions: structuredClone([...this.factions.values()]),
      settlements: structuredClone(this.settlements),
      history: this.history(),
      runs: [...this.runs],
      characters: structuredClone(this.characters()),
    };
  }
}
