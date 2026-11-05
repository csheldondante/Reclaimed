// The test beds on the level: the tuning panel, bug report and stations bar (level.lab, ?tunepanel=1), the noise
// lab, and the playground stations' kit. API: mountLab, mountNoiseLab, labStationKit (LevelScene.stationKit),
// traitStationDriver, resetStation.
import { EventKind } from '../../sim/globals';
import { OP } from '../../sim/edit-ops';
import { PK } from '../../sim/particles';
import { TraitStation } from '../../levels/traitstation';
import { BODIES } from '../../ui/editor';
import { Sleep } from '../../sim/sleep';
import { TunePanel } from '../../ui/tunepanel';
import { BugReport } from '../../ui/bugreport';
import { StationsBar } from '../../ui/stations';
import { experimentChip, experimentControls, startRun } from '../../ui/experiment';
import { JUDGE_ID } from '../../game/judge';
import { solverVariant } from '../../solver/variant';
import { NoiseLabControl } from '../../noiselab/control';
import { stationMiddle, type Station, type StationKit } from '../../levels/playground';
import { cpuLine } from '../../gpu/cpustat';
import { CHUNK, SLOT_WORDS } from '../../world/layout';
import { cellPos } from '../../world/lattice';
import type { LevelScene } from '../level';

/** (round 108, AR5/AR8) the tuning panel, the bug report and (the playground) the stations bar */
export function mountLab(scene: LevelScene): void {
  const { core, host } = scene;
  const rigid = scene.integrity?.rigid;
  const rigidLine = () => (rigid ? `rigid ${rigid.list.length} · step ${rigid.stats.stepMs.toFixed(2)} ms · breaks ${rigid.stats.breaks} · settled ${rigid.stats.settled}` : '');
  scene.tunePanel = new TunePanel(host.ui, {
    open: scene.level.lab?.open,
    // (solver step 4: presets to start from — the user's "tankers' feel" is world gravity × 2)
    builtins: {
      "tankers' feel (gravity × 2)": { 'world.gravityX': 2 },
      'heavy and slow (gravity × 0.5)': { 'world.gravityX': 0.5 },
      'soft metal (bends a lot)': { 'solver.steelYield': 6e4, 'solver.steelTensile': 4e5, 'solver.blowG': 12 },
      'brittle metal (snaps)': { 'solver.steelYield': 2e5, 'solver.steelTensile': 2.2e5, 'solver.steelShear': 1.5e5 },
      'deep overlap (big slop)': { 'rigid.slopK': 0.12, 'rigid.slopCap': 1.2 },
      'stiff contacts (small slop)': { 'rigid.slopK': 0.02, 'rigid.slopCap': 0.3, 'rigid.pushV': 1.5 },
    },
    // (open at the start in a test bed on a desktop; on a phone its button, the world first)
    shown: !!scene.level.lab && !matchMedia('(pointer: coarse)').matches,
    stats: () => {
      const ig = scene.integrity;
      const parts = [rigidLine(), ig ? `falling ${ig.falling.list.length} · resting ${ig.restingCount}` : '', scene.sleep ? `awake ${scene.sleep.awake} chunks` : ''];
      return parts.filter(Boolean).join(' · ');
    },
  });
  scene.bugReport = new BugReport(host.ui, {
    level: scene.level.id,
    world: () => ({ seed: core.globals.seed, dims: core.dims, flow: !!scene.flow, rockbody: !!rigid, quality: host.qualityName, params: Object.fromEntries(host.params) }),
    camera: () => ({ target: [...core.camera.target], zoom: core.camera.zoom, azimuth: core.camera.azimuth, fly: core.camera.fly ? { pos: [...core.camera.fly.pos] } : null }),
    time: () => ({ tick: core.globals.tick, simTime: core.globals.time, timeOfDay: core.dayNight.timeOfDay, season: core.globals.season ?? 0, speed: scene.speed }),
    state: () => {
      const ig = scene.integrity;
      return {
        station: scene.stationsBar?.current.id ?? null,
        // (solver step 4: which solver and judge, and what the node solver holds — the bug report's physics)
        experiment: { solver: solverVariant(host.params), judge: JUDGE_ID, lastRun: scene.lastRun },
        solver: ig?.solver
          ? [...ig.solver.bodies].slice(0, 30).map((b) => ({ slot: b.slot, kind: b.kind, nodes: b.nodes, cells: b.cells, read: ig.solver!.read(b) ?? null }))
          : null,
        integrity: ig ? { stats: { ...ig.stats }, falling: ig.falling.list.length, resting: ig.restingCount, rigid: rigid ? { bodies: rigid.list.length, stats: { ...rigid.stats }, list: rigid.list.slice(0, 20).map((b) => ({ pos: b.pos, v: b.v, w: b.w, cells: b.cells.length })) } : null } : null,
        sleep: scene.sleep ? { awake: scene.sleep.awake } : null,
        flow: scene.flow ? { springs: scene.flow.water.springs.length + scene.flow.lava.springs.length } : null,
        weather: { storms: core.weather.storms.length, dusts: core.weather.dusts.length, cyclones: core.weather.cyclones.length },
        perf: { cpu: cpuLine() },
      };
    },
  });
  const stations = scene.level.stations;
  if (stations) {
    scene.stationsBar = new StationsBar(host.ui, stations, {
      go: (s) => {
        const [x, y, z, zoom] = s.look;
        if (core.camera.fly) scene.toggleFly();
        core.camera.target = [x, y, z];
        core.camera.zoom = zoom;
      },
      run: (s, k) => {
        scene.lastRun = `${s.id}/${encodeURIComponent(s.actions[k].label)}`;
        s.actions[k].run(labStationKit(scene));
      },
      reset: (s) => resetStation(scene, s),
      resetAll: () => {
        for (const s of stations) resetStation(scene, s);
        core.weather.dusts = [];
      },
    });
    // (solver step 2, the experiment: which solver and judge — a pick reloads — and compare; ?run= presses a button)
    const hooks = { variant: solverVariant(host.params), judge: JUDGE_ID, lastRun: () => scene.lastRun };
    scene.tunePanel.prepend(experimentControls(hooks));
    // (round 120: and always in sight, a chip that opens them)
    host.ui.appendChild(experimentChip(hooks));
    startRun(host.params, (id, label) => {
      const i = stations.findIndex((s) => s.id === id);
      const k = i < 0 ? -1 : stations[i].actions.findIndex((a) => a.label === label);
      if (k < 0) return false;
      scene.stationsBar!.pick(i);
      scene.lastRun = `${id}/${encodeURIComponent(label)}`;
      stations[i].actions[k].run(labStationKit(scene));
      return true;
    });
  }
}

