// The world wiki (round 84, docs/GM.md): the facts the GM reads, made from the atlas's facts
// (src/gm/atlas-facts.ts, cached in data/atlas/). Pure and deterministic: the same atlas makes the same
// wiki. Two forms of the same facts:
//  - WorldWiki (JSON): a WorldSnapshot (src/api/contracts/world.ts) plus what the snapshot has no place for
//    yet: each region's geography, the settlements (settlement.ts's draft shape) and the roads;
//  - markdown (wikiMarkdown): the readable wiki, detailed around a point (the start).
// Names and factions are made here. Factions are PLACEHOLDERS (a deterministic table seeded from the
// regions and settlements) until the user's diplomacy design: see `placeholder` in WikiFaction.
// (Runs in Node too, for scripts/worldwiki.mjs and scripts/storycheck.mjs: runtime imports carry `.ts`.)

import type { Faction, FactionId, RegionState, WorldSnapshot } from '../api/contracts/world';
import type { Settlement } from '../api/contracts/settlement';
import type { AtlasFacts, RegionFacts } from './atlas-facts';
import { freshRegion } from '../api/contracts/world.ts';

export const WIKI_VERSION = 1;

/** what the snapshot doesn't hold of a region: its geography */
export interface WikiRegion {
  id: number;
  name: string;
  kind: string;
  land: boolean;
  continent: string | null;
  tier: string | null;
  /** e.g. "temperate, dry" */
  climate: string;
  temp: number;
  centre: [number, number];
  neighbours: number[];
  rivers: number;
  lava: number;
  /** its macro ground (world z; the sea is world.sea): a flood's level is a z like these */
  ground: { min: number; mean: number; max: number };
  stamps: string[];
}

/** a settlement: the draft Settlement (settlement.ts) plus what the atlas placed it for */
export interface WikiSettlement extends Settlement {
  /** cliffside, port, river, mountain flank, crater rim, plain */
  setting: string;
  /** the atlas's size: village, town, city, metropolis */
  atlasSize: string;
  /** the level's cell (?at=x,y) */
  cell: [number, number];
  /** settlements it has a road to */
  roads: string[];
}

export interface WikiRoad {
  id: string;
  a: string;
  b: string;
  length: number;
  via: number[];
  crossings: { kind: string; region: number }[];
}

export interface WikiFaction extends Faction {
  /** true: made by this table, not designed (the user's diplomacy design replaces it) */
  placeholder: boolean;
  /** where it's strongest: its seat (a settlement) when it has one */
  seat: string | null;
  /** what kind of faction: a realm of settlements, or one of the world's own */
  type: 'realm' | 'world';
}

export interface WorldWiki {
  version: number;
  seed: number;
  /** the atlas's start cell and region */
  spawn: { cell: [number, number]; region: number; at: [number, number] };
  world: { w: number; h: number; sea: number };
  snapshot: WorldSnapshot;
  regions: WikiRegion[];
  continents: { id: number; name: string; area: number; regions: number; settlements: number }[];
  settlements: WikiSettlement[];
  roads: WikiRoad[];
  factions: WikiFaction[];
}

// ---- names ----------------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickOf = <T>(xs: T[], r: () => number): T => xs[Math.floor(r() * xs.length)];

/** each continent speaks one tongue: its places' names sound alike */
const TONGUES = [
  { on: ['b', 'd', 'g', 'k', 'r', 'th', 'v', 'm', 'h', 'br', 'dr'], nu: ['a', 'o', 'u', 'e', 'au', 'ar'], co: ['rn', 'rd', 'k', 'ld', 'th', 'g', 'n', 'm', 'sk'] },
  { on: ['s', 'l', 'm', 'n', 'f', 'sh', 'y', 'c', 'v'], nu: ['i', 'e', 'a', 'ia', 'ae', 'ei', 'o'], co: ['l', 'n', 's', 'r', 'th', 'ss', '', ''] },
  { on: ['t', 'p', 'q', 'z', 'k', 'ch', 'j', 'x'], nu: ['a', 'i', 'o', 'ua', 'e', 'ai'], co: ['n', 'x', 'l', 'r', 't', '', 'tl'] },
  { on: ['gr', 'w', 'h', 'c', 'st', 'f', 'wh', 'b'], nu: ['e', 'o', 'a', 'ea', 'oo', 'i', 'ey'], co: ['ck', 'll', 'ff', 'nd', 'sh', 'rt', 'm', 'ld'] },
];

