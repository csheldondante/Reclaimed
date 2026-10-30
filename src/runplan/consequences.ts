// ---- runplan/consequences.ts ------------------------------------------------------------------------------------
// (round 117, runplan) What a run's outcomes do to the world for the next run, and what the GM decides when it fails.
// The user (round 117, part 2): "Decisions should impact the world for the next run. They should impact characters and
// their history, relationships and motivations. Potentially impact their gear or persistent statuses. They should
// impact factions and their relationships and power. They should impact the terrain and the cities and as mentioned
// change statuses at the regional or global level. Make it eternal night or flood a region and make a new shallow sea
// or bury a ruin under sand etc. the GM can determine some of what happens in different failure conditions like death
// or capture or just failure to meet a timeline. Maybe the lich takes over the map and the world is filled with
// undead."
// Everything here is an Outcome (story.ts: AtlasEvents, attitudes) plus CharacterChanges — the same data a GM story
// writes — so the world state applies them one way (MemoryWorldState.apply / applyCharacter), and a GM-written story
// can replace any stage's outcomes without the rest changing. The tables below are the stand-in GM: deterministic
// rules per encounter, picked by the region and who's there.

import type { CharacterChange, EncounterKind, FailureRule, RegionGraph, RegionNode, RegionRealisation, RunPlan, RunRecord, StageOutcome } from '../api/contracts/run';
import type { Outcome } from '../api/contracts/story';
import type { AtlasEvent, Faction, RegionState, WorldSnapshot } from '../api/contracts/world';
import type { MemoryWorldState } from '../api/contracts/world-state';

type Effects = StageOutcome['effects'];

/** the heroes' names on the roster (one hero a role for now; a roster of several a role is GameplayGM's hero select) */
export const HERO_NAMES: Record<string, string> = { bike: 'the Rider', lich: 'the Lich', knight: 'the Knight', wanderer: 'the Wanderer', gorilla: 'the Ape', tank: 'the Tank Crew', mech: 'the Pilot' };
type Ev = Omit<AtlasEvent, 'id' | 'run'>;

export interface StageContext {
  stage: string;
  node: RegionNode;
  state: RegionState;
  encounter: EncounterKind;
  hero: string;
  /** the faction the run is against (the most hostile with presence round the plan), if any */
  threat: Faction | null;
  /** the faction that holds this region (its settlement's, or the strongest friendly presence) */
  holder: Faction | null;
  finale: boolean;
  rnd: () => number;
  /** neighbouring land regions (spreading effects: a night, a flood) */
  around: number[];
  /** a captive hero held here (a rescue stage) */
  captive?: string;
}

const ev = (kind: Ev['kind'], regions: number[], magnitude: number, extra: Partial<Ev> = {}): Ev => ({ kind, regions, magnitude, cause: { by: 'player' }, ...extra });
const hist = (id: string, text: string): CharacterChange => ({ kind: 'history', id, text });

