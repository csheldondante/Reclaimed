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
/** the drawers left open (a redraw keeps them) */
const open = new Set<string>(params.get('open')?.split(',') ?? []);
let table = new Table({ seed, leader, seasons });

/** the run started again. `added`: packs being added to the set — refused with their report, the set stays as it was */
function restart(added: Pack[] = []): void {
  armed = null;
  try {
    table = new Table({ seed, leader, seasons, packs: [...packs, ...added] });
    packs = [...packs, ...added];
    packError = '';
  } catch (e) {
    // (a pack with errors, or packs that clash: the report shown, the run played with the packs there were)
    packError = (e as Error).message;
    table = new Table({ seed, leader, seasons, packs });
  }
}

const drawer = (id: string, title: string, body: string, force = false): string => `<details data-drawer="${id}" ${force || open.has(id) ? 'open' : ''}><summary>${esc(title)}</summary>${body}</details>`;
const tags = (list: readonly string[], cls: string): string => `<div class="tags">${list.map((x) => `<span class="tag ${cls}">${esc(x)}</span>`).join('')}</div>`;

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
  ${c.because ? `<div class="row law-row">${esc(c.because)}</div>` : ''}
  <div class="say">"${esc(c.line)}"</div>
  <div class="row"><b>${W.COST}.</b> ${esc(c.cost)}${c.printed ? `<s class="printed" title="${W.PRINTED}">${esc(c.printed)}</s>` : ''}</div>
  <div class="row"><b>${W.IF_TAKEN}.</b> ${esc(c.gives)}${c.live ? ` ${W.LIVE_NOTE}` : ''}</div>
  ${c.laws.brings.map((l) => `<div class="row law-row"><b>${W.LAW_BRINGS}.</b> ${esc(l)}</div>`).join('')}
  ${c.laws.changes.length ? `<div class="row law-row"><b>${W.LAW_CHANGES}.</b> ${c.laws.changes.map(esc).join(' ')}</div>` : ''}
  <div class="row ${c.lapse ? 'bad' : ''}"><b>${W.IF_LEFT}.</b> ${esc(c.lapse ?? W.NO_LAPSE)} ${esc(W.leftLine(c.left))}</div>
  ${c.laws.onLapse.map((l) => `<div class="row law-row"><b>${W.LAW_ON_LAPSE}.</b> ${esc(l)}</div>`).join('')}
  ${tags(c.tags, '')}
  ${miss ? `<div class="need">${esc(W.needLine(miss))}</div>` : ''}
  <div class="acts"><button class="main" data-act="take" data-id="${esc(c.id)}" ${miss ? 'disabled' : ''}>${W.TAKE}</button><button data-act="pass" data-id="${esc(c.id)}">${W.PASS}</button></div>
</div>`;
        })
        .join('')
    : `<div class="dim">${W.OPPS_NONE}</div>`;
  return `<h2>${W.OPPS_TITLE}</h2><div class="grid">${body}</div>`;
}

/** the live events under way: who is in it, what can be cast, the rules that would apply and how it would end now */
function events(): string {
  const list = table.liveEvents();
  if (!list.length) return '';
  const ab = table.abilities().find((a) => a.id === armed);
  const body = list
    .map((e) => {
      const target = !!ab && ab.targets.includes(e.id);
      const who = [...e.groups.map((g) => W.groupLine(g.who, g.n, g.alive)), ...(e.hazard ? [W.hazardLine(e.hazard.burned, e.hazard.points)] : [])].join('. ');
      const casts = e.casts.map((c) => W.castsLine(c.name, c.n)).join('. ');
      return `<div class="card event ${target ? 'target' : ''}" ${target ? `data-act="target" data-id="${esc(e.id)}"` : ''} data-event="${esc(e.template)}">
  <h3>${esc(e.title)}</h3>
  <div class="who">${esc(cap(e.place))}.</div>
  ${who ? `<div class="row">${esc(who)}.</div>` : ''}
  <div class="row dim">${esc(e.how)}${casts ? ` ${esc(casts)}.` : ''}</div>
  ${e.rules.length ? e.rules.map((r) => `<div class="row rule">${esc(r)}</div>`).join('') : `<div class="row dim">${W.NO_RULES_APPLY}</div>`}
  <div class="row predict tier-${esc(e.tier)}"><b>${W.PREDICT}. ${esc(W.TIER_NAME[e.tier] ?? e.tier)}.</b> ${esc(e.outcome)}</div>
  ${e.after.map((a) => `<div class="row chain">${esc(a)}</div>`).join('')}
  ${table.over ? '' : `<div class="acts"><button data-act="resolve" data-id="${esc(e.id)}" title="${esc(W.RESOLVE_HELP)}">${W.RESOLVE_NOW}</button></div>`}