function namer(seed: number) {
  const used = new Set<string>();
  return (tongue: number, key: number, syllables?: number) => {
    const t = TONGUES[tongue % TONGUES.length];
    const r = rng(seed * 2654435761 + key * 40503 + 11);
    for (let tries = 0; tries < 50; tries++) {
      const k = syllables ?? (r() < 0.65 ? 2 : r() < 0.85 ? 1 : 3);
      let s = '';
      for (let i = 0; i < k; i++) s += pickOf(t.on, r) + pickOf(t.nu, r) + (i === k - 1 ? (r() < 0.7 ? pickOf(t.co, r) : '') : r() < 0.25 ? pickOf(t.co, r) : '');
      const name = s[0].toUpperCase() + s.slice(1);
      if (name.length >= 3 && name.length <= 9 && !used.has(name)) {
        used.add(name);
        return name;
      }
    }
    throw new Error(`wiki: no unique name for ${key}`);
  };
}

/** what a region of each kind is called */
const NOUNS: Record<string, string[]> = {
  ocean: ['Sea', 'Deep', 'Waters'], lake: ['Mere', 'Lake', 'Water'], plains: ['Plain', 'Fields', 'Downs', 'Flats'], hills: ['Hills', 'Rises', 'Knolls'],
  highlands: ['Heights', 'Uplands', 'Moor'], range: ['Mountains', 'Peaks', 'Range', 'Teeth'], rift: ['Rift', 'Gash', 'Chasm'], mesa: ['Mesas', 'Tables', 'Buttes'],
  badlands: ['Badlands', 'Breaks', 'Gullies'], dunes: ['Dunes', 'Sands', 'Waste'], tundra: ['Tundra', 'Barrens', 'Steppe'], glacier: ['Ice', 'Glacier', 'Rime'],
  marsh: ['Fens', 'Marsh', 'Mire'], karst: ['Stone Forest', 'Karst', 'Pillars'], basalt: ['Columns', 'Causeway', 'Blackstone'], craters: ['Pocks', 'Craters', 'Scars'],
  coral: ['Reef', 'Coral'], kaleido: ['Prisms', 'Mirrors'], flesh: ['Flesh', 'Meat'], spires: ['Needles', 'Spires'], escarpment: ['Scarp', 'Edge', 'Wall'],
  lavafield: ['Burning Fields', 'Embers', 'Slag'], cenotes: ['Wells', 'Cenotes', 'Sinks'], crystalfield: ['Glitter', 'Glassfield'], crystals: ['Shards', 'Crystals'], veins: ['Veins', 'Arteries'],
};

const climateOf = (r: RegionFacts) => {
  const t = r.temp < 0 ? 'frozen' : r.temp < 6 ? 'cold' : r.temp < 14 ? 'temperate' : r.temp < 22 ? 'warm' : 'hot';
  const d = r.dryness > 0.75 ? ', dry' : r.dryness < 0.3 ? ', wet' : '';
  return t + d;
};

const SIZE: Record<string, Settlement['size']> = { village: 'village', town: 'town', city: 'city', metropolis: 'city' };
const RADIUS: Record<string, number> = { village: 40, town: 80, city: 140, metropolis: 220 };

// ---- factions (placeholders) ------------------------------------------------------------------------

const REALM_FORMS = ['Crown', 'Compact', 'League', 'Concord', 'Throne', 'Moot'];
const REALM_ETHOS: Record<Faction['era'], string[]> = {
  medieval: [
    'Lords and levies who hold the roads and tithe the harvest; proud, slow to trust, quick to take offence.',
    'A council of guild towns that trades first and fights when trade fails; polite, counting, never forgetting a debt.',
  ],
  industrial: ['Foundry towns run by a board of engineers; they dig, dam and smelt, and call the old ways waste.'],
  ancient: ['Keepers of old law under a priest-king; ritual in everything, strangers judged by the omens they bring.'],
  modern: [], 'post-apocalyptic': [], 'sci-fi': [], magical: [],
};

