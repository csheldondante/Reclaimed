// ---- cardlab/main.ts ----------------------------------------------------------------------------------------------
// (round 124, `opportunities`; BACKLOG RN2-9) The card lab page (cardlab.html): the opportunity system as a deck
// builder with no encounters and no rolls — another front end on the same contract and dealer as the map
// (src/opps/deck.ts), so whatever is tuned here carries over. The user (round 124): "I recommend making a playground
// for the card mechanics that has no playable encounters ... Think deck builder in terms of the design then we will
// work on thematic fits"; "Each should have world consequences that are visible".
// On the page: the world (settlements coloured by who holds them, marked by their condition, refugees' arrows, what's
// built), the board of what's offered (needs, costs, turns, expiry, the reward with its world consequence and the
// effects it brings, what letting it go does), the holdings (agents with their tags and effects, goods, buildings with
// theirs), what's committed with turns left, Next turn, the log and the world log, the dealer's why, every slider, the
// card library as JSON (edited here, kept in this browser), and the simulator (win rate, run length, choices a turn,
// cards never or always taken, effects fired and their impact, world change per run).

import LAB from '../../data/cards/lab.json';
import { needsPlayer, type Opportunity } from '../api/contracts/opportunity';
import { reportLines } from '../opps/dealer';
import { DeckRun, POLICIES, relicLine, simulate, tournament, worldLine, type CardDef, type LabDeck, type Policy, type SimReport } from '../opps/deck';
import { generateKingdom, type Kingdom, type LabLibrary } from '../opps/kingdom';
import { OPP_TUNING } from '../opps/tune';

const STORE = 'reclaimed.cardlab.deck';
const TUNE_STORE = 'reclaimed.cardlab.tune';
const app = document.getElementById('app')!;

function load(): LabLibrary {
  try {
    const s = localStorage.getItem(STORE);
    if (s) {
      const l = JSON.parse(s) as LabLibrary;
      if (Array.isArray(l.stacks)) return l;
    }
  } catch {
    /* (a browser that keeps nothing: the file's library) */
  }
  return structuredClone(LAB) as unknown as LabLibrary;
}
try {
  const t = localStorage.getItem(TUNE_STORE);
  if (t) OPP_TUNING.apply(JSON.parse(t), true);
} catch {
  /* (none kept) */
}

let lib = load();
let seed = Number(new URLSearchParams(location.search).get('seed') ?? 1);
/** (round 124, RN3-1) the kingdom: the world's stacks for this run, drawn from its seed */
let kseed = Number(new URLSearchParams(location.search).get('kingdom') ?? 1);
let kingdom: Kingdom;
let deck: LabDeck;
const makeKingdom = () => {
  const k = generateKingdom(lib, kseed, OPP_TUNING.values.lab.kingdom);
  kingdom = k.kingdom;
  deck = k.deck;
};
makeKingdom();
let run = new DeckRun(deck!, seed);
let sim: SimReport | null = null;
let tour: ReturnType<typeof tournament> | null = null;
let showEv = false;
let focus: string | null = null;
const open = new Set<string>(['board', 'holdings', 'log']);

const el = (tag: string, props: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) (k === 'class' ? (e.className = v) : e.setAttribute(k, v));
  for (const k of kids) e.append(k);
  return e;
};
const btn = (text: string, f: () => void, cls = '', disabled = false) => {
  const b = el('button', { class: cls }, text) as HTMLButtonElement;
  b.disabled = disabled;
  b.onclick = () => {
    f();
    render();
  };
  return b;
};
const section = (id: string, title: string, body: HTMLElement) => {
  const d = el('details') as HTMLDetailsElement;
  d.open = open.has(id);
  d.ontoggle = () => (d.open ? open.add(id) : open.delete(id));
  d.append(el('summary', {}, title), body);
  return d;
};
const goods = (g: Record<string, number>) => Object.entries(g).filter(([, n]) => n !== 0).map(([k, n]) => `${n} ${k}`).join(', ');