/** the outcomes a stage can have: the first is the hoped-for one, the last how it goes wrong */
export function stageOutcomes(c: StageContext): StageOutcome[] {
  const r = c.node.id;
  const at = c.node.name;
  const h = c.hero;
  const T = c.threat;
  const H = c.holder;
  const tPres = (m: number, regions = [r]): Ev[] => (T ? [ev('faction-presence', regions, m, { detail: { faction: T.id } })] : []);
  const att = (f: Faction | null, m: number): Ev[] => (f ? [ev('faction-attitude', [r], m, { detail: { faction: f.id } })] : []);
  const out: StageOutcome[] = [];
  const won = (id: string, text: string, e: Effects): void => void out.push({ id, text, ends: c.finale ? 'won' : 'continue', effects: e });
  const lost = (id: string, text: string, e: Effects, ends: StageOutcome['ends'] = c.finale ? 'lost' : 'continue'): void => void out.push({ id, text, ends, effects: e });
  switch (c.encounter) {
    case 'race':
      won('won-race', `Won the race across ${at}`, { atlas: [...att(H, 0.15), ev('mark', [r], 1, { detail: { name: `${at} Run`, kind: 'race course' } })], characters: [hist(h, `won the race across ${at}`), { kind: 'gear', id: h, add: ['tuned drive'] }, { kind: 'status', id: h, add: ['famed'] }] });
      won('dirty-race', `Ran ${at} dirty and took the purse`, { atlas: [...att(H, -0.2)], characters: [hist(h, `cheated the racers of ${at}`), { kind: 'gear', id: h, add: ['racers’ purse'] }] });
      lost('crashed', `Crashed out on ${at}`, { characters: [hist(h, `crashed on ${at}`), { kind: 'status', id: h, add: ['wounded'] }] });
      break;
    case 'chase':
      won('ran-down', `Ran down the raiders in ${at}`, { atlas: [...tPres(-0.25), ...att(H, 0.1)], characters: [hist(h, `ran down raiders in ${at}`)] });
      lost('got-away', `The raiders got away through ${at}`, { atlas: [...tPres(0.2), ev('ruin', [r], 0.2)], characters: [hist(h, `lost the raiders in ${at}`)] });
      break;
    case 'fight':
      won('held', `Held ${at}`, { atlas: [...tPres(-0.3), ev('rebuild', [r], 0.2), ...att(H, 0.2)], characters: [hist(h, `held ${at}`), { kind: 'meet', character: { id: `c-${c.stage}-reeve`, name: `the reeve of ${at}`, role: 'reeve', faction: H?.id ?? null, hero: false, alive: true, region: r, motivation: 'keep the walls standing', relationships: { [h]: 0.6 } } }] });
      won('sacked', `Took ${at} for yourself`, { atlas: [ev('ruin', [r], 0.3), ...att(H, -0.4), ...(H ? [ev('faction-power', [r], -0.15, { detail: { faction: H.id } })] : [])], characters: [hist(h, `sacked ${at}`), { kind: 'gear', id: h, add: ['plundered arms'] }] });
      if (T) lost('taken', `Overwhelmed at ${at} and dragged off by ${T.name}`, { atlas: [...tPres(0.3)], characters: [hist(h, `taken at ${at} by ${T.name}`)] }, 'captured');
      lost('fell', `${at} fell`, { atlas: [ev('ruin', [r], 0.35), ...tPres(0.3)], characters: [hist(h, `could not hold ${at}`), { kind: 'status', id: h, add: ['wounded'] }] });
      break;
    case 'horde':
      won('laid', `Laid the dead of ${at} to rest`, { atlas: [ev('lay-dead', [r], 0.5), ev('light', [r], 0.2)], characters: [hist(h, `laid the dead of ${at}`)] });
      lost('rising', `The dead rose over ${at}`, { atlas: [ev('raise-dead', [r, ...c.around], 0.35), ev('shadow', [r], 0.2)], characters: [hist(h, `fled the dead at ${at}`)] });
      break;
    case 'spectacle': {
      // the force of nature's choices: the user's own examples — a new shallow sea, a ruin under sand, eternal night
      const low = c.node.ground.mean - c.node.ground.min < 25 || c.node.kind === 'marsh' || c.node.kind === 'plains';
      const sea: Effects = { atlas: [ev('sink', [r], 0.6), ev('mark', [r], 1, { detail: { name: `the Drowned ${at}`, kind: 'drowned ruin' } })], characters: [hist(h, `drowned ${at} under a new shallow sea`)] };
      const sand: Effects = { atlas: [ev('bury', [r], 6, { detail: { material: c.node.lava > 0 ? 'ash' : 'sand' } }), ev('ruin', [r], 0.3)], characters: [hist(h, `buried ${at} under ${c.node.lava > 0 ? 'ash' : 'sand'}`)] };
      const night: Effects = { atlas: [ev('shadow', [r, ...c.around], 0.8), ev('storm', [r], 0.6, { detail: { storm: 'arcane' } })], characters: [hist(h, `called an endless night over ${at}`), { kind: 'status', id: h, add: ['night-touched'] }] };
      const picks: [string, string, Effects][] = [
        ['drowned', `Drowned ${at}: a new shallow sea`, sea],
        ['buried', `Buried ${at} under ${c.node.lava > 0 ? 'ash' : 'sand'}`, sand],
        ['night', `Called down an endless night on ${at}`, night],
      ];
      if (!low) picks.push(picks.shift()!);
      // (sand country and lava country bury first: a ruin under sand, a town under ash — the first look drowned a lava field)
      if (c.node.kind === 'dunes' || c.node.kind === 'badlands' || c.node.lava > 0 || c.node.kind === 'lavafield') picks.unshift(picks.splice(picks.findIndex((p) => p[0] === 'buried'), 1)[0]);
      won(picks[0][0], picks[0][1], picks[0][2]);
      won(picks[1][0], picks[1][1], picks[1][2]);
      lost('unleashed', `The storm at ${at} got away from you`, { atlas: [ev('storm', [r, ...c.around], 0.5, { detail: { storm: 'arcane' } }), ev('ruin', [r], 0.2)], characters: [hist(h, `lost control at ${at}`), { kind: 'status', id: h, add: ['cursed'] }] });
      break;
    }
    case 'destruction':
      won('razed', `Broke ${at} apart`, { atlas: [ev('ruin', [r], 0.6), ...(H ? [ev('faction-power', [r], -0.25, { detail: { faction: H.id } }), ...att(H, -0.5)] : []), ...(T && H ? [ev('faction-relation', [r], 0.2, { detail: { faction: T.id, toward: H.id } })] : [])], characters: [hist(h, `broke ${at}`), { kind: 'status', id: h, add: ['feared'] }] });
      won('spared', `Stayed your hand at ${at}`, { atlas: [...att(H, 0.3)], characters: [hist(h, `spared ${at}`)] });
      lost('rebuffed', `${at} stood against you`, { atlas: [...att(H, -0.2)], characters: [hist(h, `was driven off from ${at}`), { kind: 'status', id: h, add: ['wounded'] }] });
      break;
    case 'delve':
      won('relic', `Found the relic under ${at}`, { atlas: [ev('mark', [r], 1, { detail: { name: `the Opened Vault of ${at}`, kind: 'opened tomb' } })], characters: [hist(h, `brought a relic up from under ${at}`), { kind: 'gear', id: h, add: [`relic of ${at}`] }] });
      won('sealed', `Sealed what sleeps under ${at}`, { atlas: [ev('lay-dead', [r], 0.2), ev('mark', [r], 1, { detail: { name: `the Seal of ${at}`, kind: 'shrine' } })], characters: [hist(h, `sealed the deep under ${at}`)] });
      lost('woke', `Woke what slept under ${at}`, { atlas: [ev('raise-dead', [r], 0.4), ...(T ? tPres(0.2) : [])], characters: [hist(h, `woke the dead under ${at}`), { kind: 'status', id: h, add: ['wounded'] }] });
      break;
    case 'talk':
      won('allied', `Won ${H?.name ?? at} over`, { atlas: [...att(H, 0.3), ...(T && H ? [ev('faction-relation', [r], -0.3, { detail: { faction: H.id, toward: T.id } })] : [])], characters: [hist(h, `made friends in ${at}`), { kind: 'meet', character: { id: `c-${c.stage}-elder`, name: `the elder of ${at}`, role: 'elder', faction: H?.id ?? null, hero: false, alive: true, region: r, motivation: T ? `see ${T.name} gone` : 'a quiet year', relationships: { [h]: 0.5 } } }] });
      won('bargain', `Struck a bargain in ${at}`, { atlas: [...att(H, 0.1), ...(T && H ? [ev('faction-relation', [r], 0.3, { detail: { faction: H.id, toward: T.id } })] : [])], characters: [hist(h, `bargained in ${at}`), { kind: 'gear', id: h, add: ['letter of passage'] }] });
      lost('insulted', `Gave offence in ${at}`, { atlas: [...att(H, -0.3)], characters: [hist(h, `offended ${at}`)] });
      break;
    case 'explore':
      won('charted', `Charted ${at}`, { atlas: [ev('mark', [r], 1, { detail: { name: `${at} Cairn`, kind: 'cairn' } })], characters: [hist(h, `charted ${at}`), { kind: 'gear', id: h, add: [`map of ${at}`] }] });
      lost('lost-way', `Lost the way in ${at}`, { characters: [hist(h, `lost days in ${at}`)] });
      break;
    case 'rescue': {
      const who = c.captive ?? 'the captive';
      won('freed', `Freed ${who} from ${at}`, { atlas: [...tPres(-0.2)], characters: c.captive ? [{ kind: 'status', id: c.captive, remove: [...capturedBy(c.captive, T)] }, { kind: 'relationship', id: c.captive, toward: h, delta: 0.8 }, hist(c.captive, `freed by ${h}`), hist(h, `freed ${who}`)] : [] });
      lost('too-late', `Came too late for ${who}`, { characters: c.captive ? [{ kind: 'die', id: c.captive, text: `died a captive in ${at}` }, hist(h, `came too late for ${who}`)] : [] });
      break;
    }
  }
  if (c.finale && T) {
    // the finale is the run's stand against the threat: winning breaks its hold round here; losing is a failure rule
    for (const o of out)
      if (o.ends === 'won') o.effects.atlas = [...(o.effects.atlas ?? []), ev('faction-power', [r], -0.3, { detail: { faction: T.id } }), ev('faction-presence', [r, ...c.around], -0.4, { detail: { faction: T.id } })];
  }
  return out;
}

