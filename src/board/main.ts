// (board, docs/design/BOARD.md) The phone board: the season loop played on a 2D sprite town over the same model as the
// card table (table/game.ts → season/realm.ts). Canvas 2D only, no GPU. The town fills the screen; a slim bar on top
// holds the pools and the needs; the pieces and "Next season" sit at the bottom; a sheet slides up for what is tapped.
// Every number shown is the model's; the board animates what the model did (time-lapse between seasons, the raid).
import type { Pack } from '../packs/check';
import { POOL_ICON } from '../season/words';
import { POOLS, type Pool } from '../season/ledger';
import { Table } from '../table/game';
import { previewLine } from '../table/words';
import { readBoard, type BoardState, type LiveView, type OfferView } from './model';
import { RaidPlay } from './raid';
import { RegionScene } from './region';
import { TownScene, type Action } from './scene';
import { ACT, FOE, HW, spriteCount } from './sprites';
import { attachGestures, tileXY, toScreen, type Camera } from './view';
import * as W from './words';

const params = new URLSearchParams(location.search);
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

window.addEventListener('error', (e) => fatal(String(e.error?.stack ?? e.message)));
window.addEventListener('unhandledrejection', (e) => fatal(String((e.reason as Error)?.stack ?? e.reason)));
function fatal(msg: string): void {
  const d = document.createElement('div');
  d.id = 'err';
  d.textContent = msg;
  document.body.appendChild(d);
}

const seed = Number(params.get('seed') ?? 7);
let leader = params.get('leader') ?? 'ysolt';
const seasons = Number(params.get('seasons') ?? 12);
let packs: Pack[] = [];
let table!: Table;
let state!: BoardState;

const canvas = $('c') as HTMLCanvasElement;
const g = canvas.getContext('2d')!;
const scene = new TownScene();
const region = new RegionScene();
let mode: 'town' | 'region' = params.get('region') === '1' ? 'region' : 'town';
const [kx, ky] = scene.siteXY('keep');
const cam: Camera = { x: kx, y: ky + 30, zoom: 0.72 };
let sheet: { kind: 'site' | 'offer' | 'live' | 'far' | 'end' | 'result'; id: string; lines?: string[] } | null = null;
/** what is playing: the time-lapse, the raid; while it plays the turn is closed */
let busy: 'lapse' | 'raid' | null = null;
let raid: { play: RaidPlay; id: string; then: (() => void) | null } | null = null;
let skipLapse: (() => void) | null = null;
const sizes = { w: 0, h: 0, dpr: 1, top: 0, bottom: 0 };

function resize(): void {
  sizes.dpr = Math.min(2, window.devicePixelRatio || 1);
  sizes.w = window.innerWidth;
  sizes.h = window.innerHeight;
  canvas.width = Math.round(sizes.w * sizes.dpr);
  canvas.height = Math.round(sizes.h * sizes.dpr);
  sizes.top = $('top').getBoundingClientRect().height;
  sizes.bottom = $('bottom').getBoundingClientRect().height;
  $('skip').style.top = `${sizes.top + 8}px`;
  $('hint').style.top = `${sizes.top + 8}px`;
  $('toast').style.top = `${sizes.top + 60}px`;
  $('spells').style.bottom = `${sizes.bottom + 10}px`;
}
const limits = () => {
  const min = Math.max(0.28, sizes.w / (scene.l.n * HW * 2 * 0.8));
  return { min, max: 2.2, bounds: scene.bounds() };
};

// ---- the model's reading, and the bars --------------------------------------------------------------------------------

function refresh(animate: boolean): void {
  state = readBoard(table, packs);
  scene.set(state, performance.now(), animate);
  renderTop();
  renderBottom();
  if (sheet && sheet.kind !== 'end' && sheet.kind !== 'result') renderSheet();
}

