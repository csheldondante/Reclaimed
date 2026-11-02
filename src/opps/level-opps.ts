// ---- opps/level-opps.ts -------------------------------------------------------------------------------------------
// (round 124, `opportunities`; BACKLOG RN2-6) Slice A in the level: `?skipmenu=1&level=atlas&run=opps` (`&hero=lich`
// for the lich). The situation run's live play as runsit plays it (LevelSit: the areas, the legs on the map while the
// land loads, the finale, the end card, the world remembering), with the opportunity loop in place of the ways-on list:
// at an area's edge the atlas map opens with what's offered drawn where it is — gold pins the hero rides to, blue
// diamonds for the agents (the levy), ongoing commitments with their turns left — and tapping one shows what it needs,
// what it costs, how long it takes, its odds and its consequences, then Commit. There is no hand on the screen.
// The user (round 120): "Even if we use cards behind the scenes the game should show them as events or opportunities
// on the map not as a hand." "I think we will need to tune the dealer and learn what is fun for play via iteration":
// the `dealer` panel (every weight and limit, live: the turn is dealt again as a slider moves) and the "why" list (what
// was dealt and why, what wasn't and why).

import type { Situation } from '../api/contracts/situation';
import type { RunRecord } from '../api/contracts/run';
import type { MemoryWorldState } from '../api/contracts/world-state';
import { ENCOUNTER, meet, needsPlayer, TIERS, type Opportunity } from '../api/contracts/opportunity';
import { library } from '../play/library';
import { HERO_NAMES } from '../runplan/consequences';
import type { PlayHeroId } from '../play/heroes/make';
import { LevelSit, type LevelSitDeps } from '../runsit/level-sit';
import { situationMap } from '../runsit/fill';
import { PLAY_TITLE, along, type AreaResult, type SituationRun, type V2 } from '../runsit/state';
import type { SituationEnd } from '../api/contracts/situation';
import { ROW_H } from '../world/lattice';
import { TunePanel } from '../ui/tunepanel';
import { checkLiving } from '../gm/oppcheck';
import { reportLines } from './dealer';
import { finishOpps } from './finish';
import { OppRun } from './run';
import { OPP_TUNING } from './tune';

const toCell = (p: V2): [number, number] => [p[0], p[1] / ROW_H];
const GLYPH: Record<string, string> = { flee: '⇢', ambush: '⚔', deliver: '✉', trader: '⚖', town: '♜', ford: '≈', harvest: '❦', vanguard: '⚔' };
const GOLD = '#f2c14e';
const BLUE = '#5ab0f0';
const LOCKED = '#b48cf0';
const TIER_WORD: Record<string, string> = { triumph: 'triumph', success: 'success', cost: 'at a cost', failure: 'failure', disaster: 'disaster' };
const fmtMin = (m: number) => (m < 1 ? `${Math.round(m * 60)} s` : `${m.toFixed(1)} min`);

export class LevelOpps extends LevelSit {
  /** (declared: set in newRun, which the base's constructor calls before this class's fields would be) */
  declare opps: OppRun;
  declare selected: string | null;
  declare why: boolean;
  declare hits: { x: number; y: number; r: number; id: string }[];
  /** (round 124) the run's start: the hero roster, then the intro, then play; the situation panel open */
  declare stage: 'roster' | 'intro' | 'play';
  declare sitOpen: boolean;
  readonly panel: TunePanel;
  private offTune: () => void;

  constructor(d: LevelSitDeps) {
    super(d);
    this.panel = new TunePanel(d.ui, { registry: OPP_TUNING, store: 'reclaimed.dealer.presets', urlParam: 'dealer', label: 'dealer', cls: 'dealer', open: ['dealer'] });
    this.offTune = OPP_TUNING.onChange(() => {
      // (a slider moved at an edge: the turn dealt again with the new numbers)
      if (this.run.phase === 'edge' && !this.journey) {
        this.opps.deal();
        this.render();
        if (this.d.map.isOpen) this.d.map.redraw();
      }
    });
    d.map.onTap = (x, y) => this.tap(x, y);
  }

