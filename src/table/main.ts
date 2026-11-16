// (card-table; docs/design/CARD_TABLE.md) The card table's page: DOM only. It draws what table/game.ts gives and sends
// taps back. No canvas, no GPU, no clock, no random number: the same seed, leader and taps make the same run.
import { POOL_ICON, POOL_NAME } from '../season/words';
import { poolsLine } from '../season/words';
import type { Pack } from '../packs/check';
import { LEADERS, Table } from './game';
import * as W from './words';

const params = new URLSearchParams(location.search);
const app = document.getElementById('app')!;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

let seed = Number(params.get('seed') ?? 7);
let leader = params.get('leader') ?? LEADERS[0].id;
let seasons = Number(params.get('seasons') ?? 16);
/** the packs in play (a file picked, or ?pack=<url>), and why one was refused */
let packs: Pack[] = [];
let packError = '';
/** the ability tapped, waiting for its target */
let armed: string | null = null;
let table = new Table({ seed, leader, seasons });

function restart(): void {
  armed = null;
  try {
    table = new Table({ seed, leader, seasons, packs });
    packError = '';
  } catch (e) {
    // (a pack with errors: its report shown, the base game played)
    packError = (e as Error).message;
    packs = [];
    table = new Table({ seed, leader, seasons });
  }
}

function header(): string {
  const t = table;
  const pools = t
    .poolViews()
    .map((p) => {
      const inc = W.incomeText(p.income);
      return `<div class="pool" data-pool="${p.pool}"><b>${POOL_ICON[p.pool]} ${p.have}</b><span>${POOL_NAME[p.pool]}</span>${p.of !== null ? `<span>${esc(W.freeOf(p.have, p.of))}</span>` : ''}${inc ? `<span class="inc">${esc(inc)}</span>` : ''}</div>`;
    })
    .join('');
  const threat = t.threat();
  return `<header><h1>${esc(t.title())}</h1><div class="pools">${pools}</div>${threat ? `<div class="threat">${esc(threat)}</div>` : ''}</header>`;
}

function opps(): string {
  const cards = table.cards();
  if (table.over) return '';
  const body = cards.length
    ? cards
        .map((c) => {
          const miss = poolsLine(c.short);
          return `<div class="card ${c.threat ? 'threat-card' : ''}" data-card="${esc(c.template)}">
  <h3>${esc(c.title)}</h3>
  <div class="who">${esc(c.who)}, ${esc(c.role)}. ${esc(cap(c.place))}.</div>
  <div class="say">"${esc(c.line)}"</div>
  <div class="row"><b>${W.COST}.</b> ${esc(c.cost)}</div>
  <div class="row"><b>${W.IF_TAKEN}.</b> ${esc(c.gives)}</div>
  <div class="row ${c.lapse ? 'bad' : ''}"><b>${W.IF_LEFT}.</b> ${esc(c.lapse ?? W.NO_LAPSE)} ${esc(W.leftLine(c.left))}</div>
  <div class="tags">${c.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>
  ${miss ? `<div class="need">${esc(W.needLine(miss))}</div>` : ''}
  <div class="acts"><button class="main" data-act="take" data-id="${esc(c.id)}" ${miss ? 'disabled' : ''}>${W.TAKE}</button><button data-act="pass" data-id="${esc(c.id)}">${W.PASS}</button></div>
</div>`;
        })
        .join('')
    : `<div class="dim">${W.OPPS_NONE}</div>`;
  return `<h2>${W.OPPS_TITLE}</h2><div class="grid">${body}</div>`;
}

function working(): string {
  const w = table.working();
  const built = table.built();
  const a = w.length ? `<h2>${W.WORK_TITLE}</h2><div class="small">${w.map((x) => `<div class="thing"><b>${esc(x.title)}</b><div class="dim">${esc(W.doneIn(x.left))}</div></div>`).join('')}</div>` : '';
  const b = built.length ? `<h2>${W.BUILT_TITLE}</h2><div class="tags">${built.map((x) => `<span class="tag state">${esc(x)}</span>`).join('')}</div>` : '';
  return a + b;
}

function inPlay(): string {
  const things = table.things();
  const ab = table.abilities().find((a) => a.id === armed);
  const places = [...new Set(things.map((t) => t.place))];
  const body = places
    .map((pl) => {
      const cards = things
        .filter((t) => t.place === pl)
        .map((t) => {
          const target = !!ab && ab.targets.includes(t.id);
          return `<div class="thing ${t.ruined ? 'ruined' : ''} ${target ? 'target' : ''}" ${target ? `data-act="target" data-id="${esc(t.id)}"` : ''}><b>${esc(cap(t.name))}</b>${t.text ? `<div class="dim">${esc(t.text)}</div>` : ''}<div class="tags">${t.tags.map((x) => `<span class="tag ${t.ruined ? 'ruin' : 'state'}">${esc(x)}</span>`).join('')}</div></div>`;
        })
        .join('');
      return `<div class="place">${esc(pl)}</div><div class="small">${cards}</div>`;
    })
    .join('');
  return `<h2>${W.PLAY_TITLE}</h2>${body}`;
}

