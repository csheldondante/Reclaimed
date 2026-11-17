// (card-table, docs/design/FACTORY.md) The stock and the machines, as a small pure model: what the town holds, the
// buildings with their clicks left and their recipes, and the shortest chain of clicks that would cover a need this
// season. The board's preview says "You could make it now: Dig, Dig, Smelt, Weapons"; the bots measure how often a
// card needs a chain. Pure: no Realm, no DOM.
import type { UseNow } from './realm';

export interface Recipe {
  id: string;
  name: string;
  cost: Record<string, number>;
  gives: Record<string, number>;
  /** times it may still be made this season (its own cap) */
  left: number;
}
export interface Machine {
  thing: string;
  name: string;
  /** clicks left this season (Infinity: the thing needs none — only each recipe's own cap) */
  clicks: number;
  recipes: Recipe[];
  /** room for more crews, and the clicks each brings: a chain may post a free crew here (it is then not free) */
  room?: number;
  cpc?: number;
}
export interface Click {
  thing: string;
  use: string;
  name: string;
}

/** the machines as the Realm's uses stand now (a use that cannot be made for want of a piece or of anything to give
 *  is left out; one short of goods stays — a chain may make them) */
export function machinesOf(uses: readonly UseNow[], room: (thing: string) => { room: number; cpc: number } = () => ({ room: 0, cpc: 0 })): Machine[] {
  const by = new Map<string, Machine>();
  for (const u of uses) {
    const r = room(u.thing);
    const outOfClicks = !!u.clicks && u.clicks.left <= 0;
    if (u.left <= 0 || (outOfClicks && !(r.room > 0 && r.cpc > 0))) continue;
    // (blocked for want of a piece it needs, or of anything to give: not for want of goods or of clicks)
    const blocked = !u.can && !Object.keys(u.short).length && !outOfClicks;
    if (blocked) continue;
    const m = by.get(u.thing) ?? { thing: u.thing, name: u.thingName, clicks: u.clicks ? u.clicks.left : Infinity, recipes: [], ...(u.clicks && r.room > 0 ? { room: r.room, cpc: r.cpc } : {}) };
    m.recipes.push({ id: u.use.id, name: u.use.name, cost: { ...(u.use.cost as Record<string, number>) }, gives: Object.fromEntries(Object.entries(u.gives).filter(([, n]) => !!n)) as Record<string, number>, left: u.left });
    by.set(u.thing, m);
  }
  return [...by.values()];
}

/** what is short of a need in a stock (empty: nothing) */
export function shortOf(stock: Readonly<Record<string, number>>, need: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(need)) if (n > 0 && (stock[k] ?? 0) < n) out[k] = n - (stock[k] ?? 0);
  return out;
}

/** the goods that help toward a need: the need's own, and every input of a recipe that makes one of them */
function useful(machines: readonly Machine[], need: Readonly<Record<string, number>>): Set<string> {
  const out = new Set(Object.keys(need).filter((k) => need[k] > 0));
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of machines)
      for (const r of m.recipes)
        if (Object.keys(r.gives).some((g) => out.has(g)))
          for (const k of Object.keys(r.cost))
            if (!out.has(k)) {
              out.add(k);
              grew = true;
            }
  }
  return out;
}

/**
 * The shortest chain of clicks (breadth first) after which the stock covers the need, made this season with the
 * clicks and caps left. [] when it is covered already; null when no chain within `depth` clicks does (or the search
 * passes `budget` positions). Only recipes that make something useful toward the need are tried.
 */
export function plan(stock: Readonly<Record<string, number>>, machines: readonly Machine[], need: Readonly<Record<string, number>>, o: { depth?: number; budget?: number } = {}): Click[] | null {
  const depth = o.depth ?? 8;
  const budget = o.budget ?? 20_000;
  if (!Object.keys(shortOf(stock, need)).length) return [];
  const want = useful(machines, need);
  const moves = machines.flatMap((m, mi) => m.recipes.map((r, ri) => ({ mi, ri, m, r }))).filter((x) => Object.keys(x.r.gives).some((g) => want.has(g)));
  if (!moves.length) return null;
  const keys = [...new Set([...want, 'labor'])];
  // (a chain may post a free crew on a building with room when it has no click left: the crew is then not free — the
  // `labor` of the stock — and brings its clicks; the step is told as "Post a crew at …")
  type S = { stock: Record<string, number>; clicks: number[]; room: number[]; left: number[][]; path: Click[] };
  const start: S = { stock: { ...stock }, clicks: machines.map((m) => m.clicks), room: machines.map((m) => m.room ?? 0), left: machines.map((m) => m.recipes.map((r) => r.left)), path: [] };
  const keyOf = (s: S): string => `${keys.map((k) => Math.min(s.stock[k] ?? 0, 99)).join(',')}|${s.clicks.map((c) => (c === Infinity ? 'i' : c)).join(',')}|${s.room.join(',')}|${s.left.map((l) => l.join('.')).join('/')}`;
  const seen = new Set<string>([keyOf(start)]);
  let frontier: S[] = [start];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: S[] = [];
    for (const s of frontier)
      for (const { mi, ri, m, r } of moves) {
        const post = s.clicks[mi] <= 0 && s.room[mi] > 0 && (m.cpc ?? 0) > 0 && (s.stock.labor ?? 0) > 0;
        if ((s.clicks[mi] <= 0 && !post) || s.left[mi][ri] <= 0) continue;
        const st = { ...s.stock };
        const clicks = [...s.clicks];
        const room = [...s.room];
        const path = [...s.path];
        if (post) {
          st.labor -= 1;
          room[mi]--;
          clicks[mi] += m.cpc!;
          path.push({ thing: m.thing, use: '', name: `Post a crew at ${m.name}` });
        }
        if (Object.entries(r.cost).some(([k, n]) => (st[k] ?? 0) < n)) continue;
        for (const [k, n] of Object.entries(r.cost)) st[k] -= n;
        for (const [k, n] of Object.entries(r.gives)) st[k] = (st[k] ?? 0) + n;
        clicks[mi]--;
        const left = s.left.map((l) => [...l]);
        left[mi][ri]--;
        const n: S = { stock: st, clicks, room, left, path: [...path, { thing: m.thing, use: r.id, name: r.name }] };
        if (!Object.keys(shortOf(st, need)).length) return n.path;
        const k = keyOf(n);
        if (seen.has(k)) continue;
        if (seen.size >= budget) return null;
        seen.add(k);
        next.push(n);
      }
    frontier = next;
  }
  return null;
}
