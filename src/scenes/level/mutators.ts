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
import { FOUNDED_RADIUS, holderHue, isLand } from '../../mutate/list';
import { BADGE_COLOUR, badgesOf, drawBadges } from '../../mutate/mapmarks';
import { mountMutLab } from '../../mutate/lab';
import { warpWindow } from '../../api/atlas-world';
import { ROW_H, cellAt } from '../../world/lattice';
import type { LevelScene } from '../level';
import { MemoryWorldState } from '../../api/contracts/world-state';
import { FactWorld } from '../../living/world';
import { registerMutatorOutcomes } from '../../mutate/outcomes';
import { useRiverWorld } from './runs';

const KEY = 'mutators:list';
export function attachMutators(scene: LevelScene, towns: FieldTowns): MutateEngine | null {
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
  // FIXED-CITY (BACKLOG MU-26): the run's home is the atlas's start town, for the whole run
  const homeId = a.startTown ?? null;

  // ---- the signs shown (docs/design/MUTATORS.md "Signs"): nothing runs while none is on
  const shown = { crime: new Set<string>(), dead: [] as number[] };
  // FIXED-CITY (BACKLOG MU-27): a sign shows only while its place's FieldTown is live in the window (or it names no
  // place); a sign on a camp, an army or a column of refugees has nothing to show on
  const strongest = (signs: readonly Sign[], kind: SignKind) => signs.filter((s) => s.kind === kind && (s.place === null || towns.live.has(s.place))).reduce((m, s) => Math.max(m, s.strength), 0);
  const showSigns = (signs: readonly Sign[]) => {
    core.skyDim = strongest(signs, 'darkness');
    // (ash fall: one number in the Globals — the weather's own rain draw makes the flakes of it, the lit surfaces
    // their grey dusting (rain.wgsl, render/light.wgsl ashDust). Nothing runs on the CPU while it is on)
    core.ashFall = strongest(signs, 'ashfall');
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
    // FIXED-CITY (BACKLOG MU-27): the dead rise in the first live FieldTown's streets, not at the sign's own place
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

  // ---- rivers run dry (BACKLOG MU-42): every `dried` entry is a cut of the river through its place — the river's nodes
  // in its disc and every reach above them (weather/catchwet.ts RiverCut), which the river field carries on downstream.
  // The held rivers and the tiles read the field; the water the window's columns hold is settled to it in one dispatch
  // when the field is fitted again and when land arrives (riverset.wgsl). Nothing runs while no river is cut.
  let cutsKey = '';
  let settle = false;
  const syncCuts = (rec: MutationRecord) => {
    const cuts = rec.list.filter((m) => m.kind === 'dried').map((m) => ({ x: m.cell[0], y: m.cell[1] * ROW_H, radius: m.radius, factor: Math.max(0, 1 - m.strength) }));
    const key = JSON.stringify(cuts);
    if (key === cutsKey) return;
    cutsKey = key;
    scene.riverCuts = cuts;
    // (the field's nodes take it the next frame: the window's catchments fitted again)
    scene.catchAt = '';
  };
  const cut = () => scene.riverCuts.length > 0 || [...scene.riverInflow.values()].some((v) => v < 1);
  scene.riverFieldWritten = (refit) => {
    if (!(refit || settle) || !cut()) return;
    settle = false;
    gpu.riverSettle([0, 0, core.dims.w, core.dims.h]);
    scene.flow?.water.forget(0, 0, core.dims.w, core.dims.h);
  };
  // (arriving land comes in with its rivers at the reference: settled after the field's next write)
  S.onWritten.push(() => void (settle = cut()));

  // ---- founded places built (BACKLOG MU-6): every `founded` entry is a site of the field towns — the town generator's
  // own path (citygen/towns.ts: made on the GPU when the window nears it, let go far behind, the same again on return:
  // a pure function of its seed, the ground and its population field). Its approach road runs toward the nearest
  // settlement of the atlas and on past the far side, so the generator has an arterial to hang its streets on.
  const syncFounded = (rec: MutationRecord) => {
    for (const m of rec.list) {
      if (m.kind !== 'founded' || !m.place) continue;
      const at: [number, number] = [m.cell[0] + 0.5, (m.cell[1] + 0.5) * ROW_H];
      const R = FOUNDED_RADIUS[m.size ?? 'camp'];
      const near = st.near(at, 1e9).find((q) => q.id !== m.place);
      let dx = near ? near.at[0] - at[0] : 1;
      let dy = near ? near.at[1] - at[1] : 0;
      dx -= Math.round(dx / a.atlas.worldW) * a.atlas.worldW;
      dy -= Math.round(dy / a.atlas.worldH) * a.atlas.worldH;
      const l = Math.hypot(dx, dy) || 1;
      const way = (k: number): [number, number][] => [0, 0.5, 1, 1.5, 2].map((t) => [at[0] + (dx / l) * R * t * k, at[1] + (dy / l) * R * t * k]);
      // (a camp is built as the generator's smallest grid, a village: under it the generator makes no streets —
      // citygen/town.ts hasGrid)
      towns.addSite({ id: m.place, name: m.name ?? m.place, at, size: m.size === 'town' ? 'town' : 'village', roads: [way(1), way(-1)], seed: (m.seed * 2654435761 + m.cell[0] * 40503 + m.cell[1] * 9973) >>> 0, purpose: m.purpose });
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
    changed: (rec) => {
      void S.store?.put(KEY, new TextEncoder().encode(JSON.stringify(rec)), { session: 'town', hash: 0 });
      syncCuts(rec);
      syncFounded(rec);
    },
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
  void (async () => {
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
    syncCuts(eng.record());
    syncFounded(eng.record());
    for (const m of mine) eng.apply({ ...m, at: m.cell, place: m.place ?? undefined });
  })();

  // ---- the atlas map: the map itself is the record (BACKLOG MU-5). Every land entry's area drawn at its place in its
  // kind's colour (water, char, rock, sand, a dry bed, dead or new green), and every changed place — read from the
  // fact layer, `places()` — a row of badges, one a condition, each with its own picture and its plain word: drowned,
  // burned, buried, under lava, occupied (in the holder's colour), vassal, founded, abandoned, destroyed
  // (mutate/mapmarks.ts). The map's pins (`marks`) are left to their owner, a run's objectives.
  const map = scene.atlasMap;
  if (map) {
    const prevOver = map.overlay;
    const texel = a.atlas.worldW / a.atlas.p.n;
    const hueColour = (by: string) => {
      const h = (holderHue(by) / 256) * Math.PI * 2;
      const c = [h, h - 2.094, h + 2.094].map((q) => Math.round((0.5 + 0.5 * Math.cos(q)) * 190 + 30));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    };
    map.overlay = (ctx, px, scale) => {
      prevOver?.(ctx, px, scale);
      const list = eng.record().list;
      for (const m of list) {
        if (!isLand(m.kind)) continue;
        const [x, y] = px(m.cell[0], m.cell[1]);
        const r = Math.max(7, m.radius / texel / scale);
        ctx.save();
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = BADGE_COLOUR[m.kind];
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
        ctx.restore();
        // (a change that names no place: its badge on the land itself)
        if (m.place === null) drawBadges(ctx, [m.kind], x, y, { words: true });
      }
      for (const p of eng.places()) {
        const kinds = badgesOf(p);
        if (!kinds.length) continue;
        const [x, y] = px(p.at[0], p.at[1]);
        drawBadges(ctx, kinds, x, y - 13, { words: true, tint: p.owner && p.status === 'occupied' ? hueColour(p.owner) : undefined });
      }
    };
  }
  if (lab) startLab(scene, towns, eng);
  return eng;
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
  // (the lab's hooks for scripts — scripts/mutators-reload.mjs: travel to a place by its id, and a live town's lot
  // conditions counted (a readback of its condition words, asked for by a check, never by the game))
  (globalThis as { mutlab?: unknown }).mutlab = {
    go: (id: string) => {
      // (an atlas settlement, or a place founded this run: the list's own)
      const s = st.settlement(id);
      const cell = s ? [Math.round(s.at[0]), Math.round(s.at[1] / ROW_H)] : eng.places().find((q) => q.id === id)?.at;
      if (!cell) throw new Error(`mutlab: no place ${id}`);
      return warpWindow(a.atlas, S, core.dims, cell[0], cell[1]);
    },
    live: () => [...towns.live.keys()],
    conditions: async (id: string): Promise<Record<number, number> | null> => {
      const t = towns.live.get(id);
      if (!t) return null;
      await t.made;
      const dev = host.gpu.device;
      const n = t.lots.room * 4;
      const rd = dev.createBuffer({ label: 'mutlab-cond', size: n, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(t.lots.condition, 0, rd, 0, n);
      dev.queue.submit([enc.finish()]);
      await rd.mapAsync(GPUMapMode.READ);
      const out: Record<number, number> = {};
      for (const v of new Uint32Array(rd.getMappedRange())) out[v & 255] = (out[v & 255] ?? 0) + 1;
      rd.unmap();
      rd.destroy();
      return out;
    },
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
        return `${m.name} founded at ${m.cell[0]}, ${m.cell[1]}: its streets and houses are made when the land round it is in view`;
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