/** the world's own factions: what they are and where they gather (region kinds) */
const WORLD_FACTIONS: { id: FactionId; name: string; era: Faction['era']; attitude: number; ethos: string; kinds: string[]; ports?: boolean }[] = [
  { id: 'f-ashwrights', name: 'The Ashwrights', era: 'industrial', attitude: 0, ethos: 'Miners and smelters of the burning lands: they tap lava, quarry basalt and sell iron to anyone. Blunt, fair in a deal, ruthless with the land.', kinds: ['lavafield', 'basalt', 'craters', 'rift', 'badlands'] },
  { id: 'f-green-choir', name: 'The Green Choir', era: 'magical', attitude: 0.2, ethos: 'Druids who sing the wild back over ruins: they would let forest swallow every town. Gentle in speech, implacable in purpose.', kinds: ['marsh', 'karst', 'cenotes', 'hills', 'plains'] },
  { id: 'f-hollow-court', name: 'The Hollow Court', era: 'magical', attitude: -0.7, ethos: 'The dead that did not lie down, and the living who serve them; they want the world quiet, dark and theirs. Courteous, cold, patient.', kinds: ['rift', 'glacier', 'range', 'tundra'] },
  { id: 'f-salt-fleet', name: 'The Salt Fleet', era: 'post-apocalyptic', attitude: -0.3, ethos: 'Raiders and salvagers of the coasts in patched hulls; loyal to their crews, nothing else. Loud, greedy, superstitious about the sea.', kinds: [], ports: true },
];

// ---- the wiki -----------------------------------------------------------------------------------------

