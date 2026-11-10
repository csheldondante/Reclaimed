// (trackA-opps, the season loop; docs/design/SEASON_LOOP.md "UI") The season's cards on screen, phone first: the
// pools along the top, a bottom sheet with the hand (Start / Undo), what's being built and Next season (Skip while it
// plays). Every line from season/words.ts. The sim runs live under it; the sheet folds down to watch the town.
import { POOLS } from './ledger';
import type { SeasonLoop } from './loop';
import {
  BUILDING_NOW,
  BUILDING_SEASON,
  costLine,
  givesLine,
  HAND_TITLE,
  incomeLine,
  NEXT_SEASON,
  NO_ROOM,
  NOTHING_BUILDING,
  POOL_ICON,
  POOL_NAME,
  seasonsLeftLine,
  seasonTitle,
  shortLine,
  SKIP,
  START,
  UNDO,
  backLine,
} from './words';
import { POOL_ROLE, pools, total } from './ledger';

const CSS = `
.season-top{position:absolute;left:0;right:0;top:0;z-index:30;display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px 8px;background:linear-gradient(rgba(18,20,24,.85),rgba(18,20,24,.55));color:#f2efe8;font:13px system-ui,sans-serif;pointer-events:none}
.season-top .s-title{font-weight:700;margin-right:6px}
.season-top .s-pool{background:rgba(255,255,255,.1);border-radius:10px;padding:2px 7px;white-space:nowrap}
.season-top .s-pool b{font-weight:700}
.season-top .s-pool i{font-style:normal;opacity:.7;font-size:11px;margin-left:2px}
.season-top .s-pool.unrest b{color:#ff9b7a}
.season-sheet{position:absolute;left:0;right:0;bottom:0;z-index:30;background:rgba(22,24,28,.92);color:#f2efe8;font:13px system-ui,sans-serif;border-radius:14px 14px 0 0;padding:8px 10px calc(10px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:7px;max-height:58vh}
.season-sheet .s-head{display:flex;align-items:center;gap:8px;font-weight:600}
.season-sheet .s-head span{flex:1}
.season-sheet .s-fold{background:none;border:0;color:#bbb;font:16px system-ui;padding:2px 8px}
.season-sheet .s-hand{display:grid;grid-template-columns:1fr 1fr;gap:6px;overflow-y:auto;max-height:44vh;padding-bottom:2px}
.season-sheet .s-card{min-width:0;background:#2c3038;border-radius:10px;padding:7px;display:flex;flex-direction:column;gap:3px;border:2px solid transparent}
.season-sheet .s-card .need{color:#ff9b7a;font-size:12px}
.season-sheet .s-card.on{border-color:#6fcf5a;background:#2f3b2d}
.season-sheet .s-card.no{opacity:.6}
.season-sheet .s-card h4{margin:0;font-size:13px}
.season-sheet .s-card .why{color:#d9c99a;font-size:12px}
.season-sheet .s-card .small{font-size:12px;color:#c8c8c8}
.season-sheet .s-card button{margin-top:auto;font:600 14px system-ui;padding:6px;border-radius:8px;border:0;background:#6fcf5a;color:#122}
.season-sheet .s-card button.undo{background:#555;color:#eee}
.season-sheet .s-card button:disabled{background:#444;color:#999}
.season-sheet .s-building{display:flex;flex-wrap:wrap;gap:5px;font-size:12px}
.season-sheet .s-building span{background:#3a3428;border-radius:8px;padding:3px 7px}
.season-sheet .s-building span.new{background:#2f3b2d}
.season-sheet .s-summary{font-size:12px;color:#d0d0d0}
.season-sheet .s-go{display:flex;gap:8px}
.season-sheet .s-go button{flex:1;font:700 16px system-ui;padding:11px;border-radius:10px;border:0;background:#e8b84a;color:#221}
.season-sheet .s-go button.skip{flex:0 0 90px;background:#555;color:#eee}
.season-sheet .s-go button:disabled{opacity:.5}
.season-sheet.folded .s-hand,.season-sheet.folded .s-building,.season-sheet.folded .s-summary{display:none}
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function mountSeasonUi(ui: HTMLElement, loop: SeasonLoop): () => void {
  const style = el('style');
  style.textContent = CSS;
  const top = el('div', 'season-top');
  const sheet = el('div', 'season-sheet');
  const head = el('div', 's-head');
  const headText = el('span');
  const fold = el('button', 's-fold', '▾');
  fold.onclick = () => {
    sheet.classList.toggle('folded');
    fold.textContent = sheet.classList.contains('folded') ? '▴' : '▾';
  };
  head.append(headText, fold);
  const hand = el('div', 's-hand');
  const building = el('div', 's-building');
  const summary = el('div', 's-summary');
  const go = el('div', 's-go');
  const next = el('button', 'next', NEXT_SEASON);
  const skip = el('button', 'skip', SKIP);
  next.onclick = () => void loop.next();
  skip.onclick = () => loop.skip();
  go.append(next, skip);
  sheet.append(head, hand, building, summary, go);
  ui.append(style, top, sheet);

  const render = () => {
    const l = loop.ledger;
    // the pools: people free of all, goods held and what each season brings
    top.replaceChildren(el('span', 's-title', seasonTitle(l.season)));
    const free = pools(l);
    for (const k of POOLS) {
      const chip = el('span', `s-pool ${k}`);
      chip.append(`${POOL_ICON[k]} ${POOL_NAME[k]} `, el('b', undefined, POOL_ROLE[k] === 'people' ? `${free[k]}/${total(l, k)}` : String(free[k])));
      const each = l.income[k] ?? 0;
      if (each) chip.append(el('i', undefined, incomeLine(each)));
      top.appendChild(chip);
    }
    const playing = loop.playing;
    headText.textContent = playing ? BUILDING_SEASON : HAND_TITLE;
    hand.replaceChildren();
    if (!playing)
      loop.hand.forEach((o, i) => {
        const can = loop.canStart(i);
        const on = loop.started.has(i);
        const c = el('div', `s-card${on ? ' on' : ''}${!can.ok && !on ? ' no' : ''}`);
        c.append(el('h4', undefined, o.card.title));
        c.append(el('div', 'why', o.reason));
        c.append(el('div', 'small', costLine(o.card)));
        c.append(el('div', 'small', givesLine(o.card)));
        // (what stops it, as a line of its own: the button keeps its one word)
        if (!on && !can.land) c.append(el('div', 'need', NO_ROOM));
        else if (!on && Object.keys(can.short).length) c.append(el('div', 'need', shortLine(can.short)));
        const b = el('button', on ? 'undo' : undefined, on ? UNDO : START);
        if (on) b.onclick = () => loop.undo(i);
        else {
          b.disabled = !can.ok;
          b.onclick = () => loop.start(i);
        }
        c.appendChild(b);
        hand.appendChild(c);
      });
    building.replaceChildren(el('b', undefined, BUILDING_NOW));
    if (!l.projects.length) building.appendChild(el('span', undefined, NOTHING_BUILDING));
    for (const p of l.projects) {
      const back = p.commitment.resolvesTurn!;
      building.appendChild(el('span', p.commitment.turn === l.season ? 'new' : undefined, `${p.card.title} · ${seasonsLeftLine(back - l.season)} · ${backLine(p.card.locks, back)}`));
    }
    summary.textContent = loop.summary ?? '';
    next.disabled = playing;
    skip.style.display = playing ? '' : 'none';
  };
  loop.onChange.push(render);
  render();
  return () => {
    style.remove();
    top.remove();
    sheet.remove();
  };
}
