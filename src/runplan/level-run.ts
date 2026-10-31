// ---- runplan/level-run.ts ---------------------------------------------------------------------------------------
// (round 117, runplan; BACKLOG RP5, RC2, RC3 — round 119, runplay: stages played) A planned run in the level:
// `?level=atlas&runplan=<hero>`. The run is planned from the spawn's region on this atlas (its facts and wiki read
// from the live atlas, so any seed works; its region graph terrain's). A card says where the player is and what the
// stage is about; the stage is PLAYED by a StagePlayer (contracts/run.ts — src/runplay: play's hero, its controls) and
// the outcome its play picked is the one the world gets; without a player (no units in the level) it's picked from the
// card as before. Then the player picks a leg out: the plan's asks of terrain are made on the destination's land
// (runplan/requests.ts, before it's made), and the travel plays on the atlas map — the run's legs and stages drawn
// over the game's own map, the marker moving along the road, each en-route event held until answered — while the
// streamer makes the destination's land (precacheWarp). It arrives when the animation is done and the land is ready
// (warpReady), then warps there. The run ends on a finale, a death, a capture or the clock (the plan's deadline:
// rules.ts RunClock), and the end card says what changed in the world.
// The user (round 115): "have the player use the atlas map to travel from location to location. We can precache the
// locations they go to and animate travel on that map while we load in the background." (round 119): "I need to
// actually play a generated run and try it out."

import type { EncounterKind, PlayedStage, RunPlan, RunRecord, RunStage, StagePlayer } from '../api/contracts/run';
import type { ControllerProfile } from '../api/contracts/play';
import { MemoryWorldState } from '../api/contracts/world-state';
import type { AtlasMap } from '../api/atlas-map';
import type { Atlas } from '../atlas/atlas';
import type { Terrain } from '../api/contracts/terrain';
import { atlasFacts } from '../gm/atlas-facts';
import { buildWiki } from '../gm/wiki';
import { ROW_H } from '../world/lattice';
import { finishRun } from './consequences';
import { runGraph } from './graph';
import { heroCaps } from './heroes';
import { planRun } from './plan';
import { askTerrain } from './requests';
import { RunClock } from './clock';
import { Journey, type JourneyState } from './travel';
import { describe } from './viewer-text';
import type { RegionGraph } from '../api/contracts/run';

const GLYPH: Record<EncounterKind, string> = {
  race: '»', chase: '⇝', fight: '⚔', horde: '☠', spectacle: '✷', destruction: '✸', delve: '⛏', talk: '✉', explore: '⚐', rescue: '♡',
};
const COLOUR: Record<EncounterKind, string> = {
  race: '#f2c14e', chase: '#f08a4b', fight: '#e0483a', horde: '#9a6bd8', spectacle: '#4fd1c5', destruction: '#ff6f91',
  delve: '#c49a6c', talk: '#8fd16a', explore: '#7fb7f0', rescue: '#ffffff',
};

export interface LevelRunDeps {
  atlas: Atlas;
  /** (runplay) the terrain system: its atlas graph is the run's region graph; the plan's asks are made of it */
  terrain: Terrain;
  map: AtlasMap;
  ui: HTMLElement;
  hero: string;
  /** (runplay) the hero's body (play's profile): what terrain's requests are made for */
  body: ControllerProfile;
  /** (runplay) who plays the stages (absent: the card picks) */
  player?: StagePlayer;
  /** (runplay) the run's length, minutes (default the planner's 15-50) */
  minutes?: [number, number];
  /** the streamer's: ask for a warp's land ahead, is it ready, warp there (world cells) */
  precache: (cx: number, cy: number) => number;
  ready: (cx: number, cy: number) => boolean;
  warp: (cx: number, cy: number) => Promise<void>;
  say: (s: string, seconds?: number) => void;
}

/** world units (the atlas's, the plan's) → world cells (the streamer's, the map's) */
const toCell = (x: number, y: number): [number, number] => [x, y / ROW_H];

export class LevelRun {
  plan!: RunPlan;
  readonly world: MemoryWorldState;
  private graph: RegionGraph;
  private spawnRegion: number;
  at = '';
  private path: { stage: string; outcome: string }[] = [];
  private stops: { leg: string; event: string }[] = [];
  /** the last stage's play (the card shows it) */
  private played: (PlayedStage & { stage: string }) | null = null;
  /** a stage is being played (the card is down) */
  playing = false;
  /** the plan's asks being made of terrain before a leg sets out */
  private asking = false;
  journey: Journey | null = null;
  jstate: JourneyState | null = null;
  record: RunRecord | null = null;
  /** the run's clock (the plan's deadline: past it, 'late') */
  clock = new RunClock(0);
  runs = 0;
  private card: HTMLDivElement;
  private warping = false;
  private travelScale = 1;
  readonly log: string[] = [];