</div>`;
    })
    .join('');
  return `<h2>${W.EVENTS_TITLE}</h2><div class="grid">${body}</div>`;
}

function working(): string {
  const w = table.working();
  return w.length ? `<h2>${W.WORK_TITLE}</h2><div class="small">${w.map((x) => `<div class="thing"><b>${esc(x.title)}</b><div class="dim">${esc(W.doneIn(x.left))}</div></div>`).join('')}</div>` : '';
}

function inPlay(): string {
  const things = table.things();
  const ab = table.abilities().find((a) => a.id === armed);
  const card = (t: (typeof things)[number]): string => {
    const target = !!ab && ab.targets.includes(t.id);
    return `<div class="thing ${t.ruined ? 'ruined' : ''} ${target ? 'target' : ''}" ${target ? `data-act="target" data-id="${esc(t.id)}"` : ''}><b>${esc(cap(t.name))}</b>${t.text ? `<div class="dim">${esc(t.text)}</div>` : ''}${tags(t.tags, t.ruined ? 'ruin' : 'state')}</div>`;
  };
  // (a place with nothing on it yet goes in a drawer, unless the armed ability can be cast on it)
  // (draft 7: the far places have their own section, as news — farPlaces)
  const shown = things.filter((t) => t.place !== W.FAR && (!t.plain || (!!ab && ab.targets.includes(t.id))));
  const plain = things.filter((t) => !shown.includes(t));
  const places = [...new Set(shown.map((t) => t.place))];
  const body = places.map((pl) => `<div class="place">${esc(pl)}</div><div class="small">${shown.filter((t) => t.place === pl).map(card).join('')}</div>`).join('');
  return `<h2>${W.PLAY_TITLE}</h2>${body}${plain.length ? drawer('plain', `${W.PLAIN_PLACES} (${plain.length})`, `<div class="small">${plain.map(card).join('')}</div>`) : ''}`;
}

/** (draft 7) the far places as news of a living world: who holds what, who stands with whom, what changed and why */
function farPlaces(): string {
  const n = table.farNews();
  const ab = table.abilities().find((a) => a.id === armed);
  const farThings = table.things().filter((t) => t.place === W.FAR);
  const places = n.places
    .map((p) => {
      const t = farThings.find((x) => x.name === p.name);
      const target = !!t && !!ab && ab.targets.includes(t.id);
      return `<div class="thing ${t?.ruined ? 'ruined' : ''} ${target ? 'target' : ''}" ${target ? `data-act="target" data-id="${esc(t!.id)}"` : ''}><b>${esc(cap(p.name))}</b><div>${esc(p.line)}</div>${p.since ? `<div class="dim">${esc(p.since)}</div>` : ''}${t ? tags(t.tags, t.ruined ? 'ruin' : 'state') : ''}</div>`;
    })
    .join('');
  const stances = n.stances.length ? `<div class="place">${W.FAR_STANCES}</div>${n.stances.map((s) => `<div class="why">${esc(s)}</div>`).join('')}` : '';
  const changes = `<div class="place">${W.FAR_CHANGES}</div>${n.changes.length ? n.changes.map((s) => `<div class="why">${esc(s)}</div>`).join('') : `<div class="dim">${W.FAR_NONE}</div>`}`;
  return `<h2>${W.FAR}</h2><div class="dim">${W.FAR_HELP}</div><div class="small">${places}</div>${stances}${changes}`;
}

function abilities(): string {
  if (table.over) return '';
  const list = table.abilities();
  const armedOne = list.find((a) => a.id === armed);
  const body = list.length
    ? `<div class="wheel">${list.map((a) => `<button class="${a.id === armed ? 'armed' : ''}" data-act="arm" data-id="${esc(a.id)}" ${a.can && a.targets.length ? '' : 'disabled'} title="${esc(a.text)}">${esc(a.name)} · ${esc(W.castCost(a.cost))}</button>`).join('')}</div>${armedOne ? `<div class="why ok">${esc(armedOne.text)} ${W.PICK_TARGET}</div>` : ''}`
    : `<div class="dim">${W.ABILITIES_NONE}</div>`;
  return `<h2>${W.ABILITIES_TITLE}</h2>${body}`;
}

/** the discovery tool: every rule, what paid last season with its reason, what is ready, and for the rest the one
 *  thing missing; then the tags in play */
function rules(): string {
  const list = table.rules();
  const order = (r: (typeof list)[number]): number => (r.fired.length ? 0 : r.ready ? 1 : 2);
  const body = [...list]
    .sort((a, b) => order(a) - order(b))
    .map((r) => {
      const state = r.off ? 'not off' : r.fired.length ? 'paid' : r.ready ? 'ready' : 'not';
      const lawed = r.laws.length && !r.off ? `<div class="lawed">${W.CHANGED_BY}: ${r.laws.map(esc).join(', ')}.</div>` : '';
      return `<div class="rulecard ${state}" data-rule="${esc(r.id)}"><b>${esc(r.name)}</b> <span class="dim">${esc(r.when)}</span><div class="says">${esc(r.says)}</div>${lawed}${r.fired.map((f) => `<div class="why ok">${esc(f)}</div>`).join('')}<div class="why ${state.startsWith('not') ? 'no' : ''}">${esc(r.why)}</div></div>`;
    })
    .join('');
  const tagList = table.tagsInPlay();
  const paid = list.filter((r) => r.fired.length).length;
  const ready = list.filter((r) => !r.fired.length && r.ready).length;
  return drawer('rules', `${W.RULES_TITLE} (${W.rulesCount(paid, ready, list.length)})`, `<div class="why">${W.RULES_HELP}</div>${body}<div class="place">${W.TAGS_TITLE}</div><div class="tags">${tagList.map((t) => `<span class="tag state">${esc(t.tag)}${t.n > 1 ? ` ×${t.n}` : ''}</span>`).join('')}</div>`);
}

/** (laws) the laws in force, in the order they came: what each does, who or what made it, how long it stands. Open
 *  while any is in force */
function lawsList(): string {
  const list = table.laws();
  const body = list.length ? list.map((l) => `<div class="law" data-law="${esc(l.id)}"><b>${esc(l.name)}</b><div>${esc(l.text)}</div><div class="why">${esc(W.lawFrom(l.from, l.until, l.times))}</div></div>`).join('') : `<div class="dim">${W.LAWS_NONE}</div>`;
  // (opened once, when the first law comes into force; the player may close it)
  if (list.length && !lawsShown) {
    lawsShown = true;
    open.add('laws');
  }
  return drawer('laws', `${W.LAWS_TITLE} (${list.length})`, `<div class="why">${W.LAWS_HELP}</div>${body}`);
}
let lawsShown = false;

/** (the record) every card resolved or run out in this world, by place, then by run */
function recordList(): string {
  const list = table.record();
  const body = list.length ? list.map((p) => `<div class="place">${esc(p.place)}</div>${p.lines.map((l) => `<div class="why">${esc(l)}</div>`).join('')}`).join('') : `<div class="dim">${W.RECORD_NONE}</div>`;
  return drawer('record', `${W.RECORD_TITLE} (${list.reduce((n, p) => n + p.lines.length, 0)})`, body);
}

/** the packs in play: each with a button to take it out, what the validator says to look at, and a picker that adds
 *  one or several files (the run starts again with the new set) */
function packDrawer(): string {
  const lines = table.packs.flatMap((p) => [
    `<div class="bar"><span style="flex:1">${esc(W.packLine(p.name, p.templates.length))}</span><button data-act="unpack" data-id="${esc(p.id)}">${W.PACK_REMOVE}</button></div>`,
    ...p.left.map((x) => `<div class="need">${esc(W.packLeft(x.card, x.why))}</div>`),
    ...p.problems.map((x) => `<div class="why">${esc(x.where)}: ${esc(x.text)}</div>`),
  ]);
  const both = table.together.map((x) => `<div class="why">${esc(x.where)}: ${esc(x.text)}</div>`).join('');
  return drawer('packs', `${W.PACK_TITLE} (${table.packs.length})`, `${lines.join('') || `<div class="dim">${W.PACK_NONE}</div>`}${both}${packError ? `<pre class="need" style="white-space:pre-wrap">${esc(packError)}</pre>` : ''}<div class="bar" style="margin-top:6px"><label>${W.PACK_LOAD} <input id="packfile" type="file" multiple accept=".json,application/json" style="width:auto"></label></div>`, !!packError);
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
  const setup = drawer('setup', W.SETUP, `<div class="bar" style="margin-top:6px"><label>${W.SEED} <input id="seed" type="number" value="${seed}"></label><label>${W.LENGTH} <input id="seasons" type="number" min="4" max="40" value="${seasons}"></label><select id="leader" title="${W.LEADER}">${leaders}</select><button data-act="restart">${W.RESTART}</button></div>`);
  return `${setup}<footer><div class="bar">${main}</div></footer>`;
}

function draw(): void {
  const y = window.scrollY;
  const built = table.built();
  const builtRow = built.length ? `<h2>${W.BUILT_TITLE}</h2>${tags(built, 'state')}` : '';
  app.innerHTML = header() + end() + lawsList() + events() + opps() + abilities() + rules() + inPlay() + farPlaces() + working() + builtRow + log() + recordList() + packDrawer() + footer();
  window.scrollTo(0, y);
}

app.addEventListener('toggle', (e) => {
  const d = (e.target as HTMLElement).closest<HTMLDetailsElement>('[data-drawer]');
  if (!d) return;
  if (d.open) open.add(d.dataset.drawer!);
  else open.delete(d.dataset.drawer!);
}, true);

app.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!b || (b as HTMLButtonElement).disabled) return;
  const act = b.dataset.act;
  const id = b.dataset.id ?? '';
  if (act === 'take') table.take(id);
  else if (act === 'pass') table.pass(id);
  else if (act === 'resolve') {
    armed = null;
    table.resolveNow(id);
  }
  else if (act === 'end') {
    armed = null;
    table.endSeason();
  } else if (act === 'arm') armed = armed === id ? null : id;
  else if (act === 'target' && armed) {
    table.cast(armed, id);
    // (still armed while there is something left to cast it on: a second cast is one tap)
    const a = table.abilities().find((x) => x.id === armed);
    if (!a || !a.can || !a.targets.length) armed = null;
  } else if (act === 'unpack') {
    packs = packs.filter((p) => p.pack.id !== id);
    restart();
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
    const files = [...((el as HTMLInputElement).files ?? [])];
    if (files.length) void Promise.all(files.map((f) => f.text())).then(usePacks);
  }
});

/** packs' texts: checked and loaded with the packs already in play, and the run started again with the whole set
 *  mixed into the base cards. A pack already in play (the same id) is replaced: the file was edited and picked again */
function usePacks(texts: string[]): void {
  let added: Pack[];
  try {
    added = texts.map((t) => JSON.parse(t) as Pack);
  } catch (e) {
    packError = `Not readable as JSON. ${(e as Error).message}`;
    draw();
    return;
  }
  packs = packs.filter((p) => !added.some((a) => a?.pack?.id === p.pack.id));
  restart(added);
  draw();
}
// (?pack=a.json,b.json: several packs, loaded together)
const packUrls = (params.get('pack') ?? '').split(',').filter((u) => u);
if (packUrls.length)
  void Promise.all(packUrls.map((u) => fetch(u).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${u}: ${r.status}`)))))).then(usePacks, (e: Error) => {
    packError = e.message;
    draw();
  });

// (scripts and the browser console)
(window as unknown as { table: () => Table }).table = () => table;
(window as unknown as { tableDraw: () => void }).tableDraw = draw;
draw();
