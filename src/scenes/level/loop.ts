// (loop-skeleton; docs/design/LOOP_SKELETON.md) ?loop=1: the main game loop's walking skeleton on the town the level
// opens on. Pick a leader → the town → named people ask (petitions: the opportunity cards) → agree by committing the
// cost → Next season (the season loop's time-lapse) → the threat's countdown ends → the attack plays with the soldiers
// built, spells cast → the end of the run → a new run in the same world. World changes (the mutators' contract) are
// applied and saved at once whenever a card is agreed or runs out, in the town or far away; one in the town gets a short
// reveal with the camera on it. This file is the wiring only: the rules are season/run.ts (pure), the pools the season ledger, the
// building and the fight the season loop and its war, the screens season/run-ui.ts, every line season/run-words.ts.
// `window.rungame` for scripts.
import type { FieldTowns } from '../../citygen/towns';
import { lose, newLedger, pools, total, type SeasonLedger } from '../../season/ledger';
import type { SeasonLoop } from '../../season/loop';
import type { Mutators } from '../../season/mutation';
import { comesHome, decodeWorld, encode, endRun, endSeason, fought, mutate, newRun, newWorld, play, raidDue, startLedger, threatDone, type Mutation, type Petition, type RunRecord, type SpellId, type WorldChange, type WorldRecord } from '../../season/run';
import { mountRunUi, type Marker, type Phase, type RunGame } from '../../season/run-ui';
import * as W from '../../season/run-words';
import { WAVE_NO_ROAD } from '../../season/words';
import { StoryCamera, type V3 } from '../../story/camera';
import type { LevelScene } from '../level';
import { standinMutators } from './loop-standin';
import { startSeasonLoop, storeReady } from './season';

const WORLD_KEY = 'loop:world';
const MUTATORS_KEY = 'loop:mutators';
/** the sim's speed while the raiders march in (they walk from outside the town) */
const MARCH_SPEED = 3;
/** seconds raiders stay in a town with no soldier left before the fight is called */
const SACK_SECONDS = 5;
/** wall seconds an attack may take at most before it is called as it stands */
const ATTACK_SECONDS = 150;
/** a spell's blow: its radius (cells), its damage, its cost */
const HEATRAY = { radius: 5, damage: 3, magic: 1 };

class Game implements RunGame {
  phase: Phase = 'boot';
  run: RunRecord | null = null;
  world: WorldRecord = newWorld();
  selected: Petition | null = null;
  notes: string[] = [];
  fightLine: string | null = null;
  resultLines: string[] = [];
  change: { text: string; standin: boolean } | null = null;
  armed: SpellId | null = null;
  readonly onChange: (() => void)[] = [];
  private cam: StoryCamera;
  private mutators: Mutators;
  /** the attack under way: when it began (s), when the town was first left with no soldier, the raiders watched */
  private attack: { t: number; sackAt: number | null; unwatch: (() => void) | null; following: boolean } | null = null;
  /** world changes in the town applied and recorded, their reveals not yet played */
  private reveals: { text: string; frame: [number, number]; radius: number; play?: () => { done: Promise<void> } }[] = [];
  /** the end screen left to look at a change's place */
  looking: WorldChange | null = null;
  private speed0 = 1;

  constructor(
    private scene: LevelScene,
    private towns: FieldTowns,
    private season: SeasonLoop,
  ) {
    this.cam = new StoryCamera(scene.core.camera, scene.storyCut ?? {});
    // (a shot's points are window coordinates: they slide with the window)
    scene.core.onShift.push((dx, dy, dz) => this.cam.shift(dx, dy, dz));
    // (the stand-in until the `mutators` branch merges: season/mutation.ts)
    this.mutators = standinMutators(scene.core);
    season.onChange.push(() => this.changed());
    let last = performance.now();
    const tick = (now: number) => {
      requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.cam.update(dt);
      this.watchFight(dt);
    };
    requestAnimationFrame(tick);
    scene.host.canvas.addEventListener('pointerdown', (e) => this.cast(e), true);
  }

