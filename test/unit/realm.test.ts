// (loop-skeleton round 2) The realm: a home-town run on the living engine joined to the season ledger. Over the Briar
// Hollow test world (living/briar.ts): the deal is the dealer's (few, one a site, a presenter of the card's role), a
// commitment locks the ledger's own people, a project is built by the ledger's seasons, an expiry changes the fact
// layer, the arc brings the raid, and the fact layer saved is what the next run starts from.
import { describe, expect, it } from 'vitest';
import { briarWorld } from '../../src/living/briar';
import { grant, newLedger, nextSeason, pools, total, type SeasonLedger } from '../../src/season/ledger';
import { Realm, roadLook, type Leader } from '../../src/season/realm';
import { projectId } from '../../src/season/realm-templates';
import type { WorldSnapshot } from '../../src/api/contracts/world';
import { lint } from '../support/writing';

const YSOLT: Leader = { id: 'ysolt', name: 'Marshal Ysolt', line: 'A soldier.', pools: { magic: 1, might: 3, labor: 4, materials: 6, intel: 1 }, income: { materials: 2, magic: 1 } };
const LAND = { left: 14, open: [] };

function realm(o: { world?: WorldSnapshot; seasons?: number; ledger?: SeasonLedger; seed?: number } = {}): Realm {
  return new Realm({ world: o.world ?? briarWorld().ws.snapshot(), home: 'briar-hollow', seed: o.seed ?? 7, leader: YSOLT, ledger: o.ledger ?? newLedger(YSOLT.pools, YSOLT.income), land: () => LAND, seasons: o.seasons ?? 4 });
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

describe('the realm (season/realm.ts)', () => {
  it('deals few, each over its own site of the home town, each brought by someone of its role', () => {
    const r = realm();
    const offs = r.offers().filter((o) => o.status === 'offered');
    expect(offs.length).toBeGreaterThan(1);
    expect(offs.length).toBeLessThanOrEqual(r.engine.dealerTune().resourceMax + 1);
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
    expect(n(big)).toBeLessThanOrEqual(small.engine.dealerTune().resourceMax + small.engine.dealerTune().unaffordable);
  });

  it('committing a project locks the ledger\'s own people and spends its goods; the ledger builds it and its people come back', () => {
    const r = realm({ seasons: 8 });
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

  it('a card left to expire changes the fact layer: the neighbour falls, unrest rises, a physical change is named', () => {
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
    expect(r.physical.some((p) => p.kind === 'captured' && p.at === other)).toBe(true);
    expect(r.history().some((e) => e.kind === 'fell')).toBe(true);
    expect(offer(r, 'relieve-neighbour')).toBeUndefined();
  });

  it('helped, the neighbour swears to you and pays each season', () => {
    const r = realm({ seasons: 12 });
    const o = until(r, 'relieve-neighbour');
    const income = r.ledger.income.materials ?? 0;
    r.commit(o.id);
    season(r);
    season(r);
    expect(r.w.relations({ type: 'vassal_of', from: o.bind.other }).length).toBe(1);
    expect(r.ledger.income.materials).toBe(income + 1);
    expect(r.physical.some((p) => p.kind === 'vassal')).toBe(true);
  });

  it('the arc: scouts, a farm burned, then the raid in the run\'s last season; fought, the run is over and the history says how', () => {
    const r = realm({ seasons: 4 });
    expect(r.raid).toBeNull();
    const news: string[] = [];
    for (let k = 0; k < 3; k++) news.push(...season(r));
    expect(r.season).toBe(4);
    expect(r.raid).toBe(6);
    expect(news.join(' ')).toContain('scouts are seen on the road');
    expect(r.over).toBe(false);
    r.fought({ raiders: 6, left: 4, fallen: 0 });
    expect(r.over).toBe(true);
    expect(r.fight?.held).toBe(false);
    expect(r.history().some((e) => e.kind === 'raid-broke')).toBe(true);
    expect(r.physical.some((p) => p.kind === 'burned')).toBe(true);
  });

  it('the raiders can be paid off in the last seasons: no raid comes', () => {
    const r = realm({ seasons: 4, ledger: grant(newLedger(YSOLT.pools, YSOLT.income), { materials: 10 }) });
    let pay = offer(r, 'pay-raiders');
    for (let k = 0; k < 3 && !pay; k++) {
      season(r);
      pay = offer(r, 'pay-raiders');
    }
    expect(pay).toBeTruthy();
    r.commit(pay!.id);
    while (r.season < 4) season(r);
    season(r);
    expect(r.averted).toBe(true);
    expect(r.raid).toBeNull();
    expect(r.over).toBe(true);
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
