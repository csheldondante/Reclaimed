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

/** 'event': the player is at a live event (the raid, the dead, a parade, a fire: one runner plays them all) */
export type Phase = 'boot' | 'leader' | 'city' | 'petition' | 'season' | 'event' | 'result' | 'end';

export interface Marker {
  /** an offer's id (the threat: 'threat') */
  id: string;
  label: string;
  /** 'raider', 'soldier': a ring round one figure of the fight (no label); 'folk' (round 7): a ring round one of the
   *  people of an event who take no part in a fight (a parade's marchers, refugees' carts); 'side': a side's name and
   *  count over it */
  kind: 'ask' | 'threat' | 'raider' | 'soldier' | 'folk' | 'side' | 'thing' | 'done' | 'edge';
  x: number;
  y: number;
}

/** (round 8) a full-screen page over the town: laws in force, the rules, the record, a thing's card, a pack's report */
export interface Panel {
  title: string;
  /** a picture (a portrait or a thing's art), or none */
  image?: string | null;
  sections: { head?: string; lines: string[] }[];
  actions?: { label: string; on: () => void }[];
}

/** an offer as the screens list it */
export interface Asking {
  id: string;
  who: string;
  title: string;
  left: number;
}

/** (loop round 10, LS-93) a leader on the start screen: `locked` the hint of how to open it ("" none written; null:
 *  open); `note` a plain line when they play from another town */
export interface LeaderView {
  id: string;
  name: string;
  line: string;
  pools: Partial<Record<string, number>>;
  locked: string | null;
  note: string | null;
}

