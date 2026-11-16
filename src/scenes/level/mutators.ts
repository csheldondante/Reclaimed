// (mutators, docs/design/MUTATORS.md) The world mutators on the atlas level: the world modifier list bound to this
// window — its GPU ops over WorldGpu's contract buffers, arriving land written right after the static claims
// (Streamer.onWritten), each field town's lot conditions written when its lots are made (FieldTowns.onMade), the list
// kept in the world store, every entry drawn on the atlas map at its place, and the signs shown (the sky dimmed, ash
// falling, lots looted, the dead walking). `?mutlab=1`: the lab's buttons.
import type { FieldTown } from '../../citygen/town';
import type { FieldTowns } from '../../citygen/towns';
import { mutators, type MutationRecord, type MutatorKind, type Sign, type SignKind } from '../../mutate';
import { MutateEngine, type MutTown } from '../../mutate/engine';
import { MutateGpu } from '../../mutate/gpu';
import { isLand } from '../../mutate/list';
import { mountMutLab } from '../../mutate/lab';
import { warpWindow } from '../../api/atlas-world';
import { PK } from '../../sim/particles';
import { ROW_H, cellAt } from '../../world/lattice';
import type { LevelScene } from '../level';
import { MemoryWorldState } from '../../api/contracts/world-state';
import { FactWorld } from '../../living/world';
import { registerMutatorOutcomes } from '../../mutate/outcomes';
import { useRiverWorld } from './runs';

const KEY = 'mutators:list';
/** the map's colours a kind */
const MARK: Record<string, string> = {
  flooded: '#3f7fc4', burned: '#2a2420', melted: '#b3261a', buried: '#d8c08a', dried: '#b59a6a', withered: '#8a8474', greened: '#3f9a4a',
  founded: '#8fd18a', destroyed: '#b0483a', abandoned: '#9a968c', occupied: '#c05ad0', vassal: '#e6c84a',
};

/** `restore: false`: the caller lays the saved list over the window itself (`restoreMutators`), once it has bound its
 *  own fact world — the main loop's run, whose saved world already holds the entries' fact events */