/** a captive's status names its captor (or any) */
function capturedBy(_id: string, T: Faction | null): string[] {
  return T ? [`captive:${T.id}`] : [];
}

/**
 * What the GM decides happens when the run fails each way. Death: if the dead have a hold here (the Hollow Court, or
 * undead in the plan's regions) the lich takes the map — the dead rise and the night falls over every region within a
 * few borders of the run; otherwise the threat takes the finale. Capture: the hero is held at the threat's seat (the
 * next plan finds it and can offer a rescue). Late: the finale's threat wins without the hero there.
 */
export function failureRules(o: { plan: Pick<RunPlan, 'stages'>; hero: string; threat: Faction | null; spread: number[]; deadOnMap: number; finaleRegion: number; finaleName: string; seat: number | null }): FailureRule[] {
  const T = o.threat;
  const rules: FailureRule[] = [];
  const dead = T?.id === 'f-hollow-court' || o.deadOnMap > 0.15;
  if (dead)
    rules.push({
      when: 'lost',
      text: 'The hero fell, and the lich took the map: the dead walk and the night does not lift',
      effects: {
        atlas: [
          ev('raise-dead', o.spread, 0.6, { cause: { by: 'world', ref: 'the lich takes the map' } }),
          ev('shadow', o.spread, 0.5, { cause: { by: 'world', ref: 'the lich takes the map' } }),
          ...(T ? [ev('faction-presence', o.spread, 0.5, { detail: { faction: T.id }, cause: { by: 'world' } }), ev('faction-power', [o.finaleRegion], 0.4, { detail: { faction: T.id }, cause: { by: 'world' } })] : []),
        ],
        characters: [{ kind: 'die', id: o.hero, text: `fell at ${o.finaleName}; the dead rose after` }],
      },
    });
  else
    rules.push({
      when: 'lost',
      text: T ? `The hero fell, and ${T.name} took ${o.finaleName}` : `The hero fell at ${o.finaleName}`,
      effects: {
        atlas: [ev('ruin', [o.finaleRegion], 0.4, { cause: { by: 'world' } }), ...(T ? [ev('faction-presence', [o.finaleRegion, ...o.spread.slice(0, 4)], 0.4, { detail: { faction: T.id }, cause: { by: 'world' } }), ev('faction-power', [o.finaleRegion], 0.2, { detail: { faction: T.id }, cause: { by: 'world' } })] : [])],
        characters: [{ kind: 'die', id: o.hero, text: `fell at ${o.finaleName}` }],
      },
    });
  rules.push({
    when: 'captured',
    text: T ? `Taken by ${T.name}: held at their seat until someone comes` : 'Taken, and held',
    effects: {
      atlas: T ? [ev('faction-power', [o.seat ?? o.finaleRegion], 0.1, { detail: { faction: T.id }, cause: { by: 'world' } })] : [],
      characters: [{ kind: 'status', id: o.hero, add: [T ? `captive:${T.id}` : 'captive'] }, { kind: 'move', id: o.hero, region: o.seat ?? o.finaleRegion }, hist(o.hero, T ? `taken by ${T.name}` : 'taken captive')],
    },
  });
  rules.push({
    when: 'late',
    text: T ? `Too late: ${T.name} had ${o.finaleName} before the hero came` : `Too late for ${o.finaleName}`,
    effects: {
      atlas: [ev('ruin', [o.finaleRegion], 0.5, { cause: { by: 'world' } }), ...(T ? [ev('faction-presence', [o.finaleRegion], 0.4, { detail: { faction: T.id }, cause: { by: 'world' } })] : []), ...(dead ? [ev('raise-dead', [o.finaleRegion], 0.4, { cause: { by: 'world' } })] : [])],
      characters: [hist(o.hero, `came too late to ${o.finaleName}`)],
    },
  });
  return rules;
}