  get ledger(): SeasonLedger {
    return this.season.ledger;
  }
  get canSkip(): boolean {
    return this.season.playing;
  }
  private changed(): void {
    for (const f of this.onChange) f();
  }
  private set(phase: Phase): void {
    this.phase = phase;
    this.changed();
  }

  // ---- the town's places ------------------------------------------------------------------------------

  private get town() {
    return this.season.town !== null ? this.towns.live.get(this.season.town) : undefined;
  }

  private z(x: number, y: number): number {
    return this.scene.heightAt(x, y) ?? this.scene.core.camera.target[2];
  }

  /** a named part of the town as a window point */
  private spot(s: NonNullable<Mutation['near']>['spot'], share = 0.45): [number, number] | null {
    const t = this.town;
    if (!t) return null;
    const c = t.centreInWindow();
    const R = t.box.R * share;
    if (s === 'centre') return c;
    if (s === 'east') return [c[0] + R, c[1]];
    if (s === 'west') return [c[0] - R, c[1]];
    if (s === 'north') return [c[0], c[1] - R];
    // (the lowest ground of a ring round the centre, from the level's own height reader)
    let best: [number, number] = c;
    let low = Infinity;
    for (let k = 0; k < 16; k++) {
      const p: [number, number] = [c[0] + Math.cos((k * Math.PI) / 8) * R, c[1] + Math.sin((k * Math.PI) / 8) * R];
      const z = this.scene.heightAt(p[0], p[1]);
      if (z !== null && z < low) [low, best] = [z, p];
    }
    return best;
  }

  /** where a petition's character stands: a fixed place in the town's core for each (the threat: out on the east road) */
  private stand(p: Petition): [number, number] | null {
    const t = this.town;
    if (!t) return null;
    if (p.threat) return this.spot('east', 0.4);
    const i = W.PETITIONS.indexOf(p);
    const c = t.centreInWindow();
    const r = t.box.R * (0.1 + 0.035 * (i % 6));
    return [c[0] + Math.cos(i * 2.399) * r, c[1] + Math.sin(i * 2.399) * r];
  }

  markers(): Marker[] {
    const t = this.town;
    const cam = this.scene.core.camera;
    if (!t || !this.run || this.phase === 'leader' || (this.phase === 'end' && !this.looking) || this.phase === 'boot') return [];
    const out: Marker[] = [];
    const put = (id: string, label: string, kind: Marker['kind'], at: [number, number]) => {
      const [x, y] = cam.project(at[0], at[1], this.z(at[0], at[1]));
      if (x > -50 && y > -50 && x < innerWidth + 50 && y < innerHeight + 50) out.push({ id, label, kind, x, y });
    };
    for (const c of this.world.changes) if (c.near?.town === t.site.name) put(c.id, W.changeTag(c), 'change', t.inWindow(c.near.at));
    if (this.phase === 'city' || this.phase === 'petition')
      for (const h of this.run.hand) {
        const p = W.PETITIONS.find((x) => x.id === h.id)!;
        const at = this.stand(p);
        if (at) put(p.id, W.markerLabel(p), p.threat ? 'threat' : 'ask', at);
      }
    return out;
  }

  private at3(p: [number, number]): V3 {
    return [p[0], p[1], this.z(p[0], p[1])];
  }

  // ---- saving -----------------------------------------------------------------------------------------

  async load(): Promise<void> {
    const st = await storeReady(this.scene);
    if (st?.has(WORLD_KEY)) this.world = decodeWorld(await st.get(WORLD_KEY));
    if (st?.has(MUTATORS_KEY)) this.mutators.restore(JSON.parse(new TextDecoder().decode(await st.get(MUTATORS_KEY))));
    console.log(`[loop] world: ${this.world.runs} runs before, ${this.world.changes.length} changes`);
    this.set('leader');
  }

  private async save(): Promise<void> {
    const st = this.scene.stream?.store;
    if (!st) return;
    await st.put(WORLD_KEY, encode(this.world), { session: 'loop', hash: 0 });
    await st.put(MUTATORS_KEY, new TextEncoder().encode(JSON.stringify(this.mutators.record())), { session: 'loop', hash: 0 });
  }