const TOP_POOLS: Pool[] = ['magic', 'materials', 'intel', 'unrest'];
function renderTop(): void {
  const p = new Map(state.pools.map((x) => [x.pool, x]));
  const pools = TOP_POOLS.map((k) => {
    const v = p.get(k)!;
    const inc = v.income ? `${v.income > 0 ? '+' : ''}${v.income}/season` : W.poolName(k);
    return `<div class="pool ${k === 'unrest' && v.have > 0 ? 'bad' : ''}" data-pool="${k}"><b>${POOL_ICON[k]} ${v.have}</b><span>${esc(k === 'unrest' ? 'Unrest' : inc === W.poolName(k) ? inc : `${W.poolName(k)} ${inc}`)}</span></div>`;
  }).join('');
  const needs: string[] = [];
  if (state.raid) needs.push(`<button class="need raid" data-need="raid">⚔ <b>${esc(W.raidChip(state.raid.raiders, state.raid.meet, state.raid.left))}</b></button>`);
  for (const lv of state.live) needs.push(`<button class="need ${lv.ev.groups.some((x) => x.side === 'foe') ? 'raid' : ''}" data-live="${esc(lv.ev.id)}">${lv.raid ? '⚔' : '🔥'} <b>${esc(lv.ev.title)}</b> now</button>`);
  for (const o of state.offers.filter((x) => x.card.threat)) needs.push(`<button class="need" data-offer="${esc(o.card.id)}">⏳ <b>${esc(o.card.title)}</b> · ${esc(W.leftWord(o.card.left))}</button>`);
  $('top').innerHTML = `<div class="row"><div class="season"><b>${esc(W.seasonOf(state.season, state.seasons))}</b><span>${esc(W.seasonSub(state.season, state.seasons, state.run))}</span></div>${pools}</div>${needs.length ? `<div id="needs">${needs.join('')}</div>` : ''}`;
  resize();
}

function renderBottom(): void {
  const armed = scene.armed;
  const lock = !!busy || state.over;
  $('bottom').innerHTML = `
    <button class="piece ${armed === 'crew' ? 'armed' : ''}" data-arm="crew" ${lock || !state.crews.free ? 'disabled' : ''}>⚒ ${state.crews.free}<small>/${state.crews.all}</small></button>
    <button class="piece ${armed === 'soldier' ? 'armed' : ''}" data-arm="soldier" ${lock || !state.soldiers.free ? 'disabled' : ''}>⚔ ${state.soldiers.free}<small>/${state.soldiers.all}</small></button>
    <button class="region" data-act="region">${mode === 'town' ? '🗺 ' + W.REGION : '🏠 ' + W.TOWN}</button>
    <button class="next" data-act="next" ${lock ? 'disabled' : ''}>${esc(state.over ? W.NEW_RUN(state.run + 1) : W.NEXT)} ▶</button>`;
  $('hint').hidden = !armed;
  if (armed) $('hint').textContent = state.works.some((w) => w.slots.some((s) => s.kind === armed && s.posted < s.n)) ? W.armedHint(armed) : W.noRoom(armed);
}

// ---- the sheet ----------------------------------------------------------------------------------------------------------

function openSheet(kind: NonNullable<typeof sheet>['kind'], id: string, lines?: string[]): void {
  sheet = { kind, id, ...(lines ? { lines } : {}) };
  scene.focus = kind === 'site' ? (id as never) : null;
  renderSheet();
}
function closeSheet(): void {
  sheet = null;
  scene.focus = null;
  $('sheet').hidden = true;
}

function previewHtml(o: OfferView): string {
  if (Object.keys(o.card.short).length) {
    const miss = POOLS.filter((k) => o.card.short[k]).map((k) => `${o.card.short[k]} ${W.poolName(k)}`).join(', ');
    return `<div class="pv bad">Short: ${esc(miss)}</div>`;
  }
  const p = table.preview(o.card.id);
  const rows = POOLS.filter((k) => p.after[k] !== p.before[k]).map((k) => `<div>${esc(W.poolName(k))} ${p.before[k]} <span class="arrow">→</span> <span class="${p.after[k] < p.before[k] ? 'down' : 'up'}">${p.after[k]}</span></div>`);
  const tied = (['crew', 'soldier'] as const).filter((k) => p.tied[k] > 0).map((k) => `<div>${esc(W.tiedLine(k, p.tied[k], p.back))}</div>`);
  return `<div class="pv">${rows.join('') || '<div>Nothing spent.</div>'}${tied.join('')}</div>`;
  void previewLine;
}