function abilities(): string {
  if (table.over) return '';
  const list = table.abilities();
  const body = list.length
    ? `<div class="wheel">${list.map((a) => `<button class="${a.id === armed ? 'armed' : ''}" data-act="arm" data-id="${esc(a.id)}" ${a.can && a.targets.length ? '' : 'disabled'} title="${esc(a.text)}">${esc(a.name)} · ${esc(W.castCost(a.cost))}</button>`).join('')}</div>${list.map((a) => `<div class="why">${esc(a.name)}. ${esc(a.text)}${a.targets.length ? '' : ` ${W.NO_TARGET}`}</div>`).join('')}${armed ? `<div class="why ok">${W.PICK_TARGET}</div>` : ''}`
    : `<div class="dim">${W.ABILITIES_NONE}</div>`;
  return `<h2>${W.ABILITIES_TITLE}</h2>${body}`;
}

function packDrawer(): string {
  const lines = table.packs.flatMap((p) => [`<div>${esc(W.packLine(p.name, p.templates.length))}</div>`, ...p.left.map((x) => `<div class="need">${esc(W.packLeft(x.card, x.why))}</div>`), ...p.problems.map((x) => `<div class="why">${esc(x.where)}: ${esc(x.text)}</div>`)]);
  return `<details ${packError ? 'open' : ''}><summary>${W.PACK_TITLE}</summary>${lines.join('') || `<div class="dim">${W.PACK_NONE}</div>`}${packError ? `<pre class="need" style="white-space:pre-wrap">${esc(packError)}</pre>` : ''}<div class="bar" style="margin-top:6px"><label>${W.PACK_LOAD} <input id="packfile" type="file" accept=".json,application/json" style="width:auto"></label></div></details>`;
}

function log(): string {
  const lines = [...table.log].reverse();
  const body = lines.length ? lines.map((l) => `<div class="k-${l.kind}"><span class="s">S${l.season}</span>${esc(l.text)}</div>`).join('') : `<div class="dim">${W.LOG_NONE}</div>`;
  return `<h2>${W.LOG_TITLE}</h2><div class="log">${body}</div>`;
}

function end(): string {
  if (!table.over) return '';
  const r = table.result;
  const story = table.story();
  return `<h2>${esc(r?.title ?? W.RUN_OVER)}</h2><div class="card">${(r?.lines ?? []).map((l) => `<div>${esc(l)}</div>`).join('')}<div class="dim">${W.CARRY}</div></div>
<h2>${W.STORY_TITLE}</h2><div class="log">${story.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
}

function footer(): string {
  const leaders = LEADERS.map((l) => `<option value="${l.id}" ${l.id === leader ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const main = table.over ? `<button class="main" data-act="next">${W.NEW_RUN}</button>` : `<button class="main" data-act="end">${W.END_SEASON}</button>`;
  const setup = `<details><summary>${W.SETUP}</summary><div class="bar" style="margin-top:6px"><label>${W.SEED} <input id="seed" type="number" value="${seed}"></label><label>${W.LENGTH} <input id="seasons" type="number" min="4" max="40" value="${seasons}"></label><select id="leader" title="${W.LEADER}">${leaders}</select><button data-act="restart">${W.RESTART}</button></div></details>`;
  return `${setup}<footer><div class="bar">${main}</div></footer>`;
}

function draw(): void {
  const y = window.scrollY;
  app.innerHTML = header() + end() + opps() + abilities() + inPlay() + working() + log() + packDrawer() + footer();
  window.scrollTo(0, y);
}

app.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!b || (b as HTMLButtonElement).disabled) return;
  const act = b.dataset.act;
  const id = b.dataset.id ?? '';
  if (act === 'take') table.take(id);
  else if (act === 'pass') table.pass(id);
  else if (act === 'end') table.endSeason();
  else if (act === 'arm') armed = armed === id ? null : id;
  else if (act === 'target' && armed) {
    table.cast(armed, id);
    armed = null;
  } else if (act === 'next') table = table.next(leader);
  else if (act === 'restart') {
    seed = Number((document.getElementById('seed') as HTMLInputElement).value) || 0;
    seasons = Math.max(4, Number((document.getElementById('seasons') as HTMLInputElement).value) || 16);
    leader = (document.getElementById('leader') as HTMLSelectElement).value;
    history.replaceState(null, '', `?seed=${seed}&leader=${leader}&seasons=${seasons}`);
    restart();
  }
  draw();
});
app.addEventListener('change', (e) => {
  const el = e.target as HTMLElement;
  if (el.id === 'leader') leader = (el as HTMLSelectElement).value;
  if (el.id === 'packfile') {
    const f = (el as HTMLInputElement).files?.[0];
    if (f) void f.text().then((t) => usePack(t));
  }
});

/** a pack's text: checked and loaded, and the run started again with it mixed into the base cards */
function usePack(t: string): void {
  try {
    packs = [JSON.parse(t) as Pack];
  } catch (e) {
    packs = [];
    packError = `Not readable as JSON. ${(e as Error).message}`;
    draw();
    return;
  }
  restart();
  draw();
}
const packUrl = params.get('pack');
if (packUrl)
  void fetch(packUrl)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${packUrl}: ${r.status}`))))
    .then(usePack, (e: Error) => {
      packError = e.message;
      draw();
    });

// (scripts and the browser console)
(window as unknown as { table: () => Table; tableDraw: () => void }).table = () => table;
(window as unknown as { tableDraw: () => void }).tableDraw = draw;
draw();