  constructor(private d: LevelRunDeps) {
    const facts = atlasFacts(d.atlas);
    const wiki = buildWiki(facts);
    this.graph = runGraph(d.terrain.atlasGraph(), { names: { regions: wiki.regions, settlements: wiki.snapshot.settlements }, facts });
    this.world = MemoryWorldState.restore(structuredClone(wiki.snapshot));
    this.spawnRegion = wiki.spawn.region;
    this.card = document.createElement('div');
    this.card.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;width:min(92vw,420px);max-height:56vh;overflow:auto;z-index:60;background:rgba(18,16,12,0.92);color:#efe6d2;font:13px/1.4 system-ui,sans-serif;padding:8px 10px;border-radius:9px;border:1px solid #5a4a30;pointer-events:auto;';
    this.card.addEventListener('pointerdown', (e) => e.stopPropagation());
    d.ui.appendChild(this.card);
    d.map.canWarp = false;
    d.map.overlay = (ctx, px, scale) => this.drawOnMap(ctx, px, scale);
    d.map.playerAt = () => (this.jstate ? toCell(...this.jstate.at) : null);
    this.newPlan(this.spawnRegion);
  }

  /** a plan from `from` on the world as it is now (the first run, or the next after one ended) */
  private newPlan(from: number): void {
    const t0 = performance.now();
    this.plan = planRun({ graph: this.graph, world: this.world.snapshot(), hero: heroCaps(this.d.hero), seed: this.d.atlas.p.seed, from, minutes: this.d.minutes });
    this.log.push(`plan ${this.plan.id} in ${(performance.now() - t0).toFixed(1)} ms: ${this.plan.stages.length} stages, ${this.plan.minutes.min}-${this.plan.minutes.max} min, deadline ${this.plan.deadline}`);
    this.at = this.plan.start;
    this.path = [];
    this.stops = [];
    this.played = null;
    this.record = null;
    this.clock = new RunClock(this.plan.deadline);
    this.runs++;
    this.d.player?.hold(true);
    this.render();
  }

  private stage(id: string): RunStage {
    return this.plan.stages.find((s) => s.id === id)!;
  }

  /** the card's pick (no player), or what a played stage picked */
  choose(outcome: string): void {
    const s = this.stage(this.at);
    const o = s.outcomes.find((x) => x.id === outcome)!;
    this.path.push({ stage: s.id, outcome: o.id });
    this.log.push(`${s.id}: ${o.id}`);
    if (o.ends !== 'continue') this.end();
    else this.render();
  }

  /** (runplay) play the stage the run is at */
  async playStage(): Promise<void> {
    const P = this.d.player;
    if (!P || this.playing || this.record) return;
    const s = this.stage(this.at);
    if (this.path.at(-1)?.stage === s.id) return;
    this.playing = true;
    this.render();
    const r = await P.play(s);
    this.playing = false;
    P.hold(true);
    this.played = { ...r, stage: s.id };
    this.clock.stage(s.minutes, r.seconds, r.par);
    this.log.push(`${s.id} ${r.won ? 'won' : 'lost'} (${r.line}) in ${r.seconds.toFixed(0)} s → ${r.outcome}; clock ${this.clock.minutes.toFixed(1)}/${this.plan.deadline} min`);
    const o = s.outcomes.find((x) => x.id === r.outcome)!;
    this.path.push({ stage: s.id, outcome: o.id });
    if (r.runEnd) this.end(r.runEnd);
    else if (o.ends !== 'continue') this.end();
    else if (this.clock.late) this.end('late');
    else this.render();
  }