function renderSheet(): void {
  if (!sheet) return;
  const el = $('sheet');
  let html = '';
  const s = state;
  if (sheet.kind === 'offer') {
    const o = s.offers.find((x) => x.card.id === sheet!.id);
    if (!o) return closeSheet();
    const c = o.card;
    html = `<h2>${esc(c.title)}</h2>
      <div class="who">${esc(c.who)}, ${esc(c.role)} · ${esc(cap(c.place))}</div>
      <div class="say">“${esc(c.line)}”</div>
      <div class="line"><b>${W.COST}:</b> ${esc(c.cost)}</div>
      ${previewHtml(o)}
      <div class="line"><b>${W.GIVES}:</b> ${esc(c.gives)}</div>
      ${c.lapse ? `<div class="line bad"><b>${W.IF_LEFT}:</b> ${esc(c.lapse)} (${esc(W.leftWord(c.left))})</div>` : `<div class="line" style="color:var(--dim)">Stays ${esc(W.leftWord(c.left))}.</div>`}
      ${c.laws.brings.map((l) => `<div class="line" style="color:#c9a8ff">${esc(l)}</div>`).join('')}
      <div class="acts"><button class="go" data-do="take" data-id="${esc(c.id)}" ${Object.keys(c.short).length || busy ? 'disabled' : ''}>${W.COMMIT}</button><button data-do="pass" data-id="${esc(c.id)}" ${busy ? 'disabled' : ''}>${W.PASS}</button></div>`;
  } else if (sheet.kind === 'site') {
    const sv = s.sites[sheet.id as keyof typeof s.sites];
    const works = s.works.filter((w) => w.site === sv.key);
    const offers = s.offers.filter((o) => 'site' in o.at && o.at.site === sv.key);
    const lives = s.live.filter((o) => 'site' in o.at && o.at.site === sv.key);
    const state = [...sv.look.scars.map((x) => cap(x)), ...sv.look.marks.map(cap)];
    html = `<h2>${esc(cap(sv.name))}</h2>${state.length ? `<div class="bad">${esc(state.join(' · '))}</div>` : ''}
      ${sv.raising ? `<div class="line">${esc(W.raisingLine(sv.raising.title, sv.raising.left))}</div>` : ''}
      ${works
        .map((w) => {
          const slots = w.slots.map((sl) => `<div class="slot"><span>${esc(W.slotLine(sl.kind, sl.posted, sl.n))}</span><button data-do="post" data-kind="${sl.kind}" data-id="${esc(w.id)}" ${busy || sl.posted >= sl.n || !(sl.kind === 'crew' ? s.crews.free : s.soldiers.free) ? 'disabled' : ''}>+ ${W.POST}</button><button data-do="recall" data-kind="${sl.kind}" data-id="${esc(w.id)}" ${busy || !sl.posted ? 'disabled' : ''}>− ${W.RECALL}</button></div>`).join('');
          const uses = w.uses.map((u) => `<button class="use" data-do="use" data-use="${esc(u.use.id)}" data-id="${esc(w.id)}" ${u.can && !busy ? '' : 'disabled'}>${esc(u.use.name)}<small>${esc(u.use.text)} · ${esc(W.usesLeft(u.left))}</small></button>`).join('');
          return `<div class="thing"><b>${esc(cap(w.name))}</b><div class="who">${esc(w.text)}</div>${slots}${uses}</div>`;
        })
        .join('')}
      ${[...lives.map((l) => `<div class="row-offer"><span style="flex:1">${l.raid ? '⚔' : '🔥'} ${esc(l.ev.title)}</span><button data-open="live" data-id="${esc(l.ev.id)}">Open</button></div>`), ...offers.map((o) => `<div class="row-offer"><span style="flex:1">${o.card.threat ? '⏳' : '!'} ${esc(o.card.title)}</span><button data-open="offer" data-id="${esc(o.card.id)}">Open</button></div>`)].join('')}
      ${!works.length && !offers.length && !lives.length && !sv.raising ? `<div class="who">${W.NOTHING_HERE}</div>` : ''}`;
  } else if (sheet.kind === 'live') {
    const lv = s.live.find((x) => x.ev.id === sheet!.id);
    if (!lv) return closeSheet();
    const e = lv.ev;
    const foe = e.groups.find((x) => x.side === 'foe');
    const town = e.groups.find((x) => x.side === 'town');
    const spells = table.abilities().filter((a) => a.targets.includes(e.id));
    html = `<h2>${esc(e.title)}</h2><div class="who">${esc(cap(e.place))}</div>
      ${foe ? `<div class="line">${esc(W.fightLine(foe.n, town?.n ?? 0))}</div>` : ''}
      ${lv.raid && !(town?.n ?? 0) ? `<div class="line bad">${esc(W.NO_MUSTER)}</div>` : ''}
      ${e.hazard ? `<div class="line">${esc(`${e.hazard.burned} of ${e.hazard.points} places would burn as it stands.`)}</div>` : ''}
      <div class="line">${esc(e.how)}</div>
      ${e.rules.map((r) => `<div class="line good">${esc(r)}</div>`).join('')}
      <div class="pv"><b>${W.PREDICT}:</b> ${esc(e.outcome)}</div>
      <div class="acts">${lv.raid ? `<button class="foe" data-do="defend" data-id="${esc(e.id)}" ${busy ? 'disabled' : ''}>⚔ ${W.DEFEND}</button>` : `${spells.map((a) => `<button data-do="cast" data-ab="${esc(a.id)}" data-id="${esc(e.id)}" ${a.can && !busy ? '' : 'disabled'}>${esc(a.name)} · ${a.cost} ✦</button>`).join('')}<button class="go" data-do="resolve" data-id="${esc(e.id)}" ${busy ? 'disabled' : ''}>${W.RESOLVE}</button>`}</div>`;
  } else if (sheet.kind === 'far') {
    const f = s.far.find((x) => x.id === sheet!.id);
    if (!f) return closeSheet();
    const news = table.farNews().places.find((p) => p.name === f.name);
    const offers = s.offers.filter((o) => 'far' in o.at && o.at.far === f.id);
    html = `<h2>${esc(cap(f.name))}</h2>${news ? `<div class="line">${esc(cap(news.line))}</div>${news.since ? `<div class="who">${esc(news.since)}</div>` : ''}` : ''}
      ${offers.map((o) => `<div class="row-offer"><span style="flex:1">${o.card.threat ? '⏳' : '!'} ${esc(o.card.title)}</span><button data-open="offer" data-id="${esc(o.card.id)}">Open</button></div>`).join('')}`;
  } else if (sheet.kind === 'result') {
    html = `<h2>${esc(sheet.id)}</h2>${(sheet.lines ?? []).map((l) => `<div class="line">${esc(l)}</div>`).join('')}<div class="acts"><button class="go" data-do="close">OK</button></div>`;
  } else if (sheet.kind === 'end') {
    const r = table.result;
    const later = table.newForLater();
    html = `<h2>${esc(r?.title ?? 'The run is over')}</h2>${(r?.lines ?? []).map((l) => `<div class="line">${esc(l)}</div>`).join('')}
      ${later.length ? `<div class="line"><b>New for later runs:</b></div>${later.map((l) => `<div class="who">${esc(l)}</div>`).join('')}` : ''}
      <div class="line"><b>What the next run finds:</b></div>
      ${s.built.length ? `<div class="who">Built: ${esc([...new Set(s.built)].join(', '))}.</div>` : ''}
      ${Object.values(s.sites).filter((x) => x.look.scars.length).map((x) => `<div class="who">${esc(cap(x.name))}: ${esc(x.look.scars.join(', '))}.</div>`).join('')}
      ${s.signs.length ? `<div class="who">Over the town: ${esc(s.signs.join(', '))}.</div>` : ''}
      ${s.far.filter((f) => f.look.status !== 'standing' || f.look.yours || f.look.founded).map((f) => `<div class="who">${esc(cap(f.name))}: ${esc([f.look.status, f.look.yours ? 'yours' : '', f.look.founded ? 'new' : ''].filter((q) => q).join(', '))}.</div>`).join('')}
      <div class="acts"><button class="go" data-do="newrun">${esc(W.NEW_RUN(state.run + 1))}</button></div>`;
  }
  el.innerHTML = `<button class="close" data-do="close">✕</button>${html}`;
  el.hidden = false;
}