/** apply an Outcome (+ character changes) to the world; returns the AtlasEvents applied (with ids) */
export function applyEffects(w: MemoryWorldState, e: Outcome & { characters?: CharacterChange[] }, run: number, ref: string): AtlasEvent[] {
  const done: AtlasEvent[] = [];
  (e.atlas ?? []).forEach((a, i) => {
    const full: AtlasEvent = { ...structuredClone(a), id: `${ref}-${i}`, run, cause: { ...a.cause, ref: a.cause.ref ?? ref } };
    w.apply(full);
    done.push(full);
  });
  for (const a of e.attitude ?? []) {
    if (!a.faction) continue;
    const full: AtlasEvent = { id: `${ref}-att-${a.faction}`, kind: 'faction-attitude', regions: [0], magnitude: Math.max(-1, Math.min(1, a.delta)), detail: { faction: a.faction }, run, cause: { by: 'story', ref } };
    w.apply(full);
    done.push(full);
  }
  for (const c of e.characters ?? []) w.applyCharacter(c, run);
  return done;
}

/**
 * A run played along a path through the plan: each stage's outcome applied in order, then the failure rule if it ended
 * in one, and the RunRecord kept. `path` is the stages and their outcomes ids as played (the viewer's step-through, or
 * the game's run log).
 */
