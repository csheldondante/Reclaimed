// window.reclaimed: the test and console API over the live level (scripts/*.mjs drive the game through it). API:
// testApi(scene) builds the base object; exposeTestApi(scene, api) adds the streamed world's, settlements', flow's and
// the rest and installs it on window. Exposes; owns nothing.
import { gatesOf } from '../../game/levels';
import { Trial } from '../../game/trial';
import { EventKind } from '../../sim/globals';
import { type WakeOptions } from '../../physics/wake';
import { box, table } from '../../physics/shapes';
import { boxMesh, rockMesh, type SkinMesh } from '../../physics/mesh';
import { WorldCore } from '../world-core';
import { FLOWLAB } from '../../levels/flowlab';
import { RB } from '../../game/rockbodies';
import { TUNING } from '../../tune/params';
import { readColumn } from '../../world/layout';
import { modelById, type VoxelModel } from '../../world/models';
import { MAT } from '../../world/materials';
import { cellAt, cellPos } from '../../world/lattice';
import { qRotate, qYawPitchRoll } from '../../grids/structures';
import { terrainSystem, worldAt } from './atlas-controls';
import { impact } from './impacts';
import { traitStationDriver } from './labs';
import type { LevelScene } from '../level';
import { captureTownFixture } from './town-fixture';
import { worldApiOf } from './world-api';

