// (loop-skeleton round 2) The realm: a home-town run on the living engine joined to the season ledger. Over the Briar
// Hollow test world (living/briar.ts): the deal is the dealer's (few, one a site, a presenter of the card's role), a
// commitment locks the ledger's own people, a project is built by the ledger's seasons, an expiry changes the fact
// layer, the arc brings the raid, and the fact layer saved is what the next run starts from.
import { afterEach, describe, expect, it } from 'vitest';
import { mutators, type Applied, type Mutation, type MutationSpec, type SignSpec } from '../../src/mutate';
import { briarWorld } from '../../src/living/briar';
import { grant, newLedger, nextSeason, pools, total, type SeasonLedger } from '../../src/season/ledger';
import { Realm, roadLook, type Leader } from '../../src/season/realm';
import { projectId } from '../../src/season/realm-templates';
import { setStance } from '../../src/living/stance';
import type { WorldSnapshot } from '../../src/api/contracts/world';
import { lint } from '../support/writing';

const YSOLT: Leader = { id: 'ysolt', name: 'Marshal Ysolt', line: 'A soldier.', pools: { magic: 1, might: 3, labor: 4, materials: 6, intel: 1 }, income: { materials: 2, magic: 1 } };
const LAND = { left: 14, open: [] };

function realm(o: { world?: WorldSnapshot; seasons?: number; ledger?: SeasonLedger; seed?: number; where?: (s: string) => [number, number] | null } = {}): Realm {
  return new Realm({ world: o.world ?? briarWorld().ws.snapshot(), home: 'briar-hollow', seed: o.seed ?? 7, leader: YSOLT, ledger: o.ledger ?? newLedger(YSOLT.pools, YSOLT.income), land: () => LAND, seasons: o.seasons ?? 4, ...(o.where ? { where: o.where } : {}) });
}

/** a whole season: the opportunities' end, the ledger's own season, the deal again */
function season(r: Realm): string[] {
  const news = r.endSeason();
  r.afterSeason(nextSeason(r.ledger).ledger);
  return news;
}

const offer = (r: Realm, template: string) => r.offers().find((o) => o.template === template && o.status === 'offered');
/** seasons passed until the dealer offers it (the dealer picks among equals by its own scores): at most `n` */
function until(r: Realm, template: string, n = 8) {
  for (let k = 0; k < n && !offer(r, template); k++) season(r);
  const o = offer(r, template);
  if (!o) throw new Error(`${template} was not offered in ${n} seasons: ${r.offers().map((x) => x.template).join(', ')}`);
  return o;
}

/** the mutators bound as a recorder: what the realm's outcomes ask of them (the GPU side is test/gpu/mutators.test.ts) */
function recorder(): { applied: MutationSpec[]; signs: SignSpec[]; seasons: number[] } {
  const applied: MutationSpec[] = [];
  const list: Mutation[] = [];
  const signs: SignSpec[] = [];
  const seasons: number[] = [];
  mutators.bind({
    list: () => [],
    apply: (sp) => {
      applied.push(sp);
      const m: Mutation = { id: `m${list.length}`, kind: sp.kind, place: sp.place ?? null, cell: [sp.at?.[0] ?? 0, sp.at?.[1] ?? 0], radius: sp.radius ?? 0, strength: sp.strength ?? 1, seed: sp.seed ?? 1, params: [], seq: list.length, ...(sp.fact ? { fact: sp.fact } : {}), ...(sp.cause ? { cause: sp.cause } : {}), ...(sp.name ? { name: sp.name } : {}) };
      list.push(m);
      return { ...m, resident: true, fresh: true } as Applied;
    },
    play: () => Promise.resolve(),
    places: () => [],
    place: () => null,
    record: () => ({ version: 2, list, season: seasons.at(-1) ?? 0 }),
    restore: () => {},
    sign: (sp) => {
      signs.push(sp);
      return null;
    },
    signs: () => [],
    season: (n) => void seasons.push(n),
    useWorld: () => {},
    world: null,
  });
  return { applied, signs, seasons };
}
afterEach(() => mutators.bind(null));