  protected makeRun(sit: Situation, snap: ReturnType<MemoryWorldState['snapshot']>): SituationRun {
    const world = this.world;
    const g = this.graph;
    // (merge124) the run's cards from the living engine over this world (its fact layer, its holdings), checked by the
    // one oppcheck on every deal
    this.opps = new OppRun(sit, situationMap(g, snap), {
      seed: this.d.atlas.p.seed,
      hero: this.d.hero,
      world,
      check: (r, e) => checkLiving(e, r, { region: (id) => !!g.node(id), situation: sit }),
    });
    this.selected = this.opps.offered.find((o) => o.forced)?.id ?? null;
    this.why = false;
    this.stage ??= 'roster';
    this.sitOpen ??= false;
    this.hits = [];
    return this.opps.sr;
  }

  protected areaDone(r: AreaResult): void {
    this.opps.areaDone(r);
    this.log.push(...this.opps.log.splice(0));
    this.selected = null;
  }
  protected finishRun(end: SituationEnd, seconds: number): void {
    this.opps.finish(end, seconds);
    this.log.push(...this.opps.log.splice(0));
  }
  protected arrived(): void {
    this.opps.arrive();
    this.log.push(...this.opps.log.splice(0));
  }
  protected finishRecord(): RunRecord {
    return finishOpps(this.world, this.opps, this.d.hero);
  }

  /** commit an opportunity (the player's: travel there or play it here; an agent's: locked, rolled) */
  commit(id: string): void {
    const o = this.opps.opp(id);
    if (!o.affordable) return;
    if (needsPlayer(o)) {
      const from = this.run.area();
      const { travel } = this.opps.play(id);
      this.log.push(...this.opps.log.splice(0));
      this.selected = null;
      if (travel) this.travel(from, this.run.leg!);
      else {
        this.d.map.close();
        void this.playArea();
      }
      return;
    }
    this.opps.commitResources(id);
    this.log.push(...this.opps.log.splice(0));
    this.selected = null;
    this.render();
    this.d.map.redraw();
  }

  /** (a check's: commit the offered opportunity of this template) */
  commitTemplate(template: string): boolean {
    const o = this.opps.offered.find((x) => x.template === template && x.affordable);
    if (!o) return false;
    this.commit(o.id);
    return true;
  }

  /**
   * (a check's switch: scripts/opps.mjs --ff) Play these ways on (situation choice ids) without the areas between, each
   * counted at its planned minutes and won, the first offer taken; then warp to where they lead.
   */
  async fastForward(choices: string[]): Promise<void> {
    for (const id of choices) {
      const a = this.run.area();
      if (!this.opps.playing) {
        const f = this.opps.offered.find((o) => o.forced);
        if (f) this.opps.play(f.id);
      }
      this.opps.areaDone({ seconds: a.minutes * 60, won: true, pursuers: this.run.pursuers?.count ?? 0 });
      if (this.run.offers.length) this.run.take(this.run.offers[0]);
      this.cameFrom = this.run.map.areaAt(a);
      const o = this.opps.offered.find((x) => x.offer === id);
      if (!o) throw new Error(`fastForward: ${id} isn't offered (${this.opps.offered.map((x) => x.offer).join(', ')})`);
      this.opps.play(o.id);
      this.opps.arrive();
    }
    this.log.push(...this.opps.log.splice(0));
    this.warping = true;
    await this.d.warp(...toCell(this.run.map.areaAt(this.run.area())));
    this.warping = false;
    this.render();
  }

  /** (a check's: play the area the hero is at to its edge at once, won — to see the next deal without riding it) */
  skipArea(won = true): void {
    if (this.playing || this.run.phase !== 'area') return;
    const a = this.run.area();
    if (!this.opps.playing) {
      const f = this.opps.offered.find((o) => o.forced);
      if (f) this.opps.play(f.id);
    }
    this.areaDone({ seconds: a.minutes * 60, won, pursuers: 0 });
    this.render();
  }

