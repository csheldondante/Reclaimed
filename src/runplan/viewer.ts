// ---- runplan/viewer.ts ------------------------------------------------------------------------------------------
// (round 117, runplan) The run-plan viewer (DECISIONS round 117 part 4: "a VIEWER page per generator — seed, a few
// parameters, turn and zoom — just having a way to view that sounds great"). `?runplan=view&seed=1&hero=bike`.
// Seed and hero in; the atlas is made for the seed (on the GPU, as the game makes it), its facts and wiki read from
// it, the run planned on its region graph and drawn on the atlas map (the game map's own painter). Step through it:
// play a stage (pick an outcome), choose a leg, watch the travel animated on the map with its en-route events (stop or
// pass by), and at the end see what the run did to the world — the events, the regions as each generator will
// realise them, the hero's history, gear and statuses. "Next run" plans again from the world as left.
// The travel here waits on a stand-in loader (a few seconds a leg): the viewer has no streamer. In the level, the same
// Journey takes the streamer's precache (api/atlas-world.ts precacheWarp).

import type { EncounterKind, EnRouteEvent, RunPlan, RunRecord, RunStage, StageOutcome, TravelLeg } from '../api/contracts/run';
import type { AtlasEvent } from '../api/contracts/world';
import { MemoryWorldState } from '../api/contracts/world-state';
import { paintAtlasImage } from '../api/atlas-map';
import { Atlas, atlasParamsFrom } from '../atlas/atlas';
import { atlasFacts, type AtlasFacts } from '../gm/atlas-facts';
import { buildWiki, type WorldWiki } from '../gm/wiki';
import type { Host, Scene } from '../scenes/world-core';
import { finishRun, HERO_NAMES, realise } from './consequences';
import { factsGraph } from './graph';
import { HEROES, heroCaps } from './heroes';
import { planRun } from './plan';
import { Journey, type JourneyState, type Precacher } from './travel';

const ENC_COLOUR: Record<EncounterKind, string> = {
  race: '#f2c14e', chase: '#f08a4b', fight: '#e0483a', horde: '#9a6bd8', spectacle: '#4fd1c5', destruction: '#ff6f91',
  delve: '#c49a6c', talk: '#8fd16a', explore: '#7fb7f0', rescue: '#ffffff',
};
const ENC_GLYPH: Record<EncounterKind, string> = {
  race: '»', chase: '⇝', fight: '⚔', horde: '☠', spectacle: '✷', destruction: '✸', delve: '⛏', talk: '✉', explore: '⚐', rescue: '♡',
};
const EVENT_GLYPH: Record<EnRouteEvent['kind'], string> = { vista: '▲', poi: '★', ambush: '!', weather: '≈', traveller: '☺' };

const CSS = `
.rp-panel{position:absolute;right:0;top:0;bottom:0;width:360px;overflow:auto;background:rgba(18,16,12,0.92);color:#efe6d2;font:13px/1.4 system-ui,sans-serif;padding:10px 12px;box-sizing:border-box;touch-action:pan-y}
.rp-panel h2{font:600 16px Georgia,serif;margin:4px 0 6px}
.rp-panel h3{font:600 13px system-ui,sans-serif;margin:10px 0 4px;color:#f2c14e}
.rp-panel button{font:13px system-ui,sans-serif;min-height:36px;margin:3px 4px 3px 0;padding:4px 9px;border-radius:7px;border:1px solid #6b5b3e;background:#2a241a;color:#f3e8cf;text-align:left}
.rp-panel button.on{background:#6b4f1d;border-color:#f2c14e}
.rp-panel button.wide{display:block;width:100%}
.rp-panel .muted{color:#a99c80}
.rp-panel .ev{font-size:12px;color:#cfc3a6;margin:2px 0 2px 10px}
.rp-panel .card{background:rgba(255,240,200,0.06);border:1px solid #4a3f2c;border-radius:8px;padding:8px;margin:6px 0}
.rp-panel input{width:70px;font:13px system-ui;padding:4px;background:#2a241a;color:#eee;border:1px solid #6b5b3e;border-radius:5px}
.rp-toast{position:absolute;left:12px;top:12px;right:372px;pointer-events:none;color:#fbefcf;font:600 15px Georgia,serif;text-shadow:0 1px 3px #000}
.rp-zoom{position:absolute;left:12px;bottom:12px;display:flex;gap:6px}
.rp-zoom button{min-width:44px;height:44px;font:20px system-ui;border-radius:8px;border:1px solid #888;background:rgba(20,22,24,0.85);color:#eee}
@media (max-width:700px){.rp-panel{left:0;right:0;top:auto;width:auto;height:46%}.rp-toast{right:12px}.rp-zoom{bottom:calc(46% + 10px)}}
`;