export function finishRun(w: MemoryWorldState, plan: RunPlan, path: { stage: string; outcome: string }[], end?: RunRecord['end'], stops: { leg: string; event: string }[] = []): RunRecord {
  const run = w.run;
  const events: AtlasEvent[] = [];
  const deeds: string[] = [];
  let how: RunRecord['end'] = end ?? 'abandoned';
  // the hero joins the world's roster on its first run (its history, gear and statuses carry over from then on)
  const start = plan.stages.find((x) => x.id === plan.start);
  if (!w.character(plan.hero)) w.applyCharacter({ kind: 'meet', character: { id: plan.hero, name: HERO_NAMES[plan.hero] ?? plan.hero, role: plan.hero, faction: null, hero: true, alive: true, region: start?.region ?? null, motivation: 'see the run through' } }, run);
  for (const step of path) {
    const s = plan.stages.find((x) => x.id === step.stage);
    if (!s) throw new Error(`finishRun: no stage ${step.stage} in plan ${plan.id}`);
    const o = s.outcomes.find((x) => x.id === step.outcome);
    if (!o) throw new Error(`finishRun: stage ${s.id} has no outcome ${step.outcome}`);
    events.push(...applyEffects(w, o.effects, run, `${plan.id}-${s.id}-${o.id}`));
    deeds.push(o.text);
    if (o.ends !== 'continue') {
      if (end === undefined) how = o.ends;
      break;
    }
  }
  // the places found on the road that the player stopped at (TravelLeg.events with effects: a poi kept as a mark)
  for (const st of stops) {
    const e = plan.legs.find((l) => l.id === st.leg)?.events.find((x) => x.id === st.event);
    if (!e) throw new Error(`finishRun: no event ${st.event} on leg ${st.leg}`);
    if (e.effects) events.push(...applyEffects(w, e.effects, run, `${plan.id}-${e.id}`));
    deeds.push(e.text);
  }
  const rule = plan.failures.find((f) => f.when === how);
  if (rule) {
    events.push(...applyEffects(w, rule.effects, run, `${plan.id}-fail-${rule.when}`));
    deeds.push(rule.text);
  }
  const rec: RunRecord = { run, hero: plan.hero, story: plan.id, plan: plan.id, path: [...path], end: how, deeds, events };
  w.record(rec);
  return rec;
}

