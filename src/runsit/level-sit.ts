// ---- runsit/level-sit.ts ----------------------------------------------------------------------------------------
// (round 120, `runsit`; BACKLOG RS20-RS22) A situation run in the level: `?skipmenu=1&level=atlas&runplan=hoverbike`
// (or `=lich`). The run is one situation on the live map (the GM's for this world, else the template's: gm.ts): an
// area played where it is (area.ts — the hero, the outriders, the ambush, the hall, the trader, the town), then at its
// edge the atlas map with the situation drawn on it (the dead's march and where they are now, the hold's levy, the
// refuge) and the ways on, each with what the actual clock says of it; the leg travelled on the map while the next
// area's land loads (runplan/travel.ts Journey, the streamer's precache), then the warp and the next area. The finale
// at the town; the end card says what changed; the world remembers (finish.ts), and the settlements system is told a
// burned town is ruined (realised charred from then on). Another run starts in the world as it was left.
// The user (round 120): "when the player reaches the boundary of an area they get the map and choices of where to go
// based on the actual situation. Deliver a message to the Red Hold to get them to send reinforcements or warn the town
// and lead the peoplen into the hills."

import type { RegionGraph, RunRecord, TravelLeg } from '../api/contracts/run';
import type { Situation } from '../api/contracts/situation';
import type { Settlement } from '../api/contracts/settlement';
import type { UnitId, Units } from '../api/contracts/units';
import type { Terrain } from '../api/contracts/terrain';
import type { Sim } from '../api/world';
import { MemoryWorldState } from '../api/contracts/world-state';
import type { AtlasMap } from '../api/atlas-map';
import type { Atlas } from '../atlas/atlas';
import type { PlaySession } from '../play/session';
import { atlasFacts } from '../gm/atlas-facts';
import { buildWiki } from '../gm/wiki';
import { runGraph } from '../runplan/graph';
import { Journey, type JourneyState } from '../runplan/travel';
import { ROW_H } from '../world/lattice';
import { AreaPlay, type AreaEnd, type TownPlaces } from './area';
import { situationMap } from './fill';
import { finishSituation } from './finish';
import { UnitFollowers } from './followers';
import { situationFor } from './gm';
import { carried, displaced, totals } from './items';
import { PLAY_TITLE, SituationRun, along, delta, LEVY_PACE, type V2 } from './state';

/** what the run needs of the settlements system (its public API: settlements.ts) */
export interface SettlementsView {
  places(id: string): { centre: V2; radius: number; doors: { at: V2; ref: string }[] } | null;
  setCondition(id: string, c: Settlement['condition']): void;
}

export interface LevelSitDeps {
  atlas: Atlas;
  terrain: Terrain;
  map: AtlasMap;
  ui: HTMLElement;
  hero: string;
  session: PlaySession;
  api: Sim;
  units: Units;
  settlements: SettlementsView;
  bounds: [number, number];
  /** world units → the window (as it is now) */
  toWin: (p: V2) => V2;
  /** the streamer's: ask for a warp's land ahead, is it ready, warp there (world cells) */
  precache: (cx: number, cy: number) => number;
  ready: (cx: number, cy: number) => boolean;
  warp: (cx: number, cy: number) => Promise<void>;
  say: (s: string, seconds?: number) => void;
  /** the window made again where it is (the streamer's warp to its own place): land a system changed comes in as it is now */
  remake: () => Promise<void>;
  /** false: the template even where the GM wrote one (?runsitgm=0) */
  gm?: boolean;
}

const toCell = (x: number, y: number): [number, number] => [x, y / ROW_H];
/** seconds a fallen town burns live before the window is made again with it charred */
const CHAR_AFTER_S = 25;
const PLAY_COLOUR: Record<string, string> = { flee: '#f08a4b', ambush: '#e0483a', deliver: '#f2c14e', trader: '#8fd16a', town: '#ffffff' };
const PLAY_GLYPH: Record<string, string> = { flee: '⇢', ambush: '⚔', deliver: '✉', trader: '⚖', town: '♜' };