  private tap(x: number, y: number): boolean {
    let best: { id: string; d: number } | null = null;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= h.r && (!best || d < best.d)) best = { id: h.id, d };
    }
    if (!best) return false;
    this.selected = best.id;
    this.render();
    return true;
  }

  /** the map open on what's offered: the player and every marker in view */
  private fitMap(): void {
    const M = this.d.map;
    if (!M.isOpen) M.open();
    const here = this.opps.at();
    const W = this.run.map.world;
    const run = this.run;
    const pts: V2[] = [here, ...this.opps.offered.map((o) => o.location.at as V2), ...this.opps.running().map(({ c }) => c.opp.location.at as V2), along(run.sit.threat.route.map((r) => run.map.regionCentre(r)), run.hordeProgress(), W)];
    // (the box round them, each the short way round the torus from the player)
    let [x0, y0, x1, y1] = [0, 0, 0, 0];
    for (const p of pts) {
      const dx = p[0] - here[0] - Math.round((p[0] - here[0]) / W.w) * W.w;
      const dy = p[1] - here[1] - Math.round((p[1] - here[1]) / W.h) * W.h;
      x0 = Math.min(x0, dx);
      x1 = Math.max(x1, dx);
      y0 = Math.min(y0, dy);
      y1 = Math.max(y1, dy);
    }
    // (the card takes the bottom of the screen: the box fits the top 55 %, with room for the labels)
    const availW = innerWidth - 60;
    const availH = innerHeight * 0.55 - 70;
    const upp = Math.max((x1 - x0 + 200) / availW, (y1 - y0 + 200) / availH, 1.2);
    const scale = (upp * this.d.atlas.p.n) / this.d.atlas.worldW;
    const cx = here[0] + (x0 + x1) / 2;
    const cy = here[1] + (y0 + y1) / 2 + innerHeight * 0.22 * upp;
    M.centreOn(...toCell([cx, cy]), scale);
    M.redraw();
  }

  /** (round 124) the roster's choice: the hero played, and the run made again for it */
  pickHero(id: string): void {
    const S = this.d.session;
    const p = S.hero?.position();
    this.d.hero = id;
    S.choose(id as PlayHeroId, p ? S.dryNear([p[0], p[1]]) : undefined);
    this.stage = 'intro';
    this.newRun(this.wiki.spawn.region, this.wiki.spawn.at as V2);
  }

  /** the modes a hero plays, from its profile (the user: "an indicator of what game modes") */
  static modes(id: string): { icon: string; name: string; on: boolean }[] {
    const c = library.get(id);
    const e = c?.profile().encounters;
    return [
      { icon: '🏁', name: 'ride and race', on: (e?.race ?? 0) >= 0.5 },
      { icon: '⇢', name: 'chase and flee', on: (e?.chase ?? 0) >= 0.5 },
      { icon: '⚔', name: 'combat', on: (e?.fight ?? 0) >= 0.5 },
      { icon: '💀', name: 'raise and command', on: !!c?.params.some((x) => x.id === 'raiseReach') },
      { icon: '🧱', name: 'build', on: false },
    ];
  }

  private renderRoster(h: (tag: string, text: string, css?: string) => HTMLElement, btn: (text: string, f: () => void, main?: boolean, css?: string) => HTMLButtonElement, muted: string): void {
    h('div', 'Choose your hero', 'font:600 16px Georgia,serif;color:#ffd9a0');
    h('div', 'Each plays the run its own way: the modes it is good at, what it can cross, what it carries from earlier runs.', muted);
    for (const c of library.controllers()) {
      const p = c.profile();
      const rec = this.world.character(c.id);
      const box = document.createElement('div');
      box.style.cssText = 'border:1px solid #5a4a30;border-radius:9px;padding:6px 8px;margin:6px 0;background:rgba(40,32,20,0.6)';
      this.card.appendChild(box);
      const line = (t: string, css = '') => {
        const e = document.createElement('div');
        e.textContent = t;
        e.style.cssText = css;
        box.appendChild(e);
      };
      line(`${c.icon} ${c.name}${rec ? ` — ${rec.name}${rec.alive ? '' : ' ✝'}` : ` — ${HERO_NAMES[c.id] ?? c.id}`}`, 'font:600 14px Georgia,serif');
      line(c.line, 'font-size:12px');
      line(`speed ${p.speed.cruise.toFixed(0)}/${p.speed.top.toFixed(0)} cells/s · jump ${p.jump.height ? `${p.jump.height.toFixed(1)} high, ${p.jump.gap.toFixed(0)} across` : 'none'} · ${p.fly.ceiling ? `flies ${p.fly.ceiling.toFixed(0)} up` : 'on the ground'} · breaks ${Math.round(p.destruction * 100)}%`, muted);
      const tags = [...(rec?.tags ?? []), ...(rec?.bonuses ?? []).map((b) => `✦ ${b.why}`), ...(rec?.statuses ?? [])];
      line(`tags: ${tags.length ? tags.join(' · ') : 'none yet'}${rec?.history.length ? ` · ${rec.history.length} deeds` : ''}`, muted);
      line(`modes: ${LevelOpps.modes(c.id).map((m) => `${m.on ? m.icon : '·'} ${m.on ? m.name : `(${m.name})`}`).join('  ')}`, 'font-size:12px');
      const b = btn(`Play ${c.name}`, () => this.pickHero(c.id), c.id === this.d.hero);
      box.appendChild(b);
    }
  }

  private renderIntro(h: (tag: string, text: string, css?: string) => HTMLElement, btn: (text: string, f: () => void, main?: boolean, css?: string) => HTMLButtonElement, muted: string): void {
    const run = this.run;
    const sit = run.sit;
    const th = sit.threat;
    const fac = this.world.faction(th.faction)?.name ?? th.faction;
    h('div', sit.title, 'font:600 16px Georgia,serif;color:#ffd9a0');
    h('div', `What is happening: ${th.count} ${th.role} of ${th.name} (${fac}) march over ${th.route.length} regions for ${sit.target.name}.${th.outriders ? ` ${th.outriders.count} outriders ride ahead of them — and they have seen you.` : ''}`, 'margin-top:4px;font-size:13px');
    h('div', `How bad: if they reach ${sit.target.name} and nothing stops them, it burns (${sit.endings.burned.text})`, 'margin-top:4px;font-size:13px');
    h('div', `What you are trying to do: ${sit.premise}`, 'margin-top:4px;font-size:13px');
    h('div', `The clock: they reach ${sit.target.name} at minute ${run.hordeArrives().toFixed(1)}${this.opps.clockWas !== sit.threat.arrives ? ` (the GM's clock was ${this.opps.clockWas})` : ''}. Every ride and every fight spends it.`, 'margin-top:4px;font-size:13px');
    h('div', `You play ${library.get(this.d.hero)?.icon ?? ''} ${library.get(this.d.hero)?.name ?? this.d.hero}. ${this.by === 'gm' ? 'Written by the GM for this world.' : 'The template, filled from this world.'}`, muted);
    btn('▶ Begin', () => {
      this.stage = 'play';
      this.render();
    }, true);
    btn('Another hero', () => {
      this.stage = 'roster';
      this.render();
    });
  }

  /** the compact situation, reachable all run */
  private renderSituation(h: (tag: string, text: string, css?: string) => HTMLElement, muted: string): void {
    const run = this.run;
    const sit = run.sit;
    const left = run.hordeArrives() - run.clock;
    h('div', [
      `${sit.title}`,
      `${sit.threat.name}: ${Math.max(1, sit.threat.count - run.thinned)} ${sit.threat.role}, at ${sit.target.name} ${left > 0 ? `in ${left.toFixed(1)} min` : `${(-left).toFixed(1)} min ago`}`,
      `aim: ${sit.premise}`,
      `you: ${library.get(this.d.hero)?.name ?? this.d.hero} · modes ${LevelOpps.modes(this.d.hero).filter((m) => m.on).map((m) => m.icon).join(' ')}`,
      this.opps.intel ? `the lookout's word: the ford's odds +${Math.round(this.opps.intel * 100)}%` : '',
      this.opps.rallied ? `${this.opps.rallied} freed stand with ${sit.target.name}` : '',
    ].filter(Boolean).join('\n'), `${muted};white-space:pre-line;margin-top:4px;border-left:3px solid #6b5b3e;padding-left:6px`);
  }

  protected render(): void {
    const run = this.run;
    if (this.opps && (this.stage === 'roster' || this.stage === 'intro')) return this.renderStart();
    if (this.panel) this.panel.button.style.visibility = '';
    if (!this.opps || this.record || this.journey || this.playing || (run.phase === 'area' && this.opps.playing) || (run.phase === 'edge' && run.offers.length)) {
      super.render();
      return;
    }
    const C = this.card;
    C.innerHTML = '';
    C.style.display = '';
    C.style.top = 'auto';
    C.style.bottom = '8px';
    C.style.maxHeight = '46vh';
    const h = (tag: string, text: string, css = '') => {
      const e = document.createElement(tag);
      e.textContent = text;
      e.style.cssText = css;
      C.appendChild(e);
      return e;
    };
    const btn = (text: string, f: () => void, main = false, css = '') => {
      const b = document.createElement('button');
      b.style.cssText = `display:inline-block;min-height:44px;margin:4px 6px 0 0;padding:6px 12px;border-radius:7px;border:1px solid #6b5b3e;background:${main ? '#5a3f12' : '#2a241a'};color:#f3e8cf;font:600 ${main ? 15 : 13}px system-ui,sans-serif;${css}`;
      b.textContent = text;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.onclick = (e) => {
        e.stopPropagation();
        f();
      };
      C.appendChild(b);
      return b;
    };
    const muted = 'color:#a99c80;font-size:12px';
    const o = this.selected ? this.opps.offered.find((x) => x.id === this.selected) : undefined;
    this.status(h, muted);
    if (this.sitOpen) this.renderSituation(h, muted);
    if (o) this.detail(o, h, btn, muted);
    else {
      h('div', 'Tap an opportunity on the map: gold you ride to, blue for your agents.', 'margin-top:6px;font-size:13px');
      const n = this.opps.offered.length;
      h('div', n === 1 ? 'One makes sense this turn.' : `${n} on offer this turn.`, muted);
    }
    btn(this.d.map.isOpen ? '🗺 Hide the map' : '🗺 The map', () => {
      if (this.d.map.isOpen) this.d.map.close();
      else this.fitMap();
      this.render();
    });
    btn(this.sitOpen ? '☰ ▲' : '☰ the situation', () => {
      this.sitOpen = !this.sitOpen;
      this.render();
    });
    btn(this.why ? 'why ▲' : 'why? (the dealer)', () => {
      this.why = !this.why;
      this.render();
    });
    if (this.why && this.opps.report) {
      const pre = h('pre', reportLines(this.opps.report).join('\n'), 'white-space:pre-wrap;font:11px/1.35 ui-monospace,monospace;color:#d8ccb0;background:rgba(0,0,0,0.35);padding:6px;border-radius:6px;margin:6px 0 0;max-height:30vh;overflow:auto');
      pre.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    if (!this.d.map.isOpen) this.fitMap();
    else this.d.map.redraw();
  }

  /** the line of what's going on and what's held */
  private status(h: (tag: string, text: string, css?: string) => HTMLElement, muted: string): void {
    const run = this.run;
    const sit = run.sit;
    const left = run.hordeArrives() - run.clock;
    const held = this.opps.holdings.agents.filter((a) => a.kind !== 'player').map((a) => `${a.name} (${a.count}${a.tags.length ? `, ${a.tags.join(', ')}` : ''}${a.committed ? ', committed' : ''})`);
    const goods = Object.entries(this.opps.holdings.goods).filter(([, n]) => n > 0).map(([g, n]) => `${n} ${g}`);
    const lines = [
      `turn ${this.opps.turn} · ⏱ minute ${run.clock.toFixed(1)} · ☠ ${sit.threat.name} at ${sit.target.name} ${left > 0 ? `in ${left.toFixed(1)} min` : `${(-left).toFixed(1)} min ago`}`,
      held.length || goods.length ? `you hold: ${[...held, ...goods].join(' · ')}` : 'you hold: only yourself',
      ...this.opps.running().map(({ c, turnsLeft }) => `⏳ ${c.opp.title}: ${turnsLeft ? `${turnsLeft} turn${turnsLeft > 1 ? 's' : ''} left` : 'resolves now'}`),
      ...this.opps.resolutions.filter((r) => r.turn === this.opps.turn && !this.opps.commitments.find((c) => c.id === r.commitment)?.opp.challenge).map((r) => `✔ ${r.outcome.text}`),
      ...this.opps.expired.filter((e) => e.opp.expires.turn === this.opps.turn - 1).map((e) => `✘ ${e.text}`),
      run.warned ? (run.evacuate ? '☞ the town warned: its people to be led out' : '⚑ the town warned') : '',
    ].filter(Boolean);
    h('div', lines.join('\n'), `${muted};white-space:pre-line;margin-top:4px`);
  }

  /** an opportunity, tapped: what it needs, costs, takes, its odds and consequences, Commit */
  private detail(o: Opportunity, h: (tag: string, text: string, css?: string) => HTMLElement, btn: (text: string, f: () => void, main?: boolean, css?: string) => HTMLButtonElement, muted: string): void {
    const player = needsPlayer(o);
    const col = !o.affordable ? '#9a9a9a' : player ? GOLD : BLUE;
    h('div', `${GLYPH[o.challenge?.play ?? o.template] ?? '◆'} ${o.title}`, `margin-top:6px;font:600 14px Georgia,serif;color:${col}`);
    h('div', `${o.location.name}${o.forced ? ' · forced: it must be played now' : ''}${o.climax ? ' · the climax' : ''}`, muted);
    h('div', o.pitch, 'margin:2px 0;font-size:12px');
    const m = meet(o.requires, this.opps.holdings);
    const who = m.ok ? m.agents.map((id) => this.opps.holdings.agents.find((a) => a.id === id)!).map((a) => (a.kind === 'player' ? 'you' : `${a.name} (${a.count})`)).join(', ') : '';
    const need = o.requires.map((r) => `${r.count} ${r.kind}${r.tags?.length ? ` (${r.tags.join(', ')})` : ''}`).join(', ');
    const cost = Object.entries(o.costs).filter(([, n]) => n > 0).map(([g, n]) => `${n} ${g} (${this.opps.holdings.goods[g] ?? 0} held)`).join(', ') || 'nothing';
    const dur = 'minutes' in o.duration ? `about ${fmtMin(o.duration.minutes)}: the ride and ${PLAY_TITLE[o.challenge!.play as keyof typeof PLAY_TITLE]?.toLowerCase() ?? o.challenge!.play}` : `${o.duration.turns} turn${o.duration.turns === 1 ? '' : 's'}`;
    const e = o.challenge?.encounter;
    if (e) h('div', `${ENCOUNTER[e.kind].icon} ${ENCOUNTER[e.kind].name}: ${e.text}`, 'margin-top:2px;font:600 12.5px system-ui,sans-serif;color:#ffb38a');
    h('div', `⏱ ${this.timer(o)}`, 'font-size:12px;color:#ffd35a');
    const rows = [
      `Needs: ${need}${who ? ` — ${who}` : ''}${o.tiers > 1 ? ` · tier ${o.tier} of ${o.tiers}` : ''}`,
      `Costs: ${cost}`,
      `Takes: ${dur}`,
      o.odds ? `Odds: ${TIERS.filter((t) => (o.odds![t] ?? 0) > 0).map((t) => `${TIER_WORD[t]} ${Math.round(o.odds![t]! * 100)}%`).join(' · ')}` : 'Odds: how you play it',
    ];
    if (!o.affordable) rows.push(`Missing: ${o.missing.join('; ')}`);
    h('div', rows.join('\n'), 'white-space:pre-line;font-size:12px;margin-top:2px');
    const cons = TIERS.filter((t) => o.outcomes[t] && (!o.odds || (o.odds[t] ?? 0) > 0)).map((t) => {
      const oc = o.outcomes[t]!;
      return `${TIER_WORD[t]}: ${oc.text}${oc.losses ? ` (${Math.round(oc.losses * 100)}% lost)` : ''}`;
    });
    if (o.onExpire) cons.push(`if let go: ${o.onExpire.text}`);
    h('div', cons.join('\n'), `${muted};white-space:pre-line;margin-top:2px`);
    // (merge124: the living engine's card — who presents it, and what the player gets besides the world change)
    const card = this.opps.engine.offers.find((x) => x.id === o.id);
    if (card) h('div', `✦ You get: ${card.reward}`, 'font-size:12px;margin-top:2px;color:#9fe0a0');
    if (o.affordable) btn(player ? (o.challenge?.area === this.run.at ? '▶ Commit: play it' : '▶ Commit: ride there') : `Commit ${who || 'them'}`, () => this.commit(o.id), true);
    btn('Back', () => {
      this.selected = null;
      this.render();
    });
  }

  /** how long an opportunity stays: this turn, n turns, m minutes of the run's clock */
  timer(o: Opportunity): string {
    const turns = o.expires.turn - this.opps.turn;
    const mins = o.expires.minute !== undefined ? o.expires.minute - this.run.clock : Infinity;
    if (Number.isFinite(mins) && mins < 30) return `${fmtMin(Math.max(0, mins))} left${o.onExpire ? ' — then it happens anyway' : ''}`;
    return turns <= 0 ? `this turn only${o.onExpire ? ' — then it happens anyway' : ''}` : `${turns + 1} turns${o.onExpire ? ' — then it happens anyway' : ''}`;
  }

  /** the roster and the intro, before the first turn */
  private renderStart(): void {
    const C = this.card;
    C.innerHTML = '';
    C.style.display = '';
    C.style.top = '8px';
    C.style.bottom = 'auto';
    C.style.maxHeight = '86vh';
    this.d.map.close();
    const h = (tag: string, text: string, css = '') => {
      const e = document.createElement(tag);
      e.textContent = text;
      e.style.cssText = css;
      C.appendChild(e);
      return e;
    };
    const btn = (text: string, f: () => void, main = false) => {
      const b = document.createElement('button');
      b.style.cssText = `display:inline-block;min-height:44px;margin:6px 6px 0 0;padding:6px 12px;border-radius:7px;border:1px solid #6b5b3e;background:${main ? '#5a3f12' : '#2a241a'};color:#f3e8cf;font:600 14px system-ui,sans-serif`;
      b.textContent = text;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.onclick = (e) => {
        e.stopPropagation();
        f();
      };
      C.appendChild(b);
      return b;
    };
    const muted = 'color:#a99c80;font-size:12px';
    // (the dealer's panel waits for the run: it sat over the roster's first lines)
    if (this.panel) this.panel.button.style.visibility = 'hidden';
    if (this.stage === 'roster') this.renderRoster(h, btn, muted);
    else this.renderIntro(h, btn, muted);
  }

  protected drawOnMap(ctx: CanvasRenderingContext2D, px: (cx: number, cy: number) => [number, number]): void {
    if (!this.opps) return;
    const run = this.run;
    const sit = run.sit;
    const W = run.map.world;
    const P = (p: V2) => px(...toCell(p));
    const hits: { x: number; y: number; r: number; id: string }[] = [];
    // the host's road and where it is now
    const route = sit.threat.route.map((r) => run.map.regionCentre(r));
    ctx.setLineDash([8, 5]);
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(200,40,40,0.85)';
    ctx.beginPath();
    let at = route[0];
    ctx.moveTo(...P(at));
    for (let i = 1; i < route.length; i++) {
      const [dx, dy] = [route[i][0] - at[0] - Math.round((route[i][0] - at[0]) / W.w) * W.w, route[i][1] - at[1] - Math.round((route[i][1] - at[1]) / W.h) * W.h];
      at = [at[0] + dx, at[1] + dy];
      ctx.lineTo(...P(at));
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const extra = this.journey && this.jstate ? this.jstate.t * (run.leg?.minutes ?? 0) : 0;
    const host = along(route, Math.max(0, Math.min(1, (run.clock + extra) / run.hordeArrives())), W);
    this.dot(ctx, P(host), 9, '#c02828', '☠');
    this.dot(ctx, P(run.map.regionCentre(sit.refuge.region)), 6, '#6fcf6f', '⌂');
    const here = P(this.opps.at());
    // ongoing commitments: where they are, with their turns left
    for (const { c, turnsLeft } of this.opps.running()) {
      const p = P(c.opp.location.at as V2);
      this.line(ctx, here, p, LOCKED, 2, [4, 4]);
      this.diamond(ctx, p, 12, LOCKED, '⏳');
      this.label(ctx, p, `${c.opp.title} · ${turnsLeft ? `${turnsLeft} turn${turnsLeft > 1 ? 's' : ''}` : 'now'}`, LOCKED);
    }
    // what's offered (two at one place — warn and lead out, both at the town — fanned round it so each can be tapped)
    const placed = this.opps.offered.map((o) => P(o.location.at as V2));
    const labelDy = placed.map(() => 0);
    const spread = placed.map((p, i) => {
      const same = placed.map((q, j) => j).filter((j) => Math.hypot(placed[j][0] - p[0], placed[j][1] - p[1]) < 24);
      if (same.length < 2) return p;
      labelDy[i] = same.indexOf(i) * 16;
      const k = same.indexOf(i);
      const a = -Math.PI / 2 + (k - (same.length - 1) / 2) * 1.3;
      return [p[0] + Math.cos(a) * 30, p[1] + Math.sin(a) * 30 + 30] as [number, number];
    });
    for (const [i, o] of this.opps.offered.entries()) {
      const p = spread[i];
      const player = needsPlayer(o);
      const col = !o.affordable ? '#8a8a8a' : player ? GOLD : BLUE;
      const sel = o.id === this.selected;
      if (player && o.challenge?.area !== run.at) this.line(ctx, here, p, col, sel ? 4 : 2.5, sel ? [] : [7, 5]);
      else if (!player) this.line(ctx, here, p, col, sel ? 3 : 1.5, [3, 5]);
      const glyph = o.challenge ? ENCOUNTER[o.challenge.encounter.kind].icon : (GLYPH[o.template] ?? '◆');
      if (player) this.dot(ctx, p, sel ? 15 : 13, col, glyph, o.forced ? '#ff5a3a' : o.climax ? '#ffffff' : undefined);
      else this.diamond(ctx, p, sel ? 16 : 14, col, glyph);
      this.label(ctx, [p[0], p[1] + labelDy[i] * 2], o.title.length > 30 && !sel ? `${o.title.slice(0, 28)}…` : o.title, sel ? '#ffffff' : col);
      // (its timer over it: the user — "clear timers")
      this.badge(ctx, [p[0], p[1] - 22], `⏱ ${this.timer(o).split(' — ')[0]}`, o.onExpire ? '#ff8a5a' : '#ffd35a');
      hits.push({ x: p[0], y: p[1], r: 26, id: o.id });
    }
    this.hits = hits;
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  private badge(ctx: CanvasRenderingContext2D, [x, y]: [number, number], text: string, colour: string): void {
    ctx.font = '600 11px system-ui,sans-serif';
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = 'rgba(14,10,6,0.88)';
    ctx.fillRect(x - w / 2, y - 14, w, 15);
    ctx.fillStyle = colour;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - 6);
  }

  private line(ctx: CanvasRenderingContext2D, a: [number, number], b: [number, number], colour: string, width: number, dash: number[]): void {
    ctx.setLineDash(dash);
    ctx.lineWidth = width;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private dot(ctx: CanvasRenderingContext2D, [x, y]: [number, number], r: number, fill: string, glyph: string, ring?: string): void {
    ctx.fillStyle = 'rgba(20,16,10,0.9)';
    ctx.beginPath();
    ctx.arc(x, y, r + 3, 0, Math.PI * 2);
    ctx.fill();
    if (ring) {
      ctx.strokeStyle = ring;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    this.glyph(ctx, x, y, glyph);
  }

  private diamond(ctx: CanvasRenderingContext2D, [x, y]: [number, number], r: number, fill: string, glyph: string): void {
    const path = (k: number) => {
      ctx.beginPath();
      ctx.moveTo(x, y - k);
      ctx.lineTo(x + k, y);
      ctx.lineTo(x, y + k);
      ctx.lineTo(x - k, y);
      ctx.closePath();
    };
    ctx.fillStyle = 'rgba(20,16,10,0.9)';
    path(r + 4);
    ctx.fill();
    ctx.fillStyle = fill;
    path(r);
    ctx.fill();
    this.glyph(ctx, x, y, glyph);
  }

  private glyph(ctx: CanvasRenderingContext2D, x: number, y: number, g: string): void {
    ctx.fillStyle = '#1a1206';
    ctx.font = '700 14px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(g, x, y + 1);
  }

  private label(ctx: CanvasRenderingContext2D, [x, y]: [number, number], text: string, colour: string): void {
    ctx.font = '600 12px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(14,10,6,0.9)';
    ctx.strokeText(text, x, y + 19);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y + 19);
  }

  dispose(): void {
    super.dispose();
    this.d.map.onTap = undefined;
    this.offTune();
    this.panel.dispose();
  }
}