export function buildWiki(f: AtlasFacts): WorldWiki {
  if (f.version !== 1) throw new Error(`wiki: atlas facts version ${f.version}, expected 1`);
  const seed = f.params.seed;
  const name = namer(seed);
  const W = f.params.worldW;
  const H = f.params.worldH;
  const dist = (a: [number, number], b: [number, number]) => {
    const dx = Math.abs(a[0] - b[0]) % W;
    const dy = Math.abs(a[1] - b[1]) % H;
    return Math.hypot(Math.min(dx, W - dx), Math.min(dy, H - dy));
  };

  // continents: the ones with settlements or a fair size get names; each its own tongue
  const contIds = [...new Set(f.regions.filter((r) => r.land).map((r) => r.cont))];
  const contArea = new Map(f.regions.filter((r) => r.land).map((r) => [r.cont, r.contArea]));
  contIds.sort((a, b) => contArea.get(b)! - contArea.get(a)! || a - b);
  const tongue = new Map(contIds.map((c, i) => [c, i % TONGUES.length]));
  const contName = new Map(contIds.map((c, i) => [c, name(i % TONGUES.length, 1_000_000 + c, 2)]));

  const regions: WikiRegion[] = f.regions.map((r) => {
    const nouns = NOUNS[r.kind] ?? [r.kind];
    const rr = rng(seed * 7 + r.id * 131 + 3);
    const t = r.land ? tongue.get(r.cont)! : Math.floor(rr() * TONGUES.length);
    const proper = name(t, r.id);
    const noun = pickOf(nouns, rr);
    return {
      id: r.id,
      name: rr() < 0.75 ? `${proper} ${noun}` : `the ${noun} of ${proper}`,
      kind: r.kind,
      land: r.land,
      continent: r.land ? contName.get(r.cont)! : null,
      tier: r.tier,
      climate: climateOf(r),
      temp: r.temp,
      centre: r.centre,
      neighbours: r.neighbours,
      rivers: r.rivers,
      lava: r.lava,
      ground: r.ground,
      stamps: r.stamps,
    };
  });

  // settlements: named in their continent's tongue
  const sid = (i: number) => `s${i}`;
  const settlements: WikiSettlement[] = f.sites.map((s) => ({
    id: sid(s.id),
    name: name(tongue.get(s.cont) ?? 0, 2_000_000 + s.id),
    region: s.region,
    faction: null,
    at: s.at,
    radius: RADIUS[s.size],
    size: SIZE[s.size],
    condition: 'thriving',
    buildings: [],
    people: [],
    stores: {},
    needs: [],
    setting: s.setting,
    atlasSize: s.size,
    cell: s.cell,
    roads: [],
  }));
  const roads: WikiRoad[] = f.roads.map((r, i) => {
    settlements[r.a].roads.push(sid(r.b));
    settlements[r.b].roads.push(sid(r.a));
    return { id: `r${i}`, a: sid(r.a), b: sid(r.b), length: r.length, via: r.via, crossings: r.crossings };
  });

  // realms: each continent's settlements in clusters of about 32 (farthest-point seeds, then nearest);
  // a continent with fewer than 5 has free towns
  const factions: WikiFaction[] = [];
  const presence = f.regions.map(() => ({}) as Partial<Record<FactionId, number>>);
  const add = (r: number, fid: FactionId, v: number) => (presence[r][fid] = Math.min(1, Math.max(presence[r][fid] ?? 0, v)));
  const SIZE_RANK = ['village', 'town', 'city', 'metropolis'];
  for (const c of contIds) {
    const own = f.sites.filter((s) => s.cont === c);
    if (own.length < 5) continue;
    const k = Math.max(1, Math.round(own.length / 32));
    const seeds = [own.reduce((b, s) => (SIZE_RANK.indexOf(s.size) > SIZE_RANK.indexOf(b.size) ? s : b))];
    while (seeds.length < k) seeds.push(own.reduce((b, s) => (Math.min(...seeds.map((q) => dist(q.at, s.at))) > Math.min(...seeds.map((q) => dist(q.at, b.at))) ? s : b)));
    const groups = seeds.map(() => [] as typeof own);
    for (const s of own) groups[seeds.reduce((bi, q, i) => (dist(q.at, s.at) < dist(seeds[bi].at, s.at) ? i : bi), 0)].push(s);
    groups.forEach((g, gi) => {
      const seat = g.reduce((b, s) => (SIZE_RANK.indexOf(s.size) > SIZE_RANK.indexOf(b.size) ? s : b));
      const r = rng(seed * 977 + c * 31 + gi * 7 + 1);
      const eraRoll = r();
      const era: Faction['era'] = eraRoll < 0.6 ? 'medieval' : eraRoll < 0.85 ? 'industrial' : 'ancient';
      const seatName = settlements[seat.id].name;
      const id = `f-${seatName.toLowerCase()}`;
      factions.push({
        id,
        name: `The ${seatName} ${pickOf(REALM_FORMS, r)}`,
        ethos: pickOf(REALM_ETHOS[era], r),
        era,
        attitude: +(0.3 * r() - 0.05).toFixed(2),
        relations: {},
        placeholder: true,
        seat: sid(seat.id),
        type: 'realm',
      });
      for (const s of g) {
        settlements[s.id].faction = id;
        add(s.region, id, 0.7);
        for (const nb of f.regions[s.region].neighbours) if (f.regions[nb].land) add(nb, id, 0.35);
      }
    });
  }
  // the world's own: where their kinds of land are near settled land (patchy), the fleet at the ports
  for (const wf of WORLD_FACTIONS) {
    factions.push({ id: wf.id, name: wf.name, ethos: wf.ethos, era: wf.era, attitude: wf.attitude, relations: {}, placeholder: true, seat: null, type: 'world' });
    const kinds = new Set(wf.kinds);
    for (const r of f.regions) {
      if (!r.land || !kinds.has(r.kind)) continue;
      const rr = rng(seed * 389 + r.id * 17 + wf.id.length * 1013);
      if (rr() < 0.45) add(r.id, wf.id, +(0.2 + 0.4 * rr()).toFixed(2));
    }
    if (wf.ports) for (const s of f.sites) if (s.setting === 'port') add(s.region, wf.id, +(0.2 + 0.3 * rng(seed * 61 + s.id)()).toFixed(2));
  }
  // relations: realms wary of each other, the Court hostile to all living, the Choir against the Ashwrights
  for (const a of factions)
    for (const b of factions) {
      if (a === b) continue;
      const r = rng(seed * 13 + a.id.length * 7 + b.id.length * 101 + a.id.charCodeAt(2) * 3 + b.id.charCodeAt(2))();
      let v = +(0.4 * r - 0.2).toFixed(2);
      if (a.id === 'f-hollow-court' || b.id === 'f-hollow-court') v = -0.8;
      else if ((a.id === 'f-green-choir' && b.id === 'f-ashwrights') || (b.id === 'f-green-choir' && a.id === 'f-ashwrights')) v = -0.6;
      else if (a.id === 'f-salt-fleet' || b.id === 'f-salt-fleet') v = -0.4;
      a.relations[b.id] = v;
    }

  const bySite = new Map<number, string[]>();
  for (const s of settlements) bySite.set(s.region, [...(bySite.get(s.region) ?? []), s.id]);
  const snapshot: WorldSnapshot = {
    version: 0,
    run: 0,
    regions: regions.map((r) => {
      const state: RegionState = freshRegion();
      state.presence = presence[r.id];
      return { id: r.id, name: r.name, kind: r.kind, state, settlements: bySite.get(r.id) ?? [] };
    }),
    factions: factions.map(({ placeholder: _p, seat: _s, type: _t, ...fac }) => fac),
    history: [],
    runs: [],
  };
  const continents = contIds
    .filter((c) => f.sites.some((s) => s.cont === c) || contArea.get(c)! > 2000)
    .map((c) => ({ id: c, name: contName.get(c)!, area: contArea.get(c)!, regions: f.regions.filter((r) => r.land && r.cont === c).length, settlements: f.sites.filter((s) => s.cont === c).length }));
  const ROW_H = Math.sqrt(3) / 2;
  return {
    version: WIKI_VERSION,
    seed,
    spawn: { cell: f.spawn.cell, region: f.spawn.region, at: [f.spawn.cell[0], Math.round(f.spawn.cell[1] * ROW_H)] },
    world: { w: W, h: H, sea: f.params.sea },
    snapshot,
    regions,
    continents,
    settlements,
    roads,
    factions,
  };
}