export class LevelSit {
  readonly world: MemoryWorldState;
  readonly graph: RegionGraph;
  private wiki: ReturnType<typeof buildWiki>;
  run!: SituationRun;
  by: 'gm' | 'template' = 'template';
  /** why the GM's situation wasn't played (another make of this world), if so */
  byNote: string | undefined;
  area: AreaPlay | null = null;
  /** the last area's report (the edge card) */
  last: AreaEnd | null = null;
  journey: Journey | null = null;
  jstate: JourneyState | null = null;
  record: RunRecord | null = null;
  playing = false;
  runs = 0;
  readonly log: string[] = [];
  private followers: UnitFollowers;
  /** (the scripts hide it for a look at the town) */
  readonly card: HTMLDivElement;
  private warping = false;
  private travelScale = 1;
  private cameFrom: V2 | null = null;

  constructor(private d: LevelSitDeps) {
    const facts = atlasFacts(d.atlas);
    this.wiki = buildWiki(facts);
    this.graph = runGraph(d.terrain.atlasGraph(), { names: { regions: this.wiki.regions, settlements: this.wiki.snapshot.settlements }, facts });
    this.world = MemoryWorldState.restore(structuredClone(this.wiki.snapshot));
    this.followers = new UnitFollowers(d.units, 'hero');
    this.card = document.createElement('div');
    this.card.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;width:min(92vw,440px);max-height:62vh;overflow:auto;z-index:60;background:rgba(18,16,12,0.93);color:#efe6d2;font:13px/1.4 system-ui,sans-serif;padding:8px 10px;border-radius:9px;border:1px solid #5a4a30;pointer-events:auto;';
    this.card.addEventListener('pointerdown', (e) => e.stopPropagation());
    d.ui.appendChild(this.card);
    d.map.canWarp = false;
    d.map.overlay = (ctx, px) => this.drawOnMap(ctx, px);
    d.map.playerAt = () => (this.jstate ? toCell(...this.jstate.at) : null);
    d.session.extraParts = () => this.area?.parts() ?? [];
    this.newRun(this.wiki.spawn.region, this.wiki.spawn.at as V2);
  }

  /** a situation for the world as it is now, starting where the hero is */
  private newRun(from: number, at: V2): void {
    const t0 = performance.now();
    const snap = this.world.snapshot();
    const { sit, by, note } = situationFor({ graph: this.graph, world: snap, wiki: this.wiki, seed: this.d.atlas.p.seed, from, at, hero: this.d.hero, gm: this.d.gm });
    this.by = by;
    this.byNote = note;
    this.run = new SituationRun(sit, situationMap(this.graph, snap));
    this.log.push(`situation ${sit.id} (${by}) in ${(performance.now() - t0).toFixed(1)} ms: ${sit.title}; the threat at ${sit.target.name} in ${sit.threat.arrives} min`);
    this.record = null;
    this.last = null;
    this.cameFrom = null;
    this.area?.dispose();
    this.area = null;
    this.runs++;
    this.d.session.paused = true;
    this.render();
  }

  get sit(): Situation {
    return this.run.sit;
  }

  /** the town's places in the window, once planned */
  private places = (sid: string): TownPlaces | null => {
    const p = this.d.settlements.places(sid);
    if (!p) return null;
    return { centre: this.d.toWin(p.centre), radius: p.radius, doors: p.doors.map((x) => this.d.toWin(x.at)) };
  };

  /** the town's people out now: its units, not hostile, not its guards */
  private townsfolk = (sid: string): UnitId[] => {
    const p = this.places(sid);
    if (!p) return [];
    return this.d.units
      .query(p.centre, p.radius * 2 + 40)
      .filter((u) => u.settlement === sid && !u.hostile && u.role !== 'guard')
      .map((u) => u.id);
  };

