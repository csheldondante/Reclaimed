// (loop-skeleton; docs/design/LOOP_SKELETON.md "Conformance") The home-town run's screens, phone first, crude on purpose.
// Opportunities are shown over their places on the map: a name and a countdown at the site the card stands at; a tap
// goes there and opens the presenter's dialog (the petition: dialog/petition.ts, opened by the scene). There is no
// hand. Kept for reach on a phone: a short list of the same names on the sheet, each opening the same dialog (say if it
// should go). The rest: pick a leader, the top bar (pools, the raiders' countdown), the season's news, the attack with
// the spell bar, its result, the end of the run read from the fact layer's history. A view only: it reads the game
// (RunGame — scenes/level/loop.ts implements it) and calls it back; its lines are run-words.ts.
import { POOL_ROLE, POOLS, pools, total, type SeasonLedger } from './ledger';
import type { Leader, SpellId } from './realm';
import * as W from './run-words';
import { incomeLine, POOL_ICON, POOL_NAME } from './words';

export type Phase = 'boot' | 'leader' | 'city' | 'petition' | 'season' | 'event' | 'attack' | 'result' | 'end';

export interface Marker {
  /** an offer's id (the threat: 'threat') */
  id: string;
  label: string;
  /** 'raider', 'soldier': a ring round one figure of the fight (no label); 'side': a side's name and count over it */
  kind: 'ask' | 'threat' | 'raider' | 'soldier' | 'side';
  x: number;
  y: number;
}

/** an offer as the screens list it */
export interface Asking {
  id: string;
  who: string;
  title: string;
  left: number;
}

export interface RunGame {
  readonly phase: Phase;
  readonly leader: Leader | null;
  /** the run: its season, its length, which run of this world it is; null before a leader is picked */
  readonly run: { season: number; seasons: number; n: number; threatIn: number | null; averted: boolean; spells: SpellId[]; fight: W.Fight | null } | null;
  readonly ledger: SeasonLedger;
  /** what is offered now, and what is under way */
  asking(): Asking[];
  working(): string[];
  /** the season's news, newest last */
  readonly notes: string[];
  readonly fightLine: string | null;
  readonly resultLines: string[];
  readonly armed: SpellId | null;
  /** (a live event) give it up as it stands */
  leave(): void;
  /** the fact layer's history as sentences: this run's (with its season), and the earlier runs' */
  history(): { season: number; text: string }[];
  before(): string[];
  /** the physical changes this run named (the mutators' entries, drawn on the land) */
  land(): string[];
  readonly canSkip: boolean;
  readonly onChange: (() => void)[];
  /** the names over the map now, in screen px */
  markers(): Marker[];
  pick(leader: string): void;
  open(offer: string): void;
  next(): void;
  skip(): void;
  arm(spell: SpellId | null): void;
  proceed(): void;
  again(): void;
  /** open the world's map (far places, and what has changed at each) */
  map(): void;
}