  // ---- the player's moves -----------------------------------------------------------------------------

  pick(id: string): void {
    const who = W.leader(id);
    const before = this.world.runs > 0 ? this.season.ledger : null;
    const { run, world } = newRun(who, W.PETITIONS, this.world, (this.world.runs + 1) * 7919 + W.LEADERS.indexOf(who));
    this.run = run;
    this.world = world;
    this.notes = [];
    this.resultLines = [];
    this.season.setLedger(startLedger(who, before, newLedger));
    void this.save();
    console.log(`[loop] run ${run.n}: ${who.name}; hand ${run.hand.map((h) => h.id).join(', ')}`);
    this.set('city');
    // (the town framed above the sheet: its core across the screen)
    const t = this.town;
    if (t) void this.cam.look(this.at3(t.centreInWindow()), { zoom: innerWidth / (0.9 * t.box.R), place: [0.5, 0.36], ease: 1.2 });
  }

  open(id: string): void {
    if (this.phase !== 'city' && this.phase !== 'petition') return;
    const p = W.PETITIONS.find((x) => x.id === id);
    if (!p || !this.run?.hand.some((h) => h.id === id)) return;
    this.selected = p;
    const at = this.stand(p);
    // (the story camera's frame: the place above the card sheet. No cutaway in this level yet — a plain zoom)
    if (at) void this.cam.frame(this.at3(at), { zoom: Math.max(6, this.scene.core.camera.zoom * (this.phase === 'city' ? 2.2 : 1)), place: [0.5, 0.25] });
    this.set('petition');
  }

  back(): void {
    this.selected = null;
    void this.cam.release();
    this.set('city');
  }

  agree(): void {
    const p = this.selected;
    if (!p || !this.run) return;
    const r = play(this.run, this.season.ledger, W.PETITIONS, p.id);
    this.run = r.run;
    this.season.setLedger(r.ledger);
    this.notes = [...this.notes, W.playedLine(p)];
    this.applyDue();
    this.back();
    void this.reveal().then(() => this.phase === 'mutation' && this.set('city'));
  }

  next(): void {
    if (this.phase !== 'city' || !this.run || this.season.playing) return;
    const e = endSeason(this.run, this.season.ledger, W.PETITIONS, this.world);
    this.run = e.run;
    this.season.setLedger(e.ledger);
    // (instant: what the expired cards set off is in the world and saved before the season plays)
    this.applyDue();
    this.notes = [...e.expired.map((p) => W.expiredLine(p, p.expires)), ...(Object.keys(e.tribute).length ? [W.tributeLine(e.tribute)] : []), ...W.homeLines(comesHome(this.world))];
    this.set('season');
    void this.season.next().then(async () => {
      // (the season's time-lapse played out, or skipped)
      while (this.season.playing) await new Promise((r) => setTimeout(r, 100));
      await this.flow();
    });
  }

  skip(): void {
    this.season.skip();
  }

  /** what comes next: the reveals of what changed in the town, then the attack if it is due, the end if the threat
   *  is past */
  private async flow(): Promise<void> {
    await this.reveal();
    const run = this.run!;
    if (raidDue(run, run.season) !== null) return this.beginAttack();
    if (threatDone(run, W.PETITIONS)) return this.set('end');
    this.set('city');
  }

  /**
   * Every due world change applied through the mutators and recorded, at once: far ones wherever the camera is (the
   * place's owner, status and tribute set in the world's places), ones in the town at their spot — their short reveal
   * queued for when the camera can go there.
   */
  private applyDue(): void {
    const t = this.town;
    let run = this.run!;
    for (const d of [...run.due]) {
      const seed = run.n * 131 + run.season;
      if (d.mutation.far) {
        this.mutators.apply({ kind: d.mutation.kind, place: d.mutation.far.id, strength: 1, seed });
        ({ run, world: this.world } = mutate(run, this.world, d.id));
      } else if (t && d.mutation.near) {
        const at = this.spot(d.mutation.near.spot) ?? t.centreInWindow();
        const radius = d.mutation.near.size * t.box.R;
        const done = this.mutators.apply({ kind: d.mutation.kind, place: t.site.name, area: { at, radius }, strength: 1, seed });
        const o = t.inWindow([0, 0]);
        ({ run, world: this.world } = mutate(run, this.world, d.id, { town: t.site.name, at: [at[0] - o[0], at[1] - o[1]], radius }));
        this.reveals.push({ text: d.text, frame: [at[0] - o[0], at[1] - o[1]], radius, play: done.play });
      } else continue;
      console.log(`[loop] world change ${d.id}: ${d.mutation.kind} at ${d.mutation.where}${d.mutation.far ? ' (far)' : ''}`);
    }
    this.run = run;
    void this.save();
    // (the living town's counts again: a far change comes home — SeasonLoop.setLedger passes them on)
    if (!this.season.playing) this.season.setLedger(this.season.ledger);
    this.changed();
  }