  /** play the area the run is at */
  async playArea(): Promise<void> {
    if (this.playing || this.run.phase !== 'area' || this.journey || this.warping) return;
    this.playing = true;
    this.area?.dispose();
    const S = this.d.session;
    S.respawn();
    S.paused = false;
    const a = new AreaPlay({ ui: this.d.ui, api: this.d.api, units: this.d.units, session: S, run: this.run, followers: this.followers, toWin: this.d.toWin, bounds: this.d.bounds, places: this.places, townsfolk: this.townsfolk }, this.cameFrom);
    this.area = a;
    for (const b of a.area.say ?? []) this.d.say(b.line, b.seconds ?? 4);
    this.render();
    const r = await a.result;
    this.last = r;
    this.log.push(...a.log.splice(0));
    if (r.kind === 'area') {
      this.run.areaDone(r.result);
      // (the area's units go with it: what's still after the hero is the run's pursuers now)
      await new Promise((res) => setTimeout(res, 1200));
      a.dispose();
      if (this.area === a) this.area = null;
    } else this.run.finish(r.end, r.seconds);
    this.log.push(...this.run.log.splice(0));
    this.playing = false;
    S.paused = true;
    if ((this.run.phase as string) === 'ended') this.end();
    else this.render();
  }

  take(id: string | null): void {
    this.run.take(id);
    this.log.push(...this.run.log.splice(0));
    this.render();
  }

  /** set out on a way on: the leg travelled on the map while the next area's land loads */
  choose(id: string): void {
    if (this.run.phase !== 'edge' || this.journey) return;
    const from = this.run.area();
    const leg = this.run.choose(id);
    this.log.push(...this.run.log.splice(0));
    this.cameFrom = this.run.map.areaAt(from);
    const len = Math.hypot(leg.path[1][0] - leg.path[0][0], leg.path[1][1] - leg.path[0][1]);
    const tl: TravelLeg = { id: leg.choice.id, from: from.id, to: leg.to.id, route: [], path: leg.path, minutes: leg.minutes, animSeconds: Math.max(4, Math.min(10, 3 + len / 200)), crossings: [], events: [] };
    const dest = this.run.map.areaAt(leg.to);
    this.journey = new Journey(tl, dest, { precache: (x, y) => this.d.precache(x, y), ready: this.d.ready }, toCell);
    this.jstate = null;
    this.d.session.paused = true;
    if (!this.d.map.isOpen) this.d.map.open();
    this.travelScale = ((Math.max(len, 500) / this.d.atlas.worldW) * this.d.atlas.p.n) / (Math.min(innerWidth, innerHeight) * 0.6);
    this.render();
  }

  private end(): void {
    const run = this.run;
    this.record = finishSituation(this.world, run, this.d.hero);
    const ending = run.sit.endings[run.end!];
    if (ending.settlement === 'ruined' || ending.settlement === 'abandoned') {
      // (the settlements system realises it charred from now on; the window is made again once the fires have had their
      // time, so what stands of a town of plaster and tile — which the fire's heat only cracks — comes down to its stumps:
      // DEVLOG round 120)
      this.d.settlements.setCondition(run.sit.target.settlement, ending.settlement);
      const n = this.runs;
      setTimeout(() => {
        if (this.runs === n && !this.journey) void this.d.remake().then(() => this.log.push(`${run.sit.target.name}: the window made again, the town charred`));
      }, CHAR_AFTER_S * 1000);
    }
    this.log.push(`end ${run.end}: ${this.record.events.length} events; ${run.sit.target.name} ${ending.settlement ?? 'as it was'}`);
    this.render();
  }

  /**
   * (a check's switch: scripts/runsit.mjs --ff) Take these ways on without playing the areas between (each counted at
   * its planned minutes, won, the first offer taken), then warp to where they lead — to look at a later area, the
   * finale above all, without riding the whole run each time.
   */
  async fastForward(choices: string[]): Promise<void> {
    for (const id of choices) {
      const a = this.run.area();
      this.run.areaDone({ seconds: a.minutes * 60, won: true, pursuers: this.run.pursuers?.count ?? 0 });
      if (this.run.offers.length) this.run.take(this.run.offers[0]);
      this.cameFrom = this.run.map.areaAt(a);
      this.run.choose(id);
      this.run.arrive();
    }
    this.log.push(...this.run.log.splice(0));
    this.warping = true;
    await this.d.warp(...toCell(...this.run.map.areaAt(this.run.area())));
    this.warping = false;
    this.render();
  }