const CSS = `
.run-top{position:absolute;left:0;right:0;top:0;z-index:30;display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px 8px;background:linear-gradient(rgba(18,20,24,.9),rgba(18,20,24,.6));color:#f2efe8;font:13px system-ui,sans-serif;pointer-events:none}
.run-top .r-title{font-weight:700;flex:1 0 100%}
.run-top .r-pool{background:rgba(255,255,255,.1);border-radius:10px;padding:2px 7px;white-space:nowrap}
.run-top .r-pool i{font-style:normal;opacity:.7;font-size:11px;margin-left:2px}
.run-top .r-pool.unrest b{color:#ff9b7a}
.run-top .r-sign{background:#4a3a56;border:1px solid #c9a2ff;border-radius:10px;padding:2px 7px;white-space:nowrap}
.run-top .r-threat{font-size:12px;color:#ffb199;flex:1 0 100%;font-weight:600}
/* (ui/style.css gives every child of #ui pointer-events:auto, by id: without the id here the marks' layer, which covers
   the screen, took every press meant for the map — no pan, and no spell was ever cast in a fight; LS-46) */
#ui > .run-marks,#ui > .run-top{pointer-events:none}
.run-marks{position:absolute;inset:0;z-index:20;overflow:hidden}
.run-marks button{position:absolute;transform:translate(-50%,-100%);pointer-events:auto;font:700 13px system-ui,sans-serif;padding:5px 9px;border-radius:14px 14px 14px 2px;border:2px solid #221;background:#f2e3b0;color:#221;white-space:nowrap}
/* (a thumb's reach: the name is 28 px tall; what takes the press is 46 px, above and below it) */
.run-marks button::after{content:'';position:absolute;left:-4px;right:-4px;top:-9px;bottom:-9px}
.run-marks button.threat{background:#e2573f;color:#fff}
.run-marks button.raider,.run-marks button.soldier{width:22px;height:22px;padding:0;border-radius:50%;background:rgba(226,60,40,.28);border:3px solid #ff3b2f;transform:translate(-50%,-62%);pointer-events:none;box-shadow:0 0 0 1px #000}
.run-marks button.soldier{background:rgba(50,140,255,.28);border-color:#39a0ff}
.run-marks button.side{pointer-events:none;font-size:12px;padding:3px 8px;border-radius:10px;background:#e2573f;color:#fff;transform:translate(-50%,-260%)}
.run-marks button.side.ours{background:#2f7fd6;transform:translate(-50%,90%)}
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
.run-sheet .item{display:flex;gap:8px;align-items:center;min-height:44px;box-sizing:border-box;background:#2c3038;border-radius:10px;padding:8px;border:0;color:inherit;font:inherit;text-align:left}
.run-sheet .item.threat{background:#4a2a26}
.run-sheet .item span{flex:1}
.run-sheet .item i{font-style:normal;font-size:12px;color:#d9c99a;white-space:nowrap}
.run-sheet .go{display:flex;gap:8px}
.run-sheet .go button{flex:1;min-height:46px;font:700 16px system-ui;padding:12px;border-radius:10px;border:0;background:#e8b84a;color:#221}
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
.run-full button.big{min-height:44px;font:700 15px system-ui;padding:10px;border-radius:10px;border:0;background:#e8b84a;color:#221}
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

  const render = () => {
    const { phase, run } = game;
    const l = game.ledger;
    // ---- the top: the leader, the season, the pools and what each season brings, the raiders' countdown
    top.style.display = run && phase !== 'leader' && phase !== 'end' ? '' : 'none';
    top.replaceChildren();
    if (run && game.leader) {
      top.append(el('span', 'r-title', W.leaderTitle(game.leader.name, run.season, run.seasons, run.n)));
      const free = pools(l);
      for (const k of POOLS) {
        const chip = el('span', `r-pool ${k}`);
        chip.append(`${POOL_ICON[k]} ${POOL_NAME[k]} `, el('b', undefined, POOL_ROLE[k] === 'people' ? `${free[k]}/${total(l, k)}` : String(free[k])));
        const each = l.income[k] ?? 0;
        if (each) chip.append(el('i', undefined, incomeLine(each)));
        top.appendChild(chip);
      }
      const threat = W.threatText(run.threatIn, run.averted);
      if (threat && !run.fight) top.appendChild(el('span', 'r-threat', threat));
    }
    // ---- the full screens: pick a leader, the end of the run
    full.style.display = phase === 'leader' || phase === 'end' ? '' : 'none';
    const list = (lines: string[]): HTMLElement => {
      const ul = el('ul');
      for (const t of lines) ul.appendChild(el('li', undefined, t));
      return ul;
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
      const old = game.before();
      if (old.length) full.append(el('h4', undefined, W.WORLD_KEPT), list(old));
    }
    if (phase === 'end' && run) {
      full.append(el('h2', undefined, W.END_TITLE), el('div', 'sub', W.runLine(run.n)));
      if (game.resultLines.length) full.append(el('div', undefined, game.resultLines.join(' ')));
      full.append(el('h4', undefined, W.END_LIST));
      const mine = game.history();
      if (!mine.length) full.append(el('div', undefined, W.END_NONE));
      else full.appendChild(list(mine.map((e) => `${W.seasonLabel(e.season)}. ${e.text}`)));
      const land = game.land();
      if (land.length) full.append(el('h4', undefined, W.END_LAND), list(land));
      const old = game.before();
      if (old.length) full.append(el('h4', undefined, W.END_BEFORE), list(old));
      full.append(btn(W.NEW_RUN, () => game.again(), 'big'));
    }
    // ---- the sheet
    sheet.style.display = phase === 'boot' || phase === 'leader' || phase === 'end' || phase === 'petition' ? 'none' : '';
    sheet.replaceChildren();
    const go = el('div', 'go');
    if (phase === 'city' && run) {
      const asks = game.asking();
      sheet.append(el('h3', undefined, asks.length ? W.ASKS_TITLE : W.ASKS_NONE));
      if (asks.length) sheet.append(el('div', 'note', W.TAP_MARKER));
      for (const t of game.notes) sheet.append(el('div', 'note', t));
      const box = el('div', 'list');
      for (const a of asks) {
        const item = el('button', 'item');
        item.append(el('span', undefined, `${a.who}. ${a.title}`), el('i', undefined, W.leftText(a.left)));
        item.onclick = () => game.open(a.id);
        box.appendChild(item);
      }
      for (const t of game.working()) {
        const item = el('div', 'item');
        item.append(el('span', undefined, t), el('i', undefined, W.WORKING));
        box.appendChild(item);
      }
      sheet.appendChild(box);
      // (the world's map: far places and what has changed at each — the mutators' badges)
      const map = btn(W.MAP, () => game.map(), 'quiet');
      map.style.flex = '0 0 76px';
      go.append(map, btn(W.NEXT, () => game.next()));
    } else if (phase === 'season') {
      sheet.append(el('h3', undefined, W.BUILDING));
      for (const t of game.notes) sheet.append(el('div', 'note', t));
      const s = btn(W.SKIP, () => game.skip(), 'quiet');
      s.disabled = !game.canSkip;
      go.append(s);
    } else if (phase === 'event' && run) {
      sheet.append(el('h3', undefined, W.DEAD_TITLE), el('div', undefined, game.fightLine ?? ''), el('div', game.armed ? 'warn' : 'note', game.armed ? W.SPELL_AIM : W.DEAD_HOW));
      go.append(btn(W.SPELL_NAME.fire, () => game.arm(game.armed === 'fire' ? null : 'fire'), game.armed === 'fire' ? 'on' : undefined), btn(W.DEAD_LEAVE, () => game.leave(), 'quiet'));
    } else if (phase === 'attack' && run) {
      sheet.append(el('h3', undefined, W.ATTACK_TITLE), el('div', undefined, game.fightLine ?? W.ATTACK_WAIT));
      if (!run.spells.length) sheet.append(el('div', 'note', W.SPELL_NONE));
      for (const sp of run.spells) go.append(btn(W.SPELL_NAME[sp], () => game.arm(game.armed === sp ? null : sp), game.armed === sp ? 'on' : undefined));
      const later = btn(W.TELEKINESIS, () => undefined, 'quiet');
      later.disabled = true;
      go.append(later);
      if (game.armed) sheet.append(el('div', 'warn', W.SPELL_AIM), el('div', 'stand', W.SPELL_STANDIN));
      sheet.append(el('div', 'stand', W.SPELL_LATER));
    } else if (phase === 'result' && run?.fight) {
      sheet.append(el('h3', undefined, W.resultTitle(run.fight)));
      for (const t of game.resultLines) sheet.append(el('div', undefined, t));
      go.append(btn(W.CONTINUE, () => game.proceed()));
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
        b = el('button', m.kind === 'ask' ? undefined : m.kind);
        if (m.kind === 'ask') b.onclick = () => game.open(m.id);
        made.set(key, b);
        marks.appendChild(b);
      }
      if (b.textContent !== m.label) b.textContent = m.label;
      if (m.kind === 'side') b.classList.toggle('ours', m.id === 'ours');
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
