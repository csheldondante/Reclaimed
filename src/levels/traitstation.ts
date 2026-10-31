// The playground's traits station (LW1): a crowd of the living and the walking dead, a lich, the fallen raised, a
// sanctuary — the slice's rules seen working on hundreds of agents at once. The lich here is a thin test driver of the
// effect path (the coordinator's word: "not a second lich"): a figure standing where it is, and the same TraitsApi
// calls play's lich will make (docs/ARCHITECTURE.md "Traits and effects": its one-line hook). No controls of its own.
//
// Groups and fields it uses on the agents (the playground has no AgentUnits, whose groups 0-7 and fields 0-11 these
// share): the village (group 10) gathers round its well (field 4); the walking dead (11) shamble about (a hostile kind
// wanders); the raised (12) follow the lich (field 5); the lich (13) stands.

import type { Agents } from '../agents/agents';
import type { TraitsApi, EffectId } from '../api/contracts/traits';

const G = { village: 10, dead: 11, raised: 12, lich: 13 } as const;
const F = { well: 4, lich: 5 } as const;

/** What the station's buttons call (StationKit.traits). */
export interface TraitStationDriver {
  /** the crowd: the village round its well, the walking dead beside it, the lich */
  crowd(): void;
  /** the lich's blast: necrotic death over the village's near edge — bodies to raise */
  smite(): void;
  /** the lich raises what lies near it: they rise undead, keep their kind, and follow it */
  raise(): void;
  /** a sanctuary over the middle: heals the living (a halo), burns the undead (sparks), greens and mends the ground */
  sanctuary(): void;
  /** fear on the village: the frightened flee their well */
  fear(): void;
  /** stone on the walking dead: rooted, grey */
  petrify(): void;
  /** everything the station spawned and put into the world, gone */
  clear(): void;
  /** counts for the station's readout and the shots */
  census(): Promise<Record<string, number>>;
}

export class TraitStation implements TraitStationDriver {
  private ids: number[] = [];
  private lich: number | null = null;
  private effects: EffectId[] = [];

  /** `at`: the station's middle (world x, y) */
  constructor(
    private agents: Agents,
    private traits: TraitsApi,
    private at: [number, number],
  ) {
    agents.follow(G.village, F.well);
    agents.follow(G.dead, -1);
    agents.follow(G.raised, F.lich);
    agents.follow(G.lich, -1);
  }

  private get village(): [number, number] {
    return [this.at[0] - 16, this.at[1] - 4];
  }
  private get graveyard(): [number, number] {
    return [this.at[0] + 18, this.at[1] - 2];
  }
  private get lichAt(): [number, number] {
    return [this.at[0] + 2, this.at[1] + 10];
  }

  crowd(): void {
    const [vx, vy] = this.village;
    const [dx, dy] = this.graveyard;
    const [lx, ly] = this.lichAt;
    this.ids.push(...this.agents.spawn(180, vx, vy, { group: G.village, kind: 'worker', spread: 9 }));
    const dead = this.agents.spawn(90, dx, dy, { group: G.dead, kind: 'raider', spread: 8 });
    this.traits.assign(dead, ['undead']);
    this.ids.push(...dead);
    if (this.lich === null) {
      [this.lich] = this.agents.spawn(1, lx, ly, { group: G.lich, kind: 'ogre', spread: 0 });
      this.traits.assign([this.lich], ['undead', 'fire_immune']);
      this.ids.push(this.lich);
    }
    this.agents.seed(F.well, [{ x: vx, y: vy }]);
    this.agents.seed(F.lich, [{ x: lx, y: ly }]);
  }

  smite(): void {
    const [vx, vy] = this.village;
    const [lx, ly] = this.lichAt;
    // (toward the lich, on the village's edge)
    const at: [number, number] = [vx + (lx - vx) * 0.45, vy + (ly - vy) * 0.45];
    this.effects.push(this.traits.apply({ op: 'damage', type: 'necrotic', amount: 100, at, radius: 6 }));
  }

  raise(): void {
    this.effects.push(this.traits.apply({ op: 'raise', group: G.raised, at: this.lichAt, radius: 18 }));
  }

  sanctuary(): void {
    const at: [number, number] = [this.at[0], this.at[1] - 3];
    this.effects.push(this.traits.apply({ op: 'heal', rate: 1.5, at, radius: 12, seconds: 25, world: { grow: true, mend: true, every: 1 } }));
  }

  fear(): void {
    this.effects.push(this.traits.apply({ op: 'status', status: 'frightened', lasts: 6, at: this.village, radius: 12 }));
  }

  petrify(): void {
    this.effects.push(this.traits.apply({ op: 'status', status: 'petrified', lasts: 15, at: this.graveyard, radius: 7 }));
  }

  clear(): void {
    this.agents.remove(this.ids);
    this.ids = [];
    this.lich = null;
    for (const e of this.effects) this.traits.end(e);
    this.effects = [];
    this.agents.seed(F.well, []);
    this.agents.seed(F.lich, []);
  }

  async census(): Promise<Record<string, number>> {
    await this.traits.read();
    const out: Record<string, number> = {};
    for (const id of this.ids) for (const t of this.traits.traitsOf(id) ?? []) out[t] = (out[t] ?? 0) + 1;
    return out;
  }
}