/** the viewer's stand-in loader: each ask is ready a few seconds later (the level uses the streamer's precache) */
class FakeLoader implements Precacher {
  private due = new Map<string, number>();
  asked = 0;
  constructor(private seconds: number) {}
  precache(cx: number, cy: number): number {
    this.due.set(`${Math.round(cx)},${Math.round(cy)}`, performance.now() + this.seconds * 1000);
    this.asked++;
    return 1;
  }
  ready(cx: number, cy: number): boolean {
    return performance.now() >= (this.due.get(`${Math.round(cx)},${Math.round(cy)}`) ?? 0);
  }
}

type Step = { stage: string; outcome: string };

export class RunPlanView implements Scene {
  private canvas: HTMLCanvasElement;
  private panel: HTMLDivElement;
  private toast: HTMLDivElement;
  private img: HTMLCanvasElement;
  private els: HTMLElement[] = [];
  /** view: middle in map texels, texels a css px */
  private vx = 0;
  private vy = 0;
  private scale = 2;
  private want: { vx: number; vy: number; scale: number } | null = null;
  private graph;
  private world: MemoryWorldState;
  private hero: string;
  private plan!: RunPlan;
  private at!: string;
  private path: Step[] = [];
  private stops: { leg: string; event: string }[] = [];
  private journey: Journey | null = null;
  private jstate: JourneyState | null = null;
  private clock = 0;
  private record: RunRecord | null = null;
  private touched = new Map<number, AtlasEvent[]>();
  private error: string | null = null;
  private speed: number;
  /** what the page did, for scripts (window.reclaimed.runplan) */
  readonly log: string[] = [];

  private constructor(
    host: Host,
    private atlas: Atlas,
    facts: AtlasFacts,
    private wiki: WorldWiki,
  ) {
    this.graph = factsGraph(facts, { regions: wiki.regions, settlements: wiki.snapshot.settlements });
    this.world = MemoryWorldState.restore(structuredClone(wiki.snapshot));
    this.hero = host.params.get('hero') ?? 'bike';
    heroCaps(this.hero);
    this.speed = Number(host.params.get('travel') ?? 1);
    const style = document.createElement('style');
    style.textContent = CSS;
    host.ui.appendChild(style);
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;background:#0a0e14';
    host.ui.appendChild(this.canvas);
    this.toast = document.createElement('div');
    this.toast.className = 'rp-toast';
    host.ui.appendChild(this.toast);
    const zoom = document.createElement('div');
    zoom.className = 'rp-zoom';
    for (const [t, f] of [['+', 0.6], ['−', 1.6], ['◎', 0]] as [string, number][]) {
      const b = document.createElement('button');
      b.textContent = t;
      b.onclick = () => (f ? this.zoomBy(f) : this.fit());
      zoom.appendChild(b);
    }
    host.ui.appendChild(zoom);
    this.panel = document.createElement('div');
    this.panel.className = 'rp-panel';
    host.ui.appendChild(this.panel);
    this.els.push(style, this.canvas, this.toast, zoom, this.panel);
    this.img = paintAtlasImage(atlas);
    this.listen();
    this.newPlan();
    (window as unknown as { reclaimed: unknown }).reclaimed = { atlas, facts, wiki, runplan: this };
  }

  static async create(host: Host): Promise<RunPlanView> {
    const seed = host.params.get('seed');
    const p = atlasParamsFrom(host.params, seed ? { seed: Number(seed) } : {});
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = `Making the world (seed ${p.seed})…`;
    host.ui.appendChild(note);
    try {
      const atlas = await Atlas.build(host.gpu.device, p);
      const facts = atlasFacts(atlas);
      return new RunPlanView(host, atlas, facts, buildWiki(facts));
    } finally {
      note.remove();
    }
  }

  // ---- the run ---------------------------------------------------------------------------------------------------