describe('the realm (season/realm.ts)', () => {
  it('deals few, each over its own site of the home town, each brought by someone of its role', () => {
    const r = realm();
    // (the raiders' standing threat stands over the whole town, not a site: it is counted apart — the raid is a card)
    const all = r.offers().filter((o) => o.status === 'offered');
    const offs = all.filter((o) => o.template !== 'pay-raiders');
    expect(all.find((o) => o.template === 'pay-raiders')?.place).toBe(r.home);
    expect(offs.length).toBeGreaterThan(1);
    // (the board, the dealer's one guarantee, one threatening card)
    expect(offs.length).toBeLessThanOrEqual(r.engine.dealerTune().resourceMax + 2);
    const sites = offs.map((o) => r.siteOf(o));
    expect(sites.every((s) => s !== null)).toBe(true);
    expect(new Set(sites).size).toBe(sites.length);
    for (const o of offs) {
      const t = r.engine.template(o.template);
      expect(r.ws.character(o.presenter)?.role).toBe(t.presenter.role);
      expect(o.line.length).toBeGreaterThan(10);
    }
  });

  it('the number of decisions does not grow with the holdings: bigger pools, the same few cards', () => {
    const small = realm();
    const big = realm({ ledger: grant(newLedger(YSOLT.pools, YSOLT.income), { labor: 12, might: 8, materials: 30, magic: 8 }) });
    const n = (r: Realm) => r.offers().filter((o) => o.status === 'offered').length;
    expect(n(big)).toBeLessThanOrEqual(Math.max(n(small), small.engine.dealerTune().resourceMax));
    for (let k = 0; k < 3; k++) season(big);
    expect(n(big)).toBeLessThanOrEqual(small.engine.dealerTune().resourceMax + 2);
  });

  it('nothing agreed for a whole run: the choices a season never pass the dealer\'s limit and its one guarantee', () => {
    const r = realm({ seasons: 16 });
    const counts: number[] = [];
    for (let k = 0; k < 15; k++) {
      // (a forced live card asks nothing: it begins — counted apart since draft 8 lets it past a card at its place)
      counts.push(r.offers().filter((o) => o.status === 'offered' && !r.engine.template(o.template).play?.forced).length);
      season(r);
    }
    // (draft 8: + the raiders' standing threat, on the board from a fifth of the run to its end — CT-52)
    expect(Math.max(...counts), counts.join(',')).toBeLessThanOrEqual(6);
  });

  it('committing a project locks the ledger\'s own people and spends its goods; the ledger builds it and its people come back', () => {
    const r = realm({ seasons: 16 });
    const o = until(r, projectId('houses'));
    const before = pools(r.ledger);
    const workers = total(r.ledger, 'labor');
    expect(r.short(o!)).toEqual({});
    r.commit(o!.id);
    const after = pools(r.ledger);
    expect(after.labor).toBeLessThan(before.labor);
    expect(after.materials).toBeLessThan(before.materials);
    expect(r.ledger.projects.map((p) => p.card.id)).toEqual(['houses']);
    expect(r.ledger.projects[0].external).toBe(true);
    // (the world's holdings are the ledger's: one record)
    expect(r.w.holdings).toBe(r.ledger.holdings);
    const seasons = r.ledger.projects[0].card.seasons;
    for (let k = 0; k < seasons; k++) season(r);
    expect(r.ledger.built).toContain('houses');
    expect(r.ledger.projects).toEqual([]);
    expect(total(r.ledger, 'labor')).toBe(workers + 2);
    expect(r.ledger.holdings.agents.some((a) => a.committed)).toBe(false);
    expect(r.history().some((e) => e.kind === 'built')).toBe(true);
    // (one a town: not offered again)
    expect(offer(r, projectId('keep'))).toBeUndefined();
  });

  it('a card left to expire changes the fact layer: the neighbour falls, unrest rises, and the mutators are told with the event that says so', () => {
    const m = recorder();
    const r = realm({ seasons: 12 });
    const o = until(r, 'relieve-neighbour');
    const other = o!.bind.other;
    expect(other).toBe(r.neighbour());
    const unrest = pools(r.ledger).unrest;
    season(r);
    season(r);
    expect(r.w.facts.tag(other, 'condition', 'occupied')?.value).toBe(true);
    expect(pools(r.ledger).unrest).toBeGreaterThanOrEqual(unrest + 1);
    expect(r.news.concat(r.history().map((e) => e.note)).join(' ')).toContain('fell to raiders');
    // (the place's state is the fact layer's: who holds it; the mutators' entry is its look and carries the event's id)
    expect(r.w.facts.relations({ type: 'occupies', to: other })[0]?.from).toBe('raiders');
    const cap = m.applied.find((p) => p.kind === 'captured');
    expect(cap).toMatchObject({ place: other, by: 'raiders' });
    expect(r.w.facts.events({ kind: 'captured' }).some((e) => e.id === cap!.fact)).toBe(true);
    expect(r.changes().some((c) => c.kind === 'captured')).toBe(true);
    expect(r.history().some((e) => e.kind === 'fell')).toBe(true);
    expect(offer(r, 'relieve-neighbour')).toBeUndefined();
  });

  it('a town that falls sends its people: they are in your streets, and one of them asks for huts', () => {
    const r = realm({ seasons: 16 });
    until(r, 'relieve-neighbour');
    expect(r.life().people).toBe(0);
    season(r);
    expect(r.history().some((e) => e.kind === 'migration' && e.to.includes(r.home))).toBe(true);
    expect(r.life()).toMatchObject({ people: 40, wagons: 10 });
    const o = until(r, 'house-refugees');
    expect(r.ws.character(o.presenter)?.role).toBe('refugee');
    expect(r.life().wagons).toBe(0);
    const labor = total(r.ledger, 'labor');
    r.commit(o.id);
    season(r);
    season(r);
    expect(total(r.ledger, 'labor')).toBe(labor + 2);
  });

  it('a mining camp sends ore wagons while it stands; lost to raiders, they stop and its ore with them', () => {
    const m = recorder();
    const r = realm({ seasons: 16, ledger: grant(newLedger(YSOLT.pools, YSOLT.income), { materials: 6, labor: 4 }) });
    r.commit(until(r, 'mining-outpost').id);
    season(r);
    season(r);
    expect(r.life().wagons).toBeGreaterThanOrEqual(14);
    const income = r.ledger.income.materials ?? 0;
    until(r, 'guard-camp', 14);
    season(r);
    season(r);
    expect(m.applied.find((p) => p.kind === 'destroyed')).toMatchObject({ place: 'copper-hollow' });
    expect(r.w.settlement('copper-hollow')?.condition).toBe('ruined');
    expect(r.ledger.income.materials).toBe(income - 1);
    expect(r.life().wagons % 14).not.toBe(0 + 14);
    expect(r.life().wagons).toBeLessThan(14);
  });

  it('helped, the neighbour swears to you and pays each season', () => {
    const m = recorder();
    const r = realm({ seasons: 12 });
    const o = until(r, 'relieve-neighbour');
    const income = r.ledger.income.materials ?? 0;
    r.commit(o.id);
    season(r);
    season(r);
    expect(r.w.relations({ type: 'vassal_of', from: o.bind.other }).length).toBe(1);
    expect(r.ledger.income.materials).toBe(income + 1);
    expect(m.applied.find((p) => p.kind === 'vassal')).toMatchObject({ place: o.bind.other, by: 'player', tribute: 1 });
  });

  it('the raid is a card: the raiders\' standing threat counts down to the last season, then the raid is forced; fought, the run goes on to its end and the history says how', () => {
    const m = recorder();
    const r = realm({ seasons: 4 });
    expect(r.raid).toBeNull();
    // (the standing threat is on the board from the first season of a 4-season run, its countdown the header's)
    expect(r.standingThreat()).toMatchObject({ template: 'pay-raiders', left: 3 });
    expect(r.history().some((e) => e.kind === 'scouts-seen')).toBe(true);
    const news: string[] = [];
    for (let k = 0; k < 3; k++) news.push(...season(r));
    expect(r.season).toBe(4);
    expect(r.raid).toBe(18);
    expect(news.join(' ')).toContain('The raiders break camp and march on the town');
    expect(r.over).toBe(false);
    // (round 6: the raid is a live event's card, forced; resolved here as nobody played it — Might 3 and nowhere for
    // soldiers to gather: all 18 get in — card-table tuning, CT-18)
    expect(r.forcedLive()?.template).toBe('raid');
    const rep = r.playForced().find((x) => x.template === 'raid')!;
    expect(rep).toMatchObject({ template: 'raid', tier: 'failure', vars: { raiders: 18, left: 18 } });
    expect(r.fight?.held).toBe(false);
    expect(m.signs.find((s) => s.kind === 'crime')).toMatchObject({ place: r.home, until: r.w.turn + 3 });
    // (the raid no longer ends the run: its last season does, with a plain ending in the record)
    expect(r.over).toBe(false);
    season(r);
    expect(r.over).toBe(true);
    expect(r.ended).toMatchObject({ result: 'stood', by: 'the last season' });
    expect(r.history().some((e) => e.kind === 'run-ended')).toBe(true);
    expect(r.history().some((e) => e.kind === 'raid-broke')).toBe(true);
    // (sacked: the district by the gate burned — an area of the home town, the raid's own event its fact — and thieves
    // in the town for three seasons)
    const broke = r.history().find((e) => e.kind === 'raid-broke')!;
    const burn = m.applied.find((p) => p.kind === 'burned' && p.radius === 30)!;
    expect(burn).toMatchObject({ fact: broke.id, radius: 30 });
    expect(burn.at).toEqual(r.cellOf('gate'));
  });

  it('a hazard left alone changes the land round its site: one event, and the mutators\' entry carries its id', () => {
    const m = recorder();
    const cells: Record<string, [number, number]> = { dam: [5000, 3000], mountain: [4400, 3300] };
    const r = realm({ seasons: 16, where: (s) => cells[s] ?? null });
    for (let k = 0; k < 14 && !m.applied.some((p) => p.kind === 'flooded'); k++) season(r);
    const flood = m.applied.find((p) => p.kind === 'flooded')!;
    expect(flood).toMatchObject({ at: [5000, 3000], radius: 34 });
    const ev = r.history().filter((e) => e.kind === 'flooded');
    expect(ev.length).toBe(1);
    expect(flood.fact).toBe(ev[0].id);
    expect(r.w.facts.tag(`site:${r.home}:dam`, 'condition', 'flooded')?.value).toBe(true);
    // (the mutators keep the history's turn as their season: it runs on across runs)
    expect(m.seasons.at(-1)).toBe(r.w.turn);
  });

  it('with no world bound to the mutators the facts alone change (a test, the inspector)', () => {
    const r = realm({ seasons: 4 });
    for (let k = 0; k < 3; k++) season(r);
    r.playForced();
    expect(r.w.facts.tag(`site:${r.home}:gate`, 'condition', 'burned')?.value).toBe(true);
    expect(r.changes()).toEqual([]);
  });

  it('a mining camp founded is a settlement of the world: its record, its entity, the player its holder', () => {
    const m = recorder();
    const r = realm({ seasons: 16, ledger: grant(newLedger(YSOLT.pools, YSOLT.income), { materials: 6, labor: 4 }) });
    const o = until(r, 'mining-outpost');
    r.commit(o.id);
    season(r);
    season(r);
    expect(r.w.settlement('copper-hollow')?.name).toBe('Copper Hollow');
    expect(r.w.facts.relations({ type: 'controls', from: 'player', to: 'copper-hollow' }).length).toBe(1);
    expect(m.applied.find((p) => p.kind === 'founded')).toMatchObject({ place: 'copper-hollow', name: 'Copper Hollow', at: r.cellOf('hills') });
    expect(offer(r, 'mining-outpost')).toBeUndefined();
  });

  it('the raiders can be paid off: a truce for the run, and no raid comes', () => {
    const r = realm({ seasons: 4, ledger: grant(newLedger(YSOLT.pools, YSOLT.income), { materials: 10 }) });
    let pay = offer(r, 'pay-raiders');
    for (let k = 0; k < 3 && !pay; k++) {
      season(r);
      pay = offer(r, 'pay-raiders');
    }
    expect(pay).toBeTruthy();
    r.commit(pay!.id);
    while (r.season < 4) season(r);
    expect(r.raidersThreaten()).toBe(false);
    expect(r.forcedLive()).toBeNull();
    season(r);
    expect(r.raid).toBeNull();
    expect(r.fight).toBeNull();
    expect(r.over).toBe(true);
  });

  it('in a world with no raiders on the road (their camp abandoned, no quarrel with you), no raid comes and the run ends at its last season', () => {
    const w = briarWorld();
    const r0 = new Realm({ world: w.ws.snapshot(), home: 'briar-hollow', seed: 7, leader: YSOLT, ledger: newLedger(YSOLT.pools, YSOLT.income), land: () => LAND, seasons: 4 });
    // (their camp abandoned and no quarrel with you: a town they take later is no road to yours)
    r0.w.facts.setTag('raiders-camp', 'condition', 'abandoned', true);
    setStance(r0.w, 'raiders', 'player', 'none', 'test');
    const r = realm({ world: r0.snapshot(), seasons: 4 });
    expect(r.raidersThreaten()).toBe(false);
    for (let k = 0; k < 4; k++) {
      expect(offer(r, 'pay-raiders')).toBeUndefined();
      expect(r.forcedLive()?.template).not.toBe('raid');
      season(r);
    }
    expect(r.over).toBe(true);
    expect(r.fight).toBeNull();
    expect(r.ended?.result).toBe('stood');
  });

  it('the fact layer saved is the next run\'s world: its people, its places and its history are there', () => {
    const a = realm({ seasons: 12 });
    const cast = a.offers().map((o) => o.presenter).sort();
    a.commit(until(a, 'mining-outpost').id);
    season(a);
    season(a);
    expect(a.w.facts.entity('copper-hollow')?.name).toBe('Copper Hollow');
    // (saved as bytes and read back: what the store keeps)
    const saved = JSON.parse(JSON.stringify(a.snapshot())) as WorldSnapshot;
    const b = realm({ world: saved, seasons: 12 });
    expect(b.w.facts.entity('copper-hollow')?.name).toBe('Copper Hollow');
    expect(b.history(true).some((e) => e.kind === 'founding')).toBe(true);
    expect(b.history().some((e) => e.kind === 'founding')).toBe(false);
    expect(b.history(true).filter((e) => e.kind === 'run-began').length).toBe(2);
    // (a place founded is not offered again; the people who asked before are the same people)
    expect(offer(b, 'mining-outpost')).toBeUndefined();
    for (let k = 0; k < 3; k++) season(b);
    expect(offer(b, 'mining-outpost')).toBeUndefined();
    for (const id of cast) expect(b.ws.character(id)?.alive).toBe(true);
    expect(b.season).toBe(4);
    expect(a.season).toBeGreaterThan(2);
  });

  it('the camera looks down a road from where the window is sure to hold the rest of it (LS-16)', () => {
    // (Muru's east road: out from the centre to the box's corner, 184 cells away; the window sure for 68 round the camera)
    const road: [number, number][] = [];
    for (let k = 0; k <= 46; k++) road.push([144 + (158 * k) / 46, 109 - (94 * k) / 46]);
    const at = roadLook(road, 68)!;
    const end = road[road.length - 1];
    expect(Math.max(Math.abs(at[0] - end[0]), Math.abs(at[1] - end[1]))).toBeGreaterThanOrEqual(68);
    expect(Math.max(Math.abs(at[0] - end[0]), Math.abs(at[1] - end[1]))).toBeLessThan(68 + 4);
    expect(roadLook([[0, 0], [10, 0]], 68)).toEqual([0, 0]);
    expect(roadLook([[0, 0]], 68)).toBeNull();
  });

  it('every line an offer shows passes the writing lint', () => {
    const r = realm({ seasons: 6 });
    const lines: string[] = [];
    for (let k = 0; k < 5; k++) {
      for (const o of r.offers()) lines.push(o.opp.title, o.line, o.reward, ...(o.gain ? [o.gain] : []));
      lines.push(...season(r));
    }
    expect(lint(lines.join('\n'))).toEqual([]);
  });
});