/** the base of window.reclaimed (made before the streamed world is set up, as attach always did) */
export function testApi(scene: LevelScene) {
  const { core } = scene;
  const { camera, sim, weather, globals, map, dims } = core;
  const self = scene;
  const api = {
    core,
    sim,
    world: core.world,
    weather,
    camera,
    renderer: core.renderer,
    map,
    packed: core.packed,
    globals,
    nature: scene.nature,
    powers: scene.powers,
    readBuffer: (n: Parameters<WorldCore['readBuffer']>[0]) => core.readBuffer(n),
    probe: (...a: Parameters<WorldCore['probe']>) => core.probe(...a),
    integrity: () => scene.integrity,
    // (round 117, structures) the city (?city=): its plan, stats
    // (round 119) the settlements' structures: what's drawn and claimed (settle/view.ts)
    settlementsView: () => scene.settlementsView,
    shipsView: () => scene.shipsView,
    // (round 95) the rigid rock's knobs (?rockbody=1): rb.breakSpeed = 12
    rb: RB,
    // (round 108, AR5) the tuning registry: tune.set('rigid.friction', 0.3), tune.changed(), tune.encode()
    tune: TUNING,
    // (round 87) the sandbox's tool bar: editor().select('smash') as a tap on its button would (scripts/towertest.mjs)
    editor: () => scene.editor,
    // agents: agents.spawn(200, x, y, { group: 0 }); agents.goTo(0, x, y)
    agents: scene.agents,
    // (LW1) traits: traits.apply({ op: 'heal', rate: 2, at: [x, y], radius: 10 }), traits.read(), traits.census()
    traits: scene.traits,
    // (LW1, the playground) the traits station's driver: station.crowd(), .smite(), .raise(), .sanctuary(), .census()
    traitStation: () => traitStationDriver(scene),
    // (round 117, ?life=) the inhabitants: life.define(spec), life.spawnGroup(sp, [x, y], n), life.drive(g, order), life.presence(rect, cell)
    get inhabitants() {
      return self.inhabitants;
    },
    // physics voxels (sandbox): phys.drop('steel', 5, 1, 10, x, y, 6) — a w × d × h box
    // of a material, its centre at world (x, y), `above` cells over the ground
    phys: {
      get physics() {
        return self.physics;
      },
      shapes: { box, table },
      meshes: { box: boxMesh, rock: rockMesh },
      /** wake ruin (or, with opts, terrain) within r of (x, y, z) into bodies (physics/wake.ts) */
      wake: (x: number, y: number, z: number, r: number, opts?: WakeOptions) => scene.waker?.wake(x, y, z, r, opts),
      /**
       * a mesh as a body over a lattice `voxel` cells apart (round 49): its
       * lowest point `above` the ground under (x, y), turned by yaw/pitch/roll (degrees)
       */
      dropMesh: async (mesh: SkinMesh, voxel: number, x: number, y: number, above = 0, yaw = 0, pitch = 0, roll = 0, vel: [number, number, number] = [0, 0, 0]) => {
        const phys = scene.physics;
        if (!phys) return null;
        const r = Math.PI / 180;
        const q = qYawPitchRoll(yaw * r, pitch * r, roll * r);
        let lo = [Infinity, Infinity, Infinity];
        let hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < mesh.pos.length; i += 3) {
          lo = lo.map((v, k) => Math.min(v, mesh.pos[i + k]));
          hi = hi.map((v, k) => Math.max(v, mesh.pos[i + k]));
        }
        // (the lattice's low corner is the mesh frame's origin: about its bounds' corner)
        const ext = hi.map((v, k) => Math.ceil((v - lo[k]) / voxel - 1e-6) * voxel) as [number, number, number];
        const pts: [number, number, number][] = [];
        for (let k = 0; k <= 2; k++) for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) pts.push(qRotate(q, [(ext[0] * i) / 2, (ext[1] * j) / 2, (ext[2] * k) / 2]));
        const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
        const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
        const lowZ = Math.min(...pts.map((p) => p[2]));
        const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
        let ground = 0;
        for (const p of pts) {
          const [gx, gy] = cellAt(x - cx + p[0], y - cy + p[1]);
          if (gx < 0 || gy < 0 || gx >= dims.w || gy >= dims.h) continue;
          const col = readColumn(core.packed, slots, gx, gy);
          if (col.length) ground = Math.max(ground, col[col.length - 1].z1);
        }
        return phys.spawnMesh(mesh, voxel, [x - cx, y - cy, ground + above - lowZ], q, vel);
      },
      spawn: async (m: VoxelModel, x: number, y: number, above = 0, yaw = 0, pitch = 0, roll = 0, vel: [number, number, number] = [0, 0, 0], floor = 0) => {
        const r = Math.PI / 180;
        const q = qYawPitchRoll(yaw * r, pitch * r, roll * r);
        const vs = m.voxel ?? 1;
        const [w, d, h] = m.size.map((n) => n * vs);
        // its lowest point `above` the highest ground (loose ground too) under its footprint
        const pts: [number, number, number][] = [];
        for (let k = 0; k <= 4; k++) for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) pts.push(qRotate(q, [(w * i) / 4, (d * j) / 4, (h * k) / 4]));
        const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
        const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
        const lowZ = Math.min(...pts.map((p) => p[2]));
        const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
        // (floor: something under it the layers don't hold, a body it was dropped on)
        let ground = floor;
        for (const p of pts) {
          const [gx, gy] = cellAt(x - cx + p[0], y - cy + p[1]);
          if (gx < 0 || gy < 0 || gx >= dims.w || gy >= dims.h) continue;
          const col = readColumn(core.packed, slots, gx, gy);
          if (col.length) ground = Math.max(ground, col[col.length - 1].z1);
        }
        return scene.physics?.spawn(m, [x - cx, y - cy, ground + above - lowZ], q, vel) ?? null;
      },
      /** the layers' intervals of the column at world (x, y) (tests) */
      column: async (x: number, y: number) => {
        const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
        const [gx, gy] = cellAt(x, y);
        return readColumn(core.packed, slots, gx, gy);
      },
      // (voxel: each voxel's edge in cells, round 49; w, d, h count voxels)
      drop: (mat: string, w: number, d: number, h: number, x: number, y: number, above = 0, yaw = 0, pitch = 0, roll = 0, voxel = 1) => {
        const id = MAT[(mat[0].toUpperCase() + mat.slice(1)) as keyof typeof MAT];
        if (id === undefined) throw new Error(`no material "${mat}"`);
        return api.phys.spawn({ ...box(id, w, d, h), voxel }, x, y, above, yaw, pitch, roll);
      },
    },
    trial: new Trial(core, scene.powers, gatesOf(map), map.poi.healthy),
    // structure grids: grids.place('officetower', x, y, yawDeg, pitchDeg, rollDeg) at world (x, y)
    grids: {
      list: core.structures.list,
      place: (id: string, x: number, y: number, yaw = 0, pitch = 0, roll = 0, sink = 0) => {
        const m = modelById(id);
        if (!m) throw new Error(`no model "${id}"`);
        const r = Math.PI / 180;
        return core.structures.place(m, x, y, qYawPitchRoll(yaw * r, pitch * r, roll * r), scene.heightAt, sink);
      },
    },
    // regions and rooms (docs/PLACES.md): places.load(plan), places.get(name).bury('sand', 2)…
    places: core.places,
    // the world as modules a game uses (docs/WORLD_API.md): api.terrain.heightAt(x, y), api.wind.gust(…), api.fx.burst('dust', …)
    // (`world` stays the GPU buffers, for tests)
    get api() {
      return worldApiOf(self);
    },
    scene: scene,
  };
  return api;
}