  async travel(legId: string): Promise<void> {
    if (this.journey || this.asking) return;
    const l = this.plan.legs.find((x) => x.id === legId)!;
    const to = this.stage(l.to);
    // (runplay) the plan's asks of the destination's land made of terrain first: its edits are stamped into land made
    // from now on, and the precache below makes it
    this.asking = true;
    this.render();
    try {
      const t0 = performance.now();
      const lines = await askTerrain(this.d.terrain, this.plan, to, this.d.body);
      this.log.push(`terrain asks for ${to.id} (${(performance.now() - t0).toFixed(0)} ms): ${lines.join('; ')}`);
    } finally {
      this.asking = false;
    }
    const t0 = performance.now();
    this.journey = new Journey(l, to.section.at, { precache: (x, y) => { const n = this.d.precache(x, y); this.log.push(`precache ${n} regions round ${to.id} (${(performance.now() - t0).toFixed(1)} ms)`); return n; }, ready: this.d.ready }, toCell);
    this.jstate = null;
    this.log.push(`travel ${l.id}`);
    this.d.player?.hold(true);
    if (!this.d.map.isOpen) this.d.map.open();
    // (the map zoomed to the leg: its longer side across 60% of the screen's shorter)
    const xs = l.path.map((p) => p[0]);
    const ys = l.path.map((p) => p[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 400);
    this.travelScale = ((span / this.d.atlas.worldW) * this.d.atlas.p.n) / (Math.min(innerWidth, innerHeight) * 0.6);
    this.render();
  }

  answer(stop: boolean): void {
    if (!this.journey || this.jstate?.phase !== 'event') return;
    if (stop) this.stops.push({ leg: this.journey.leg.id, event: this.jstate.event.id });
    this.journey.answer(stop);
    this.render();
  }

  end(how?: RunRecord['end']): void {
    this.record = finishRun(this.world, this.plan, this.path, how, this.stops);
    this.log.push(`end ${this.record.end}: ${this.record.events.length} events`);
    this.d.player?.hold(true);
    this.render();
  }

  /** each frame */
  update(dt: number): void {
    if (!this.journey || this.warping) return;
    const prev = this.jstate?.phase;
    const prevEv = this.jstate?.phase === 'event' ? this.jstate.event.id : null;
    this.jstate = this.journey.update(dt);
    const st = this.jstate;
    if (this.d.map.isOpen) {
      this.d.map.centreOn(...toCell(...st.at), this.travelScale);
      this.d.map.redraw();
    }
    if (st.phase === 'arrived') {
      const leg = this.journey.leg;
      const to = this.stage(leg.to);
      this.warping = true;
      this.log.push(`arrived ${to.id} (waited ${this.journey.waited.toFixed(1)} s for the land)`);
      const [cx, cy] = toCell(...to.section.at);
      void this.d.warp(cx, cy).then(() => {
        this.warping = false;
        this.journey = null;
        this.jstate = null;
        this.at = to.id;
        this.played = null;
        this.d.map.close();
        this.d.player?.arrived();
        this.clock.leg(leg.minutes);
        this.d.say(`${GLYPH[to.encounter]} ${to.name}`, 4);
        if (this.clock.late) this.end('late');
        else this.render();
      });
    } else if (st.phase !== prev || (st.phase === 'event' && st.event.id !== prevEv)) this.render();
  }

  private render(): void {
    const C = this.card;
    C.innerHTML = '';
    // (down while a stage is played: the banner has the screen)
    C.style.display = this.playing ? 'none' : '';
    // (on the map, the card sits at the bottom: the map's buttons are at the top)
    C.style.top = this.journey ? 'auto' : '8px';
    C.style.bottom = this.journey ? '34px' : 'auto';
    const h = (tag: string, text: string, css = '') => {
      const e = document.createElement(tag);
      e.textContent = text;
      e.style.cssText = css;
      C.appendChild(e);
      return e;
    };
    const btn = (text: string, f: () => void, main = false) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = `display:block;width:100%;text-align:left;min-height:44px;margin:4px 0;padding:6px 9px;border-radius:7px;border:1px solid #6b5b3e;background:${main ? '#5a3f12' : '#2a241a'};color:#f3e8cf;font:${main ? '600 15px' : '13px'} system-ui,sans-serif;`;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.onclick = (e) => {
        e.stopPropagation();
        f();
      };
      C.appendChild(b);
      return b;
    };
    const muted = 'color:#a99c80;font-size:12px';
    if (this.record) return this.renderEnd(h, btn, muted);
    if (this.asking) {
      h('div', 'Setting out…', 'font:600 14px Georgia,serif');
      h('div', 'The land ahead is being shaped for the stage (terrain’s requests).', muted);
      return;
    }
    if (this.journey) {
      const to = this.stage(this.journey.leg.to);
      h('div', `Travelling to ${to.name}`, 'font:600 14px Georgia,serif');
      const st = this.jstate;
      if (st?.phase === 'event') {
        h('div', st.event.text, 'margin:4px 0');
        btn(st.event.kind === 'ambush' ? 'Fight through' : 'Stop', () => this.answer(true));
        btn('Pass by', () => this.answer(false));
      } else h('div', st?.phase === 'waiting' ? 'The land there is still being made…' : `${this.journey.leg.route.length} regions on the road`, muted);
      return;
    }
    const s = this.stage(this.at);
    const done = this.path.at(-1)?.stage === s.id;
    h('div', `${GLYPH[s.encounter]} ${s.name}`, `font:600 14px Georgia,serif;color:${COLOUR[s.encounter]}`);
    h('div', `${s.brief} · run clock ${this.clock.minutes.toFixed(0)}/${this.plan.deadline} min`, muted);
    if (!done) {
      const P = this.d.player;
      if (P) {
        const pv = P.preview(s);
        h('div', pv.goal, 'margin-top:6px;font:600 14px system-ui,sans-serif;color:#fff3c4');
        if (pv.note) h('div', `(stand-in: ${pv.note})`, muted);
        btn(`▶ Play`, () => void this.playStage(), true);
      } else {
        h('div', 'How it went (no hero in this level: pick):', 'margin-top:4px;font-size:12px');
        for (const o of s.outcomes) btn(o.text, () => this.choose(o.id)).title = describe(o);
      }
      return;
    }
    const o = s.outcomes.find((x) => x.id === this.path.at(-1)!.outcome)!;
    if (this.played?.stage === s.id) h('div', `${this.played.won ? 'Won' : 'Lost'} — ${this.played.line}`, `margin-top:4px;font:700 14px system-ui,sans-serif;color:${this.played.won ? '#9be07a' : '#ff8a70'}`);
    h('div', o.text, 'margin:2px 0 2px');
    h('div', describe(o), muted);
    h('div', 'Where next — travel on the map:', 'margin-top:6px;font-size:12px');
    for (const lid of s.next) {
      const l = this.plan.legs.find((x) => x.id === lid)!;
      const t = this.stage(l.to);
      btn(`${GLYPH[t.encounter]} ${t.name} (${l.events.length} on the road)`, () => void this.travel(lid));
    }
  }

