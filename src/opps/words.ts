// ---- opps/words.ts ------------------------------------------------------------------------------------------------
// (dialog2) What the run's screens say, as pure functions of plain data: the roster, the intro, the status line, the
// situation panel and the map's hint. In plain words (docs/WRITING.md); test/unit/writing.test.ts runs them over seed
// 1's run and checks every line. The level (level-opps.ts) only lays them out.

import { capitalise } from '../living/plain';

const mins = (m: number) => `${+m.toFixed(1)} minute${+m.toFixed(1) === 1 ? '' : 's'}`;

export interface HeroCard {
  icon: string;
  name: string;
  /** who plays it (the record's name), and whether they died */
  who: string;
  dead: boolean;
  line: string;
  top: number;
  jump: { height: number; gap: number };
  fly: number;
  /** 0..1 */
  breaks: number;
  earned: string[];
  deeds: number;
  modes: { name: string; on: boolean }[];
}

/** a hero on the roster: its lines */
export function rosterLines(h: HeroCard): { head: string; lines: string[] } {
  const move = [
    `Top speed ${h.top.toFixed(0)} cells a second.`,
    h.jump.height ? `Jumps ${h.jump.height.toFixed(0)} high and ${h.jump.gap.toFixed(0)} across.` : 'Cannot jump.',
    h.fly ? `Flies up to ${h.fly.toFixed(0)} high.` : '',
    `Breaks ${Math.round(h.breaks * 100)}% of what it hits.`,
  ].filter(Boolean).join(' ');
  const good = h.modes.filter((m) => m.on).map((m) => m.name);
  return {
    head: `${h.icon} ${h.name}, played by ${h.who}${h.dead ? ', who died' : ''}`,
    lines: [
      h.line,
      move,
      h.earned.length ? `Earned so far: ${h.earned.join(', ')}.` : 'Nothing earned yet.',
      ...(h.deeds ? [`${h.deeds} deed${h.deeds === 1 ? '' : 's'} remembered.`] : []),
      good.length ? `Good at: ${good.join(', ')}.` : '',
    ].filter(Boolean),
  };
}

export interface IntroFacts {
  title: string;
  threat: string;
  count: number;
  role: string;
  faction: string;
  target: string;
  outriders: number;
  premise: string;
  arrives: number;
  hero: string;
  byGM: boolean;
}

/** the run's intro: what is happening, how bad, what you are trying to do, the clock */
export function introLines(f: IntroFacts): { title: string; lines: string[]; foot: string } {
  return {
    title: f.title,
    lines: [
      `${capitalise(f.threat)} is marching on ${f.target}. That is ${f.count} ${f.role}, sent by ${f.faction}.`,
      ...(f.outriders ? [`${f.outriders} of their riders are out ahead, and they have seen you.`] : []),
      `If nothing stops them, ${f.target} burns.`,
      f.premise,
      `They reach ${f.target} at minute ${f.arrives.toFixed(1)}. Every ride and every fight uses up time.`,
    ],
    foot: `You play ${f.hero}. ${f.byGM ? 'This story was written for this world.' : 'This story was made from this world.'}`,
  };
}

export interface StatusFacts {
  turn: number;
  clock: number;
  threat: string;
  target: string;
  /** minutes until the threat reaches the target (negative: it is there) */
  left: number;
  held: { name: string; count: number; veteran: boolean; busy: boolean }[];
  goods: Record<string, number>;
  running: { title: string; turns: number }[];
  done: string[];
  lapsed: string[];
  warned: boolean;
  evacuate: boolean;
}

/** the line of what's going on and what you have */
export function statusLines(f: StatusFacts): string[] {
  const held = f.held.map((a) => `${a.name}, ${a.count} strong${a.veteran ? ', veterans' : ''}${a.busy ? ', away' : ''}`);
  const goods = Object.entries(f.goods).filter(([, n]) => n > 0).map(([g, n]) => `${n} ${n === 1 && g === 'supplies' ? 'supply' : g}`);
  return [
    `Turn ${f.turn}. Minute ${f.clock.toFixed(1)}. ${f.left > 0 ? `The dead reach ${f.target} in ${mins(f.left)}.` : `The dead reached ${f.target} ${mins(-f.left)} ago.`}`,
    held.length || goods.length ? `With you: ${[...held, ...goods].join('. ')}.` : 'With you: nobody yet.',
    ...f.running.map((r) => `⏳ ${r.title}. ${r.turns ? `${r.turns} turn${r.turns > 1 ? 's' : ''} left.` : 'Done this turn.'}`),
    ...f.done.map((t) => `✔ ${t}`),
    ...f.lapsed.map((t) => `✘ ${t}`),
    f.warned ? (f.evacuate ? `☞ ${f.target} is warned. Its people are ready to leave.` : `⚑ ${f.target} is warned.`) : '',
  ].filter(Boolean);
}

/** the compact situation panel */
export function situationLines(f: { title: string; threat: string; count: number; role: string; target: string; left: number; premise: string; hero: string; intelPct: number; rallied: number }): string[] {
  return [
    f.title,
    `${capitalise(f.threat)}: ${f.count} ${f.role}. ${f.left > 0 ? `They reach ${f.target} in ${mins(f.left)}.` : `They reached ${f.target} ${mins(-f.left)} ago.`}`,
    f.premise,
    `You play ${f.hero}.`,
    f.intelPct ? `From the ridge: holding the ford is ${f.intelPct}% more likely.` : '',
    f.rallied ? `${f.rallied} freed people will fight for ${f.target}.` : '',
  ].filter(Boolean);
}

/** the map's hint, with nothing chosen */
export function mapHint(n: number): string[] {
  return ['Tap someone on the map to hear them out. Gold means you go. Blue means you send soldiers.', n === 1 ? 'One person is asking for help this turn.' : `${n} people are asking for help this turn.`];
}