// ---- the markdown ---------------------------------------------------------------------------------

export function wikiMarkdown(w: WorldWiki, opt: { around?: [number, number]; radius?: number } = {}): string {
  const at = opt.around ?? w.spawn.at;
  const R = opt.radius ?? 2600;
  const dist = (a: [number, number], b: [number, number]) => {
    const dx = Math.abs(a[0] - b[0]) % w.world.w;
    const dy = Math.abs(a[1] - b[1]) % w.world.h;
    return Math.hypot(Math.min(dx, w.world.w - dx), Math.min(dy, w.world.h - dy));
  };
  const reg = (id: number) => w.regions[id];
  const st = (id: number) => w.snapshot.regions[id].state;
  const fac = new Map(w.factions.map((f) => [f.id, f]));
  const set = new Map(w.settlements.map((s) => [s.id, s]));
  const pres = (p: RegionState['presence']) =>
    Object.entries(p)
      .sort((a, b) => b[1]! - a[1]!)
      .map(([k, v]) => `${k} ${v!.toFixed(2)}`)
      .join(', ') || 'none';
  const near = (c: [number, number]) => dist(c, at);
  const L: string[] = [];
  const home = reg(w.spawn.region);
  L.push(`# World wiki — seed ${w.seed}`);
  L.push('');
  L.push(`World version ${w.snapshot.version}, run ${w.snapshot.run}. Made by scripts/worldwiki.mjs from the atlas (data/atlas/seed${w.seed}.json); the JSON form is data/wiki/seed${w.seed}.json (a WorldSnapshot plus geography, settlements and roads). Ids here are the ones a SessionStory must use: regions are numbers, settlements \`s<n>\`, factions \`f-<name>\`.`);
  L.push('');
  L.push('## How to read this');
  L.push('');
  L.push('- A **region** is one patch of the atlas: a kind of land (plains, rift, glacier …), a landform tier (lowland, upland, plateau, massif), a climate. Its **state** is what play and stories have done to it (RegionState: sunk, buried, overgrowth, frozen, storm, shadow, undead, ruin, flooded, wetness, faction presence, marks). Every region starts fresh.');
  L.push('- A **settlement** stands in a region, in a setting the atlas placed it for (a port at a river mouth, a cliffside town on a plateau rim, a river town). Roads join neighbours; a road crosses landform edges by ramps, switchbacks or lifts, massifs by tunnels, rivers and gorges by bridges.');
  L.push('- **Factions are placeholders** (a deterministic table, not designed): realms are clusters of settlements named for their seat; four world factions roam the kinds of land that suit them. The user\'s diplomacy design will replace them; stories may use them as they are.');
  L.push(`- Distances are world units (a cell is one unit; the world is ${w.world.w} × ${Math.round(w.world.h)} and wraps). A region is about 200 across; walking a road of 1000 is a long day.`);
  L.push('');
  L.push('## The world');
  L.push('');
  for (const c of w.continents.slice(0, 8)) L.push(`- **${c.name}** (continent ${c.id}): ${c.regions} regions, ${c.settlements} settlements, ${((100 * c.area) / (2048 * 2048)).toFixed(1)}% of the world.`);
  L.push('');
  L.push('History: nothing has happened yet (no AtlasEvents). Past runs: none.');
  L.push('');
  L.push('## Factions (placeholders)');
  L.push('');
  for (const f of w.factions) {
    const where = w.snapshot.regions.filter((r) => r.state.presence[f.id]).sort((a, b) => near(reg(a.id).centre) - near(reg(b.id).centre)).slice(0, 4);
    const rel = Object.entries(f.relations).filter(([, v]) => Math.abs(v!) >= 0.3).map(([k, v]) => `${k} ${v}`);
    L.push(`### ${f.name} \`${f.id}\``);
    L.push(`- ${f.type === 'realm' ? 'A realm' : 'A world faction'}, era ${f.era}; attitude to the player ${f.attitude}.${f.seat ? ` Seat: ${set.get(f.seat)!.name} \`${f.seat}\`.` : ''}`);
    L.push(`- ${f.ethos}`);
    if (rel.length) L.push(`- Strong feelings: ${rel.join(', ')}.`);
    L.push(`- Nearest presence: ${where.map((r) => `${r.name} (${r.id}, ${r.state.presence[f.id]})`).join('; ') || 'none'}.`);
    L.push('');
  }
  L.push('## The start');
  L.push('');
  L.push(`The sea stands at z ${w.world.sea}.`);
  L.push('');
  L.push(`The run starts at cell ${w.spawn.cell.join(',')} (world ${w.spawn.at.join(',')}), in **${home.name}** (region ${home.id}): ${home.kind}, ${home.tier ?? 'water'}, ${home.climate} (${home.temp} °C at sea level)${home.rivers ? `, rivers run through it (${home.rivers} river nodes)` : ''}. Presence: ${pres(st(home.id).presence)}.`);
  L.push('');
  const RR = Math.min(R, 1400);
  const close = w.regions.filter((r) => near(r.centre) <= RR).sort((a, b) => near(a.centre) - near(b.centre));
  L.push(`## Regions within ${RR} of the start (${close.length})`);
  L.push('');
  L.push('id | name | kind | tier | climate | ground (min/mean/max z) | water | stamps | settlements | presence | neighbours | distance');
  L.push('--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---');
  for (const r of close) {
    const water = [r.rivers ? `rivers ${r.rivers}` : '', r.lava ? `lava ${r.lava}` : ''].filter(Boolean).join(', ') || '-';
    const ss = w.snapshot.regions[r.id].settlements.map((s) => `${set.get(s)!.name} \`${s}\``).join(', ') || '-';
    L.push(`${r.id} | ${r.name} | ${r.kind} | ${r.tier ?? '-'} | ${r.climate} | ${r.ground.min}/${r.ground.mean}/${r.ground.max} | ${water} | ${r.stamps.join(', ') || '-'} | ${ss} | ${pres(st(r.id).presence)} | ${r.neighbours.join(' ')} | ${Math.round(near(r.centre))}`);
  }
  L.push('');
  const towns = w.settlements.filter((s) => near(s.at) <= R).sort((a, b) => near(a.at) - near(b.at));
  L.push(`## Settlements within ${R} of the start (${towns.length})`);
  L.push('');
  for (const s of towns) {
    const r = reg(s.region);
    L.push(`### ${s.name} \`${s.id}\``);
    L.push(`- A ${s.atlasSize} (${s.setting}) in ${r.name} (region ${r.id}: ${r.kind}, ${r.tier}, ${r.climate}); ${Math.round(near(s.at))} from the start; cell ${s.cell.join(',')}.`);
    L.push(`- Faction: ${s.faction ? `${fac.get(s.faction)!.name} \`${s.faction}\`` : 'none (a free town)'}. Condition: ${s.condition}.`);
    const rs = w.roads.filter((x) => x.a === s.id || x.b === s.id);
    for (const x of rs) {
      const o = set.get(x.a === s.id ? x.b : x.a)!;
      const kinds = [...new Set(x.via.map((v) => reg(v).kind))];
      const cr = x.crossings.map((c) => `${c.kind === 'switchbacks' ? '' : 'a '}${c.kind} in ${reg(c.region).name} (${c.region})`);
      L.push(`- Road to ${o.name} \`${o.id}\`: ${x.length} long, through ${kinds.join(', ')}${cr.length ? `; crosses by ${cr.join(', ')}` : ''}.`);
    }
    L.push('');
  }
  L.push('## What a story can change (AtlasEvent kinds)');
  L.push('');
  L.push('sink, raise (under the sea), bury (ash/sand/silt, magnitude in cells), overgrow, freeze, thaw, storm (detail.storm: rain, dust, snow, ash, arcane), clear-storm, shadow, light, raise-dead, lay-dead, flood (magnitude: a level), drain, burn, ruin, rebuild, faction-presence (detail.faction), mark (detail.name, detail.kind: a grave, a statue, a crater named for someone). See docs/GM.md.');
  L.push('');
  return L.join('\n');
}