  /** the queued reveals, one at a time: the camera on the place, the mutator's reveal played, back */
  private async reveal(): Promise<void> {
    while (this.reveals.length) {
      const r = this.reveals.shift()!;
      this.change = { text: r.text, standin: true };
      this.set('mutation');
      const t = this.town;
      // (its place kept in the town's frame: the window may have slid since it was applied)
      if (t) await this.cam.frame(this.at3(t.inWindow(r.frame)), { zoom: Math.max(3, innerWidth / (3.2 * r.radius)), place: [0.5, 0.36], ease: 1 });
      await (r.play?.().done ?? new Promise((res) => setTimeout(res, 1500)));
      await new Promise((res) => setTimeout(res, 800));
      await this.cam.release();
    }
    this.change = null;
  }

  /** from the end screen: the camera to a change's place in the town (far places: the world map, not wired yet) */
  look(id: string | null): void {
    const c = id === null ? null : (this.world.changes.find((x) => x.id === id) ?? null);
    const t = this.town;
    if (this.looking) void this.cam.release();
    this.looking = c?.near && t ? c : null;
    if (this.looking?.near && t) void this.cam.frame(this.at3(t.inWindow(this.looking.near.at)), { zoom: Math.max(3, innerWidth / (3.2 * this.looking.near.radius)), place: [0.5, 0.4] });
    this.changed();
  }

  proceed(): void {
    if (this.phase === 'result') void this.flow();
  }

  again(): void {
    this.look(null);
    if (this.run) this.run = endRun(this.run);
    this.set('leader');
  }

  // ---- the attack -------------------------------------------------------------------------------------

  private beginAttack(): void {
    this.attack = { t: 0, sackAt: null, unwatch: null, following: false };
    this.fightLine = null;
    this.speed0 = this.scene.speed;
    this.scene.speed = Math.max(this.speed0, MARCH_SPEED);
    this.set('attack');
  }

  /** each frame of an attack: the raiders watched and followed, its line, and its end */
  private watchFight(dt: number): void {
    const a = this.attack;
    const war = this.season.war;
    if (!a || !war || this.phase !== 'attack') return;
    a.t += dt;
    const f = war.fight;
    if (!f) {
      if (a.t > ATTACK_SECONDS) this.endAttack(null);
      return;
    }
    const units = this.scene.units;
    const forces = this.scene.townForces;
    if (!a.unwatch && units && forces) {
      const ids = forces.members(f.raiders);
      if (ids.length) {
        a.unwatch = units.observe(ids);
        const mid = (): V3 | null => {
          let n = 0;
          const s: V3 = [0, 0, 0];
          for (const id of forces.members(f.raiders)) {
            const at = units.get(id)?.at;
            if (!at) continue;
            n++;
            for (let k = 0; k < 3; k++) s[k] += at[k];
          }
          return n ? [s[0] / n, s[1] / n, s[2] / n] : null;
        };
        // (the camera to the raiders once their place is read, then sliding after them)
        const go = () => {
          if (this.attack !== a) return;
          const p = mid();
          if (!p) return void setTimeout(go, 100);
          void this.cam.look(p, { zoom: 7, ease: 1 }).then(() => this.cam.follow(mid));
          a.following = true;
        };
        go();
      }
    }
    if (f.stage !== 'coming') this.scene.speed = this.speed0;
    const line = f.failed ? WAVE_NO_ROAD : W.attackLine(f.n, f.alive, f.soldiers, f.stage);
    if (line !== this.fightLine) {
      this.fightLine = line;
      this.changed();
    }
    if (f.stage !== 'coming' && f.soldiers === 0 && f.alive > 0) a.sackAt ??= a.t;
    const over = f.failed || f.alive === 0 || (a.sackAt !== null && a.t - a.sackAt > SACK_SECONDS) || a.t > ATTACK_SECONDS;
    if (over) this.endAttack(f);
  }