export interface RunGame {
  readonly phase: Phase;
  readonly leader: Leader | null;
  /** (loop round 10) the leaders the start screen shows: the base game's and the packs' */
  leaders(): LeaderView[];
  /** the run: its season, its length, which run of this world it is; null before a leader is picked */
  readonly run: { season: number; seasons: number; n: number; threat: { title: string; left: number } | null; spells: SpellId[]; fight: W.Fight | null } | null;
  readonly ledger: SeasonLedger;
  /** what is offered now, and what is under way */
  asking(): Asking[];
  working(): string[];
  /** the season's news, newest last */
  readonly notes: string[];
  readonly fightLine: string | null;
  readonly resultLines: string[];
  /** a spell (SpellId) or a pack ability's id armed to cast */
  readonly armed: string | null;
  /** the live event the player is at: its words, the spells it allows, whether the player may go back to the town;
   *  (round 8) the pack abilities castable into it, and whether it can be settled now */
  readonly liveNow: { id: string; title: string; how: string; spells: SpellId[]; abilities: { id: string; name: string }[]; wantsSpells: boolean; canLeave: boolean; canSettle: boolean } | null;
  /** (round 8) settle the live event the player is at now, with what was done so far */
  settle(id: string): void;
  /** (round 8) the page open over the town, or null; the town sheet's buttons that open one */
  readonly panel: Panel | null;
  closePanel(): void;
  views(): { label: string; on: () => void }[];
  /** (round 8) what ended the run (an ending, a law's win), or null; what the world is now, at a run's start */
  readonly endTitle: string | null;
  worldNow(): string[];
  /** the spells the player may cast in the town now (the growth rune) */
  readonly citySpells: SpellId[];
  /** (a live event) back to the town: it goes on without the player */
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
  arm(spell: string | null): void;
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
.run-marks button.folk:not(.side){width:20px;height:20px;padding:0;border-radius:50%;background:rgba(255,200,60,.25);border:3px solid #ffc83c;transform:translate(-50%,-62%);pointer-events:none;box-shadow:0 0 0 1px #000}
.run-marks button.side{pointer-events:none;font-size:12px;padding:3px 8px;border-radius:10px;background:#e2573f;color:#fff;transform:translate(-50%,-260%)}
.run-marks button.side.ours{background:#2f7fd6;transform:translate(-50%,90%)}
.run-marks button.folk.wide:not(.side){width:46px;height:46px;background:transparent;transform:translate(-50%,-58%)}
.run-marks button.side.folk{background:#ffc83c;color:#221}
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
.run-full .leader.locked{opacity:.6}
.run-full button.big{min-height:44px;font:700 15px system-ui;padding:10px;border-radius:10px;border:0;background:#e8b84a;color:#221}
.run-full ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px}
.run-full button.small{font:600 13px system-ui;padding:3px 10px;border-radius:8px;border:0;background:#e8b84a;color:#221}
.run-full .stand{font-size:12px;color:#c9a2ff}
.run-full h4{margin:6px 0 0;font-size:14px;color:#d9c99a}
.run-marks button.thing{background:#2d4a3a;color:#dff5e6;border-color:#8fe0a8;border-radius:4px;font-size:12px}
.run-marks button.thing.ruined{background:#3a3532;color:#cfc4b8;border-color:#8a7f74;border-style:dashed}
.run-marks button.done{background:#33404f;color:#d6e7ff;border-color:#8fb8ff;border-radius:4px;font-size:11px;font-weight:600}
.run-full img.art{width:100%;max-height:38vh;object-fit:contain;border-radius:10px;background:#222}
.run-full .acts{display:flex;flex-wrap:wrap;gap:8px}
.run-full .acts button{flex:1 1 140px}
.run-sheet .head{display:flex;align-items:center;gap:8px}
.run-sheet .head h3{flex:1}
.run-sheet button.fold{flex:0 0 auto;min-height:36px;font:600 13px system-ui;padding:6px 12px;border-radius:10px;border:0;background:#3a3f4a;color:#eee}
.run-sheet .views{display:flex;gap:8px}
.run-sheet .views button{flex:1;min-height:44px;font:600 14px system-ui;border-radius:10px;border:0;background:#3a3f4a;color:#eee}
/* (loop round 16: the town's bar is one row of buttons — the town fills the screen; the asks are the names over it) */
.run-sheet.slim{padding:6px 8px calc(6px + env(safe-area-inset-bottom));gap:4px;border-radius:12px 12px 0 0}
.run-sheet.slim .go button{min-height:46px;padding:8px 6px;font-size:15px}
.run-sheet.slim .go button.asks{flex:0 0 auto;background:#3a3f4a;color:#eee;font-weight:600}
.run-sheet .last{font-size:12px;color:#d0d0d0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.run-marks button.edge{background:#f2e3b0;border-style:dashed;font-size:12px}
.run-full .item{display:flex;gap:8px;align-items:center;min-height:46px;box-sizing:border-box;background:#2c3038;border-radius:10px;padding:8px;border:0;color:inherit;font:inherit;text-align:left;width:100%}
.run-full .item span{flex:1}
.run-full .item i{font-style:normal;font-size:12px;color:#d9c99a;white-space:nowrap}
.run-full .note{font-size:13px;color:#d0d0d0}
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

  /** (loop round 16) the full list of asks open as a page over the town */
  let listOpen = false;
  let was: Phase | null = null;
  const render = () => {
    const { phase, run } = game;
    if (phase !== was || phase !== 'city') listOpen = false;
    was = phase;
    const l = game.ledger;
    // ---- the top: the leader, the season, the pools and what each season brings, the raiders' countdown
    top.style.display = run && phase !== 'leader' && phase !== 'end' ? '' : 'none';
    top.replaceChildren();
    if (run && game.leader) {
      // (a run past its last season reads as its last: the Realm's season counts on to seasons + 1 once it is over)
      top.append(el('span', 'r-title', W.leaderTitle(game.leader.name, Math.min(run.season, run.seasons), run.seasons, run.n)));
      const free = pools(l);
      for (const k of POOLS) {
        const chip = el('span', `r-pool ${k}`);
        chip.append(`${POOL_ICON[k]} ${POOL_NAME[k]} `, el('b', undefined, POOL_ROLE[k] === 'people' ? `${free[k]}/${total(l, k)}` : String(free[k])));
        const each = l.income[k] ?? 0;
        if (each) chip.append(el('i', undefined, incomeLine(each)));
        top.appendChild(chip);
      }
      const threat = W.threatText(run.threat);
      if (threat) top.appendChild(el('span', 'r-threat', threat));
    }
    // ---- the full screens: pick a leader, the end of the run
    const panel = game.panel;
    full.style.display = phase === 'leader' || phase === 'end' || panel || listOpen ? '' : 'none';
    const list = (lines: string[]): HTMLElement => {
      const ul = el('ul');
      for (const t of lines) ul.appendChild(el('li', undefined, t));
      return ul;
    };
    full.replaceChildren();
    if (panel) {
      // (round 8: a page over whatever screen is under it — laws, rules, the record, a thing's card)
      full.append(el('h2', undefined, panel.title));
      if (panel.image) {
        const img = el('img', 'art');
        img.src = panel.image;
        img.alt = panel.title;
        full.append(img);
      }
      for (const s of panel.sections) {
        if (s.head) full.append(el('h4', undefined, s.head));
        if (s.lines.length) full.append(list(s.lines));
      }
      const acts = el('div', 'acts');
      for (const a of panel.actions ?? []) acts.append(btn(a.label, a.on, 'big'));
      acts.append(btn(W.CLOSE, () => game.closePanel(), 'big'));
      full.append(acts);
    } else if (listOpen && run) {
      // (loop round 16: the asks as a list, for those who want one — a tap opens the petition as its name over the map
      // does; what is under way; the season's news; the laws, rules and record)
      const asks = game.asking();
      full.append(el('h2', undefined, asks.length ? W.ASKS_TITLE : W.ASKS_NONE));
      const close = () => ((listOpen = false), render());
      for (const a of asks) {
        const item = el('button', 'item');
        item.append(el('span', undefined, `${a.who}. ${a.title}`), el('i', undefined, W.leftText(a.left)));
        item.onclick = () => (close(), game.open(a.id));
        full.appendChild(item);
      }
      for (const t of game.working()) {
        const item = el('div', 'item');
        item.append(el('span', undefined, t), el('i', undefined, W.WORKING));
        full.appendChild(item);
      }
      if (game.notes.length) {
        full.append(el('h4', undefined, W.NEWS_TITLE));
        for (const t of game.notes) full.append(el('div', 'note', t));
      }
      const acts = el('div', 'acts');
      for (const v of game.views()) acts.append(btn(v.label, () => (close(), v.on()), 'big'));
      acts.append(btn(W.CLOSE, close, 'big'));
      full.append(acts);
    } else if (phase === 'leader') {
      full.append(el('h2', undefined, W.PICK_TITLE), el('div', 'sub', W.PICK_SUB));
      // (loop round 10, LS-93: the base leaders and the packs' — one who plays from another town says so; a locked one
      // shows how to open it and cannot be picked)
      for (const who of game.leaders()) {
        const box = el('div', who.locked !== null ? 'leader locked' : 'leader');
        const body = el('div', 'body');
        body.append(el('b', undefined, who.name));
        if (who.locked !== null) body.append(el('div', 'starts', W.lockedLine(who.locked)));
        else {
          body.append(el('div', undefined, who.line), el('div', 'starts', startsLine(who.pools)));
          if (who.note) body.append(el('div', 'starts', who.note));
          body.append(btn(W.PICK_BUTTON, () => game.pick(who.id), 'big'));
        }
        box.append(el('div', 'portrait', W.PORTRAIT), body);
        full.appendChild(box);
      }
      const now = game.worldNow();
      if (now.length) full.append(el('h4', undefined, W.NOW_TITLE), list(now));
      const old = game.before();
      if (old.length) full.append(el('h4', undefined, W.WORLD_KEPT), list(old));
    } else if (phase === 'end' && run) {
      full.append(el('h2', undefined, game.endTitle ?? W.END_TITLE), el('div', 'sub', W.runLine(run.n)));
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
    sheet.style.display = phase === 'boot' || phase === 'leader' || phase === 'end' || phase === 'petition' || panel ? 'none' : '';
    sheet.replaceChildren();
    const go = el('div', 'go');
    // (loop round 13: the town's sheet folds down to one button, and the names over the map go with it — to look at the
    // land itself; it opens again on a tap, or at the next phase)
    // (loop round 16, the owner: "The cards take up too much screen space. I think having the opportunities selectable
    // on the map only is fine." The town's sheet is one row — the map, the growth rune, the list as a page for those who
    // want it, Next season; the pools, the season and the threat are the top bar's. The names over the town are the way in)
    sheet.className = phase === 'city' ? 'run-sheet slim' : 'run-sheet';
    if (phase === 'city' && run) {
      const asks = game.asking();
      // (round 6: a spell every season — the growth rune over a field; what it does is said once it is pressed)
      if (game.armed) sheet.append(el('div', 'warn', W.GROWTH_HOW));
      // (the world's map: far places and what has changed at each — the mutators' badges)
      const map = btn(W.MAP, () => game.map(), 'quiet');
      map.style.flex = '0 0 64px';
      go.append(map);
      for (const sp of game.citySpells) {
        const b = btn(W.SPELL_NAME[sp], () => game.arm(game.armed === sp ? null : sp), game.armed === sp ? 'on quiet' : 'quiet');
        b.style.flex = '0 0 104px';
        b.style.fontSize = '14px';
        go.append(b);
      }
      go.append(btn(W.listButton(asks.length), () => ((listOpen = true), render()), 'asks'));
      go.append(btn(W.NEXT, () => game.next()));
    } else if (phase === 'season') {
      sheet.append(el('h3', undefined, W.BUILDING));
      for (const t of game.notes) sheet.append(el('div', 'note', t));
      const s = btn(W.SKIP, () => game.skip(), 'quiet');
      s.disabled = !game.canSkip;
      go.append(s);
    } else if (phase === 'event' && run && game.liveNow) {
      const ev = game.liveNow;
      sheet.append(el('h3', undefined, ev.title));
      // (loop round 13: an event with no running line — a pack's — shows none; what a cast did shows here a while)
      if (game.fightLine) sheet.append(el('div', undefined, game.fightLine));
      sheet.append(el('div', game.armed ? 'warn' : 'note',game.armed ? W.SPELL_AIM : ev.spells.length || ev.abilities.length || !ev.wantsSpells ? ev.how : `${ev.how} ${W.SPELL_NONE}`));
      for (const sp of ev.spells) go.append(btn(W.SPELL_NAME[sp], () => game.arm(game.armed === sp ? null : sp), game.armed === sp ? 'on' : undefined));
      for (const a of ev.abilities) go.append(btn(a.name, () => game.arm(game.armed === a.id ? null : a.id), game.armed === a.id ? 'on' : undefined));
      if (ev.canLeave) go.append(btn(W.LIVE_LEAVE, () => game.leave(), 'quiet'));
      if (ev.canSettle) {
        const row = el('div', 'views');
        // (loop round 10, job 5: the press settles the event this button was drawn for — a second tap landing on the
        // next bout's button, drawn in its place, is a press of its own)
        const id = ev.id;
        row.append(btn(W.SETTLE, () => game.settle(id)));
        sheet.appendChild(row);
      }
      if (game.armed === 'heatray') sheet.append(el('div', 'stand', W.SPELL_STANDIN));
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
        if (m.kind === 'ask' || m.kind === 'thing' || m.kind === 'done' || m.kind === 'edge') b.onclick = () => game.open(m.id);
        if (m.kind === 'thing' && m.label.startsWith(W.remainsOf(''))) b.classList.add('ruined');
        made.set(key, b);
        marks.appendChild(b);
      }
      if (b.textContent !== m.label) b.textContent = m.label;
      if (m.kind === 'side') {
        b.classList.toggle('ours', m.id === 'ours');
        b.classList.toggle('folk', m.id.startsWith('folk'));
      }
      // (loop round 17: the messenger's ring wide and hollow — the 20 px tinted one hid the figure and its horse or cart)
      b.classList.toggle('wide', m.id === 'folk-messenger');
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