/**
 * RegionState converted at the boundary into what each generator realises (contracts/run.ts RegionRealisation): the
 * terrain's flood fills (sunk → a water fill to a level over the region's lowest ground: a new shallow sea; buried →
 * a sand or ash fill: a ruin under sand; flooded → a water fill at the flood's level), the structures' ruin and what
 * buries or drowns them, the inhabitants' undead and factions, flora's and the sky's own.
 * Why one flood-fill request for sea, sand and flood: the user's "GPU flood fill based on height … We can flood with
 * water, sand, magma etc." is one tool; terrain owns it, and every way a region goes under becomes a call to it.
 */
export function realise(n: RegionNode, s: RegionState, factions: Faction[] = []): RegionRealisation {
  const fills: RegionRealisation['terrain']['fills'] = [];
  const g = n.ground;
  // a sunk region: water to a level that drowns `sunk` of its relief, at least a shallow sea over its lowest ground
  if (s.sunk > 0) fills.push({ at: n.centre, level: g.min + 3 + s.sunk * (g.max - g.min + 6), fluid: 'water', region: n.id, why: `sunk ${s.sunk.toFixed(2)}: a new shallow sea` });
  if (s.buried.depth > 0) fills.push({ at: n.centre, level: g.min + s.buried.depth + 0.5 * (g.mean - g.min), fluid: s.buried.material, region: n.id, why: `buried ${s.buried.depth} cells of ${s.buried.material}` });
  if (s.flooded !== null) fills.push({ at: n.centre, level: s.flooded, fluid: 'water', region: n.id, why: `flooded to ${s.flooded.toFixed(1)}` });
  const top = fills.reduce((m, f) => Math.max(m, f.level), -Infinity);
  const welcome = Object.entries(s.presence).reduce((acc, [id, p]) => acc + (p ?? 0) * (factions.find((f) => f.id === id)?.attitude ?? 0), 0);
  return {
    region: n.id,
    terrain: { fills, frozen: s.frozen },
    structures: {
      ruin: s.ruin,
      overgrowth: s.overgrowth,
      buriedBy: Math.max(0, fills.filter((f) => f.fluid !== 'water').reduce((m, f) => Math.max(m, f.level - g.mean), 0)),
      drowned: fills.some((f) => f.fluid === 'water' && f.level > g.mean),
      marks: s.marks,
    },
    inhabitants: { undead: s.undead, presence: { ...s.presence }, welcome: Math.max(-1, Math.min(1, welcome)) },
    flora: { overgrowth: s.overgrowth, frozen: s.frozen, shadow: s.shadow, wetness: s.wetness + (top > g.mean ? 0.5 : 0) },
    sky: { shadow: s.shadow, storm: s.storm },
  };
}

/** regions within `hops` borders of these (land only), the spread of a world-scale consequence */
export function spread(g: RegionGraph, from: number[], hops: number): number[] {
  const seen = new Set(from);
  let front = [...from];
  for (let i = 0; i < hops; i++) {
    const next: number[] = [];
    for (const id of front)
      for (const e of g.edges(id))
        if (!seen.has(e.b) && g.node(e.b)?.land) {
          seen.add(e.b);
          next.push(e.b);
        }
    front = next;
  }
  return [...seen];
}

/** who holds a region: its settlement's faction, else its friendliest presence */
export function holderOf(n: RegionNode, s: RegionState, snap: WorldSnapshot): Faction | null {
  const sett = snap.settlements.find((x) => n.settlements.includes(x.id));
  const byId = new Map(snap.factions.map((f) => [f.id, f]));
  if (sett?.faction && byId.has(sett.faction)) return byId.get(sett.faction)!;
  let best: Faction | null = null;
  let bp = 0.1;
  for (const [id, p] of Object.entries(s.presence)) {
    const f = byId.get(id);
    if (f && f.attitude > -0.2 && (p ?? 0) > bp) {
      best = f;
      bp = p ?? 0;
    }
  }
  return best;
}
