// What the fortress's planning panel says (docs/WRITING.md: plain words, one idea a sentence, numbers of things).
// Pure, so the writing lint reads every line (fortress.test.ts).
import type { Good, Goods, PerBlock, PlanTotals, StructureDef } from '../api/contracts/fortress';

const NAMES: Record<Good, [string, string]> = {
  log: ['wood', 'wood'],
  stone: ['stone', 'stone'],
  grain: ['grain', 'grain'],
  weapons: ['weapon', 'weapons'],
  soldiers: ['soldier', 'soldiers'],
  power: ['power', 'power'],
};

const ORDER: Good[] = ['log', 'stone', 'grain', 'weapons', 'soldiers', 'power'];

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
  parts.push(def.form === 'yard' ? 'flat' : `up to ${def.maxLevels} high`);
  // (short sentences, not one run-on line: the writing lint's limit is 20 words a sentence)
  const [label, ...rest] = parts;
  return `${label}: ${rest.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1) : x)).join('. ')}.`;
}

/** The picker's hint for a type: what one block costs and gives. */
export function typeLines(def: StructureDef): string[] {
  const out = [`Each block costs ${goodsText(def.cost)}.`];
  if (def.form === 'yard') out.push('It lies flat on the ground.');
  else out.push(`Stack it up to ${def.maxLevels} high.`);
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

/** The stores strip: what's in the stores and the power coming in. */
export function storesLine(stores: Goods, powerPerDay: number): string {
  const n = (k: Good) => Math.floor(stores[k] ?? 0);
  return `Wood ${n('log')} · Stone ${n('stone')} · Grain ${n('grain')} · Power ${n('power')}, +${Math.round(powerPerDay)} a day`;
}
