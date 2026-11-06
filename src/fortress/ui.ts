// The fortress's bar. Planning (time stopped): select what — one of the nine types — then tap to plan it; Erase, and for
// walls Gate and Tower toggles (no shift key on a phone); a compact line on the type picked (what a block costs, makes,
// holds, how high: typeCard, from its data), the structure just painted, the plan against the stores; a big Build button.
// Building (time runs): the bar shrinks to the progress and a Plan button, so the building can be watched. The stores
// and the power coming in show at the top in both. Planning is unmistakable (round 128d, the user: "I don't mind that
// as long as we are clearly in planning mode"): a "Planning (paused)" banner and an amber frame round the screen.
// (round 128d, the user: "I think pause prevents both panning and building in build mode": the frame covers the whole
// screen, and ui/style.css's `#ui > * { pointer-events: auto }` outranked its own `pointer-events: none` — every press
// landed on the frame, not the map, paused or not. The frame and the banners take no presses, at #ui's specificity.)
import { STRUCTURE_TYPES, type StructureType } from '../api/contracts/fortress';
import { DEFS } from './defs';
import type { Fortress } from './fortress';
import { inspectCard, inspectFacts } from './inspect';
import { townCard } from './townpick';
import { ECON } from './defs';
import { BEDS_LINE, buildingLine, crewLine, cutOffLine, FULL_LINE, HUNGRY_LINE, jobsLine, PAUSED_LINE, peopleLine, planLines, SKIP_DONE, SKIPPING_LINE, storesLine, structureLines, typeCard } from './words';

const CSS = `
.fort-bar{position:absolute;left:0;right:0;bottom:0;padding:6px 8px calc(8px + env(safe-area-inset-bottom));
  background:rgba(20,22,26,.86);color:#eee;font:14px/1.3 system-ui,sans-serif;pointer-events:auto;z-index:30}
.fort-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}
.fort-bar button{min-height:40px;border:1px solid #555;border-radius:7px;background:#2c3036;color:#eee;font:inherit;padding:2px 4px}
.fort-bar button.on{background:#c8a24a;color:#111;border-color:#e6c46a;font-weight:600}
.fort-bar button:disabled{opacity:.35}
.fort-bar button.go{background:#3f7a3a;border-color:#6fae5f;font-weight:700;font-size:16px;min-height:46px}
.fort-row{display:flex;gap:5px;margin-top:5px}
.fort-row button{flex:1}
.fort-info{margin:0 0 6px;font-size:13px;line-height:1.35}
.fort-info p{margin:0}
.fort-info .card{color:#f1d58a;font-weight:600}
.fort-info .short{color:#ff9c7a}
.fort-info .title{color:#f1d58a;font-weight:700;font-size:14px}
.fort-row button.inspect{flex:0 0 30%}
.fort-row button.skip{flex:2}
.fort-top{position:absolute;left:50%;top:8px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;
  gap:3px;z-index:30;pointer-events:none;width:max-content;max-width:96vw}
.fort-top div{background:rgba(20,22,26,.82);color:#eee;padding:4px 11px;border-radius:13px;font:13px system-ui,sans-serif;white-space:nowrap}
.fort-top .mode{font-weight:700;font-size:15px}
.fort-top .mode.plan{background:#c8a24a;color:#111}
.fort-frame{position:absolute;inset:0;pointer-events:none;z-index:29;box-shadow:inset 0 0 0 5px #c8a24a;background:rgba(200,162,74,.07)}
#ui>.fort-frame,#ui>.fort-top{pointer-events:none}
`;