/**
 * (round 111, TG1) the noise lab: its land rewritten from each recipe it runs — the whole window's columns, water
 * and surface (WorldCore.replaceWindow), the sea held at its level past the edges, what moved forgotten, the
 * mesh remade
 */
export function mountNoiseLab(scene: LevelScene): void {
  const { core, host } = scene;
  const { w, h, zMax } = core.dims;
  const p = core.packed;
  scene.noiseLab = new NoiseLabControl(
    host.gpu.device,
    host.ui,
    {
      w,
      h,
      zMax,
      layout: { chunksX: p.chunksX, chunkTable: p.chunkTable, slots: p.slots.length / SLOT_WORDS },
      write: (cols, sea) => {
        const t0 = performance.now();
        core.globals.seaZ = sea > 0 ? sea : undefined;
        scene.integrity?.forget(0, 0, w, h);
        core.replaceWindow(cols.slots, cols.water, cols.surface);
        const [wx1, wy1] = cellPos(w, h);
        core.renderer.fieldMesh.urgent(0, 0, wx1, wy1);
        scene.sleep?.wake(wx1 / 2, wy1 / 2, Math.max(wx1, wy1), Sleep.EVENT_S, performance.now() / 1000);
        return performance.now() - t0;
      },
    },
    host.params,
  );
  (globalThis as { noiselab?: NoiseLabControl }).noiselab = scene.noiseLab;
}