// ---- moves: each changes the model, then the board shows what moved ---------------------------------------------------

/** a move made: the pools before and after fly between the place it was made and the bar */
function move(fn: () => boolean, from: [number, number] | null): boolean {
  const before = new Map(state.pools.map((p) => [p.pool, p.have]));
  const ok = fn();
  refresh(true);
  if (!ok) return false;
  const now = performance.now();
  const src = from ?? [sizes.w / 2, sizes.h / 2];
  let i = 0;
  for (const p of state.pools) {
    const d = p.have - (before.get(p.pool) ?? 0);
    if (!d) continue;
    const chip = poolChip(p.pool);
    const text = `${d > 0 ? '+' : ''}${d} ${POOL_ICON[p.pool]}`;
    if (d > 0) scene.fly.push({ text, color: '#c8ff9a', from: src, to: chip, t0: now + i * 120, dur: 900 });
    else scene.fly.push({ text, color: '#ffb08a', from: chip, to: src, t0: now + i * 120, dur: 900 });
    pulse(p.pool, now + i * 120 + 850);
    i++;
  }
  return true;
}
function poolChip(k: Pool): [number, number] {
  const el = document.querySelector<HTMLElement>(`[data-pool="${k}"]`) ?? document.querySelector<HTMLElement>(`[data-arm="${k === 'labor' ? 'crew' : 'soldier'}"]`);
  if (!el) return [sizes.w / 2, 30];
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}
function pulse(k: Pool, at: number): void {
  setTimeout(() => {
    const el = document.querySelector(`[data-pool="${k}"]`);
    el?.classList.add('pulse');
    setTimeout(() => el?.classList.remove('pulse'), 450);
  }, Math.max(0, at - performance.now()));
}
/** the screen point of a work's site, or of a site */
function siteScreen(key: keyof BoardState['sites']): [number, number] {
  const [x, y] = scene.siteXY(key);
  const [sx, sy] = toScreen(cam, sizes.w, sizes.h, x, y);
  return [sx, sy - 30 * cam.zoom];
}