export function attachMutators(scene: LevelScene, towns: FieldTowns, opts: { restore?: boolean } = {}): MutateEngine | null {
  const a = scene.opts.atlas;
  const S = scene.stream;
  const st = a?.settlements;
  if (!a || !S || !st) return null;
  const { core, host } = scene;
  const gpu = new MutateGpu(host.gpu.device, core.world, core.dims.w, core.dims.h);
  const made = new Map<string, MutTown>();
  const townOf = (t: FieldTown): MutTown => ({
    id: t.site.id,
    centre: () => t.centreInWindow(),
    radius: Math.hypot(t.box.w, t.box.h * ROW_H) / 2,
    lots: t.lots,
    changed: (released) => t.conditionsChanged(released),
  });
  const liveTowns = () => [...made.entries()].filter(([id]) => towns.live.has(id)).map(([, t]) => t);
  const lab = host.params.get('mutlab') === '1';
  const homeId = a.startTown ?? null;

  // ---- the signs shown (docs/design/MUTATORS.md "Signs"): nothing runs while none is on
  const shown = { crime: new Set<string>(), dead: [] as number[], ash: 0, raf: 0 };
  const strongest = (signs: readonly Sign[], kind: SignKind) => signs.filter((s) => s.kind === kind && (s.place === null || towns.live.has(s.place))).reduce((m, s) => Math.max(m, s.strength), 0);
  const ashFrame = () => {
    shown.raf = 0;
    if (shown.ash <= 0) return;
    // (the particles' own ash, a few bursts a frame high over the view: it drifts down on the wind)
    const t = core.camera.target;
    for (let k = 0; k < Math.ceil(4 * shown.ash); k++) {
      const x = t[0] + (Math.random() - 0.5) * 70;
      const y = t[1] + (Math.random() - 0.5) * 70;
      core.sim.particles.burst({ kind: PK.Ash, x, y, z: t[2] + 14 + Math.random() * 10, count: 3, speed: 0.6, spread: 5, vel: [1.2, 0.6, -2.2] });
    }
    shown.raf = requestAnimationFrame(ashFrame);
  };
  const showSigns = (signs: readonly Sign[]) => {
    core.skyDim = strongest(signs, 'darkness');
    shown.ash = strongest(signs, 'ashfall');
    if (shown.ash > 0 && !shown.raf) shown.raf = requestAnimationFrame(ashFrame);
    // (crime: a share of each live town's lots looted while its sign is on, put right when it ends)
    for (const t of liveTowns()) {
      const s = signs.find((q) => q.kind === 'crime' && (q.place === t.id || q.place === null));
      if (s && !shown.crime.has(t.id)) {
        shown.crime.add(t.id);
        eng.loot(t, true, s.strength, 11);
      } else if (!s && shown.crime.has(t.id)) {
        shown.crime.delete(t.id);
        eng.loot(t, false, 0, 11);
      }
    }
    // (the dead rise: a few of the walking dead — the units' own 'shambler' kind, undead by the traits — in the streets
    // of the town under the view; removed when the sign ends)
    const dead = strongest(signs, 'deadrise');
    const units = scene.units;
    if (units && dead > 0 && !shown.dead.length) {
      const t = liveTowns()[0];
      const c = t ? t.centre() : [core.camera.target[0], core.camera.target[1]];
      for (let k = 0; k < Math.round(4 + 8 * dead); k++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 6 + Math.random() * 22;
        shown.dead.push(units.spawn('shambler', [c[0] + Math.cos(ang) * r, c[1] + Math.sin(ang) * r], null, { hostile: true }) as number);
      }
    } else if (units && dead <= 0 && shown.dead.length) {
      for (const id of shown.dead.splice(0)) units.remove(id);
    }
  };

  const eng = new MutateEngine({
    gpu,
    world: {
      ground: (x, y) => a.atlas.macroAt(x, y),
      sea: a.atlas.p.sea,
      place: (id) => {
        const s = st.settlement(id);
        return s ? { id: s.id, name: s.name, at: s.at, radius: s.radius, size: s.size, faction: s.faction } : null;
      },
      places: () => st.all().map((s) => ({ id: s.id, name: s.name, at: s.at, radius: s.radius, size: s.size, faction: s.faction })),
    },
    origin: () => [S.origin[0], S.origin[1], S.oz],
    wrap: { cols: a.atlas.p.cols, rows: a.atlas.p.rows },
    towns: liveTowns,
    // (the liquid's records of the chunks written: forgotten, so it takes the water as the columns hold it now — as for
    // arriving land. Nothing is woken)
    landChanged: (x0, y0, x1, y1) => {
      scene.flow?.water.forget(x0, y0, x1 - x0, y1 - y0);
      scene.flow?.lava.forget(x0, y0, x1 - x0, y1 - y0);
    },
    changed: (rec) => void S.store?.put(KEY, new TextEncoder().encode(JSON.stringify(rec)), { session: 'town', hash: 0 }),
    signsChanged: showSigns,
    home: () => {
      const s = homeId ? st.settlement(homeId) : null;
      return s ? { id: s.id, at: s.at } : null;
    },
    regionAt: (x, y) => st.regionAt(x, y),
    time: lab,
  });
  mutators.bind(eng);
  // (the fact world the place states live in: the atlas's own world — its settlements, factions and their entities, as
  // a run makes it (scenes/level/runs.ts). A run or the season loop with its own world binds that: mutators.useWorld.
  // Its rivers' inflow is realised by the river field, as for a run's world: a `dried` place lowers it)
  const ws = MemoryWorldState.restore(structuredClone(st.wiki.snapshot));
  useRiverWorld(scene, ws);
  eng.useWorld(new FactWorld(ws));
  registerMutatorOutcomes();
  (globalThis as { mutators?: unknown }).mutators = mutators;
  (globalThis as { mutateEngine?: unknown }).mutateEngine = eng;
  // (after the static claims' own hook — scenes/level/statics.ts: a building's columns are claimed when the ops look)
  S.onWritten.push((lx, ly, w, h) => void eng.landWritten(lx, ly, w, h));
  const add = (t: FieldTown) => {
    if (towns.live.get(t.site.id) !== t) return;
    const mt = townOf(t);
    made.set(t.site.id, mt);
    shown.crime.delete(t.site.id);
    eng.townMade(mt);
    showSigns(eng.signs());
  };
  towns.onMade.push(add);
  for (const t of towns.live.values()) void t.made.then(() => made.has(t.site.id) || add(t), () => {});
  // (the saved list, once the store is open: laid over what's in the window now; land and towns after it by the hooks)
  restorers.set(eng, async () => {
    for (let k = 0; k < 600 && !S.store; k++) await new Promise((r) => setTimeout(r, 100));
    const s = S.store;
    if (!s || !s.has(KEY)) return;
    const b = await s.get(KEY);
    if (!b) return;
    await gpu.ready;
    const rec = JSON.parse(new TextDecoder().decode(b)) as MutationRecord;
    // (what was applied before the store opened stays, after the saved ones)
    const mine = eng.record().list;
    eng.restore(rec);
    for (const m of mine) eng.apply({ ...m, at: m.cell, place: m.place ?? undefined });
  });
  if (opts.restore !== false) void restoreMutators(eng);

  // ---- the atlas map: the map itself is the record. Every land entry drawn at its place in the map's own drawing (its
  // area in the kind's colour: water, char, rock, sand, a dry bed, dead or new green), a ruin's cross, a new place's
  // house, a holder's flag; and a pin with the place's name and what happened (the cheapest honest version: MU-5)
  const map = scene.atlasMap;
  if (map) {
    const prevMarks = map.marks;
    map.marks = () => [
      ...(prevMarks?.() ?? []),
      ...eng.places().map((p) => ({
        at: p.at,
        name: `${p.name}: ${[...p.conditions, ...(p.status === 'standing' ? [] : [p.status])].join(', ')}${p.owner && p.status !== 'standing' ? ` (${eng.world?.name(p.owner) ?? p.owner})` : ''}`,
        colour: MARK[p.status === 'standing' ? (p.conditions[p.conditions.length - 1] ?? 'founded') : p.status],
      })),
    ];
    const prevOver = map.overlay;
    const texel = a.atlas.worldW / a.atlas.p.n;
    map.overlay = (ctx, px, scale) => {
      prevOver?.(ctx, px, scale);
      for (const m of eng.record().list) {
        const [x, y] = px(m.cell[0], m.cell[1]);
        const r = Math.max(6, m.radius / texel / scale);
        ctx.save();
        if (isLand(m.kind)) {
          ctx.globalAlpha = 0.78;
          ctx.fillStyle = MARK[m.kind];
          ctx.beginPath();
          if (m.kind === 'melted') {
            // (a tongue from the vent, downhill)
            const ang = Math.atan2(m.params[5], m.params[4]);
            ctx.ellipse(x, y, r * 1.1, r * 0.55, ang, 0, Math.PI * 2);
          } else if (m.kind === 'dried') ctx.rect(x - r, y - 2, 2 * r, 4);
          else ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          if (m.kind === 'melted') {
            ctx.strokeStyle = '#ff9a3a';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        } else if (m.kind === 'destroyed' || m.kind === 'abandoned') {
          ctx.strokeStyle = MARK[m.kind];
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(x - 6, y - 6);
          ctx.lineTo(x + 6, y + 6);
          ctx.moveTo(x + 6, y - 6);
          ctx.lineTo(x - 6, y + 6);
          ctx.stroke();
        } else if (m.kind === 'founded') {
          ctx.fillStyle = MARK.founded;
          ctx.strokeStyle = '#123';
          ctx.beginPath();
          ctx.moveTo(x - 6, y + 5);
          ctx.lineTo(x - 6, y - 2);
          ctx.lineTo(x, y - 8);
          ctx.lineTo(x + 6, y - 2);
          ctx.lineTo(x + 6, y + 5);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          // (captured, vassal: the holder's flag)
          ctx.strokeStyle = '#123';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x + 8, y + 6);
          ctx.lineTo(x + 8, y - 12);
          ctx.stroke();
          ctx.fillStyle = MARK[m.kind === 'vassal' ? 'vassal' : 'occupied'];
          ctx.beginPath();
          ctx.moveTo(x + 8, y - 12);
          ctx.lineTo(x + 20, y - 8);
          ctx.lineTo(x + 8, y - 4);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
    };
  }
  if (lab) startLab(scene, towns, eng);
  return eng;
}

const restorers = new WeakMap<MutateEngine, () => Promise<void>>();
/** the saved world modifier list laid over the window (once the store is open): land and lots in the window written
 *  now, the rest as it arrives. Entries whose fact event the bound world lacks are recorded in it. */
export function restoreMutators(eng: MutateEngine): Promise<void> {
  return restorers.get(eng)?.() ?? Promise.resolve();
}

function startLab(scene: LevelScene, towns: FieldTowns, eng: MutateEngine): void {
  const a = scene.opts.atlas!;
  const S = scene.stream!;
  const st = a.settlements!;
  const { core, host } = scene;
  let seed = Number(host.params.get('mutseed') ?? 1);
  let far: { id: string; name: string; at: readonly [number, number] } | null = null;
  const here = (): [number, number] => {
    const [cx, cy] = cellAt(core.camera.target[0], core.camera.target[1]);
    return [S.origin[0] + cx, S.origin[1] + cy];
  };
  const town = () => {
    const [x, y] = here();
    return st.near([x, y * ROW_H], 400).find((s) => towns.live.has(s.id)) ?? null;
  };
  const timing = (kind: MutatorKind) => void eng.lastMs.then((ms) => console.log(`[mutlab] ${kind}: GPU ${ms === null ? 'n/a' : ms.toFixed(3)} ms`));
  const farPlace = () => {
    const [x, y] = here();
    return st.near([x, y * ROW_H], 1e9).find((q) => !towns.live.has(q.id) && (q.size === 'town' || q.size === 'village' || q.size === 'city') && Math.hypot(q.at[0] - x, q.at[1] - y * ROW_H) > 300) ?? null;
  };
  mountMutLab(host.ui, {
    apply: (kind) => {
      if (isLand(kind)) {
        const m = mutators.apply({ kind, at: here(), radius: Number(host.params.get('mutr') ?? 40), strength: Number(host.params.get('muts') ?? 1), seed: seed++ });
        timing(kind);
        return `${kind} at ${m.cell[0]}, ${m.cell[1]}: ${m.resident ? 'written now' : 'waits for its land'}`;
      }
      if (kind === 'founded') {
        const m = mutators.apply({ kind, at: here(), name: 'New camp', size: 'camp' });
        return `${m.name} founded at ${m.cell[0]}, ${m.cell[1]} (a record, and a house on the map)`;
      }
      const t = town();
      if (!t) return 'No town is loaded near here.';
      // (the holder: a real faction of the world, not the town's own)
      const w = mutators.world!;
      const by = w.facts.find({ kind: 'faction' }).find((f) => f.id !== w.controllerOf(t.id))?.id;
      if (!by) return 'No other faction in this world.';
      mutators.apply({ kind, place: t.id, by, tribute: 3 });
      timing(kind);
      const p = mutators.place(t.id)!;
      return `${p.name}: ${p.status}${p.owner ? `, held by ${w.name(p.owner)}` : ''}${p.tribute ? `, pays ${p.tribute} a season` : ''}`;
    },
    sign: (kind) => {
      const on = mutators.signs().some((s) => s.kind === kind);
      mutators.sign({ kind, strength: on ? 0 : Number(host.params.get('muts') ?? 1) });
      return `${kind}: ${on ? 'off' : 'on'}`;
    },
    far: () => {
      const s = farPlace();
      if (!s) return 'No far place found.';
      far = s;
      const f = mutators.apply({ kind: 'flooded', place: s.id, seed: 3 });
      const w = mutators.world!;
      const by = w.facts.find({ kind: 'faction' }).find((q) => q.id !== w.controllerOf(s.id))?.id;
      if (by) mutators.apply({ kind: 'captured', place: s.id, by });
      return `${s.name} flooded and captured: ${f.resident ? 'written now' : 'not loaded, it will arrive that way'}. Open the map to see it.`;
    },
    erupt: () => {
      const s = farPlace();
      if (!s) return 'No far place found.';
      far = s;
      mutators.apply({ kind: 'melted', place: s.id, seed: 5 });
      const n = mutators.signs().filter((q) => q.cause !== null).length;
      return `${s.name} melted, far away: ${n ? 'ash and darkness fall here for three seasons' : 'no sign cast (no home town)'}.`;
    },
    go: () => {
      if (!far) return;
      void warpWindow(a.atlas, S, core.dims, Math.round(far.at[0]), Math.round(far.at[1] / ROW_H));
    },
    reload: () => {
      const u = new URL(location.href);
      u.searchParams.delete('fresh');
      void S.saveAll().then(() => (location.href = u.toString()));
    },
  });
}