/** (round 108, AR8) what a station's buttons do: the world's own events and APIs */
export function labStationKit(scene: LevelScene): StationKit {
  const { core } = scene;
  const now = () => performance.now() / 1000;
  return {
    smash: (x, y, z, r) => {
      core.globals.events.push({ kind: EventKind.Edit, x, y, z: OP.SMASH * 32, radius: r, strength: z });
      core.sim.particles.burst({ kind: PK.Chip, x, y, z, count: 6 + r * 3, speed: 4, spread: r * 0.5 });
      scene.sleep?.wake(x, y, r + 8, Sleep.EVENT_S, now());
    },
    dig: (x, y, r, layers) => {
      core.globals.events.push({ kind: EventKind.Edit, x, y, z: OP.DIG * 32 + 512, radius: r, strength: layers });
      scene.sleep?.wake(x, y, r + 8, Sleep.EVENT_S, now());
    },
    source: (cols, rate) => {
      const v = new Float32Array([rate / 60 / cols.length]);
      for (const [x, y] of cols) core.host.gpu.device.queue.writeBuffer(core.world.waterSource, core.ring.i(x, y) * 4, v);
      const [wx, wy] = cellPos(cols[0][0], cols[0][1]);
      scene.sleep?.wake(wx, wy, 24, Sleep.EVENT_S, now());
    },
    dust: (x, y) => void core.weather.placeDust(x, y),
    rain: (x, y) => void core.weather.spawn(x, y),
    later: (secs, f) => void setTimeout(f, secs * 1000),
    pour: (x, y, r, layers, mat) => {
      core.sim.edit.always = true;
      core.globals.events.push({ kind: EventKind.Edit, x, y, z: OP.POUR * 32 + mat + 512, radius: r, strength: layers });
      scene.sleep?.wake(x, y, r + 8, Sleep.EVENT_S, now());
    },
    drop: (cells, vel) => {
      if (!scene.integrity?.dropBody(cells, vel)) throw new Error('station drop: no node solver here (the level needs the rigid rock)');
      const [wx, wy] = cellPos(cells[0].x, cells[0].y);
      scene.sleep?.wake(wx, wy, 24, Sleep.EVENT_S, now());
    },
    wakeMetal: (x, y, z) => scene.integrity?.wakeMetalAt(x, y, z),
    dropModels: (ids, x, y, above, wrap) => {
      const kinds = ids.map((id) => {
        const k = BODIES.find((b) => b.id === id);
        if (!k) throw new Error(`station dropModels: no body ${id} (physics/shapes.ts bodyCatalogue)`);
        return k;
      });
      if (!scene.integrity?.rigid) throw new Error('station dropModels: no solvers here (the level needs the rigid rock)');
      void scene.integrity.dropModels(kinds.map((k) => k.make()), x, y, above, wrap);
      const [wx, wy] = cellPos(x, y);
      scene.sleep?.wake(wx, wy, 40, Sleep.EVENT_S, now());
    },
    traits: scene.level.stations?.some((x) => x.id === 'traits') ? traitStationDriver(scene) : undefined,
  };
}

/** (LW1) the playground's traits station: its driver over this level's agents and trait system (made once) */
export function traitStationDriver(scene: LevelScene): TraitStation {
  const s = scene.level.stations?.find((x) => x.id === 'traits');
  if (!s) throw new Error('this level has no traits station');
  return (scene.traitStation ??= new TraitStation(scene.agents, scene.traits, stationMiddle(s)));
}

/** (round 108, AR8) a station put back as the level opened: what moves there let go, its chunks restored */
export function resetStation(scene: LevelScene, s: Station): void {
  const { core } = scene;
  const [x0, y0, x1, y1] = s.rect;
  scene.integrity?.forget(x0, y0, x1, y1);
  core.restoreChunks(x0 / CHUNK, y0 / CHUNK, x1 / CHUNK, y1 / CHUNK);
  const [wx0, wy0] = cellPos(x0, y0);
  const [wx1, wy1] = cellPos(x1, y1);
  core.renderer.fieldMesh.urgent(wx0, wy0, wx1, wy1);
  scene.integrity?.markBox(wx0, wy0, wx1, wy1);
  scene.sleep?.wake((wx0 + wx1) / 2, (wy0 + wy1) / 2, Math.max(wx1 - wx0, wy1 - wy0) / 2 + 8, Sleep.EVENT_S, performance.now() / 1000);
}