function doAction(a: Action): void {
  if (a.kind === 'offer') openSheet('offer', a.id);
  else if (a.kind === 'live') openSheet('live', a.id);
  else if (a.kind === 'post') {
    const w = state.works.find((x) => x.id === a.work)!;
    move(() => table.post(a.piece, a.work), siteScreen(w.site));
    const free = a.piece === 'crew' ? state.crews.free : state.soldiers.free;
    const room = state.works.some((x) => x.slots.some((s) => s.kind === a.piece && s.posted < s.n));
    if (!free || !room) scene.armed = null;
    renderBottom();
  } else if (a.kind === 'site') {
    if (scene.armed) {
      // (a piece in hand and a tap on a place without room: the piece is put down)
      scene.armed = null;
      renderBottom();
    }
    openSheet('site', a.key);
  }
}

$('sheet').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-do],[data-open]');
  if (!b || (b as HTMLButtonElement).disabled) return;
  if (b.dataset.open) return openSheet(b.dataset.open as 'offer', b.dataset.id!);
  const d = b.dataset.do;
  const id = b.dataset.id ?? '';
  if (d === 'close') return closeSheet();
  if (d === 'take') {
    const o = state.offers.find((x) => x.card.id === id)!;
    const at = 'site' in o.at ? siteScreen(o.at.site) : siteScreen('keep');
    move(() => table.take(id), at);
    closeSheet();
  } else if (d === 'pass') {
    table.pass(id);
    refresh(true);
    closeSheet();
  } else if (d === 'post' || d === 'recall') {
    const w = state.works.find((x) => x.id === id)!;
    move(() => (d === 'post' ? table.post(b.dataset.kind as 'crew', id) : table.recall(b.dataset.kind as 'crew', id)), siteScreen(w.site));
  } else if (d === 'use') {
    const w = state.works.find((x) => x.id === id)!;
    move(() => table.use(b.dataset.use!, id), siteScreen(w.site));
  } else if (d === 'cast') {
    move(() => table.cast(b.dataset.ab!, id), null);
  } else if (d === 'resolve') {
    const before = table.log.length;
    move(() => table.resolveNow(id), null);
    openSheet('result', table.log[before]?.text.split('.')[0] ?? 'Settled', table.log.slice(before).map((l) => l.text));
  } else if (d === 'defend') {
    closeSheet();
    startRaid(id, null);
  } else if (d === 'newrun') newRun();
  renderBottom();
});

$('top').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button');
  if (!b || busy) return;
  if (b.dataset.offer) {
    focusOn(state.offers.find((o) => o.card.id === b.dataset.offer)?.at);
    openSheet('offer', b.dataset.offer);
  } else if (b.dataset.live) {
    focusOn(state.live.find((o) => o.ev.id === b.dataset.live)?.at);
    openSheet('live', b.dataset.live);
  } else if (b.dataset.need === 'raid') openSheet('result', 'The raiders', [W.raidNeed(state.raid!.raiders, state.raid!.meet, state.raid!.left, state.raid!.military), 'Pay them off with the card on the road, or post soldiers: on the watchtower they stop raiders on the road, on the wall walk they fight from above the gate.']);
});
function focusOn(at: OfferView['at'] | undefined): void {
  if (!at) return;
  if ('far' in at) {
    mode = 'region';
    renderBottom();
    return;
  }
  mode = 'town';
  const [x, y] = scene.siteXY('site' in at ? at.site : 'keep');
  cam.x = x;
  cam.y = y + 60;
}