function cardOf(o: Opportunity): HTMLElement {
  const def = run.card(o.template);
  const player = needsPlayer(o);
  const event = !!def.onExpire || !!def.climax;
  const c = el('div', { class: `card ${player ? 'player' : 'agents'}${event ? ' event' : ''}${o.affordable ? '' : ' no'}` });
  c.append(el('div', { class: 't' }, `${def.climax ? '♛ ' : event ? '⚠ ' : ''}${o.title}`));
  const left = o.expires.turn - run.turn;
  c.append(el('div', { class: 'r k' }, `${run.place(def.place).name}${run.place(def.place).settlement ? ` (${run.place(def.place).settlement!.name})` : ''} · ⏱ ${left <= 0 ? 'goes at the end of this turn' : `${left + 1} turns on the board`}`));
  const needs = o.requires.map((r) => `${r.count} ${r.kind}${r.tags?.length ? ` (${r.tags.join(', ')})` : ''}`).join(', ') || 'no one';
  c.append(el('div', { class: 'r' }, `Needs: ${needs}${o.tiers > 1 ? ` · tier ${o.tier} of ${o.tiers}` : ''} · Costs: ${goods(o.costs) || 'nothing'}`));
  c.append(el('div', { class: 'r' }, `Takes: ${run.turns(def)} turn${run.turns(def) === 1 ? '' : 's'} (${run.travel(def.place)} travel + ${def.work} work${run.turns(def) < run.travel(def.place) + def.work ? ', less what you hold' : ''})`));
  c.append(el('div', { class: 'r ok' }, `Done: ${rewardLine(def, def.reward, o.tier)}`));
  for (const w of def.reward.world ?? []) c.append(el('div', { class: 'r w' }, `🌍 ${worldLine(w, deck)}`));
  for (const b of [...(def.reward.relics ?? []), ...(def.reward.build?.relics ?? []), ...(def.reward.agents ?? []).flatMap((a) => a.relics ?? [])]) c.append(el('div', { class: 'r relic', title: relicLine(b) }, `✦ ${relicLine(b)}`));
  if (def.onExpire) {
    c.append(el('div', { class: 'r x' }, `If let go: ${rewardLine(def, def.onExpire, 1)}`));
    for (const w of def.onExpire.world ?? []) c.append(el('div', { class: 'r w' }, `🌍 ${worldLine(w, deck)}`));
  }
  if (o.pitch) c.append(el('div', { class: 'r k' }, o.pitch));
  if (showEv) {
    const e = run.ev(def, o.tier);
    c.append(el('div', { class: 'r', style: 'color:#7fe0c0' }, `EV ${e.perTurn.toFixed(2)} pts/turn = (${e.direct.toFixed(1)} direct + ${e.engine.toFixed(1)} engine${def.onExpire ? ' + its penalty avoided' : ''}) ÷ ${e.turns} turns · horizon ${run.horizon().toFixed(1)}`));
  }
  if (o.affordable) c.append(btn(player ? '▶ Commit yourself' : '▶ Commit', () => run.commit(o.id), 'main', !!run.end));
  else c.append(el('div', { class: 'r bad' }, `Missing: ${o.missing.join('; ')}`));
  return c;
}

function rewardLine(def: CardDef, o: CardDef['reward'], tier: number): string {
  const parts = [o.text];
  if (o.goods) parts.push(goods(Object.fromEntries(Object.entries(o.goods).map(([g, n]) => [g, n > 0 ? n * tier : n]))));
  for (const a of o.agents ?? []) parts.push(`+${a.name} (${a.kind} ${a.count})`);
  if (o.tags?.length) parts.push(`those who go: ${o.tags.join(', ')}`);
  if (o.build) parts.push(`builds ${o.build.name}`);
  if (o.unlock?.length) parts.push(`unlocks ${o.unlock.join(', ')}`);
  if (o.doom) parts.push(`doom ${o.doom > 0 ? '+' : ''}${o.doom}`);
  if (o.losses) parts.push(`${Math.round(o.losses * 100)}% of those who go are lost`);
  if (o.end) parts.push(`the run is ${o.end}`);
  void def;
  return parts.join(' · ');
}