  /** another run, from where the hero is, in the world as it was left */
  again(): void {
    const a = this.run.area();
    this.newRun(a.region, this.run.map.areaAt(a));
  }

  /** each frame */
  update(dt: number): void {
    this.area?.update(dt);
    if (!this.journey || this.warping) return;
    const prev = this.jstate?.phase;
    this.jstate = this.journey.update(dt);
    const st = this.jstate;
    if (this.d.map.isOpen) {
      this.d.map.centreOn(...toCell(...st.at), this.travelScale);
      this.d.map.redraw();
    }
    if (st.phase === 'arrived') {
      this.warping = true;
      const dest = this.run.map.areaAt(this.run.leg!.to);
      void this.d.warp(...toCell(...dest)).then(() => {
        this.warping = false;
        this.journey = null;
        this.jstate = null;
        this.d.map.close();
        this.run.arrive();
        this.log.push(...this.run.log.splice(0));
        const a = this.run.area();
        this.d.say(`${PLAY_GLYPH[a.play.kind]} ${a.name}`, 4);
        this.render();
      });
    } else if (st.phase !== prev) this.render();
  }

  /** the window slid */
  shift(dx: number, dy: number): void {
    this.area?.shift(dx, dy);
  }

  private render(): void {
    const C = this.card;
    C.innerHTML = '';
    C.style.display = this.playing ? 'none' : '';
    C.style.top = this.journey ? 'auto' : '8px';
    C.style.bottom = this.journey ? '34px' : 'auto';
    const h = (tag: string, text: string, css = '') => {
      const e = document.createElement(tag);
      e.textContent = text;
      e.style.cssText = css;
      C.appendChild(e);
      return e;
    };
    const btn = (text: string, f: () => void, main = false, sub = '') => {
      const b = document.createElement('button');
      b.style.cssText = `display:block;width:100%;text-align:left;min-height:44px;margin:4px 0;padding:6px 9px;border-radius:7px;border:1px solid #6b5b3e;background:${main ? '#5a3f12' : '#2a241a'};color:#f3e8cf;font:${main ? '600 15px' : '600 13px'} system-ui,sans-serif;`;
      b.textContent = text;
      if (sub) {
        const s = document.createElement('div');
        s.textContent = sub;
        s.style.cssText = 'font:12px system-ui,sans-serif;color:#cdbf9f;margin-top:2px';
        b.appendChild(s);
      }
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.onclick = (e) => {
        e.stopPropagation();
        f();
      };
      C.appendChild(b);
      return b;
    };
    const muted = 'color:#a99c80;font-size:12px';
    const run = this.run;
    const sit = run.sit;
    if (this.record) return this.renderEnd(h, btn, muted);
    const status = () => {
      const left = run.hordeArrives() - run.clock;
      const lines = [
        `⏱ minute ${run.clock.toFixed(1)} · ☠ ${sit.threat.name} at ${sit.target.name} ${left > 0 ? `in ${left.toFixed(1)} min` : `${(-left).toFixed(1)} min ago`}`,
        run.pursuers ? `⇢ ${run.pursuers.count} outriders ${Math.max(0, run.pursuers.behind).toFixed(1)} min behind` : '',
        run.reinforce ? `✉ the levy at ${sit.target.name} by minute ${run.reinforce.arrives.toFixed(1)}` : '',
        run.warned ? (run.evacuate ? '☞ the town warned: its people to be led out' : '⚑ the town warned') : '',
        carried(run.loadout).length ? `🎒 ${carried(run.loadout).map((id) => run.item(id).name).join(', ')}` : '',
      ].filter(Boolean);
      h('div', lines.join('\n'), `${muted};white-space:pre-line;margin-top:4px`);
    };
    if (this.journey) {
      h('div', `Riding to ${run.leg?.to.name ?? ''}`, 'font:600 14px Georgia,serif');
      h('div', this.jstate?.phase === 'waiting' ? 'The land there is still being made…' : run.leg?.choice.text ?? '', muted);
      status();
      return;
    }
    const a = run.area();
    if (run.phase === 'area') {
      if (!run.path.length) {
        h('div', sit.title, 'font:600 16px Georgia,serif;color:#ffd9a0');
        h('div', sit.premise, 'margin:2px 0 6px');
        h('div', this.by === 'gm' ? 'written by the GM for this world' : 'the template, filled from this world', muted);
        if (this.byNote) h('div', `(${this.byNote})`, muted);
      }
      h('div', `${PLAY_GLYPH[a.play.kind]} ${a.name} — ${PLAY_TITLE[a.play.kind]}`, `margin-top:6px;font:600 14px Georgia,serif;color:${PLAY_COLOUR[a.play.kind]}`);
      h('div', a.brief, 'margin:2px 0');
      status();
      btn('▶ Go', () => void this.playArea(), true);
      return;
    }
    // the edge: what came of it, the offers, the ways on
    const r = this.last?.kind === 'area' ? this.last.result : null;
    h('div', `${PLAY_GLYPH[a.play.kind]} ${a.name}: ${r?.won ? 'done' : 'it went badly'} (${(r?.seconds ?? 0).toFixed(0)} s)`, `font:600 14px Georgia,serif;color:${r?.won ? '#9be07a' : '#ff8a70'}`);
    status();
    if (run.offers.length) {
      h('div', a.play.kind === 'trader' ? 'The trader offers one of these:' : `${a.name} offers one of these:`, 'margin-top:6px;font:600 13px system-ui,sans-serif');
      for (const id of run.offers) {
        const it = run.item(id);
        const gone = displaced(run.loadout, it);
        btn(`Take the ${it.name} (${it.slot}${it.also ? ' + ' + it.also.join(' + ') : ''})`, () => this.take(id), false, `${it.text}${gone.length ? ` — puts down the ${gone.map((g) => run.item(g).name).join(' and the ')}` : ''}`);
      }
      btn('Take nothing', () => this.take(null));
      return;
    }
    h('div', 'Where now — the map shows the dead on the march:', 'margin-top:6px;font-size:12px');
    for (const o of run.options()) btn(`${PLAY_GLYPH[o.to.play.kind]} ${o.choice.text}`, () => this.choose(o.choice.id), false, `${o.legMinutes.toFixed(1)} min on the road · ${o.note}`);
    const t = totals(run.loadout, run.item);
    if (t.pace < 1) h('div', `(your mount: the roads take ${Math.round(t.pace * 100)}% of the time)`, muted);
    btn('🗺 Look at the map', () => (this.d.map.isOpen ? this.d.map.close() : (this.d.map.open(), this.d.map.centreOn(...toCell(...run.map.areaAt(a)), this.travelScale))));
  }

