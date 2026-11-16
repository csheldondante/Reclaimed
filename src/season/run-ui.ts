// (loop-skeleton; docs/design/LOOP_SKELETON.md "Screens") The main loop's screens, phone first, crude on purpose: pick a
// leader, the town with its people's names over it, a petition as a card (cost, if you agree, if you wait too long),
// the season passing, the attack with the spell bar, its result, a world change, the end of the run. A view only: it
// reads the game (RunGame — scenes/level/loop.ts implements it) and calls it back; every line from run-words.ts.
import { POOL_ROLE, POOLS, pools, total, type SeasonLedger } from './ledger';
import type { Petition, RunRecord, SpellId, WorldChange, WorldRecord } from './run';
import { shortOf, signsNow } from './run';
import * as W from './run-words';
import { incomeLine, POOL_ICON, POOL_NAME } from './words';

export type Phase = 'boot' | 'leader' | 'city' | 'petition' | 'season' | 'attack' | 'result' | 'mutation' | 'end';

export interface Marker {
  id: string;
  label: string;
  kind: 'ask' | 'threat' | 'change';
  x: number;
  y: number;
}

export interface RunGame {
  readonly phase: Phase;
  readonly run: RunRecord | null;
  readonly world: WorldRecord;
  readonly ledger: SeasonLedger;
  readonly selected: Petition | null;
  /** what just happened, newest last (a card agreed, cards that ran out) */
  readonly notes: string[];
  /** the attack as it stands, and its result once over */
  readonly fightLine: string | null;
  readonly resultLines: string[];
  /** the world change being shown */
  readonly change: { text: string; standin: boolean } | null;
  readonly armed: SpellId | null;
  /** the end screen left to look at this change's place */
  readonly looking: WorldChange | null;
  look(change: string | null): void;
  readonly canSkip: boolean;
  readonly onChange: (() => void)[];
  /** the names over the map now, in screen px */
  markers(): Marker[];
  pick(leader: string): void;
  open(petition: string): void;
  agree(): void;
  back(): void;
  next(): void;
  skip(): void;
  arm(spell: SpellId | null): void;
  proceed(): void;
  again(): void;
}