function drawWorld(cv: HTMLCanvasElement): void {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ps = deck.world.places;
  const xs = ps.map((p) => p.at[0]);
  const ys = ps.map((p) => p.at[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const P = (a: [number, number]): [number, number] => [56 + ((a[0] - x0) / Math.max(1, x1 - x0)) * (W - 112), 22 + ((a[1] - y0) / Math.max(1, y1 - y0)) * (H - 70)];
  const colour: Record<string, string> = { 'f-you': '#f2c14e', 'f-empire': '#c05a5a', 'f-host': '#7a4cc0' };
  const hits: { id: string; x: number; y: number }[] = [];
  cv.onclick = (e) => {
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const best = hits.map((h) => ({ h, d: Math.hypot(h.x - mx, h.y - my) })).sort((a, b) => a.d - b.d)[0];
    focus = best && best.d < 40 ? (focus === best.h.id ? null : best.h.id) : null;
    render();
  };
  // refugees: arrows for every migration so far
  for (const e of run.world.history().filter((x) => x.kind === 'migrate')) {
    const a = P(run.place(String(e.detail!.from)).at);
    const b = P(run.place(String(e.detail!.to)).at);
    ctx.strokeStyle = 'rgba(160,210,255,0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.stroke();
    ctx.setLineDash([]);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    ctx.fillStyle = 'rgba(160,210,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(b[0] - Math.cos(ang) * 14, b[1] - Math.sin(ang) * 14);
    ctx.lineTo(b[0] - Math.cos(ang) * 24 + Math.sin(ang) * 6, b[1] - Math.sin(ang) * 24 - Math.cos(ang) * 6);
    ctx.lineTo(b[0] - Math.cos(ang) * 24 - Math.sin(ang) * 6, b[1] - Math.sin(ang) * 24 + Math.cos(ang) * 6);
    ctx.fill();
  }
  ctx.textAlign = 'center';
  for (const p of ps) {
    const [x, y] = P(p.at);
    const st = run.world.region(p.region);
    // the region: flooded, dark, the dead, burned
    if (st.flooded !== null) (ctx.fillStyle = 'rgba(60,120,220,0.35)'), ctx.beginPath(), ctx.arc(x, y, 26, 0, 7), ctx.fill();
    if (st.shadow > 0.05) (ctx.fillStyle = `rgba(0,0,0,${0.3 + st.shadow * 0.5})`), ctx.beginPath(), ctx.arc(x, y, 24, 0, 7), ctx.fill();
    if (st.undead > 0.05) (ctx.strokeStyle = 'rgba(180,120,255,0.8)'), (ctx.lineWidth = 2), ctx.beginPath(), ctx.arc(x, y, 22, 0, 7), ctx.stroke();
    const s = run.world.settlements.find((q) => q.id === p.id);
    ctx.fillStyle = s ? (colour[s.faction ?? ''] ?? '#9a9a9a') : '#5c6370';
    ctx.beginPath();
    ctx.arc(x, y, s ? 13 : 8, 0, 7);
    ctx.fill();
    if (run.at === p.id) (ctx.strokeStyle = '#ffffff'), (ctx.lineWidth = 3), ctx.beginPath(), ctx.arc(x, y, 17, 0, 7), ctx.stroke();
    const mark = s ? ({ thriving: '', struggling: '~', besieged: '⚔', abandoned: '⛺', ruined: '🔥' } as Record<string, string>)[s.condition] : '';
    ctx.font = '600 13px system-ui';
    ctx.fillStyle = '#111';
    ctx.textBaseline = 'middle';
    if (mark) ctx.fillText(mark, x, y + 1);
    ctx.fillStyle = '#ece6d8';
    ctx.textBaseline = 'top';
    ctx.font = '12px system-ui';
    const people = s ? s.people.reduce((n, q) => n + q.count, 0) : 0;
    const refugees = s ? (s.people.find((q) => q.role === 'refugee')?.count ?? 0) : 0;
    // (labels kept inside the canvas)
    const label = (t: string, dy: number) => {
      const w = ctx.measureText(t).width;
      ctx.fillText(t, Math.max(w / 2 + 4, Math.min(W - w / 2 - 4, x)), y + dy);
    };
    label(s ? `${s.name} (${people}${refugees ? `, ${refugees} fled here` : ''})` : p.name, 16);
    const built = run.holdings.buildings.filter((b) => b.place === p.id);
    if (built.length) (ctx.fillStyle = '#b48cf0'), label(built.map((b) => `▣ ${b.name}`).join(' '), 30);
    // (round 124: a timer over each place with something on offer — the shortest — and how many; tap to read them)
    const here = run.offered.filter((o) => run.card(o.template).place === p.id);
    const busy = run.running().filter(({ c }) => run.card(c.opp.template).place === p.id);
    if (here.length || busy.length) {
      const left = here.length ? Math.min(...here.map((o) => o.expires.turn - run.turn)) + 1 : 0;
      const ev = here.some((o) => o.onExpire);
      const t = `${here.length ? `⏱${left} ${here.length > 1 ? `×${here.length}` : ''}` : ''}${busy.length ? ` ⏳${Math.min(...busy.map((b) => b.turnsLeft))}` : ''}`.trim();
      ctx.font = '600 11px system-ui';
      const w = ctx.measureText(t).width + 8;
      const bx = Math.max(w / 2 + 2, Math.min(W - w / 2 - 2, x));
      ctx.fillStyle = focus === p.id ? 'rgba(255,255,255,0.95)' : 'rgba(14,10,6,0.9)';
      ctx.fillRect(bx - w / 2, y - 34, w, 16);
      ctx.fillStyle = focus === p.id ? '#111' : ev ? '#ff8a5a' : '#ffd35a';
      ctx.textBaseline = 'middle';
      ctx.fillText(t, bx, y - 26);
      ctx.textBaseline = 'top';
    }
    hits.push({ id: p.id, x, y });
  }
}

function render(): void {
  app.innerHTML = '';
  app.append(el('h1', {}, 'Card lab — the opportunity loop as a deck builder (no encounters, no rolls)'));
  const T = OPP_TUNING.values.lab;
  const st = run.end ? (run.end === 'won' ? '✔ WON' : '✘ LOST') : `turn ${run.turn}`;
  app.append(el('div', { class: 'status' }, `${st} · doom ${run.doom} of ${T.climaxAt} (the climax) · you are at ${run.place(run.at).name} · seed ${seed}`));
  const bar = el('div', { class: 'doom' }, el('div', { style: `width:${Math.min(100, (run.doom / T.climaxAt) * 100)}%` }));
  app.append(bar);
  const seedIn = el('input', { type: 'number', value: String(seed), style: 'width:80px' }) as HTMLInputElement;
  app.append(
    el('div', { class: 'bar' },
      btn('Next turn ▶', () => run.nextTurn(), 'main', !!run.end),
      btn('New run', () => (run = new DeckRun(deck, seed))),
      el('span', {}, 'seed'), seedIn,
      btn('Use seed', () => ((seed = Number(seedIn.value) || 1), (run = new DeckRun(deck, seed)))),
      btn('New kingdom', () => {
        kseed++;
        makeKingdom();
        run = new DeckRun(deck, seed);
      }),
      btn(showEv ? 'EV ▲' : 'EV', () => (showEv = !showEv)),
    ),
  );
  app.append(el('div', { class: 'status' }, `Kingdom ${kseed}: ${kingdom.stacks.map((s) => `${s.id} ×${s.cards.length}`).join(' · ')}`));
  const cv = el('canvas', { id: 'world' }) as HTMLCanvasElement;
  app.append(el('h2', {}, 'The world'), cv, el('div', { class: 'status' }, 'gold: yours · red: the Empire · violet: the Host · ⚔ besieged · 🔥 burned · ⛺ abandoned · ~ struggling · blue: flooded · ring: the dead · arrows: refugees · ▣ built · white ring: you'));
  requestAnimationFrame(() => drawWorld(cv));
  if (focus) {
    const here = run.offered.filter((o) => run.card(o.template).place === focus);
    const box = el('div', { class: 'board' });
    for (const o of here) box.append(cardOf(o));
    const pl = run.place(focus);
    app.append(el('h2', {}, `At ${pl.settlement?.name ?? pl.name}: ${here.length ? `${here.length} on offer` : 'nothing on offer'} (tap the place again to close)`), box);
  }
  // the board
  const board = el('div', { class: 'board' });
  for (const o of [...run.offered].sort((a, b) => Number(b.affordable) - Number(a.affordable))) board.append(cardOf(o));
  if (!run.offered.length) board.append(el('div', { class: 'k' }, 'nothing on the board'));
  app.append(section('board', `The board: ${run.offered.filter((o) => o.affordable).length} you can take, ${run.offered.length} on it`, board));
  // holdings
  const hold = el('div', { class: 'list' });
  for (const a of run.holdings.agents) {
    const d = el('div', {}, `${a.kind === 'player' ? '★' : '•'} ${a.name} (${a.kind}${a.count > 1 ? ` ${a.count}` : ''})${a.committed ? ' — committed' : ''} `);
    for (const t of a.tags) d.append(el('span', { class: 'pill' }, t));
    for (const b of run.owned({ agent: a.id })) d.append(el('span', { class: 'pill relic', title: relicLine(b) }, `✦ ${b.why}`));
    hold.append(d);
  }
  hold.append(el('div', {}, `Goods: ${goods(run.holdings.goods) || 'none'}`));
  for (const b of run.holdings.buildings) {
    const d = el('div', {}, `▣ ${b.name} at ${run.place(b.place).settlement?.name ?? run.place(b.place).name} `);
    for (const x of run.owned({ building: b.id })) d.append(el('span', { class: 'pill relic', title: relicLine(x) }, `✦ ${x.why}`));
    hold.append(d);
  }
  app.append(section('holdings', 'Holdings (✦: effects — tap or hover for what they do)', hold));
  const runL = el('div', { class: 'list' });
  for (const { c, turnsLeft } of run.running()) runL.append(el('div', {}, `⏳ ${c.opp.title}: ${turnsLeft ? `${turnsLeft} turn${turnsLeft > 1 ? 's' : ''} left` : 'done this turn'} (${c.agents.map((id) => run.holdings.agents.find((a) => a.id === id)?.name ?? id).join(', ') || 'goods'})`));
  if (!run.running().length) runL.append(el('div', { class: 'k' }, 'nothing committed'));
  app.append(section('running', `Committed: ${run.running().length}`, runL));
  app.append(section('log', 'Log', el('pre', {}, run.log.slice(-40).reverse().map((l) => `${l.turn}: ${l.text}`).join('\n'))));
  app.append(section('worldlog', `World log: ${run.world.history().length} changes`, el('pre', {}, run.worldLog.slice().reverse().map((l) => `${l.turn}: ${l.text}\n   ${(l.world ?? []).join('\n   ')}`).join('\n'))));
  app.append(section('why', "The dealer's why (what was dealt and why, what wasn't and why)", el('pre', {}, run.report ? reportLines(run.report).join('\n') : '')));
  app.append(section('tune', 'Tuning (every weight, limit and number; kept in this browser)', sliders()));
  app.append(section('deck', 'The card library: the world and its stacks (JSON: edit, Apply; kept in this browser)', editor()));
  app.append(section('sim', 'The simulator (auto-play N runs)', simulator()));
}

function sliders(): HTMLElement {
  const box = el('div');
  for (const d of OPP_TUNING.defs) {
    if (d.group !== 'dealer' && d.group !== 'lab') continue;
    const v = OPP_TUNING.get(d.id);
    const num = el('span', {}, String(v));
    const r = el('input', { type: 'range', min: String(d.min), max: String(d.max), step: String(d.step), value: String(v), title: d.help ?? '' }) as HTMLInputElement;
    r.oninput = () => {
      OPP_TUNING.set(d.id, Number(r.value));
      num.textContent = r.value;
    };
    r.onchange = () => {
      try {
        localStorage.setItem(TUNE_STORE, JSON.stringify(OPP_TUNING.changed()));
      } catch {
        /* (kept for this page only) */
      }
      run.deal();
      render();
    };
    box.append(el('div', { class: 'slider', title: d.help ?? '' }, `${d.group}: ${d.label} (${d.units})`, r, num));
  }
  box.append(btn('Defaults', () => (OPP_TUNING.reset(), localStorage.removeItem(TUNE_STORE), (run = new DeckRun(deck, seed)))));
  return box;
}

function editor(): HTMLElement {
  const box = el('div');
  const ta = el('textarea') as HTMLTextAreaElement;
  ta.value = JSON.stringify(lib, null, 2);
  const msg = el('div', { class: 'status' });
  box.append(
    ta,
    el('div', { class: 'bar' },
      btn('Apply', () => {
        try {
          const l = JSON.parse(ta.value) as LabLibrary;
          const prev = lib;
          lib = l;
          try {
            makeKingdom();
            run = new DeckRun(deck, seed);
          } catch (e) {
            lib = prev;
            makeKingdom();
            throw e;
          }
          localStorage.setItem(STORE, ta.value);
        } catch (e) {
          alert(`Not applied:\n${e instanceof Error ? e.message : String(e)}`);
        }
      }, 'main'),
      btn('Back to the file', () => {
        localStorage.removeItem(STORE);
        lib = structuredClone(LAB) as unknown as LabLibrary;
        makeKingdom();
        run = new DeckRun(deck, seed);
      }),
      btn('Copy', () => void navigator.clipboard?.writeText(ta.value)),
    ),
    msg,
  );
  return box;
}

function simulator(): HTMLElement {
  const box = el('div');
  // (round 124, RN3-3) every bot on N kingdoms: win rate and score; viable = winning at least half as often as the best
  // and scoring within 80 % of the best of those
  const nk = el('input', { type: 'number', value: '8', style: 'width:60px' }) as HTMLInputElement;
  box.append(el('div', { class: 'bar' }, el('span', {}, 'kingdoms'), nk, btn('Bots × kingdoms', () => (tour = tournament((k) => generateKingdom(lib, k, OPP_TUNING.values.lab.kingdom).deck, { kingdoms: Array.from({ length: Math.max(1, Math.min(40, Number(nk.value) || 8)) }, (_, i) => kseed + i) })), 'main')));
  if (tour) {
    const t = el('table');
    t.append(el('tr', {}, el('th', {}, 'kingdom'), ...POLICIES.map((p) => el('th', {}, p)), el('th', {}, 'viable')));
    for (const r of tour) t.append(el('tr', {}, el('td', {}, String(r.kingdom)), ...POLICIES.map((p) => {
      const x = r.results.find((y) => y.policy === p)!;
      return el('td', { style: r.viable.includes(p) ? 'color:#8fd16a;font-weight:600' : '' }, `${Math.round(x.winRate * 100)}% · ${x.meanScore}`);
    }), el('td', {}, r.viable.join(', ') || '—')));
    box.append(t);
    const two = tour.filter((r) => r.viable.length >= 2).length;
    const best = POLICIES.map((p) => ({ p, n: tour!.filter((r) => r.viable.includes(p)).length }));
    box.append(el('div', { class: 'status' }, `${two} of ${tour.length} kingdoms with two or more viable strategies · viable in: ${best.map((b) => `${b.p} ${b.n}`).join(', ')}`));
  }
  const n = el('input', { type: 'number', value: '200', style: 'width:80px' }) as HTMLInputElement;
  const pol = el('select') as HTMLSelectElement;
  for (const p of POLICIES) pol.append(el('option', { value: p }, p));
  box.append(el('div', { class: 'bar' }, el('span', {}, 'runs'), n, el('span', {}, 'policy'), pol, btn('Run', () => (sim = simulate(deck, { runs: Math.max(1, Math.min(5000, Number(n.value) || 100)), seed, policy: pol.value as Policy })), 'main')));
  if (sim) {
    const s = sim;
    box.append(el('div', { class: 'status' }, `${s.runs} runs (${s.policy}, ${s.ms} ms): won ${Math.round(s.winRate * 100)}% · score ${s.meanScore} · ${s.meanTurns} turns a run · ${s.meanChoices} cards you could take a turn · world: ${s.world.meanEvents} changes, ${s.world.meanSettlements} settlements changed a run`));
    box.append(el('div', { class: 'status' }, `never taken: ${s.never.join(', ') || '—'} · always taken: ${s.always.join(', ') || '—'}`));
    const t = el('table');
    t.append(el('tr', {}, el('th', {}, 'card'), el('th', {}, 'dealt'), el('th', {}, 'taken'), el('th', {}, 'rate'), el('th', {}, 'won when taken')));
    for (const c of s.cards) t.append(el('tr', {}, el('td', {}, c.title), el('td', {}, String(c.dealt)), el('td', {}, String(c.taken)), el('td', {}, String(c.rate)), el('td', {}, c.winTaken === null ? '—' : String(c.winTaken))));
    box.append(t);
    const r = el('table');
    r.append(el('tr', {}, el('th', {}, 'effect'), el('th', {}, 'fires a run'), el('th', {}, 'won when it fired'), el('th', {}, 'won when not')));
    for (const x of s.relics) r.append(el('tr', {}, el('td', {}, x.why), el('td', {}, String(x.firesPerRun)), el('td', {}, x.winFired === null ? '—' : String(x.winFired)), el('td', {}, x.winNot === null ? '—' : String(x.winNot))));
    box.append(el('h2', {}, 'Effects (relics)'), r);
    box.append(el('div', { class: 'status' }, `world changes a run by kind: ${Object.entries(s.world.byKind).map(([k, v]) => `${k} ${v}`).join(' · ')}`));
  }
  return box;
}

try {
  render();
} catch (e) {
  app.append(el('div', { class: 'fatal' }, `The card lab couldn't start: ${e instanceof Error ? e.message : String(e)}`));
  throw e;
}
(window as unknown as { cardlab: unknown }).cardlab = {
  get run() {
    return run;
  },
  get kingdom() {
    return kingdom;
  },
  render,
  simulate: (runs: number, policy: Policy) => (sim = simulate(deck, { runs, seed, policy })),
  tournament: (n: number) => (tour = tournament((k) => generateKingdom(lib, k, OPP_TUNING.values.lab.kingdom).deck, { kingdoms: Array.from({ length: n }, (_, i) => kseed + i) })),
  newKingdom: () => {
    kseed++;
    makeKingdom();
    run = new DeckRun(deck, seed);
  },
  focus: (p: string | null) => (focus = p),
  ev: (on: boolean) => (showEv = on),
};