  private renderEnd(h: (tag: string, text: string, css?: string) => HTMLElement, btn: (text: string, f: () => void, main?: boolean, sub?: string) => HTMLButtonElement, muted: string): void {
    const R = this.record!;
    const run = this.run;
    const end = run.end!;
    const title = { saved: `${run.sit.target.name} stands`, burned: `${run.sit.target.name} burned`, evacuated: `${run.sit.target.name}'s people live`, fell: 'The hero fell' }[end];
    h('div', title, `font:600 16px Georgia,serif;color:${end === 'saved' || end === 'evacuated' ? '#9be07a' : '#ff8a70'}`);
    for (const d of R.deeds) h('div', `• ${d}`, 'font-size:13px');
    h('div', 'What changed in the world', 'margin-top:8px;font:600 13px Georgia,serif');
    const name = (id: number) => this.graph.node(id)?.name ?? `region ${id}`;
    const seen = new Set<string>();
    for (const e of R.events) {
      const f = e.detail?.faction ? ` (${this.world.faction(String(e.detail.faction))?.name ?? e.detail.faction})` : '';
      const where = e.kind === 'faction-attitude' ? 'toward you' : e.regions.length > 4 ? `${name(e.regions[0])} and ${e.regions.length - 1} regions round it` : e.regions.map(name).join(', ');
      const line = `${e.kind}${f}: ${where}${e.kind === 'mark' && e.detail?.name ? ` — ${e.detail.name}` : ''}`;
      if (seen.has(line)) continue;
      seen.add(line);
      h('div', `· ${line}`, muted);
    }
    const c = this.world.character(this.d.hero);
    if (c && !c.alive) h('div', 'The hero is dead: the next run needs another (the world remembers).', 'margin-top:6px;font-size:12px');
    else btn('▶ Another run — the world as you left it', () => this.again(), true);
  }

