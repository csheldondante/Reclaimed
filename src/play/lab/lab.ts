// ---- play/lab/lab.ts --------------------------------------------------------------------------------------------
// (round 121, herolab; BACKLOG HL1) The lab's framework: stations and variant pickers, generic, so camera modes,
// abilities and moves, puzzles, enemies and the combat gym slot in the same way. The user (round 120): "I want a hero
// lab for both hero abilities and moves and puzzles and enemies and camera modes so we can iterate many variants and
// see what works best."
//
// - A LabStation is a place to try something (a terrain to ride, later a puzzle, an enemy pen, the combat gym): one
//   tap to go there (enter), stepped each frame while it's the one (update), left (leave). Its kind groups it.
// - A VariantPicker is a row of chips over one choice (single: a hero; multi: camera modes that combine), kept in the
//   page's address (`?<param>=`) so a variant is a link to send.
// Neither knows the world or the camera: a station is given what the lab gives it (its context), nothing else.

export type StationKind = 'camera' | 'moves' | 'traits' | 'puzzle' | 'enemy' | 'combat';

export const STATION_KINDS: { kind: StationKind; icon: string; name: string }[] = [
  { kind: 'camera', icon: '🎥', name: 'camera & terrain' },
  { kind: 'moves', icon: '🤸', name: 'abilities & moves' },
  { kind: 'traits', icon: '✨', name: 'traits: the living and the dead, sanctuary, fear, stone' },
  { kind: 'puzzle', icon: '🧩', name: 'puzzles' },
  { kind: 'enemy', icon: '👹', name: 'enemies' },
  { kind: 'combat', icon: '⚔', name: 'combat gym (CB1: a design talk first)' },
];

export interface LabStation<C> {
  id: string;
  kind: StationKind;
  name: string;
  icon?: string;
  /** one line: what to try here */
  hint: string;
  /** buttons that do something there (the traits' scenes: a crowd, smite, raise...) */
  actions?: LabAction<C>[];
  enter(ctx: C): void;
  update?(ctx: C, dt: number): void;
  leave?(ctx: C): void;
  /** (round 128, HL11) an encounter's goal: what to do, how it ends, the result shown; absent: free play */
  goal?: LabGoal<C>;
}

/**
 * (round 128, HL11; the user: "making fun encounters via the hero lab") A station's goal: an encounter is a station
 * with a scripted setup (its enter), enemies, a goal and an ending. `check` is asked each frame from the start: won,
 * lost, or on with a share done; past `time` seconds it's lost ("out of time"). Its words are player text.
 */
export interface LabGoal<C> {
  /** what to do, plain: "Get to the top." */
  text: string;
  /** seconds allowed (absent: no clock) */
  time?: number;
  check(ctx: C, t: number): GoalState;
}

export interface GoalState {
  state: 'on' | 'won' | 'lost';
  /** 0..1 done (a bar), when it can say */
  done?: number;
  /** a short plain line: "3 raiders left", "Knocked out" */
  note?: string;
}

/** how an encounter ended: the result shown */
export interface LabResult {
  station: string;
  state: 'won' | 'lost';
  /** seconds it took */
  time: number;
  note: string;
}

export interface LabAction<C> {
  label: string;
  icon?: string;
  run(ctx: C): void;
}

/** a page parameter, read and written without reloading */
export const urlParam = {
  get(name: string): string | null {
    return new URLSearchParams(location.search).get(name);
  },
  set(name: string, value: string | null): void {
    const q = new URLSearchParams(location.search);
    if (value === null) q.delete(name);
    else q.set(name, value);
    history.replaceState(null, '', `${location.pathname}?${q.toString()}${location.hash}`);
  },
};

export interface Choice<T extends string> {
  id: T;
  icon: string;
  label: string;
  hint?: string;
}

/** A row of chips over one choice: single (one on) or multi (any on, `fixed` always on), mirrored to `?param=`. */
export class VariantPicker<T extends string> {
  readonly el: HTMLDivElement;
  private chips = new Map<T, HTMLButtonElement>();
  value: T[];

  constructor(
    parent: HTMLElement,
    readonly title: string,
    readonly choices: readonly Choice<T>[],
    private o: { multi?: boolean; fixed?: T[]; param?: string; initial: T[]; format?: (v: T[]) => string; onChange: (v: T[]) => void },
  ) {
    this.value = [...o.initial];
    this.el = document.createElement('div');
    this.el.className = 'lab-row';
    const t = document.createElement('span');
    t.className = 'lab-row-title';
    t.textContent = title;
    this.el.append(t);
    for (const c of choices) {
      const b = document.createElement('button');
      b.className = 'play-chip lab-chip';
      b.innerHTML = `<span>${c.icon}</span><small>${c.label}</small>`;
      if (c.hint) b.title = c.hint;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', () => this.toggle(c.id));
      this.chips.set(c.id, b);
      this.el.append(b);
    }
    parent.append(this.el);
    this.paint();
  }

  /** a chip tapped: single, it's the one; multi, it's on or off (a fixed one stays on) */
  toggle(id: T): void {
    if (!this.o.multi) this.value = [id];
    else if (this.o.fixed?.includes(id)) {
      // (the fixed one alone: everything else off)
      this.value = [...(this.o.fixed ?? [])];
    } else this.value = this.value.includes(id) ? this.value.filter((v) => v !== id) : [...this.value, id];
    this.set(this.value);
  }

  set(v: T[]): void {
    this.value = [...v];
    this.paint();
    if (this.o.param) urlParam.set(this.o.param, this.o.format ? this.o.format(this.value) : this.value.join('+'));
    this.o.onChange(this.value);
  }

  private paint(): void {
    for (const [id, b] of this.chips) b.classList.toggle('on', this.value.includes(id));
  }

  dispose(): void {
    this.el.remove();
  }
}

/** The stations of a lab, by kind; one is current. */
export class Stations<C> {
  current: LabStation<C> | null = null;
  /** (HL11) seconds since the current station began, its goal's state now, and the last result */
  t = 0;
  goal: GoalState | null = null;
  result: LabResult | null = null;
  /** told when an encounter ends */
  readonly ended: ((r: LabResult) => void)[] = [];
  constructor(
    readonly list: LabStation<C>[],
    private ctx: C,
  ) {}

  ofKind(kind: StationKind): LabStation<C>[] {
    return this.list.filter((s) => s.kind === kind);
  }

  go(id: string): LabStation<C> {
    const s = this.list.find((x) => x.id === id);
    if (!s) throw new Error(`lab: no station "${id}" (${this.list.map((x) => x.id).join(', ')})`);
    this.current?.leave?.(this.ctx);
    this.current = s;
    this.t = 0;
    this.result = null;
    this.goal = s.goal ? { state: 'on', done: 0 } : null;
    s.enter(this.ctx);
    return s;
  }

  update(dt: number): void {
    const s = this.current;
    s?.update?.(this.ctx, dt);
    if (!s?.goal || this.result) return;
    this.t += dt;
    let g = s.goal.check(this.ctx, this.t);
    if (g.state === 'on' && s.goal.time !== undefined && this.t >= s.goal.time) g = { state: 'lost', note: 'Out of time' };
    this.goal = g;
    if (g.state !== 'on') {
      this.result = { station: s.id, state: g.state, time: this.t, note: g.note ?? '' };
      for (const f of this.ended) f(this.result);
    }
  }
}