  /** plan a run from the world as it is now */
  newPlan(): void {
    this.error = null;
    this.record = null;
    this.path = [];
    this.stops = [];
    this.journey = null;
    this.jstate = null;
    this.clock = 0;
    const t0 = performance.now();
    try {
      const me = this.world.character(this.hero);
      this.plan = planRun({ graph: this.graph, world: this.world.snapshot(), hero: heroCaps(this.hero), seed: this.atlas.p.seed, from: me?.region ?? this.wiki.spawn.region });
      this.at = this.plan.start;
      this.log.push(`plan ${this.plan.id} in ${(performance.now() - t0).toFixed(1)} ms: ${this.plan.stages.length} stages, ${this.plan.legs.length} legs, ${this.plan.minutes.min}-${this.plan.minutes.max} min`);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.fit();
    this.renderPanel();
  }

  private stage(id: string): RunStage {
    return this.plan.stages.find((s) => s.id === id)!;
  }

  private leg(id: string): TravelLeg {
    return this.plan.legs.find((l) => l.id === id)!;
  }

  /** the outcome of the stage the player is at */
  choose(outcomeId: string): void {
    const s = this.stage(this.at);
    const o = s.outcomes.find((x) => x.id === outcomeId)!;
    this.path.push({ stage: s.id, outcome: o.id });
    this.clock += s.minutes;
    this.log.push(`${s.id}: ${o.id} (${o.ends})`);
    if (o.ends !== 'continue') this.end();
    else this.renderPanel();
  }

  /** set off on a leg out of the stage played */
  travel(legId: string): void {
    const l = this.leg(legId);
    const to = this.stage(l.to);
    this.journey = new Journey(l, to.section.at, new FakeLoader(2.5 + l.route.length * 0.15), (x, y) => [x, y], this.speed);
    this.jstate = null;
    this.log.push(`travel ${l.id}`);
    this.renderPanel();
  }

  answer(stop: boolean): void {
    if (!this.journey || this.jstate?.phase !== 'event') return;
    if (stop) this.stops.push({ leg: this.journey.leg.id, event: this.jstate.event.id });
    this.journey.answer(stop);
    this.renderPanel();
  }

  /** end the run (as the last outcome said, or a failure the player picks: death, capture, the clock) */
  end(how?: RunRecord['end']): void {
    const before = new Map<number, string>();
    this.record = finishRun(this.world, this.plan, this.path, how, this.stops);
    void before;
    this.touched.clear();
    for (const e of this.record.events) for (const r of e.regions) this.touched.set(r, [...(this.touched.get(r) ?? []), e]);
    this.journey = null;
    this.log.push(`end ${this.record.end}: ${this.record.events.length} events, ${this.touched.size} regions`);
    this.renderPanel();
  }

  setHero(role: string): void {
    this.hero = role;
    this.newPlan();
  }

  /** for scripts: play the first outcome and the first leg all the way to the end, instantly */
  autoplay(pick = 0): RunRecord {
    let guard = 0;
    while (!this.record && guard++ < 50) {
      const s = this.stage(this.at);
      const o = s.outcomes[Math.min(pick, s.outcomes.length - 1)];
      this.choose(o.id);
      if (this.record) break;
      const l = this.leg(s.next[0]);
      this.at = l.to;
      this.clock += l.minutes;
    }
    return this.record!;
  }

  // ---- the panel --------------------------------------------------------------------------------------------------

  private renderPanel(): void {
    const P = this.panel;
    P.innerHTML = '';
    const h = (tag: string, text: string, cls?: string) => {
      const e = document.createElement(tag);
      e.textContent = text;
      if (cls) e.className = cls;
      P.appendChild(e);
      return e;
    };
    const btn = (text: string, f: () => void, cls?: string) => {
      const b = document.createElement('button');
      b.textContent = text;
      if (cls) b.className = cls;
      b.onclick = f;
      P.appendChild(b);
      return b;
    };
    // (not world.snapshot(): that clones every region's state — 30 ms a panel; the panel reads what it shows)
    h('h2', `Run plan · seed ${this.atlas.p.seed} · run ${this.world.run + (this.record ? 0 : 1)}`);
    const row = document.createElement('div');
    for (const role of Object.keys(HEROES)) {
      const c = this.world.character(role);
      const b = document.createElement('button');
      b.textContent = `${HERO_NAMES[role] ?? role}${c && !c.alive ? ' ✝' : c?.statuses.some((s) => s.startsWith('captive')) ? ' ⛓' : ''}`;
      if (role === this.hero) b.className = 'on';
      b.onclick = () => this.setHero(role);
      row.appendChild(b);
    }
    P.appendChild(row);
    const seedRow = document.createElement('div');
    seedRow.innerHTML = `<span class="muted">seed </span>`;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.value = String(this.atlas.p.seed);
    const go = document.createElement('button');
    go.textContent = 'Make world';
    go.onclick = () => {
      const q = new URLSearchParams(location.search);
      q.set('seed', inp.value);
      q.set('hero', this.hero);
      location.search = q.toString();
    };
    seedRow.append(inp, go);
    P.appendChild(seedRow);
    if (this.error) {
      h('div', this.error, 'card');
      return;
    }
    const p = this.plan;
    h('div', `${p.stages.length} stages · ${p.legs.length} legs · a path ${p.minutes.min.toFixed(0)}–${p.minutes.max.toFixed(0)} min · the clock runs out at ${p.deadline} min · now ${this.clock.toFixed(1)} min`, 'muted');
    for (const n of p.notes) h('div', n, 'ev');

    if (this.record) return this.renderEnd(h, btn);

    const s = this.stage(this.at);
    if (this.journey) {
      const l = this.journey.leg;
      h('h3', `Travelling to ${this.stage(l.to).name}`);
      h('div', `${l.route.length} regions · ${l.minutes} min · ${l.crossings.map((c) => `${c.barrier}: ${c.how}`).join('; ') || 'open road'}`, 'muted');
      const st = this.jstate;
      if (st?.phase === 'event') {
        const card = h('div', '', 'card');
        card.textContent = `${EVENT_GLYPH[st.event.kind]} ${st.event.text}`;
        btn(st.event.kind === 'ambush' ? 'Fight through' : 'Stop', () => this.answer(true));
        btn('Pass by', () => this.answer(false));
      } else if (st?.phase === 'waiting') h('div', 'Arriving… (the land is still loading: the travel waits for it)', 'muted');
      return;
    }
    const played = this.path.at(-1)?.stage === s.id;
    h('h3', played ? `Done: ${s.name}` : s.name);
    h('div', `${ENC_GLYPH[s.encounter]} ${s.encounter} · ${s.minutes} min · ${s.brief}`, 'muted');
    if (!played) {
      for (const o of s.outcomes) {
        const b = btn(`${o.text}${o.ends !== 'continue' ? ` (the run ends: ${o.ends})` : ''}`, () => this.choose(o.id), 'wide');
        b.title = describe(o);
        const d = document.createElement('div');
        d.className = 'ev';
        d.textContent = describe(o);
        P.appendChild(d);
      }
    } else {
      h('h3', 'Where next');
      for (const lid of s.next) {
        const l = this.leg(lid);
        const t = this.stage(l.to);
        btn(`${ENC_GLYPH[t.encounter]} ${t.name} — ${l.minutes} min, ${l.events.length} on the road`, () => this.travel(lid), 'wide');
      }
    }
    h('h3', 'Or fail');
    btn('Die here', () => this.end('lost'));
    btn('Captured', () => this.end('captured'));
    btn(this.clock > p.deadline ? 'Too late (the clock ran out)' : 'Run out the clock', () => this.end('late'));
  }

  private renderEnd(h: (tag: string, text: string, cls?: string) => HTMLElement, btn: (text: string, f: () => void, cls?: string) => HTMLButtonElement): void {
    const r = this.record!;
    h('h3', `The run ended: ${r.end}`);
    for (const d of r.deeds) h('div', `• ${d}`, 'ev');
    btn(`Next run (${HERO_NAMES[this.hero] ?? this.hero})`, () => this.newPlan(), 'wide');
    h('h3', 'What the world will remember');
    const me = this.world.character(this.hero);
    if (me) {
      h('div', `${me.name}: ${me.alive ? 'alive' : 'dead'}${me.statuses.length ? ` · ${me.statuses.join(', ')}` : ''}${me.gear.length ? ` · gear: ${me.gear.join(', ')}` : ''}`);
      for (const x of me.history.slice(-4)) h('div', `run ${x.run}: ${x.text}`, 'ev');
    }
    const others = this.world.characters().filter((c) => c.id !== this.hero && c.history.some((x) => x.run === r.run));
    for (const c of others) h('div', `${c.name} (${c.role}): ${Object.entries(c.relationships).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`, 'ev');
    const factions = this.factions();
    for (const f of factions) {
      const ev = r.events.filter((e) => e.detail?.faction === f.id);
      if (ev.length) h('div', `${f.name}: attitude ${f.attitude.toFixed(2)}, power ${(f.power ?? 0.5).toFixed(2)} (${ev.map((e) => e.kind).join(', ')})`, 'ev');
    }
    h('h3', `Regions changed (${this.touched.size})`);
    const shown = [...this.touched.keys()].slice(0, 14);
    for (const id of shown) {
      const n = this.graph.node(id);
      if (!n) continue;
      const re = realise(n, this.world.region(id), factions);
      const parts: string[] = [];
      for (const f of re.terrain.fills) parts.push(`terrain: ${f.material} fill to z ${f.level.toFixed(0)}`);
      if (re.structures.ruin > 0.05) parts.push(`structures: ruin ${re.structures.ruin.toFixed(2)}`);
      if (re.structures.marks.length) parts.push(`marks: ${re.structures.marks.map((m) => m.name).join(', ')}`);
      if (re.inhabitants.undead > 0.05) parts.push(`inhabitants: undead ${re.inhabitants.undead.toFixed(2)}`);
      if (re.sky.shadow > 0.05) parts.push(`sky: shadow ${re.sky.shadow.toFixed(2)}`);
      if (re.sky.storm.strength > 0.05) parts.push(`sky: ${re.sky.storm.kind} storm ${re.sky.storm.strength.toFixed(2)}`);
      const pres = Object.entries(re.inhabitants.presence).filter(([, v]) => (v ?? 0) > 0.05).map(([k, v]) => `${k} ${v!.toFixed(2)}`);
      if (pres.length) parts.push(`presence: ${pres.join(', ')}`);
      h('div', `${n.name}: ${parts.join(' · ') || '(factions only)'}`, 'ev');
    }
    if (this.touched.size > shown.length) h('div', `… and ${this.touched.size - shown.length} more (tinted on the map)`, 'muted');
  }

  /** the world's factions as they are now */
  private factions() {
    return this.wiki.factions.map((f) => this.world.faction(f.id)!).filter(Boolean);
  }

  // ---- the map ----------------------------------------------------------------------------------------------------

  private get n(): number {
    return this.atlas.p.n;
  }

  /** world units → css px (the map's convention: north up, world +x to the left), nearest copy on the torus of `ref` */
  private px(wx: number, wy: number, W: number, H: number): [number, number] {
    const n = this.n;
    let dx = (wx / this.atlas.worldW) * n - this.vx;
    let dy = (wy / this.atlas.worldH) * n - this.vy;
    dx -= Math.round(dx / n) * n;
    dy -= Math.round(dy / n) * n;
    return [W / 2 - dx / this.scale, H / 2 + dy / this.scale];
  }

  /** a polyline (world units, unwrapped) as css px: the first point's nearest copy, the rest following it */
  private line(path: [number, number][], W: number, H: number): [number, number][] {
    const [x0, y0] = this.px(path[0][0], path[0][1], W, H);
    const k = this.n / this.scale;
    return path.map(([x, y]) => [x0 - ((x - path[0][0]) / this.atlas.worldW) * k, y0 + ((y - path[0][1]) / this.atlas.worldH) * k]);
  }

  private fit(): void {
    if (!this.plan || this.error) {
      const sp = this.graph.node(this.wiki.spawn.region)?.centre ?? [0, 0];
      this.vx = (sp[0] / this.atlas.worldW) * this.n;
      this.vy = (sp[1] / this.atlas.worldH) * this.n;
      return;
    }
    const pts = this.plan.legs.flatMap((l) => l.path);
    if (!pts.length) pts.push(this.plan.stages[0].at);
    const tx = pts.map((p) => (p[0] / this.atlas.worldW) * this.n);
    const ty = pts.map((p) => (p[1] / this.atlas.worldH) * this.n);
    const [lx, hx, ly, hy] = [Math.min(...tx), Math.max(...tx), Math.min(...ty), Math.max(...ty)];
    const r = this.canvas.getBoundingClientRect();
    const phone = r.width <= 700;
    const W = phone ? r.width : r.width - 360;
    const H = phone ? r.height * 0.54 : r.height;
    this.want = null;
    this.vx = (lx + hx) / 2;
    this.vy = (ly + hy) / 2;
    this.scale = Math.max(0.05, Math.max((hx - lx) / Math.max(100, W - 60), (hy - ly) / Math.max(100, H - 80)));
    // (the map's middle is the canvas's: shift so the plan sits in the part the panel leaves)
    // (+x is to the screen's left: the plan's middle moved 180 px left of the canvas's means a view middle to its east)
    if (!phone) this.vx -= 180 * this.scale;
    else this.vy += r.height * 0.23 * this.scale;
  }

  private zoomBy(f: number): void {
    this.scale = Math.min(8, Math.max(0.03, this.scale * f));
  }

  private listen(): void {
    let down: { x: number; y: number; vx: number; vy: number } | null = null;
    const touches = new Map<number, [number, number]>();
    let pinch: { d: number; s: number } | null = null;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      c.setPointerCapture(e.pointerId);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: this.scale };
        down = null;
      } else down = { x: e.clientX, y: e.clientY, vx: this.vx, vy: this.vy };
      this.want = null;
    });
    c.addEventListener('pointermove', (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        this.scale = Math.min(8, Math.max(0.03, (pinch.s * pinch.d) / Math.max(10, Math.hypot(a[0] - b[0], a[1] - b[1]))));
      } else if (down) {
        this.vx = down.vx + (e.clientX - down.x) * this.scale;
        this.vy = down.vy - (e.clientY - down.y) * this.scale;
      }
    });
    const up = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      down = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY > 0 ? 1.2 : 0.83);
    }, { passive: false });
  }

  frame(_now: number, dt: number): void {
    if (this.journey) {
      const prev = this.jstate?.phase;
      const prevEvent = this.jstate?.phase === 'event' ? this.jstate.event.id : null;
      this.jstate = this.journey.update(dt);
      const st = this.jstate;
      // the camera rides along; a vista draws it in close (the user's "fade between pretty views along the road")
      const tx = (st.at[0] / this.atlas.worldW) * this.n;
      const ty = (st.at[1] / this.atlas.worldH) * this.n;
      const close = st.phase === 'event' && st.event.kind === 'vista';
      this.want = { vx: tx, vy: ty, scale: close ? Math.min(this.scale, 0.35) : Math.max(this.scale, 0.8) };
      if (st.phase === 'arrived') {
        this.at = this.journey.leg.to;
        this.clock += this.journey.leg.minutes;
        this.log.push(`arrived ${this.at} (waited ${this.journey.waited.toFixed(1)} s for the land)`);
        this.journey = null;
        this.want = null;
        this.renderPanel();
      } else if (st.phase !== prev || (st.phase === 'event' && st.event.id !== prevEvent)) this.renderPanel();
    }
    if (this.want) {
      const k = 1 - Math.exp(-dt * 3);
      // (the nearest copy on the torus)
      const n = this.n;
      let dx = this.want.vx - this.vx;
      let dy = this.want.vy - this.vy;
      dx -= Math.round(dx / n) * n;
      dy -= Math.round(dy / n) * n;
      this.vx += dx * k;
      this.vy += dy * k;
      this.scale += (this.want.scale - this.scale) * k;
    }
    this.draw();
  }

  private draw(): void {
    const c = this.canvas;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, W, H);
    const n = this.n;
    const k = 1 / this.scale;
    ctx.imageSmoothingEnabled = this.scale > 1;
    const ox = W / 2 + this.vx * k;
    const oy = H / 2 - this.vy * k;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const x = ox - i * n * k;
        const y = oy + j * n * k;
        if (x - n * k > W || y > H || x < 0 || y + n * k < 0) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(-1, 1);
        ctx.drawImage(this.img, 0, 0, n * k, n * k);
        ctx.restore();
      }
    if (!this.plan || this.error) return;
    const texel = this.atlas.worldW / n;
    // the regions the last run changed: tinted by what changed most
    for (const [id, evs] of this.touched) {
      const node = this.graph.node(id);
      if (!node) continue;
      const kinds = new Set(evs.map((e) => e.kind));
      const col = kinds.has('sink') || kinds.has('flood') ? '60,140,230' : kinds.has('raise-dead') ? '150,80,220' : kinds.has('shadow') ? '20,10,40' : kinds.has('bury') ? '230,200,120' : kinds.has('ruin') ? '220,70,50' : kinds.has('mark') ? '250,230,120' : '240,240,240';
      const [x, y] = this.px(node.centre[0], node.centre[1], W, H);
      const r = (Math.sqrt(node.area / Math.PI) * texel) / (this.atlas.worldW / n) / this.scale;
      ctx.fillStyle = `rgba(${col},0.38)`;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, r), 0, Math.PI * 2);
      ctx.fill();
    }
    const visited = new Set(this.path.map((p) => p.stage));
    const here = this.stage(this.at);
    const done = this.path.at(-1)?.stage === this.at;
    const travelled = new Set<string>();
    for (let i = 1; i < this.path.length; i++) travelled.add(`${this.path[i - 1].stage}-${this.path[i].stage}`);
    // the legs: open choices bright, travelled solid, the rest dim and dashed
    for (const l of this.plan.legs) {
      const pts = this.line(l.path, W, H);
      const open = done && l.from === this.at && !this.journey;
      const going = this.journey?.leg.id === l.id;
      const past = travelled.has(l.id);
      ctx.setLineDash(open || going || past ? [] : [6, 6]);
      ctx.lineWidth = open || going ? 4 : past ? 3 : 2;
      ctx.strokeStyle = going ? '#fff3c4' : open ? '#f2c14e' : past ? '#d8a25a' : 'rgba(250,240,210,0.45)';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 3;
      ctx.stroke();
      ctx.shadowBlur = 0;
      // the en-route events: small glyphs on the road
      for (const e of l.events) {
        const [ex, ey] = this.line([l.path[0], e.at], W, H)[1];
        ctx.fillStyle = 'rgba(20,16,10,0.85)';
        ctx.beginPath();
        ctx.arc(ex, ey, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = e.kind === 'ambush' ? '#ff7a6a' : '#fbefcf';
        ctx.font = '600 10px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(EVENT_GLYPH[e.kind], ex, ey + 0.5);
      }
    }
    ctx.setLineDash([]);
    // the stages
    for (const s of this.plan.stages) {
      const [x, y] = this.px(s.at[0], s.at[1], W, H);
      const finale = !s.next.length;
      const R = finale ? 15 : 12;
      ctx.fillStyle = 'rgba(20,16,10,0.9)';
      ctx.beginPath();
      ctx.arc(x, y, R + 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ENC_COLOUR[s.encounter];
      ctx.globalAlpha = visited.has(s.id) || s.id === this.at ? 1 : 0.8;
      ctx.beginPath();
      ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (s.id === this.at && !this.journey) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, R + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#1a1206';
      ctx.font = `700 ${finale ? 16 : 14}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ENC_GLYPH[s.encounter], x, y + 1);
      ctx.font = '600 12px Georgia, serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(20,14,8,0.9)';
      const label = s.name.replace(/^(A |An |The )/, '');
      ctx.strokeText(label, x, y - R - 10);
      ctx.fillStyle = '#fbefcf';
      ctx.fillText(label, x, y - R - 10);
    }
    // the traveller
    if (this.jstate && this.journey) {
      const [x, y] = this.line([this.journey.leg.path[0], this.jstate.at], W, H)[1];
      ctx.fillStyle = '#ff3030';
      ctx.strokeStyle = '#2a0a06';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (here && !this.record) {
      void here;
    }
    this.toast.textContent = this.jstate?.phase === 'event' ? `${EVENT_GLYPH[this.jstate.event.kind]} ${this.jstate.event.text}` : this.record ? `The run ended: ${this.record.end}` : '';
  }

  resize(): void {}

  dispose(): void {
    for (const e of this.els) e.remove();
  }
}

/** an outcome's effects in a line (what the viewer shows under each choice) */
export function describe(o: StageOutcome): string {
  const parts: string[] = [];
  for (const a of o.effects.atlas ?? []) {
    const f = a.detail?.faction ? ` ${String(a.detail.faction).replace(/^f-/, '')}` : '';
    parts.push(`${a.kind}${f} ${a.kind === 'bury' ? `${a.magnitude} cells` : a.magnitude > 0 ? `+${a.magnitude}` : a.magnitude}${a.regions.length > 1 ? ` ×${a.regions.length} regions` : ''}`);
  }
  for (const c of o.effects.characters ?? []) {
    if (c.kind === 'gear' && c.add) parts.push(`gear: ${c.add.join(', ')}`);
    if (c.kind === 'status' && c.add) parts.push(`status: ${c.add.join(', ')}`);
    if (c.kind === 'meet') parts.push(`meet ${c.character.name}`);
    if (c.kind === 'die') parts.push(`${c.id} dies`);
  }
  return parts.join(' · ') || 'nothing lasting';
}
