// What the fortress's planning panel says (docs/WRITING.md: plain words, one idea a sentence, numbers of things).
// Pure, so the writing lint reads every line (fortress.test.ts).
import type { Good, Goods, PerBlock, PlanTotals, StructureDef } from '../api/contracts/fortress';

const NAMES: Record<Good, [string, string]> = {
  log: ['wood', 'wood'],
  stone: ['stone', 'stone'],
  ore: ['ore', 'ore'],
  grain: ['grain', 'grain'],
  weapons: ['weapon', 'weapons'],
  soldiers: ['soldier', 'soldiers'],
  power: ['power', 'power'],
};

const ORDER: Good[] = ['log', 'stone', 'ore', 'grain', 'weapons', 'soldiers', 'power'];

function list(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? 'nothing';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "24 wood and 12 stone" */
export function goodsText(g: Goods): string {
  const parts: string[] = [];
  for (const k of ORDER) {
    const v = Math.round(g[k] ?? 0);
    if (v > 0) parts.push(`${v} ${NAMES[k][v === 1 ? 0 : 1]}`);
  }
  return list(parts);
}

/** What a structure gives, a sentence each. */
export function givesLines(p: PerBlock): string[] {
  const out: string[] = [];
  if (p.beds) out.push(`It has beds for ${p.beds} people.`);
  if (p.storage) out.push(`It holds ${p.storage} goods.`);
  if (p.jobs) out.push(`It needs ${p.jobs} workers.`);
  if (p.posts) out.push(`${p.posts} archers can stand on it.`);
  if (p.power) out.push(`It gives ${Math.round(p.power)} power a day once built.`);
  if (p.makes) {
    const m = goodsText(p.makes);
    if (m !== 'nothing') out.push(`It makes ${m} a day.`);
  }
  return out;
}

/**
 * (round 128d, the user: "information about what building do somewhere compact but visible") One line for a type,
 * from its data: what a block costs, what it makes, holds or needs, how high it goes.
 * "Farms: 1 wood a block. Makes 2 grain a day. 1 worker a block. Flat."
 */
export function typeCard(def: StructureDef): string {
  const p = def.perBlock;
  const parts = [def.label, `${goodsText(def.cost)} a block`];
  if (p.makes) parts.push(`makes ${goodsText(p.makes)} a day`);
  if (p.power) parts.push(`power ${p.power} a block, more up high`);
  if (p.beds) parts.push(`${p.beds} beds a block`);
  if (p.storage) parts.push(`holds ${p.storage} a block`);
  if (p.jobs) parts.push(`${p.jobs} ${p.jobs === 1 ? 'worker' : 'workers'} a block`);
  if (p.posts) parts.push(`${p.posts} archers a block`);
  parts.push(def.form === 'yard' ? 'flat' : Number.isFinite(def.maxLevels) ? `up to ${def.maxLevels} high` : 'as high as you like');
  // (short sentences, not one run-on line: the writing lint's limit is 20 words a sentence)
  const [label, ...rest] = parts;
  return `${label}: ${rest.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1) : x)).join('. ')}.`;
}

/** The picker's hint for a type: what one block costs and gives. */
export function typeLines(def: StructureDef): string[] {
  const out = [`Each block costs ${goodsText(def.cost)}.`];
  if (def.form === 'yard') out.push('It lies flat on the ground.');
  else out.push(Number.isFinite(def.maxLevels) ? `Stack it up to ${def.maxLevels} high.` : 'Stack it as high as you like.');
  return out.concat(givesLines(def.perBlock).map((s) => s.replace(/^It /, 'Each block ').replace(/^(\d+) archers can stand on it\./, '$1 archers can stand on each block.')));
}

/** The structure just painted. */
export function structureLines(def: StructureDef, blocks: number, cost: Goods, gives: PerBlock): string[] {
  const head = `This ${def.one} has ${blocks} ${blocks === 1 ? 'block' : 'blocks'}.`;
  return [head, `It costs ${goodsText(cost)}.`, ...givesLines(gives)];
}

/** The whole plan against the stores. */
export function planLines(t: PlanTotals, stores: Goods): string[] {
  if (!t.blocks) return ['Pick a building. Then tap the ground to plan it.'];
  const out = [`Your plan costs ${goodsText(t.cost)}.`];
  const have: Goods = {};
  for (const k of Object.keys(t.cost) as Good[]) have[k] = stores[k] ?? 0;
  out.push(`Your stores have ${goodsText(have)}.`);
  const short = goodsText(t.short);
  out.push(short === 'nothing' ? 'You have enough to build it.' : `You need ${short} more.`);
  return out;
}

/** (round 128d) the banners: planning (time stopped, planned blocks drawn whole) and building */
export const PAUSED_LINE = 'Planning (paused)';

/** Building: how far the plan is (counts of blocks). */
export function buildingLine(built: number, total: number): string {
  if (total <= 0) return 'Nothing to build. Press Plan to plan more.';
  if (built >= total) return `All ${total} blocks are built.`;
  return `Building: ${built} of ${total} blocks done`;
}

/**
 * (round 128e, FT-49; the user: "The agents never appeared for me to begin work") What the builders are doing:
 * "8 builders. 3 carry loads, 2 build, 3 fetch from the stores."
 */
export function crewLine(c: { builders: number; toStores: number; carrying: number; working: number; waiting: number }): string {
  if (!c.builders) return 'There are no builders.';
  const parts: string[] = [];
  if (c.carrying) parts.push(`${c.carrying} ${c.carrying === 1 ? 'carries a load' : 'carry loads'}`);
  if (c.working) parts.push(`${c.working} ${c.working === 1 ? 'builds' : 'build'}`);
  if (c.toStores) parts.push(`${c.toStores} ${c.toStores === 1 ? 'goes' : 'go'} to the stores`);
  if (c.waiting) parts.push(`${c.waiting} ${c.waiting === 1 ? 'waits' : 'wait'}`);
  const head = `${c.builders} ${c.builders === 1 ? 'builder' : 'builders'}.`;
  return parts.length ? `${head} ${list(parts)}.` : head;
}

/** (round 128e, FT-50) Skip to done: running, done, or stopped early and why */
export const SKIPPING_LINE = 'Skipping ahead until everything is built.';
export const SKIP_DONE = 'Everything you planned is built.';
export function skipShortLine(short: Goods): string {
  return `Skip stopped. The stores need ${goodsText(short)} more to finish the plan.`;
}
export function skipCutOffLine(n: number): string {
  return `Skip stopped. ${cutOffLine(n)}`;
}

/** (round 128d, FT-20) Building: blocks no builder can walk to from the heap. */
export function cutOffLine(n: number): string {
  return `${n === 1 ? '1 block' : `${n} blocks`} can't be reached from the stores. Deep water or a cliff is in the way.`;
}

/** The stores strip: what's in the stores (milestone 3: ore too). */
export function storesLine(stores: Goods): string {
  const n = (k: Good) => Math.floor(stores[k] ?? 0);
  // (round 128l, m4: the smiths' weapons too)
  return `Wood ${n('log')} · Stone ${n('stone')} · Ore ${n('ore')} · Grain ${n('grain')} · Weapons ${n('weapons')}`;
}

/** (milestone 3) The people strip: people, beds, and the power coming in. */
export function peopleLine(people: number, beds: number, stores: Goods, powerPerDay: number): string {
  // (round 128l, m4: the soldiers the barracks trained)
  return `People ${people} · Beds ${beds} · Soldiers ${Math.floor(stores.soldiers ?? 0)} · Power ${Math.floor(stores.power ?? 0)}, +${Math.round(powerPerDay)} a day`;
}

/** (milestone 3) Who does what: "4 builders, 2 farmers and 1 miner. 2 people have no work." */
export function jobsLine(jobs: Partial<Record<'build' | 'farm' | 'quarry' | 'lumber' | 'blacksmith' | 'barracks' | 'idle', number>>): string {
  const names: [keyof typeof jobs, string, string][] = [
    ['build', 'builder', 'builders'],
    ['farm', 'farmer', 'farmers'],
    ['quarry', 'miner', 'miners'],
    ['lumber', 'woodcutter', 'woodcutters'],
    ['blacksmith', 'smith', 'smiths'],
    ['barracks', 'recruit', 'recruits'],
  ];
  const parts = names.filter(([k]) => (jobs[k] ?? 0) > 0).map(([k, one, many]) => `${jobs[k]} ${jobs[k] === 1 ? one : many}`);
  const idle = jobs.idle ?? 0;
  const out: string[] = [];
  if (parts.length) out.push(`${list(parts)} at work.`);
  if (idle) out.push(idle === 1 ? '1 person has no work.' : `${idle} people have no work.`);
  return out.join(' ') || 'Nobody lives here.';
}

/** (milestone 3) The stores are too full for another load: the haul stops. */
export const FULL_LINE = 'The stores are full. Workers wait until there is room. Build more warehouse blocks.';

/** (milestone 3) No grain in the stores: nobody new comes. */
export const HUNGRY_LINE = 'There is no grain. Nobody new will come until there is. Build farms.';

/** (milestone 3) Every bed is taken: nobody new comes. */
export const BEDS_LINE = 'Every bed is taken. Build houses so more people can come.';

/** (round 128f) why the stores can't reach a spot: deep water, walled in, a cliff or a building, out past the fields */
export type ReachWhy = 'deep' | 'walled' | 'cliff' | 'far';

const WHY_WORDS: Record<ReachWhy, string> = {
  deep: 'Deep water is in the way.',
  walled: 'It is walled in. Put a gate in the wall first.',
  cliff: 'A cliff or a building is in the way.',
  far: 'It is too far from the stores.',
};

/** (round 128f) the check at placement: a block the stores can't reach isn't planned, and the panel says why */
export function reachWhyLine(why: ReachWhy): string {
  return `Builders can't reach that spot from the stores. ${WHY_WORDS[why]}`;
}

/**
 * (RT-6, round 128m) blocks placed together (taps folded into one check, a drag): the ones the stores can't reach are
 * taken out again — how many, and why (the most common reason). One block on its own: reachWhyLine
 */
export function refusedLine(refused: number, placed: number, why: ReachWhy): string {
  if (placed <= 1) return reachWhyLine(why);
  const one = refused === 1;
  const what = one ? WHY_WORDS[why] : WHY_WORDS[why].replace(/^It is/, 'They are');
  const head = refused >= placed ? `None of those ${placed} blocks were planned.` : `${refused} of those ${placed} blocks ${one ? 'was' : 'were'} not planned.`;
  return `${head} Builders can't reach ${one ? 'it' : 'them'} from the stores. ${what}`;
}

/** (round 128h, V128-13) what was put in so a block placed keeps the way open: a gate, a passage, a ramp */
export type VariantKind = 'gate' | 'passage' | 'ramp';

/** (round 128h) the panel's line for the way kept open */
export function variantLine(kind: VariantKind, type: string): string {
  const what = type === 'lumber' ? 'lumber camp' : type;
  if (kind === 'gate') return 'A gate goes in the wall, so builders can get in.';
  if (kind === 'passage') return `The ${what} gets an arch through its ground floor, so builders can walk through.`;
  return 'A ramp goes up the drop, so builders can climb back to the stores.';
}

/** (round 128f) a block that would shut planned blocks off from the stores isn't planned */
export function wouldCutLine(types: string[]): string {
  const names = types.map((t) => `the ${t === 'fortress' ? 'keep' : t === 'lumber' ? 'lumber camp' : t}`);
  return `That would shut ${list(names)} off from the stores. Leave a way through.`;
}

// ---- (round 128l, m4) the attack wave (raiders.ts): the rider's word, the raid, the summary after it

/** the rider's word, a day before the wave */
export function raidWarnLine(side: string, size: number): string {
  return `A rider brings word. Raiders from the ${side}, tomorrow at dusk. He counted ${size} of them.`;
}

/** the wave is here */
export function raidArrivedLine(side: string, size: number): string {
  return `${size} raiders are coming from the ${side}. Your people run inside. The gates will shut.`;
}

/** the wave's summary: what it took, broke and burned, who fell */
export function raidOverLines(r: { taken: Goods; broken: Record<string, number>; housesBurned: number; fallen: { name: string; soldier: boolean }[]; raidersFallen: number; raidersOut: number }): string[] {
  const out = ['The raid is over.'];
  const took = Object.values(r.taken).some((n) => (n ?? 0) >= 1) ? goodsText(r.taken) : '';
  out.push(took ? `The raiders got away with ${took}.` : 'The raiders took nothing.');
  const broke: string[] = [];
  for (const [what, n] of Object.entries(r.broken)) {
    if (what === 'house' || n <= 0) continue;
    broke.push(n === 1 ? `the ${what === 'fortress' ? 'keep' : what}` : `${n} ${what === 'fortress' ? 'keep' : what} blocks`);
  }
  if (broke.length) out.push(`They broke ${list(broke)}.`);
  if (r.housesBurned) out.push(r.housesBurned === 1 ? 'A house burned down.' : `${r.housesBurned} houses burned down.`);
  if (broke.length || r.housesBurned) out.push('Builders will rebuild what broke when the stores can pay.');
  // who fell: soldiers, then the rest, by name while there are few
  const named = (who: string[], one: string, more: string) => {
    if (!who.length) return;
    if (who.length === 1) return void out.push(`${one}${who[0]} died.`);
    out.push(`${who.length} ${more} died.`);
    if (who.length <= 4) out.push(`They were ${list(who)}.`);
  };
  named(r.fallen.filter((f) => f.soldier).map((f) => f.name), 'The soldier ', 'soldiers');
  named(r.fallen.filter((f) => !f.soldier).map((f) => f.name), '', 'of your people');
  if (!r.fallen.length) out.push('None of your people died.');
  const many = (n: number, one: string, more: string) => (n === 1 ? one : more.replace('#', String(n)));
  if (r.raidersFallen > 0) out.push(many(r.raidersFallen, 'One raider died.', '# raiders died.'));
  else out.push('None of the raiders died.');
  if (r.raidersOut > 0) out.push(many(r.raidersOut, 'One got away.', '# got away.'));
  else if (r.raidersFallen > 0) out.push('None got away.');
  return out;
}

/** the raid as it goes: what the raiders are doing now */
export function raidNowLine(stage: string, alive: number, broke: string | null): string {
  const n = alive === 1 ? 'One raider is' : alive > 1 ? `${alive} raiders are` : 'The raiders are';
  if (stage === 'breach') return `The gates are shut. ${n} at the walls, breaking in.`;
  if (stage === 'stores') return broke ? `The raiders broke the ${broke}. They are going for the stores.` : 'The raiders are going for the stores.';
  if (stage === 'houses') return 'The raiders are setting fire to the houses.';
  return `${n} running off.`;
}
