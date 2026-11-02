// ---- encounters/rules.ts --------------------------------------------------------------------------------------------
// (round 126, `encounters`) The rules of an encounter (contracts/encounter.ts): what's been won, what's been lost, and
// what the result's tier is. Pure — no DOM, no GPU, no units — so Node tests drive it with made-up observations and
// live.ts drives it with what the units and the hero are doing. The town's finale keeps its own rules (runsit/finale.ts).
//
// The tiers (the opportunity's Tier):
//   disaster  the hero died
//   failure   lost: beaten (the hero at or under `beaten` of its health), past the limit, the quarry got away, the
//             people lost, a scene's yield refused and the fight that followed lost
//   cost      won, but dearly: under COSTLY of its health left, people lost on the way, or a bargain paid
//   success   won
//   triumph   won cleanly: TRIUMPH or more of its health left, and every foe down (not broken, not shaken off), every
//             quarry caught, every one of the people safe, or a scene's foes backing down without a blow

import type { EncounterResult, EncounterSpec, SceneAnswer } from '../api/contracts/encounter';
import type { Tier } from '../api/contracts/opportunity';

/** share of its health the hero must keep for a triumph; under COSTLY a win costs */
export const TRIUMPH = 0.75;
export const COSTLY = 0.4;

/** What the live play sees each step (counts of the encounter's own units). */
export interface EncounterObs {
  t: number;
  heroAlive: boolean;
  /** the hero's health as a share of its most */
  health: number;
  /** foes (and guards) standing, and how many there were */
  foes?: { alive: number; total: number };
  /** pursuers standing, and the nearest one's cells from the hero (Infinity: none standing) */
  pursuers?: { alive: number; nearest: number };
  /** quarry standing; of them, any past the escape */
  quarry?: { alive: number; total: number; escaped: boolean };
  /** a flee to a haven: the hero is there */
  atHaven?: boolean;
  /** the people: freed yet, standing, at safety, how many there were */
  people?: { freed: boolean; alive: number; safe: number; total: number };
}

export type EncounterStatus =
  | { state: 'talk' }
  | { state: 'playing' }
  /** a fight's morale broke: the live play sends the rest running (the rules say it once) */
  | { state: 'ended'; result: Omit<EncounterResult, 'seconds' | 'pursuers'> };

export class EncounterRules {
  status: EncounterStatus;
  /** a fight's foes broke (the rest run) — told once, as it happens */
  broke = false;
  /** a flee's: since when every pursuer has been clear */
  private clearSince: number | null = null;
  /** a scene's: the answer, and whether a fight followed it */
  answer: SceneAnswer | null = null;
  fighting: boolean;
  paid = false;

  constructor(readonly spec: EncounterSpec) {
    if (spec.kind === 'race' && !spec.arena) throw new Error('encounter: a race needs an arena (jumps and crowds) — the user: "Don\'t have races unless you have arenas"');
    if (spec.finale) throw new Error('encounter: the town finale is judged by runsit/finale.ts, not here');
    this.status = spec.kind === 'scene' ? { state: 'talk' } : { state: 'playing' };
    this.fighting = spec.kind === 'fight';
  }

  /**
   * A scene's answer. `held` is what the hero has to bargain or back them down with (renown, goods, the hero's role).
   * Returns what happens: 'fight' (they come at the hero), 'yield' (they back down: won), 'bargain' (paid: won at a
   * cost). A yield they don't believe turns into a fight; a bargain the hero can't pay isn't offered (`answers`).
   */
  choose(id: SceneAnswer['id'], held: { goods: Record<string, number>; renown: number; hero: string }): { then: 'fight' | 'yield' | 'bargain'; reply: string } {
    if (this.status.state !== 'talk') throw new Error(`encounter: an answer with no talk open (${this.status.state})`);
    const a = this.spec.scene?.answers.find((x) => x.id === id);
    if (!a) throw new Error(`encounter: no answer ${id} in this scene`);
    this.answer = a;
    if (a.id === 'bargain') {
      if (a.cost && (held.goods[a.cost.goods] ?? 0) < a.cost.count) throw new Error(`encounter: a bargain the hero can't pay (${a.cost.count} ${a.cost.goods})`);
      this.paid = true;
      this.status = { state: 'ended', result: { tier: 'cost', won: true, heroDied: false, why: a.reply, answer: 'bargain' } };
      return { then: 'bargain', reply: a.reply };
    }
    if (a.id === 'yield') {
      const n = a.needs;
      const ok = !n || (n.renown !== undefined && held.renown >= n.renown) || (n.dread?.includes(held.hero) ?? false);
      if (ok) {
        this.status = { state: 'ended', result: { tier: 'triumph', won: true, heroDied: false, why: a.reply, answer: 'yield' } };
        return { then: 'yield', reply: a.reply };
      }
      this.fighting = true;
      this.status = { state: 'playing' };
      return { then: 'fight', reply: a.refused ?? 'They laugh, and come at you.' };
    }
    this.fighting = true;
    this.status = { state: 'playing' };
    return { then: 'fight', reply: a.reply };
  }

