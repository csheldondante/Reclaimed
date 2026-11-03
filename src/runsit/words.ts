// ---- runsit/words.ts ------------------------------------------------------------------------------------------------
// (round 126, `encounters`) The end card's "What changed in the world" in plain sentences (docs/WRITING.md). It showed
// the event's kind and its regions as code ("ruin: Bra Flats", "mark: Bra Flats — the burned town of Muru",
// "raise-dead: Bra Flats, Brogarn Flats…"); main's review: "Write them as sentences ("Muru burned.")". Pure: the
// writing lint reads it in Node.

import type { AtlasEvent } from '../api/contracts/world';
import { capitalise } from '../living/plain';

export interface ChangeNames {
  region: (id: number) => string;
  faction: (id: string) => string;
  settlement: (id: string) => string;
}

/** a list of places as a reader says it: "A", "A and B", "A and the land round it" */
function places(ids: number[], n: ChangeNames): string {
  if (!ids.length) return 'the land';
  if (ids.length === 1) return n.region(ids[0]);
  if (ids.length === 2) return `${n.region(ids[0])} and ${n.region(ids[1])}`;
  return `${n.region(ids[0])} and the land round it`;
}

/** one event as a sentence (null: nothing a player would notice) */
export function changeLine(e: Pick<AtlasEvent, 'kind' | 'regions' | 'magnitude' | 'detail'>, n: ChangeNames): string | null {
  const at = places(e.regions, n);
  const d = e.detail ?? {};
  const fac = typeof d.faction === 'string' ? n.faction(d.faction) : 'They';
  const town = typeof d.settlement === 'string' ? n.settlement(d.settlement) : at;
  const up = e.magnitude >= 0;
  const s = ((): string | null => {
    switch (e.kind) {
      case 'burn':
        return `Fire swept through ${at}.`;
      case 'ruin':
        return `${at} lies in ruins.`;
      case 'rebuild':
        return `${at} is rebuilt.`;
      case 'mark':
        return typeof d.name === 'string' ? `${d.name} is on the map now.` : null;
      case 'raise-dead':
        return `The dead rise in ${at}.`;
      case 'lay-dead':
        return `The dead lie still in ${at}.`;
      case 'flood':
        return `${at} is under water.`;
      case 'drain':
        return `The water drains from ${at}.`;
      case 'overgrow':
        return `Green grows over ${at}.`;
      case 'freeze':
        return `${at} freezes.`;
      case 'thaw':
        return `${at} thaws.`;
      case 'storm':
        return `A storm hangs over ${at}.`;
      case 'clear-storm':
        return `The storm over ${at} clears.`;
      case 'shadow':
        return `A shadow falls on ${at}.`;
      case 'light':
        return `The shadow lifts from ${at}.`;
      case 'sink':
        return `The ground sinks in ${at}.`;
      case 'raise':
        return `The ground rises in ${at}.`;
      case 'bury':
        return `${at} is buried.`;
      case 'faction-presence':
        return up ? `${fac} holds more of ${at}.` : `${fac} loses ground in ${at}.`;
      case 'faction-attitude':
        return up ? `${fac} thinks better of you.` : `${fac} thinks less of you.`;
      case 'faction-relation':
        return typeof d.toward === 'string' ? (up ? `${fac} warms to ${n.faction(d.toward)}.` : `${fac} turns against ${n.faction(d.toward)}.`) : null;
      case 'faction-power':
        return up ? `${fac} grows stronger.` : `${fac} grows weaker.`;
      case 'settlement-condition':
        return d.condition === 'ruined' ? `${town} burned.` : d.condition === 'abandoned' ? `${town} stands empty.` : typeof d.condition === 'string' ? `${town} is ${d.condition}.` : null;
      case 'settlement-owner':
        return `${fac} now holds ${town}.`;
      case 'migrate':
        return typeof d.from === 'string' && typeof d.to === 'string' ? `People from ${n.settlement(d.from)} move to ${n.settlement(d.to)}.` : null;
      case 'river-inflow':
        return e.magnitude < 1 ? `The rivers of ${at} run low.` : `The rivers of ${at} run high.`;
      case 'settlement-stores':
        return typeof d.good === 'string' ? (up ? `${town} has more ${d.good}.` : `${town} has less ${d.good}.`) : null;
      case 'settlement-building':
        return typeof d.name === 'string' ? `${d.name} now stands in ${town}.` : `Something new stands in ${town}.`;
    }
  })();
  return s ? capitalise(s.charAt(0).toUpperCase() + s.slice(1)) : null;
}

/** the end card's lines: each change once */
export function changeLines(events: Pick<AtlasEvent, 'kind' | 'regions' | 'magnitude' | 'detail'>[], n: ChangeNames): string[] {
  const out: string[] = [];
  for (const e of events) {
    const l = changeLine(e, n);
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}