const CSS = `
.run-top{position:absolute;left:0;right:0;top:0;z-index:30;display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px 8px;background:linear-gradient(rgba(18,20,24,.9),rgba(18,20,24,.6));color:#f2efe8;font:13px system-ui,sans-serif;pointer-events:none}
.run-top .r-title{font-weight:700;flex:1 0 100%}
.run-top .r-pool{background:rgba(255,255,255,.1);border-radius:10px;padding:2px 7px;white-space:nowrap}
.run-top .r-pool i{font-style:normal;opacity:.7;font-size:11px;margin-left:2px}
.run-top .r-pool.unrest b{color:#ff9b7a}
.run-top .r-sign{background:#4a3a56;border:1px solid #c9a2ff;border-radius:10px;padding:2px 7px;white-space:nowrap}
.run-top .r-stand{font-size:11px;color:#c9a2ff;flex:1 0 100%}
.run-marks{position:absolute;inset:0;z-index:20;pointer-events:none;overflow:hidden}
.run-marks button{position:absolute;transform:translate(-50%,-100%);pointer-events:auto;font:700 13px system-ui,sans-serif;padding:5px 9px;border-radius:14px 14px 14px 2px;border:2px solid #221;background:#f2e3b0;color:#221;white-space:nowrap}
.run-marks button.threat{background:#e2573f;color:#fff}
.run-marks button.change{background:#3b3340;color:#f0d9ff;border-color:#c9a2ff;border-radius:4px;font-weight:600;font-size:12px}
.run-sheet{position:absolute;left:0;right:0;bottom:0;z-index:30;background:rgba(22,24,28,.94);color:#f2efe8;font:14px system-ui,sans-serif;border-radius:14px 14px 0 0;padding:10px 12px calc(12px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:7px;max-height:60vh;overflow-y:auto}
.run-sheet h3{margin:0;font-size:16px}
.run-sheet .who{color:#d9c99a;font-size:13px}
.run-sheet .ask{font-style:italic}
.run-sheet .row{display:flex;gap:8px;font-size:13px}
.run-sheet .row b{flex:0 0 108px;color:#c8c8c8;font-weight:600}
.run-sheet .row span{flex:1}
.run-sheet .need,.run-sheet .warn{color:#ff9b7a;font-size:13px}
.run-sheet .note{font-size:13px;color:#d0d0d0}
.run-sheet .stand{font-size:12px;color:#c9a2ff}
.run-sheet .list{display:flex;flex-direction:column;gap:5px}
.run-sheet .item{display:flex;gap:8px;align-items:center;background:#2c3038;border-radius:10px;padding:8px;border:0;color:inherit;font:inherit;text-align:left}
.run-sheet .item.threat{background:#4a2a26}
.run-sheet .item span{flex:1}
.run-sheet .item i{font-style:normal;font-size:12px;color:#d9c99a;white-space:nowrap}
.run-sheet .go{display:flex;gap:8px}
.run-sheet .go button{flex:1;font:700 16px system-ui;padding:12px;border-radius:10px;border:0;background:#e8b84a;color:#221}
.run-sheet .go button.quiet{background:#555;color:#eee}
.run-sheet .go button.on{outline:3px solid #fff}
.run-sheet .go button:disabled{opacity:.45}
.run-full{position:absolute;inset:0;z-index:40;background:rgba(14,16,20,.93);color:#f2efe8;font:14px system-ui,sans-serif;display:flex;flex-direction:column;gap:10px;padding:18px 14px calc(16px + env(safe-area-inset-bottom));overflow-y:auto}
.run-full h2{margin:0;font-size:22px}
.run-full .sub{color:#c8c8c8;font-size:13px}
.run-full .leader{display:flex;gap:10px;background:#2c3038;border-radius:12px;padding:10px;align-items:stretch}
.run-full .portrait{flex:0 0 72px;height:92px;border:2px dashed #777;border-radius:8px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:11px;color:#999}
.run-full .leader .body{flex:1;display:flex;flex-direction:column;gap:5px}
.run-full .leader b{font-size:16px}
.run-full .leader .starts{font-size:12px;color:#d9c99a}
.run-full button.big{font:700 15px system-ui;padding:10px;border-radius:10px;border:0;background:#e8b84a;color:#221}
.run-full ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px}
.run-full button.small{font:600 13px system-ui;padding:3px 10px;border-radius:8px;border:0;background:#e8b84a;color:#221}
.run-full .stand{font-size:12px;color:#c9a2ff}
.run-full h4{margin:6px 0 0;font-size:14px;color:#d9c99a}
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const btn = (text: string, on: () => void, cls?: string): HTMLButtonElement => {
  const b = el('button', cls, text);
  b.onclick = on;
  return b;
};
const row = (label: string, text: string): HTMLElement => {
  const r = el('div', 'row');
  r.append(el('b', undefined, label), el('span', undefined, text));
  return r;
};

/** a leader's start as a line: every pool's number */
const startsLine = (p: Partial<Record<(typeof POOLS)[number], number>>): string =>
  POOLS.filter((k) => k !== 'unrest')
    .map((k) => `${POOL_NAME[k]} ${p[k] ?? 0}`)
    .join(' · ');

export function mountRunUi(ui: HTMLElement, game: RunGame): () => void {
  const style = el('style');
  style.textContent = CSS;
  const top = el('div', 'run-top');
  const marks = el('div', 'run-marks');
  const sheet = el('div', 'run-sheet');
  const full = el('div', 'run-full');
  ui.append(style, marks, top, sheet, full);

  const card = (p: Petition, left: number): HTMLElement[] => {
    const out: HTMLElement[] = [el('h3', undefined, p.title), el('div', 'who', W.presenterLine(p)), el('div', 'ask', p.ask)];
    out.push(row(W.COST, W.costText(p)), row(W.IF_PLAYED, p.played.text), row(W.IF_EXPIRES, p.expires.text));
    if (p.threat) out.push(row(W.HELPS, p.threat.helps), el('div', 'warn', W.bringsLine(p)));
    out.push(el('div', p.threat ? 'warn' : 'note', W.leftText(p, left)));
    return out;
  };

  const render = () => {
    const { phase, run, world } = game;
    const l = game.ledger;
    // ---- the top: the leader, the season, the pools
    top.style.display = run && phase !== 'leader' && phase !== 'end' ? '' : 'none';
    top.replaceChildren();
    if (run) {
      top.append(el('span', 'r-title', W.leaderTitle(W.leader(run.leader).name, run.season, run.n)));
      const free = pools(l);
      for (const k of POOLS) {
        const chip = el('span', `r-pool ${k}`);
        chip.append(`${POOL_ICON[k]} ${POOL_NAME[k]} `, el('b', undefined, POOL_ROLE[k] === 'people' ? `${free[k]}/${total(l, k)}` : String(free[k])));
        const each = l.income[k] ?? 0;
        if (each) chip.append(el('i', undefined, incomeLine(each)));
        top.appendChild(chip);
      }
      // (the signs seen in the town now: flags until the mutators' signs draw them)
      const signs = signsNow(run, l, W.PETITIONS);
      for (const k of signs) top.appendChild(el('span', 'r-sign', W.SIGN_NAME[k]));
      if (signs.length) top.appendChild(el('span', 'r-stand', W.STANDIN_SIGNS));
    }
    // ---- the full screens: pick a leader, the end of the run
    full.style.display = phase === 'leader' || (phase === 'end' && !game.looking) ? '' : 'none';
    /** a list of world changes: near ones can be shown on the map; far ones wait for the world map */
    const changes = (list: WorldChange[], show: boolean): HTMLElement => {
      const ul = el('ul');
      let far = false;
      for (const c of list) {
        const li = el('li', undefined, `${c.near ? W.NEAR : W.FAR}. ${W.changeLine(c)} `);
        if (show && c.near) li.appendChild(btn(W.SHOW, () => game.look(c.id), 'small'));
        far ||= !c.near;
        ul.appendChild(li);
      }
      if (far) ul.appendChild(el('li', 'stand', W.FAR_MAP_LATER));
      return ul;
    };
    const places = (): HTMLElement[] => {
      if (!world.places.length) return [];
      const ul = el('ul');
      for (const p of world.places) ul.appendChild(el('li', undefined, W.placeLine(p)));
      return [el('h4', undefined, W.PLACES_TITLE), ul];
    };
    full.replaceChildren();
    if (phase === 'leader') {
      full.append(el('h2', undefined, W.PICK_TITLE), el('div', 'sub', W.PICK_SUB));
      for (const who of W.LEADERS) {
        const box = el('div', 'leader');
        const body = el('div', 'body');
        body.append(el('b', undefined, who.name), el('div', undefined, who.line), el('div', 'starts', startsLine(who.pools)), btn(W.PICK_BUTTON, () => game.pick(who.id), 'big'));
        box.append(el('div', 'portrait', W.PORTRAIT), body);
        full.appendChild(box);
      }
      if (world.changes.length) full.append(el('h4', undefined, W.WORLD_KEPT), changes(world.changes, false), ...places());
    }
    if (phase === 'end' && run) {
      full.append(el('h2', undefined, W.END_TITLE), el('div', 'sub', W.runLine(run.n)));
      if (game.resultLines.length) full.append(el('div', undefined, game.resultLines.join(' ')));
      full.append(el('h4', undefined, W.END_LIST));
      const mine = world.changes.filter((c) => run.mutations.includes(c.id));
      if (!mine.length) full.append(el('div', undefined, W.END_NONE));
      else full.appendChild(changes(mine, true));
      const old = world.changes.filter((c) => !run.mutations.includes(c.id));
      if (old.length) full.append(el('h4', undefined, W.END_BEFORE), changes(old, true));
      full.append(...places());
      // (each choice paired with what it caused: agreed, or left until it ran out)
      const pet = (id: string) => W.PETITIONS.find((x) => x.id === id)!;
      const acts = [...run.played.map((x) => ({ s: x.season, t: W.playedLine(pet(x.id)) })), ...run.expired.map((x) => ({ s: x.season, t: W.expiredLine(pet(x.id), pet(x.id).expires) }))].sort((a, b) => a.s - b.s);
      if (acts.length) {
        const ul = el('ul');
        for (const a of acts) ul.appendChild(el('li', undefined, `${W.seasonLabel(a.s)}. ${a.t}`));
        full.append(el('h4', undefined, W.CHOICES_TITLE), ul);
      }
      full.append(btn(W.NEW_RUN, () => game.again(), 'big'));
    }
    // ---- the sheet
    sheet.style.display = phase === 'boot' || phase === 'leader' || (phase === 'end' && !game.looking) ? 'none' : '';
    sheet.replaceChildren();
    const go = el('div', 'go');
    if (phase === 'end' && game.looking) {
      sheet.append(el('h3', undefined, W.KIND_NAME[game.looking.kind]), el('div', undefined, W.changeLine(game.looking)), el('div', 'stand', W.STANDIN_MUTATION));
      go.append(btn(W.BACK_LIST, () => game.look(null)));
    } else if (phase === 'city' && run) {
      sheet.append(el('h3', undefined, W.ASKS_TITLE), el('div', 'note', W.TAP_MARKER));
      for (const t of game.notes) sheet.append(el('div', 'note', t));
      const list = el('div', 'list');
      for (const h of run.hand) {
        const p = W.PETITIONS.find((x) => x.id === h.id)!;
        const item = el('button', `item${p.threat ? ' threat' : ''}`);
        item.append(el('span', undefined, `${p.presenter.name}. ${p.title}`), el('i', undefined, W.leftText(p, h.left)));
        item.onclick = () => game.open(p.id);
        list.appendChild(item);
      }
      sheet.appendChild(list);
      go.append(btn(W.NEXT, () => game.next()));
    } else if (phase === 'petition' && run && game.selected) {
      const p = game.selected;
      const left = run.hand.find((h) => h.id === p.id)?.left ?? 0;
      sheet.append(...card(p, left));
      const miss = shortOf(l, p);
      const can = !Object.keys(miss).length;
      if (!can) sheet.append(el('div', 'need', W.shortText(miss)));
      const yes = btn(W.PLAY, () => game.agree());
      yes.disabled = !can;
      go.append(yes, btn(W.LEAVE, () => game.back(), 'quiet'));
    } else if (phase === 'season') {
      sheet.append(el('h3', undefined, W.BUILDING));
      for (const t of game.notes) sheet.append(el('div', 'note', t));
      if (game.world.places.some((p) => p.status === 'captured')) sheet.append(el('div', 'stand', W.STANDIN_HOME));
      const s = btn(W.SKIP, () => game.skip(), 'quiet');
      s.disabled = !game.canSkip;
      go.append(s);
    } else if (phase === 'attack' && run) {
      sheet.append(el('h3', undefined, W.ATTACK_TITLE), el('div', undefined, game.fightLine ?? W.ATTACK_WAIT));
      if (!run.spells.length) sheet.append(el('div', 'note', W.SPELL_NONE));
      for (const sp of run.spells) go.append(btn(W.SPELL_NAME[sp], () => game.arm(game.armed === sp ? null : sp), game.armed === sp ? 'on' : undefined));
      const later = btn(W.SPELL_NAME.telekinesis, () => undefined, 'quiet');
      later.disabled = true;
      go.append(later);
      if (game.armed) sheet.append(el('div', 'warn', W.SPELL_AIM), el('div', 'stand', W.SPELL_STANDIN));
      sheet.append(el('div', 'stand', `${W.SPELL_LATER.telekinesis} ${W.RUNE_LATER}`));
    } else if (phase === 'result' && run?.fight) {
      sheet.append(el('h3', undefined, run.fight.held ? W.RESULT_HELD : W.RESULT_BROKEN));
      for (const t of game.resultLines) sheet.append(el('div', undefined, t));
      go.append(btn(W.CONTINUE, () => game.proceed()));
    } else if (phase === 'mutation' && game.change) {
      sheet.append(el('h3', undefined, W.WORLD_CHANGES), el('div', undefined, game.change.text));
      if (game.change.standin) sheet.append(el('div', 'stand', W.STANDIN_MUTATION));
    }
    if (go.childElementCount) sheet.appendChild(go);
  };

  // the names over the map: placed each frame from the game's screen points
  const made = new Map<string, HTMLButtonElement>();
  let raf = 0;
  const place = () => {
    raf = requestAnimationFrame(place);
    const ms = game.markers();
    const seen = new Set<string>();
    for (const m of ms) {
      const key = `${m.kind}:${m.id}`;
      seen.add(key);
      let b = made.get(key);
      if (!b) {
        b = el('button', m.kind === 'ask' ? undefined : m.kind, m.label);
        if (m.kind !== 'change') b.onclick = () => game.open(m.id);
        made.set(key, b);
        marks.appendChild(b);
      }
      b.style.left = `${m.x.toFixed(1)}px`;
      b.style.top = `${m.y.toFixed(1)}px`;
    }
    for (const [key, b] of made)
      if (!seen.has(key)) {
        b.remove();
        made.delete(key);
      }
  };
  place();
  game.onChange.push(render);
  render();
  return () => {
    cancelAnimationFrame(raf);
    for (const n of [style, top, marks, sheet, full]) n.remove();
  };
}