  private drawOnMap(ctx: CanvasRenderingContext2D, px: (cx: number, cy: number) => [number, number]): void {
    const run = this.run;
    const sit = run.sit;
    const W = run.map.world;
    const P = (p: V2) => px(...toCell(...p));
    const line = (pts: V2[], colour: string, width: number, dash: number[] = []) => {
      ctx.setLineDash(dash);
      ctx.lineWidth = width;
      ctx.strokeStyle = colour;
      ctx.beginPath();
      // (each step the short way round the torus from the last)
      let at = pts[0];
      const [x0, y0] = P(at);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < pts.length; i++) {
        const dd = delta(at, pts[i], W);
        at = [at[0] + dd[0], at[1] + dd[1]];
        const [x, y] = P(at);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const dot = (p: V2, r: number, fill: string, glyph = '') => {
      const [x, y] = P(p);
      ctx.fillStyle = 'rgba(20,16,10,0.9)';
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (glyph) {
        ctx.fillStyle = '#1a1206';
        ctx.font = '700 13px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(glyph, x, y + 1);
      }
    };
    // the dead's march: where they rose, the road, where they are now
    const route = sit.threat.route.map((r) => run.map.regionCentre(r));
    line(route, 'rgba(200,40,40,0.85)', 4, [8, 5]);
    // the ways on
    const open = run.phase === 'edge' ? run.at : null;
    for (const c of sit.choices) {
      const going = run.leg?.choice.id === c.id;
      const avail = c.from === open;
      line([run.map.areaAt(run.area(c.from)), run.map.areaAt(run.area(c.to))], going ? '#fff3c4' : avail ? '#f2c14e' : 'rgba(250,240,210,0.45)', going || avail ? 4 : 2, going || avail ? [] : [6, 6]);
    }
    for (const a of sit.areas) dot(run.map.areaAt(a), 11, PLAY_COLOUR[a.play.kind], PLAY_GLYPH[a.play.kind]);
    dot(run.map.regionCentre(sit.refuge.region), 7, '#6fcf6f', '⌂');
    if (run.reinforce) {
      const hold = sit.areas.find((a) => a.play.kind === 'deliver');
      if (hold) {
        const from = run.map.areaAt(hold);
        const to = run.map.areaAt(run.finaleArea);
        const [dx, dy] = delta(from, to, W);
        const total = Math.hypot(dx, dy) / LEVY_PACE;
        const t = 1 - Math.max(0, run.reinforce.arrives - run.clock) / Math.max(total, 0.01);
        dot(along([from, to], t, W), 7, '#f2c14e', '⚑');
      }
    }
    // (the dead now: a minute's travel shows them move — the clock goes on with the leg)
    const extra = this.journey && this.jstate ? (this.jstate.t * (run.leg?.minutes ?? 0)) : 0;
    const prog = Math.max(0, Math.min(1, (run.clock + extra) / run.hordeArrives()));
    dot(along(route, prog, W), 9, '#c02828', '☠');
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  dispose(): void {
    this.area?.dispose();
    this.card.remove();
    this.d.map.overlay = undefined;
    this.d.map.playerAt = undefined;
  }
}
