// (mutators, docs/design/MUTATORS.md) The world mutators on the atlas level: the world modifier list bound to this
// window — its GPU ops over WorldGpu's contract buffers, arriving land written right after the static claims
// (Streamer.onWritten), each field town's lot conditions written when its lots are made (FieldTowns.onMade), the list
// kept in the world store, the changed places pinned on the atlas map. `?mutlab=1`: the lab's buttons.
import type { FieldTown } from '../../citygen/town';
import type { FieldTowns } from '../../citygen/towns';
import { mutators, type MutationRecord, type MutatorKind } from '../../mutate';
import { MutateEngine, type MutTown } from '../../mutate/engine';
import { MutateGpu } from '../../mutate/gpu';
import { mountMutLab } from '../../mutate/lab';
import { warpWindow } from '../../api/atlas-world';
import { ROW_H, cellAt } from '../../world/lattice';
import type { LevelScene } from '../level';

const KEY = 'mutators:list';
const MARK: Record<string, string> = { flooded: '#5aa9e6', burned: '#e0733a', melted: '#ff4a2a', buried: '#d8c08a', founded: '#8fd18a', destroyed: '#b0483a', abandoned: '#9a968c', occupied: '#c05ad0', vassal: '#e6c84a' };

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
  const lab = host.params.get('mutlab') === '1';
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
    towns: () => [...made.entries()].filter(([id]) => towns.live.has(id)).map(([, t]) => t),
    // (the liquid's records of the chunks written: forgotten, so it takes the water as the columns hold it now — as for
    // arriving land. Nothing is woken)
    landChanged: (x0, y0, x1, y1) => {
      scene.flow?.water.forget(x0, y0, x1 - x0, y1 - y0);
      scene.flow?.lava.forget(x0, y0, x1 - x0, y1 - y0);
    },
    changed: (rec) => void S.store?.put(KEY, new TextEncoder().encode(JSON.stringify(rec)), { session: 'town', hash: 0 }),
    time: lab,
  });
  mutators.bind(eng);
  (globalThis as { mutators?: unknown }).mutators = mutators;
  (globalThis as { mutateEngine?: unknown }).mutateEngine = eng;
  // (after the static claims' own hook — scenes/level/statics.ts: a building's columns are claimed when the ops look)
  S.onWritten.push((lx, ly, w, h) => void eng.landWritten(lx, ly, w, h));
  const add = (t: FieldTown) => {
    if (towns.live.get(t.site.id) !== t) return;
    const mt = townOf(t);
    made.set(t.site.id, mt);
    eng.townMade(mt);
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
    for (const m of mine) eng.apply({ ...m, at: m.cell, place: m.place ?? undefined });
  })();
  // (the atlas map: a pin on each changed place — its name and what the list did to it — and on each changed area)
  const map = scene.atlasMap;
  if (map) {
    const prev = map.marks;
    map.marks = () => [
      ...(prev?.() ?? []),
      ...eng.places().map((p) => ({
        at: p.at,
        name: `${p.name}: ${[...p.conditions, ...(p.status === 'standing' ? [] : [p.status])].join(', ')}${p.owner && p.status !== 'standing' ? ` (${p.owner})` : ''}`,
        colour: MARK[p.status === 'standing' ? (p.conditions[p.conditions.length - 1] ?? 'founded') : p.status],
      })),
      ...eng
        .record()
        .list.filter((m) => m.place === null)
        .map((m) => ({ at: m.cell, name: m.kind, colour: MARK[m.kind] })),
    ];
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
  mountMutLab(host.ui, {
    apply: (kind) => {
      const land = kind === 'flooded' || kind === 'burned' || kind === 'melted' || kind === 'buried';
      if (land) {
        const m = mutators.apply({ kind, at: here(), radius: Number(host.params.get('mutr') ?? 26), strength: Number(host.params.get('muts') ?? 1), seed: seed++ });
        timing(kind);
        return `${kind} at ${m.cell[0]}, ${m.cell[1]}: ${m.resident ? 'written now' : 'waits for its land'}`;
      }
      if (kind === 'founded') {
        const m = mutators.apply({ kind, at: here(), name: 'New camp', size: 'camp', by: 'player' });
        return `${m.name} founded at ${m.cell[0]}, ${m.cell[1]} (a record and a pin on the map)`;
      }
      const t = town();
      if (!t) return 'No town is loaded near here.';
      mutators.apply({ kind, place: t.id, by: 'Iron League', tribute: 3 });
      timing(kind);
      const p = mutators.place(t.id)!;
      return `${p.name}: ${p.status}${p.owner ? `, held by ${p.owner}` : ''}${p.tribute ? `, pays ${p.tribute} a season` : ''}`;
    },
    far: () => {
      const [x, y] = here();
      const s = st.near([x, y * ROW_H], 1e9).find((q) => !towns.live.has(q.id) && (q.size === 'town' || q.size === 'village' || q.size === 'city') && Math.hypot(q.at[0] - x, q.at[1] - y * ROW_H) > 300);
      if (!s) return 'No far place found.';
      far = s;
      const f = mutators.apply({ kind: 'flooded', place: s.id, seed: 3 });
      mutators.apply({ kind: 'captured', place: s.id, by: 'Iron League' });
      return `${s.name} flooded and captured: ${f.resident ? 'written now' : 'not loaded, it will arrive that way'}. Open the map to see its pin.`;
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