export interface FortressBarHooks {
  /** Build pressed: the plan goes to the builders, time runs */
  build(): void;
  /** Plan pressed: back to planning, time stops */
  plan(): void;
  /** (round 128e, FT-50) while building: run time at this speed (1, 4, 16) */
  speed(n: number): void;
  /** (FT-50) Skip to done: time runs fast until the plan stands, or stops early with a reason (Fortress.note) */
  skip(): void;
  /** the speed time runs at now, and whether it's skipping */
  now(): { speed: number; skipping: boolean };
  /** (round 128l, m4; V128-10) the person a tap picked: its card (null: none), whether the camera follows it, Follow pressed */
  person?(): { title: string; lines: string[] } | null;
  following?(): boolean;
  follow?(on: boolean): void;
  /** (round 128l, m4) the attack wave: what the bar says of it (the rider's word, the raid, its summary), and "Call raiders now" */
  raidLines?(): string[];
  callRaid?(): void;
  /** (m4, part B) whether the raid's lines are the summary card after a wave, and its Close */
  raidSummary?(): boolean;
  closeRaid?(): void;
}

/** (round 128e, FT-50) the speeds a tap picks while building */
export const SPEEDS = [1, 4, 16] as const;

export class FortressBar {
  readonly root: HTMLDivElement;
  private info: HTMLDivElement;
  private buttons = new Map<StructureType, HTMLButtonElement>();
  private eraseBtn: HTMLButtonElement;
  private gateBtn: HTMLButtonElement;
  private towerBtn: HTMLButtonElement;
  private planOnly: HTMLElement[] = [];
  /** (round 128e, FT-50) while building: 1x, 4x, 16x and Skip to done */
  private timeRow: HTMLDivElement;
  private speedBtns: HTMLButtonElement[] = [];
  private skipBtn: HTMLButtonElement;
  private goBtn: HTMLButtonElement;
  private inspectBtn: HTMLButtonElement;
  private top: HTMLDivElement;
  private modeLine: HTMLDivElement;
  private storeLine: HTMLDivElement;
  private peopleLine: HTMLDivElement;
  private frame: HTMLDivElement;
  /** (m4) Follow, under a person's card */
  private followRow: HTMLDivElement;
  private followBtn: HTMLButtonElement;
  /** (m4) Close, under the raid's summary card */
  private raidRow: HTMLDivElement;
  private hooks: FortressBarHooks;

  private now: () => { speed: number; skipping: boolean } = () => ({ speed: 1, skipping: false });

  /** (round 128e, FT-48) the old town's name, for its cards */
  townName = 'the town';