  /** the answers the hero can give (a bargain only when it can pay) */
  answers(held: { goods: Record<string, number> }): SceneAnswer[] {
    return (this.spec.scene?.answers ?? []).filter((a) => !a.cost || (held.goods[a.cost.goods] ?? 0) >= a.cost.count);
  }

  /** a step: the status now (once ended it stays) */
  step(o: EncounterObs): EncounterStatus {
    if (this.status.state !== 'playing') return this.status;
    const s = this.spec;
    const end = (won: boolean, tier: Tier, why: string) => {
      this.status = { state: 'ended', result: { tier, won, heroDied: !o.heroAlive, why, ...(this.answer ? { answer: this.answer.id } : {}) } };
      return this.status;
    };
    const winTier = (clean: boolean, dear = false): Tier => (o.health < COSTLY || dear ? 'cost' : clean && o.health >= TRIUMPH ? 'triumph' : 'success');
    if (!o.heroAlive) return end(false, 'disaster', 'the hero fell');
    if (o.health <= s.beaten) return end(false, 'failure', 'beaten: you got away with your life');
    const foes = o.foes;
    // (a fight, or a scene's fight, or an escort's guards: the foes down, or their morale broken)
    const fightWon = (): boolean => {
      if (!foes || foes.total === 0) return false;
      if (foes.alive === 0) return true;
      const down = (foes.total - foes.alive) / foes.total;
      if (!this.broke && s.morale !== undefined && down >= s.morale) this.broke = true;
      return this.broke;
    };
    switch (s.kind) {
      case 'flee': {
        const p = o.pursuers ?? { alive: 0, nearest: Infinity };
        // (a haven: only getting there carries the word; cut down or not, they're the danger on the way)
        if (s.haven !== undefined) {
          if (o.atHaven) return end(true, winTier(p.alive === 0), 'you reached the gate');
          break;
        }
        if (p.alive === 0) return end(true, winTier(true), 'they are all down');
        const clear = s.clear!;
        if (p.nearest >= clear.cells) {
          this.clearSince ??= o.t;
          if (o.t - this.clearSince >= clear.seconds) return end(true, winTier(false), 'you lost them');
        } else this.clearSince = null;
        break;
      }
      case 'chase': {
        const q = o.quarry!;
        if (q.alive === 0) return end(true, winTier(true), 'they are all run down');
        if (q.escaped) return end(false, 'failure', 'they got away');
        break;
      }
      case 'fight':
        if (fightWon()) return end(true, winTier(foes!.alive === 0), foes!.alive === 0 ? 'they are all down' : 'they broke and ran');
        break;
      case 'scene':
        if (this.fighting && fightWon()) return end(true, winTier(foes!.alive === 0, this.paid), foes!.alive === 0 ? 'they are all down' : 'they broke and ran');
        break;
      case 'escort': {
        const P = o.people!;
        const need = Math.ceil(P.total * s.escort!.safeShare);
        if (P.freed && P.safe >= need && (P.safe >= P.alive || P.safe === P.total)) return end(true, winTier(P.safe === P.total, P.safe < P.total), `${P.safe} of ${P.total} safe`);
        if (P.alive < need) return end(false, 'failure', `${P.total - P.alive} of ${P.total} lost`);
        // (the guards first: once they're down or broken the people are free)
        if (!P.freed) fightWon();
        break;
      }
      case 'race':
        throw new Error('encounter: no race is played yet (no arena exists)');
      case 'defend':
        throw new Error('encounter: defend is the finale (runsit/finale.ts)');
    }
    if (o.t > s.limit) {
      const why = s.kind === 'flee' ? 'they ran you ragged' : s.kind === 'chase' ? 'they got away' : s.kind === 'escort' ? (o.people?.freed ? 'too slow: the people were caught' : 'the guards held the captives') : 'they held the road';
      return end(false, 'failure', why);
    }
    return this.status;
  }

  /** escort: are the guards out of the way (down or broken) — the people can be freed */
  guardsClear(o: EncounterObs): boolean {
    const f = o.foes;
    if (!f || f.total === 0 || f.alive === 0) return true;
    return this.broke;
  }
}