$('bottom').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b || b.disabled) return;
  if (b.dataset.arm) {
    const k = b.dataset.arm as 'crew' | 'soldier';
    scene.armed = scene.armed === k ? null : k;
    mode = 'town';
    closeSheet();
  } else if (b.dataset.act === 'region') {
    mode = mode === 'town' ? 'region' : 'town';
    closeSheet();
  } else if (b.dataset.act === 'next') {
    if (state.over) newRun();
    else nextSeason();
  }
  renderBottom();
});

// ---- between seasons: the time-lapse ----------------------------------------------------------------------------------

function banner(title: string, sub = ''): void {
  $('banner').innerHTML = `<div>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  $('banner').hidden = false;
}
function toast(lines: string[]): void {
  $('toast').innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join('');
  setTimeout(() => ($('toast').innerHTML = ''), 4200);
}

function nextSeason(): void {
  if (busy) return;
  closeSheet();
  scene.armed = null;
  // (a raid under way is fought first, on the board)
  const r = state.live.find((x) => x.raid);
  if (r) return startRaid(r.ev.id, () => nextSeason());
  busy = 'lapse';
  const before = state;
  const logAt = table.log.length;
  const farBefore = new Map(before.far.map((f) => [f.id, `${f.look.status}|${f.look.yours}|${f.look.holder}`]));
  table.endSeason();
  const now = performance.now();
  mode = 'town';
  cam.zoom = Math.max(limits().min, Math.min(cam.zoom, 0.55));
  refresh(true);
  renderBottom();
  banner(table.over ? 'The run ends' : W.seasonOf(state.season, state.seasons), table.over ? '' : W.seasonSub(state.season, state.seasons, state.run));
  // (the pools: what the season brought, flying in from the keep)
  const from = siteScreen('keep');
  let i = 0;
  for (const p of state.pools) {
    const d = p.have - (before.pools.find((q) => q.pool === p.pool)?.have ?? 0);
    if (!d) continue;
    const chip = poolChip(p.pool);
    scene.fly.push({ text: `${d > 0 ? '+' : ''}${d} ${POOL_ICON[p.pool]}`, color: d > 0 ? '#c8ff9a' : '#ffb08a', from: d > 0 ? from : chip, to: d > 0 ? chip : from, t0: now + 700 + i * 160, dur: 1000 });
    pulse(p.pool, now + 1600 + i * 160);
    i++;
  }
  // (the far places that changed: they flash on the region, and are told)
  const changed = state.far.filter((f) => farBefore.get(f.id) !== `${f.look.status}|${f.look.yours}|${f.look.holder}`);
  for (const f of changed) region.flash.set(f.id, now);
  // (the news: brought in person, one after another)
  const news = table.log.slice(logAt).filter((l) => l.kind === 'news' || l.kind === 'built' || l.kind === 'fight' || l.kind === 'event' || l.kind === 'run');
  const pick = [...news.filter((l) => l.kind !== 'built'), ...news.filter((l) => l.kind === 'built')].slice(0, 3);
  const timers: number[] = [];
  const end = (): void => {
    for (const t of timers) clearTimeout(t);
    scene.figs = scene.figs.filter((f) => !f.key.startsWith('news'));
    $('banner').hidden = true;
    $('skip').hidden = true;
    skipLapse = null;
    busy = null;
    renderBottom();
    renderTop();
    if (changed.length) toast(changed.slice(0, 3).map((f) => `${cap(f.name)}: ${f.look.yours ? 'yours' : ''} ${f.look.status}`.replace(/\s+/g, ' ')));
    if (table.over) openSheet('end', '');
    else if (state.live.some((x) => x.raid)) {
      const r2 = state.live.find((x) => x.raid)!;
      banner('The raiders are at the gate', 'Tap ⚔ to defend');
      setTimeout(() => ($('banner').hidden = true), 2600);
      focusOn(r2.at);
    }
  };
  timers.push(window.setTimeout(() => ($('banner').hidden = true), 1300));
  pick.forEach((l, k) => {
    timers.push(
      window.setTimeout(() => {
        scene.figs = scene.figs.filter((f) => !f.key.startsWith('news'));
        const f = scene.news(l.text, mountOf(l.text), performance.now());
        f.until = performance.now() + 2600;
      }, 1200 + k * 2700),
    );
  });
  timers.push(window.setTimeout(end, Math.max(2600, 1200 + pick.length * 2700)));
  skipLapse = end;
  $('skip').hidden = false;
}
/** how news comes: by ship from the sea, a cart with goods, a rider from a far place, else on foot */
function mountOf(text: string): 'foot' | 'horse' | 'cart' | 'ship' {
  const t = text.toLowerCase();
  if (/\b(ship|ships|sail|sails|sea|coast|boat|boats|harbour|quay|cove)\b/.test(t)) return 'ship';
  if (/\b(cart|carts|wagon|wagons|grain|ore|trade|goods)\b/.test(t)) return 'cart';
  if (state.far.some((f) => t.includes(f.name.toLowerCase())) || /\b(raiders|league|riders?)\b/.test(t)) return 'horse';
  return 'foot';
}
$('skip').addEventListener('click', () => skipLapse?.());

// ---- the raid, live ---------------------------------------------------------------------------------------------------

function startRaid(id: string, then: (() => void) | null): void {
  const lv = state.live.find((x) => x.ev.id === id);
  if (!lv) return;
  busy = 'raid';
  mode = 'town';
  closeSheet();
  const foe = lv.ev.groups.find((x) => x.side === 'foe')!;
  const town = lv.ev.groups.find((x) => x.side === 'town');
  const towers: ('watch' | 'wall')[] = [];
  for (const w of state.works) if (w.slots.some((s) => s.kind === 'soldier' && s.posted > 0)) towers.push(w.site === 'watch' ? 'watch' : 'wall');
  const [gx, gy] = scene.siteXY('gate');
  cam.x = gx - 60;
  cam.y = gy - 20;
  cam.zoom = Math.max(limits().min, 0.6);
  raid = { play: new RaidPlay(scene, performance.now(), foe.n, foe.alive, town?.n ?? 0, town?.alive ?? 0, (town?.n ?? 0) > 0, towers), id, then };
  banner(`${foe.n} raiders on the east road`, (town?.n ?? 0) > 0 ? `Your ${town!.n} soldiers meet them where they stand` : 'Your soldiers have no keep or walls to gather at');
  setTimeout(() => ($('banner').hidden = true), 2400);
  renderBottom();
  renderSpells();
}
function renderSpells(): void {
  if (!raid) {
    $('spells').innerHTML = '';
    return;
  }
  const all = table.abilities().filter((a) => a.targets.includes(raid!.id));
  $('spells').innerHTML = `<div class="count" id="raidcount">${esc(W.raidCount(raid.play.standing(), raid.play.left(performance.now())))}</div>${all.map((a) => `<button data-ab="${esc(a.id)}" ${a.can && table.useful(a.id, raid!.id) ? '' : 'disabled'}>${esc(a.name)} · ${a.cost} ✦</button>`).join('')}`;
}
$('spells').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b || b.disabled || !raid) return;
  if (!table.cast(b.dataset.ab!, raid.id)) return;
  const lv = table.liveEvents().find((x) => x.id === raid!.id);
  const foe = lv?.groups.find((x) => x.side === 'foe');
  if (foe) raid.play.cast(foe.alive, performance.now(), b.dataset.ab!.includes('fire') || b.dataset.ab!.includes('heat') ? 'rgba(255,150,40,0.85)' : 'rgba(150,220,255,0.8)');
  state = readBoard(table, packs);
  renderTop();
  renderSpells();
});
function endRaid(): void {
  if (!raid) return;
  const r = raid;
  raid = null;
  r.play.end();
  const before = table.log.length;
  table.resolveNow(r.id);
  const lines = table.raidResult?.lines ?? table.log.slice(before).map((l) => l.text);
  busy = null;
  refresh(true);
  renderSpells();
  openSheet('result', table.raidResult?.title ?? 'The raid is over', lines);
  if (r.then) {
    // (the season goes on once the result is read)
    const once = (): void => {
      $('sheet').removeEventListener('click', once);
      setTimeout(() => !sheet && r.then!(), 50);
    };
    $('sheet').addEventListener('click', once);
  }
}

// ---- runs ----------------------------------------------------------------------------------------------------------------

function newRun(): void {
  const choices = Table.leaders(table.realm.snapshot(), packs, table.home);
  if (!choices.some((l) => l.id === leader)) leader = choices[0].id;
  table = table.next(leader);
  closeSheet();
  refresh(false);
  banner(`Run ${state.run}`, W.RUN_CHANGED);
  setTimeout(() => ($('banner').hidden = true), 2600);
}

// ---- the frame ------------------------------------------------------------------------------------------------------------

let last = performance.now();
const frames: number[] = [];
/** the time each frame's own work took (ms): the measure that does not depend on the display's rate */
const work: number[] = [];
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  frames.push(now - last);
  if (frames.length > 120) frames.shift();
  last = now;
  if (raid) {
    if (!raid.play.step(now)) endRaid();
    else {
      const c = document.getElementById('raidcount');
      if (c) c.textContent = W.raidCount(raid.play.standing(), raid.play.left(now));
    }
  }
  if (mode === 'town') {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#2b3324';
    g.fillRect(0, 0, canvas.width, canvas.height);
    // (the lava front of a live event: from the mountain toward its place)
    const lava = state.live.find((x) => x.hazard === 'lava' && 'site' in x.at);
    if (lava && 'site' in lava.at) {
      const to = scene.l.sites[lava.at.site];
      const cells = [];
      const n = Math.max(to.x, to.y);
      for (let i = 0; i <= n; i++) cells.push({ x: Math.round((to.x * i) / n), y: Math.round((to.y * i) / n) });
      const h = lava.ev.hazard!;
      const reached = Math.round(cells.length * (0.35 + (0.65 * h.burned) / Math.max(1, h.points)));
      if (!scene.lavaFront || scene.lavaFront.reached !== reached) scene.lavaFront = { cells, reached, t0: scene.lavaFront?.t0 ?? now };
    } else scene.lavaFront = null;
    scene.draw(g, cam, sizes.w, sizes.h, sizes.dpr, now, dt);
  } else region.draw(g, state, sizes.w, sizes.h, sizes.dpr, now, sizes.top, sizes.bottom);
  work.push(performance.now() - now);
  if (work.length > 240) work.shift();
  requestAnimationFrame(frame);
}

attachGestures(canvas, cam, limits, {
  onTap(sx, sy) {
    if (busy === 'lapse') return skipLapse?.();
    if (mode === 'region') {
      const a = region.hit(sx, sy);
      if (!a) return closeSheet();
      if (a.kind === 'town') {
        mode = 'town';
        renderBottom();
      } else if (a.kind === 'far') openSheet('far', a.id);
      else openSheet(a.kind, a.id);
      return;
    }
    if (busy === 'raid') return;
    const a = scene.hit(sx, sy);
    if (!a) {
      closeSheet();
      return;
    }
    doAction(a);
  },
  onMove(out) {
    if (out && mode === 'town' && !busy) {
      mode = 'region';
      renderBottom();
    }
  },
});
window.addEventListener('resize', resize);

// ---- start ------------------------------------------------------------------------------------------------------------------

async function start(): Promise<void> {
  const names = (params.get('packs') ?? '').split(',').filter((x) => x);
  packs = await Promise.all(names.map((n) => fetch(`${import.meta.env.BASE_URL}packs/${n}.json`).then((r) => (r.ok ? (r.json() as Promise<Pack>) : Promise.reject(new Error(`pack ${n}: ${r.status}`))))));
  table = new Table({ seed, leader, seasons, works: true, packs });
  resize();
  refresh(false);
  requestAnimationFrame(frame);
}

// (scripts: the headless stills and the measure drive the page through these and through real taps)
(window as unknown as Record<string, unknown>).board = {
  table: () => table,
  state: () => state,
  scene,
  cam,
  /** the screen point of a site's tap target (its marker row when it has offers) */
  where: (site: keyof BoardState['sites']) => {
    const [x, y] = scene.siteXY(site);
    return toScreen(cam, sizes.w, sizes.h, x, y);
  },
  offerAt: (id: string) => {
    const o = state.offers.find((x) => x.card.id === id);
    return o && 'site' in o.at ? o.at.site : null;
  },
  frameMs: () => [...frames].sort((a, b) => a - b),
  workMs: () => [...work].sort((a, b) => a - b),
  counts: () => ({ figures: scene.figs.length, folk: scene.folkCount, sprites: spriteCount() }),
  setMode: (m: 'town' | 'region') => {
    mode = m;
    renderBottom();
  },
  live: (): LiveView[] => state.live,
  /** after a script moved the model itself (to reach a later season fast): read it again */
  refresh: (animate: boolean) => refresh(animate),
  /** the tap targets drawn last frame */
  hits: () => (scene as unknown as { hits: { x: number; y: number; act: Action }[] }).hits,
  tileXY,
  ACT,
  FOE,
};
start().catch((e: Error) => fatal(e.stack ?? e.message));
