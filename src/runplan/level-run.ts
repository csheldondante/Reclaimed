// ---- runplan/level-run.ts ---------------------------------------------------------------------------------------
// (round 117, runplan; BACKLOG RP5, RC2, RC3) A planned run in the level: `?level=atlas&runplan=bike`. The run is
// planned from the spawn's region on this atlas (its facts and wiki read from the live atlas, so any seed works);
// a card says where the player is and what the stage is about; how a stage goes is picked from its outcomes (the
// stage's play itself is the play track's — the card stands in for it); then the player picks a leg out and the travel
// plays on the atlas map: the run's legs and stages drawn over the game's own map, the marker moving along the road,
// each en-route event held until answered — while the streamer makes the destination's land (precacheWarp). It
// arrives when the animation is done and the land is ready (warpReady), then warps there.
// The user (round 115): "have the player use the atlas map to travel from location to location. We can precache the
// locations they go to and animate travel on that map while we load in the background."

import type { EncounterKind, RunPlan, RunRecord, RunStage } from '../api/contracts/run';
import { MemoryWorldState } from '../api/contracts/world-state';
import type { AtlasMap } from '../api/atlas-map';
import type { Atlas } from '../atlas/atlas';
import { atlasFacts } from '../gm/atlas-facts';
import { buildWiki } from '../gm/wiki';
import { ROW_H } from '../world/lattice';
import { finishRun } from './consequences';
import { factsGraph } from './graph';
import { heroCaps } from './heroes';
import { planRun } from './plan';
import { Journey, type JourneyState } from './travel';
import { describe } from './viewer-text';

const GLYPH: Record<EncounterKind, string> = {
  race: '»', chase: '⇝', fight: '⚔', horde: '☠', spectacle: '✷', destruction: '✸', delve: '⛏', talk: '✉', explore: '⚐', rescue: '♡',
};
const COLOUR: Record<EncounterKind, string> = {
  race: '#f2c14e', chase: '#f08a4b', fight: '#e0483a', horde: '#9a6bd8', spectacle: '#4fd1c5', destruction: '#ff6f91',
  delve: '#c49a6c', talk: '#8fd16a', explore: '#7fb7f0', rescue: '#ffffff',
};

export interface LevelRunDeps {
  atlas: Atlas;
  map: AtlasMap;
  ui: HTMLElement;
  hero: string;
  /** the streamer's: ask for a warp's land ahead, is it ready, warp there (world cells) */
  precache: (cx: number, cy: number) => number;
  ready: (cx: number, cy: number) => boolean;
  warp: (cx: number, cy: number) => Promise<void>;
  say: (s: string, seconds?: number) => void;
}

/** world units (the atlas's, the plan's) → world cells (the streamer's, the map's) */
const toCell = (x: number, y: number): [number, number] => [x, y / ROW_H];

export class LevelRun {
  readonly plan: RunPlan;
  readonly world: MemoryWorldState;
  at: string;
  private path: { stage: string; outcome: string }[] = [];
  private stops: { leg: string; event: string }[] = [];
  journey: Journey | null = null;
  jstate: JourneyState | null = null;
  record: RunRecord | null = null;
  private card: HTMLDivElement;
  private warping = false;
  private travelScale = 1;
  readonly log: string[] = [];

  constructor(private d: LevelRunDeps) {
    const facts = atlasFacts(d.atlas);
    const wiki = buildWiki(facts);
    const graph = factsGraph(facts, { regions: wiki.regions, settlements: wiki.snapshot.settlements });
    this.world = MemoryWorldState.restore(structuredClone(wiki.snapshot));
    const t0 = performance.now();
    this.plan = planRun({ graph, world: this.world.snapshot(), hero: heroCaps(d.hero), seed: d.atlas.p.seed, from: wiki.spawn.region });
    this.log.push(`plan ${this.plan.id} in ${(performance.now() - t0).toFixed(1)} ms`);
    this.at = this.plan.start;
    this.card = document.createElement('div');
    this.card.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;width:min(92vw,420px);max-height:44vh;overflow:auto;z-index:60;background:rgba(18,16,12,0.9);color:#efe6d2;font:13px/1.4 system-ui,sans-serif;padding:8px 10px;border-radius:9px;border:1px solid #5a4a30;';
    d.ui.appendChild(this.card);
    d.map.canWarp = false;
    d.map.overlay = (ctx, px, scale) => this.drawOnMap(ctx, px, scale);
    d.map.playerAt = () => (this.jstate ? toCell(...this.jstate.at) : null);
    this.render();
  }

  private stage(id: string): RunStage {
    return this.plan.stages.find((s) => s.id === id)!;
  }

  choose(outcome: string): void {
    const s = this.stage(this.at);
    const o = s.outcomes.find((x) => x.id === outcome)!;
    this.path.push({ stage: s.id, outcome: o.id });
    this.log.push(`${s.id}: ${o.id}`);
    if (o.ends !== 'continue') this.end();
    else this.render();
  }

  travel(legId: string): void {
    const l = this.plan.legs.find((x) => x.id === legId)!;
    const to = this.stage(l.to);
    const t0 = performance.now();
    this.journey = new Journey(l, to.section.at, { precache: (x, y) => { const n = this.d.precache(x, y); this.log.push(`precache ${n} regions round ${to.id} (${(performance.now() - t0).toFixed(1)} ms)`); return n; }, ready: this.d.ready }, toCell);
    this.jstate = null;
    this.log.push(`travel ${l.id}`);
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
        this.d.map.close();
        this.d.say(`${GLYPH[to.encounter]} ${to.name}`, 4);
        this.render();
      });
    } else if (st.phase !== prev || (st.phase === 'event' && st.event.id !== prevEv)) this.render();
  }

  private render(): void {
    const C = this.card;
    C.innerHTML = '';
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
    const btn = (text: string, f: () => void) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = 'display:block;width:100%;text-align:left;min-height:40px;margin:4px 0;padding:6px 9px;border-radius:7px;border:1px solid #6b5b3e;background:#2a241a;color:#f3e8cf;font:13px system-ui,sans-serif;';
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.onclick = (e) => {
        e.stopPropagation();
        f();
      };
      C.appendChild(b);
      return b;
    };
    const muted = 'color:#a99c80;font-size:12px';
    if (this.record) {
      h('div', `The run ended: ${this.record.end}`, 'font:600 15px Georgia,serif');
      for (const d of this.record.deeds) h('div', `• ${d}`, muted);
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
    const played = this.path.at(-1)?.stage === s.id;
    h('div', `${GLYPH[s.encounter]} ${s.name}`, `font:600 14px Georgia,serif;color:${COLOUR[s.encounter]}`);
    h('div', `${s.minutes} min · ${s.brief}`, muted);
    if (!played) {
      h('div', 'How it went (the stage’s play is the play track’s; pick for now):', 'margin-top:4px;font-size:12px');
      for (const o of s.outcomes) {
        btn(o.text, () => this.choose(o.id)).title = describe(o);
      }
    } else {
      h('div', 'Where next — travel on the map:', 'margin-top:4px;font-size:12px');
      for (const lid of s.next) {
        const l = this.plan.legs.find((x) => x.id === lid)!;
        const t = this.stage(l.to);
        btn(`${GLYPH[t.encounter]} ${t.name} (${l.events.length} on the road)`, () => this.travel(lid));
      }
    }
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