  constructor(parent: HTMLElement, private fort: Fortress, hooks: FortressBarHooks) {
    this.hooks = hooks;
    const style = document.createElement('style');
    style.textContent = CSS;
    parent.appendChild(style);
    this.frame = document.createElement('div');
    this.frame.className = 'fort-frame';
    parent.appendChild(this.frame);
    this.top = document.createElement('div');
    this.top.className = 'fort-top';
    this.modeLine = document.createElement('div');
    this.storeLine = document.createElement('div');
    this.peopleLine = document.createElement('div');
    this.top.append(this.modeLine, this.storeLine, this.peopleLine);
    parent.appendChild(this.top);
    this.root = document.createElement('div');
    this.root.className = 'fort-bar';
    this.info = document.createElement('div');
    this.info.className = 'fort-info';
    this.root.appendChild(this.info);
    const grid = document.createElement('div');
    grid.className = 'fort-grid';
    for (const t of STRUCTURE_TYPES) {
      const b = document.createElement('button');
      b.textContent = DEFS[t].label;
      b.onclick = () => {
        fort.tool = { type: t, erase: false, gate: false };
        this.render();
      };
      this.buttons.set(t, b);
      grid.appendChild(b);
    }
    this.root.appendChild(grid);
    const row = document.createElement('div');
    row.className = 'fort-row';
    const toggle = (label: string, key: 'erase' | 'gate' | 'tower') => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        const on = !fort.tool[key];
        fort.tool = { type: fort.tool.type, erase: false, gate: false, tower: false, [key]: on };
        this.render();
      };
      return b;
    };
    this.eraseBtn = toggle('Erase', 'erase');
    this.gateBtn = toggle('Gate', 'gate');
    this.towerBtn = toggle('Tower', 'tower');
    row.append(this.eraseBtn, this.gateBtn, this.towerBtn);
    this.root.appendChild(row);
    const goRow = document.createElement('div');
    goRow.className = 'fort-row';
    this.goBtn = document.createElement('button');
    this.goBtn.className = 'go';
    this.goBtn.onclick = () => {
      // (round 128e, the user: "Reopening build doesn't seem to work": Inspect left on while building kept the types and
      // tools hidden after Plan — the bar showed the Inspect card instead. Plan and Build put Inspect away)
      if (fort.tool.inspect) {
        fort.tool = { type: fort.tool.type, erase: false, gate: false, tower: false };
        fort.inspectedTown = null;
        fort.inspect(null);
      }
      if (fort.mode === 'plan') hooks.build();
      else hooks.plan();
      this.render();
    };
    // (round 128d) Inspect, planning or building: a tap picks a structure and shows its card; a tap on nothing closes it
    this.inspectBtn = document.createElement('button');
    this.inspectBtn.className = 'inspect';
    this.inspectBtn.textContent = 'Inspect';
    this.inspectBtn.onclick = () => {
      const on = !fort.tool.inspect;
      fort.tool = { type: fort.tool.type, erase: false, gate: false, tower: false, inspect: on };
      if (!on) {
        fort.inspectedTown = null;
        fort.inspect(null);
      }
      this.render();
    };
    goRow.append(this.inspectBtn, this.goBtn);
    // (round 128e, FT-50; the user: "There is no way to fast forward or skip time to each building being completed")
    this.timeRow = document.createElement('div');
    this.timeRow.className = 'fort-row';
    for (const n of SPEEDS) {
      const b = document.createElement('button');
      b.textContent = `${n}x`;
      b.onclick = () => {
        hooks.speed(n);
        this.render();
      };
      this.speedBtns.push(b);
      this.timeRow.appendChild(b);
    }
    this.skipBtn = document.createElement('button');
    this.skipBtn.textContent = 'Skip to done';
    this.skipBtn.className = 'skip';
    this.skipBtn.onclick = () => {
      hooks.skip();
      this.render();
    };
    this.timeRow.appendChild(this.skipBtn);
    // (round 128l, m4) the attack wave's test button: the next wave now
    if (hooks.callRaid) {
      const b = document.createElement('button');
      b.textContent = 'Call raiders now';
      b.className = 'raid';
      b.onclick = () => {
        hooks.callRaid!();
        this.render();
      };
      this.timeRow.appendChild(b);
    }
    this.root.appendChild(this.timeRow);
    // (round 128l, m4) a person's card: Follow keeps the camera on them until a tap lands elsewhere
    this.followRow = document.createElement('div');
    this.followRow.className = 'fort-row';
    this.followBtn = document.createElement('button');
    this.followBtn.className = 'follow';
    this.followBtn.onclick = () => {
      hooks.follow?.(!hooks.following?.());
      this.render();
    };
    this.followRow.appendChild(this.followBtn);
    this.root.appendChild(this.followRow);
    // (round 128l, m4) the raid's summary card: Close puts it away
    this.raidRow = document.createElement('div');
    this.raidRow.className = 'fort-row';
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.onclick = () => {
      hooks.closeRaid?.();
      this.render();
    };
    this.raidRow.appendChild(close);
    this.root.appendChild(this.raidRow);
    this.root.appendChild(goRow);
    this.now = () => hooks.now();
    this.planOnly = [grid, row];
    // (the bar takes its own presses: none reach the map under it)
    for (const ev of ['pointerdown', 'pointerup', 'click', 'wheel', 'touchstart']) this.root.addEventListener(ev, (e) => e.stopPropagation());
    parent.appendChild(this.root);
    fort.onChange.push(() => this.render());
    this.render();
  }

  /** The lines the panel shows now (the writing lint reads them too). */
  lines(): { text: string; short?: boolean; card?: boolean; title?: boolean }[] {
    const f = this.fort;
    const out: { text: string; short?: boolean; card?: boolean; title?: boolean }[] = [];
    const stores = f.stores();
    // (round 128l, m4) a person picked: its card first, whatever the mode
    const who = this.hooks.person?.() ?? null;
    if (who) {
      out.push({ text: who.title, title: true });
      for (const l of who.lines) out.push({ text: l });
      return out;
    }
    if (f.tool.inspect) {
      // (round 128d) Inspect: the picked structure's card (inspect.ts), from its data and the ledger now
      const s = f.inspected !== null ? f.plan.structure(f.inspected) : null;
      if (!s && f.inspectedTown) {
        const card = townCard(f.inspectedTown, this.townName);
        out.push({ text: card.title, title: true });
        for (const l of card.lines) out.push({ text: l });
      } else if (!s) out.push({ text: 'Tap a block or a building to see what it is.' });
      else {
        // (milestone 3) the live numbers: its workers, what they brought, a farm's ripe grain (Fortress.status)
        const st = f.status;
        const live = { workers: st.workers.get(s.id) ?? 0, brought: st.made.get(s.id) ?? {}, ripe: st.ripe.get(s.id) ?? 0 };
        const card = inspectCard(inspectFacts(f.plan, s, (c, l) => f.town.has(c, l), stores, undefined, live));
        out.push({ text: card.title, title: true });
        for (const l of card.lines) out.push({ text: l });
      }
      return out;
    }
    if (f.mode === 'build') {
      const p = f.progress();
      // (round 128l, m4) the attack wave first: the rider's word, the raid as it goes; after it, its summary as a card
      const raid = this.hooks.raidLines?.() ?? [];
      if (this.hooks.raidSummary?.() && raid.length) {
        out.push({ text: raid[0], title: true });
        for (const l of raid.slice(1)) out.push({ text: l });
        return out;
      }
      for (const l of raid) out.push({ text: l, short: true });
      out.push({ text: buildingLine(p.built, p.total) });
      // (round 128e, FT-49) the builders, by what they're doing: they're small among a town's roofs
      if (f.crew && p.built < p.total) out.push({ text: crewLine(f.crew) });
      if (f.cutOff > 0) out.push({ text: cutOffLine(f.cutOff), short: true });
      // (milestone 3) who does what, and why the haul or the newcomers stopped
      out.push({ text: jobsLine(f.status.jobs) });
      if (f.status.full) out.push({ text: FULL_LINE, short: true });
      if (f.status.hungry) out.push({ text: HUNGRY_LINE, short: true });
      else if (f.status.people >= f.beds() && f.status.people < ECON.maxPeople) out.push({ text: BEDS_LINE });
      // (round 128e, FT-50) why Skip stopped, or that it's running
      if (f.note) out.push({ text: f.note, short: f.note !== SKIP_DONE });
      else if (this.now().skipping) out.push({ text: SKIPPING_LINE });
      out.push({ text: 'Press Plan to stop time and plan more.' });
      return out;
    }
    const t = f.tool;
    if (t.gate) out.push({ text: 'Tap a straight wall to put a gate in it. Tap a gate to close it.' });
    else if (t.tower) out.push({ text: 'Tap a wall to put a tower on it. Tap it again to take the tower off.' });
    else if (t.erase) out.push({ text: 'Tap a block to take it away.' });
    else out.push({ text: typeCard(DEFS[t.type]), card: true });
    // (round 128f) why the last tap planned nothing: the stores can't reach the spot, or it would shut blocks off
    if (f.refusal) out.push({ text: f.refusal, short: true });
    // (round 128h, V128-13) the way the last tap kept open (a gate, a passage, a ramp), or what it cut off (outlined)
    if (f.variant) out.push({ text: f.variant, short: true });
    // (round 128d: Houses picked showed "This wall has 2 blocks… 4 archers can stand on it" — the structure last painted,
    // of another type) the structure's lines only when it is of the type picked (Gate and Tower: a wall's)
    const s = f.selected !== null ? f.plan.structure(f.selected) : null;
    const showing = t.gate || t.tower ? 'wall' : t.erase ? s?.type : t.type;
    if (s && s.type === showing) out.push({ text: structureLines(DEFS[s.type], f.plan.blocks(s), f.plan.cost(s), f.plan.gives(s)).join(' ') });
    const tot = f.plan.totals(stores);
    const pl = planLines(tot, stores);
    out.push({ text: pl.slice(0, -1).join(' ') || pl[0] });
    if (pl.length > 1) out.push({ text: pl[pl.length - 1], short: Object.keys(tot.short).length > 0 });
    return out;
  }

  /** The banner lines at the top: the mode, the stores, and (milestone 3) the people with the power coming in. */
  topLines(): string[] {
    const f = this.fort;
    const p = f.progress();
    const st = f.stores();
    return [f.mode === 'plan' ? PAUSED_LINE : buildingLine(p.built, p.total), storesLine(st), peopleLine(f.status.people, f.beds(), st, f.powerPerDay())];
  }

  render(): void {
    const f = this.fort;
    const t = f.tool;
    const planning = f.mode === 'plan';
    for (const [k, b] of this.buttons) b.classList.toggle('on', !t.erase && !t.gate && !t.tower && k === t.type);
    this.eraseBtn.classList.toggle('on', t.erase);
    this.gateBtn.classList.toggle('on', t.gate);
    this.towerBtn.classList.toggle('on', !!t.tower);
    this.gateBtn.disabled = t.type !== 'wall' && !t.gate;
    this.towerBtn.disabled = t.type !== 'wall' && !t.tower;
    // (inspecting: the card in place of the types — the bar stays phone-sized)
    for (const el of this.planOnly) el.style.display = planning && !t.inspect ? '' : 'none';
    // (round 128e, FT-50) the time row while building
    this.timeRow.style.display = planning || t.inspect ? 'none' : '';
    const now = this.now();
    this.speedBtns.forEach((b, i) => b.classList.toggle('on', !now.skipping && now.speed === SPEEDS[i]));
    this.skipBtn.classList.toggle('on', now.skipping);
    this.goBtn.textContent = planning ? 'Build' : 'Plan';
    this.inspectBtn.classList.toggle('on', !!t.inspect);
    // (another tool picked: the card closes)
    if (!t.inspect && f.inspected !== null) f.inspect(null);
    this.frame.style.display = planning ? '' : 'none';
    // (m4) Follow under a person's card; the types and the time row make way for it
    const who = this.hooks.person?.() ?? null;
    this.followRow.style.display = who ? '' : 'none';
    // (m4) the raid's summary card: Close under it, the time row out of its way
    const card = !who && !planning && !t.inspect && !!this.hooks.raidSummary?.();
    this.raidRow.style.display = card ? '' : 'none';
    if (card) this.timeRow.style.display = 'none';
    this.followBtn.textContent = this.hooks.following?.() ? 'Stop following' : 'Follow';
    this.followBtn.classList.toggle('on', !!this.hooks.following?.());
    if (who) {
      for (const el of this.planOnly) el.style.display = 'none';
      this.timeRow.style.display = 'none';
    }
    const [mode, stores, people] = this.topLines();
    this.modeLine.textContent = mode;
    this.modeLine.className = planning ? 'mode plan' : 'mode';
    this.storeLine.textContent = stores;
    this.peopleLine.textContent = people;
    this.info.replaceChildren(
      ...this.lines().map((l) => {
        const p = document.createElement('p');
        p.textContent = l.text;
        if (l.short) p.className = 'short';
        if (l.card) p.className = 'card';
        if (l.title) p.className = 'title';
        return p;
      }),
    );
  }

  dispose(): void {
    this.root.remove();
    this.top.remove();
    this.frame.remove();
  }
}