  /** the end card: how it ended and what it changed in the world (events by region, the hero's record) */
  private renderEnd(h: (tag: string, text: string, css?: string) => HTMLElement, btn: (text: string, f: () => void, main?: boolean) => HTMLButtonElement, muted: string): void {
    const R = this.record!;
    const title: Record<RunRecord['end'], string> = { won: 'The run is won', lost: 'The hero fell', fled: 'The hero fled', abandoned: 'The run was abandoned', captured: 'The hero was taken', late: 'Too late' };
    h('div', title[R.end], `font:600 16px Georgia,serif;color:${R.end === 'won' ? '#9be07a' : '#ff8a70'}`);
    for (const d of R.deeds) h('div', `• ${d}`, 'font-size:13px');
    h('div', 'What changed in the world', 'margin-top:8px;font:600 13px Georgia,serif');
    const name = (id: number) => this.graph.node(id)?.name ?? `region ${id}`;
    const seen = new Set<string>();
    for (const e of R.events) {
      const f = e.detail?.faction ? ` (${this.world.faction(String(e.detail.faction))?.name ?? e.detail.faction})` : '';
      const where = e.regions.length > 3 ? `${name(e.regions[0])} and ${e.regions.length - 1} regions round it` : e.regions.map(name).join(', ');
      const line = `${e.kind}${f}: ${where}${e.kind === 'mark' && e.detail?.name ? ` — ${e.detail.name}` : ''}`;
      if (seen.has(line)) continue;
      seen.add(line);
      h('div', `· ${line}`, muted);
    }
    const c = this.world.character(this.plan.hero);
    if (c) {
      h('div', `${c.name}${c.alive ? '' : ' ✝'}`, 'margin-top:8px;font:600 13px Georgia,serif');
      if (c.statuses.length) h('div', `statuses: ${c.statuses.join(', ')}`, muted);
      if (c.gear.length) h('div', `gear: ${c.gear.join(', ')}`, muted);
      for (const x of c.history.slice(-4)) h('div', `run ${x.run}: ${x.text}`, muted);
    }
    if (c && !c.alive) h('div', 'The hero is dead: the next run needs another (the world remembers).', 'margin-top:6px;font-size:12px');
    else btn('▶ Another run — the world as you left it', () => this.newPlan(c?.region ?? this.spawnRegion), true);
  }

  private drawOnMap(ctx: CanvasRenderingContext2D, px: (cx: number, cy: number) => [number, number], _scale: number): void {
    const done = this.path.at(-1)?.stage === this.at;
    for (const l of this.plan.legs) {
      const going = this.journey?.leg.id === l.id;
      const open = done && !this.journey && l.from === this.at;
      ctx.setLineDash(going || open ? [] : [6, 6]);
      ctx.lineWidth = going || open ? 4 : 2;
      ctx.strokeStyle = going ? '#fff3c4' : open ? '#f2c14e' : 'rgba(250,240,210,0.5)';
      ctx.beginPath();
      // (each point at its nearest copy on the torus: a leg crossing the seam would break, and none is half a world long)
      l.path.forEach((p, i) => {
        const [x, y] = px(...toCell(...p));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const s of this.plan.stages) {
      const [x, y] = px(...toCell(...s.at));
      ctx.fillStyle = 'rgba(20,16,10,0.9)';
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLOUR[s.encounter];
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1206';
      ctx.font = '700 13px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(GLYPH[s.encounter], x, y + 1);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  dispose(): void {
    this.card.remove();
    this.d.map.overlay = undefined;
    this.d.map.playerAt = undefined;
  }
}