  private endAttack(f: NonNullable<SeasonLoop['war']>['fight'] | null): void {
    const a = this.attack!;
    this.attack = null;
    a.unwatch?.();
    this.cam.follow(null);
    this.scene.speed = this.speed0;
    this.armed = null;
    const l0 = this.season.ledger;
    const before = { might: total(l0, 'might'), materials: pools(l0).materials, unrest: pools(l0).unrest };
    // (raiders who found no road, or none came: nobody got in)
    const fight = { raiders: f && !f.failed ? f.n : 0, left: f && !f.failed ? f.alive : 0, fallen: f?.fallen ?? 0 };
    const settled = this.season.war?.resolve(l0) ?? null;
    if (settled) this.season.setLedger(settled.ledger);
    const l1 = this.season.ledger;
    const lost = { might: before.might - total(l1, 'might'), materials: before.materials - pools(l1).materials, unrest: pools(l1).unrest - before.unrest };
    this.run = fought(this.run!, fight, W.PETITIONS.find((p) => p.threat));
    this.resultLines = [...(f?.failed ? [WAVE_NO_ROAD] : []), ...W.resultLines(this.run.fight!, lost)];
    // (broken through: the threat's world change, in the world at once; its reveal after the result is read)
    this.applyDue();
    console.log(`[loop] attack over: ${JSON.stringify({ ...fight, ...lost })}`);
    this.set('result');
  }

  arm(spell: SpellId | null): void {
    this.armed = spell;
    this.changed();
  }

  /** a tap on the map with a spell armed: cast there (Heat ray: a blow over an area on the units there, shown with
   *  the level's own lightning strike — a stand-in look) */
  private cast(e: PointerEvent): void {
    if (this.phase !== 'attack' || this.armed !== 'heatray') return;
    const rect = this.scene.host.canvas.getBoundingClientRect();
    const g = this.scene.core.camera.groundAt(e.clientX - rect.left, e.clientY - rect.top, this.scene.heightAt);
    if (!g) return;
    if (pools(this.season.ledger).magic < HEATRAY.magic) {
      this.fightLine = W.shortText({ magic: HEATRAY.magic });
      return this.arm(null);
    }
    this.season.setLedger(lose(this.season.ledger, { magic: HEATRAY.magic }));
    this.scene.units?.strike?.({ at: [g[0], g[1]], radius: HEATRAY.radius, damage: HEATRAY.damage }, 'spell');
    this.scene.powers.scriptStrike(g[0], g[1], g[2]);
    console.log(`[loop] heat ray at ${g[0].toFixed(0)}, ${g[1].toFixed(0)}`);
    this.arm(null);
  }
}

export function startRunLoop(scene: LevelScene, towns: FieldTowns): void {
  let game: Game | null = null;
  const season = startSeasonLoop(scene, towns, {
    ui: false,
    dealer: false,
    // (BACKLOG SF-5: the raid is a card's effect — the threat's expiry — not the fixed schedule)
    raid: (s) => (game?.run ? raidDue(game.run, s) : null),
    ready: () => void game!.load(),
    // (what far places bring home is seen in the town: refugees in the streets, a settlement's wagons on the road)
    life: (l) => {
      const h = game ? comesHome(game.world) : { people: 0, wagons: 0 };
      return { ...l, commuters: l.commuters + h.people, wagons: l.wagons + h.wagons };
    },
  });
  game = new Game(scene, towns, season);
  scene.seasonUi = mountRunUi(scene.host.ui, game);
  (globalThis as { rungame?: Game }).rungame = game;
}