/** window.reclaimed: the base and the rest, once the streamed world is up */
export function exposeTestApi(scene: LevelScene, api: ReturnType<typeof testApi>): void {
  (window as unknown as { reclaimed: unknown }).reclaimed = Object.assign(api, {
    // (round 128l, tooling) the behaviour lab's scenario API (src/lab/lab.ts; docs/TOOLING.md)
    lab: scene.lab?.api,
    // (round 117, flora) the flora contract (api/contracts/flora.ts), for scripted checks: reclaimed.flora().passability…
    flora: () => worldApiOf(scene).flora,
    // (round 88, the atlas level) settlements.near([x, y]) / settlement('s12') / live() / raid() / plan(id), its
    // events (built, died, raided); units: the Units contract (api/contracts/units.ts) on the agents
    settlements: scene.settlements,
    units: scene.units,
    // (fortress slice 1) the fortress: plan (TownPlan), town, paint/erase/setGate, cellAt/centre/ringCells, tool
    fortress: scene.fortress,
    // (round 128m, townlab) the window round the start town as the lab's fixture (base64; scripts/labtown.mjs capture)
    townFixture: () => captureTownFixture(scene),
    // (milestone 2) its builders once Build was pressed: stats (trips, built, starved), ids, book
    fortressLife: () => scene.fortressLife,
    // (round 128d) its built blocks' claims in the columns: claimed() per structure, stats
    fortressClaims: () => (scene.fortress ? (scene.settlementsView ?? scene.lab?.view)?.claimsOf(scene.fortress.site.id) ?? null : null),
    // (round 128j) the static grids' claims written with the land: stats, audit(slots, packed) (scripts/staticclaims.mjs)
    statics: () => scene.statics,
    townDebug: scene.townDebug,
    // (?flow=1) the flow model: flow.water / flow.lava (LiquidSystem: addSpring), flow.steady (last read),
    // flow.breach() (the lab's plug dug out), flow.sleep (awake chunks)
    flow: scene.flow && {
      ...scene.flow,
      sleep: scene.sleep,
      breach: (spring?: number) => {
        const plug = FLOWLAB.notch;
        for (let y = plug.y0; y < plug.y1; y += 2) {
          const [x, wy] = cellPos((plug.plug[0] + plug.plug[1]) / 2, y + 0.5);
          // (round 86: three cells, the plug's height - at 4 a time it sank a shaft ~20 deep under the notch, which took
          // the pool's first seconds to fill before anything reached the lip)
          for (let k = 0; k < 3; k++) scene.core.globals.events.push({ kind: EventKind.Edit, x, y: wy, z: 2 * 32 + 512, radius: 2.2, strength: 1 });
        }
        scene.flow?.lab?.breach(spring);
      },
    },
    stream: scene.stream,
    atlas: scene.opts.atlas?.atlas,
    // (round 117, terrain track) the region graph, its requests and the flood tool (api/contracts/terrain.ts)
    terrain: scene.opts.atlas?.atlas ? terrainSystem(scene) : undefined,
    // (round 117, terrain: the hybrid's chunks, for probes — which are voxels, which the grid's)
    hybrid: () => scene.hybrid,
    // (round 93) the land past the window: far.lod.bytes, far.windowLook, far.grownVeg
    far: scene.far,
    toggleFly: () => scene.toggleFly(),
    // (round 86) the meteor tool's landing at world (x, y, z) now, without its flight; the last great meteor's window edit (ms)
    meteorNow: (x: number, y: number, z: number) => impact(scene, [x, y, z]),
    editLiveMs: () => scene.editLiveMs,
    // the coarse world's events at a window cell (round 71): coarse.meteor(x, y, r), coarse.erupt(x, y)
    // (round 80: `coarse`, not `world` — that's the GPU world, as everything else reads it: worldapitest broke)
    coarse: {
      meteor: (x: number, y: number, r?: number) => worldAt(scene, x, y, (wx, wy, c) => c.meteor(wx, wy, r)),
      erupt: (x: number, y: number) => worldAt(scene, x, y, (wx, wy, c) => c.erupt(wx, wy)),
      // (round 75) the geysers in the window and the time they keep
      geysers: () => ({ list: scene.geysers, t: scene.geyserT, on: [...scene.geyserOn] }),
    },
  });
}
