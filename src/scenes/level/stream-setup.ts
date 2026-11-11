// The level's world over time, set up once at attach: sleep for a fixed map's held rivers, and for a streamed level
// (level.stream) the Streamer, its slides' hooks (camera, sea, settlements, the GPU towns), the far land and the
// warm cache. API: attachStream(scene). Talks to the streamer only through its public hooks.
import { FortressReachGpu } from '../../build/reachgpu';
import { EventKind } from '../../sim/globals';
import { AgentUnits } from '../../units/agent-units';
import { Streamer, REGION, boxOf } from '../streamer';
import { FarLand } from '../../atlas/far';
import { GPUGEN } from '../../atlas/finish';
import { settleLand, Sleep } from '../../sim/sleep';
import { riverMode } from '../../sim/world-gpu';
import { record, timed } from '../../gpu/cpustat';
import { ROW_H } from '../../world/lattice';
import { HybridChunks } from '../hybrid';
import { atlasControls, worldEventHere } from './atlas-controls';
import { staticsFor } from './statics';
import { startTownLab } from '../../lab/lab';
import { ARRIVE_PREP } from './flags';
import { worldSaveOf } from '../level';
import type { LevelScene } from '../level';
import { urlFlags } from '../../flags';
import { FieldTowns } from '../../citygen/towns';
import { LivingTowns } from '../../citylife/towns';
import { TownContracts } from '../../towncontracts/contracts';
import { livingFromUrl } from '../../citylife/params';
import { mountTownPanel } from '../../citygen/panel';
import { startSeasonLoop } from './season';
import { whenPipelinesReady } from '../../gpu/pipeline';

/** sleep and the streamed window, with what follows its slides */
export function attachStream(scene: LevelScene): void {
  const { core, host } = scene;
  const { dims } = core;
  if (scene.level.stream) {
    const a = scene.opts.atlas;
    scene.stream = a
      ? new Streamer(
          core,
          {
            // (round 80: a tile of its columns a frame — streaming mustn't stall the frame)
            region: (x0, y0, w, h) => a.atlas.regionLand(x0, y0, w, h, Infinity, true),
            // (round 102, `gpugen`: made on the GPU straight into the pool — ?gpugen=0 the CPU's way, region above)
            regionInto: (x0, y0, w, h, t, how) => a.atlas.regionInto(x0, y0, w, h, t, how),
            zRange: (x0, y0, w, h) => a.atlas.zRange(x0, y0, w, h),
            wrap: [a.atlas.p.cols, a.atlas.p.rows],
            height: a.atlas.p.zTop,
            // (round 71: the coarse world changes while a region is away)
            snapshot: (x0, y0, w, h) => a.atlas.snapshot(x0, y0, w, h),
            changes: (s, x0, y0, w, h) => a.atlas.changes(s, x0, y0, w, h),
            // (round 100: a region from the store — the hooks (settlements' plans, a run's stage) see its land made, the
            // record's is what's written)
            // (round 102: the GPU's way — the stamps asked for, the plans made, no land made)
            restored: async (x0, y0, w, h) => void (GPUGEN ? await a.atlas.stampsFor(x0, y0, w, h, true) : await a.atlas.regionLand(x0, y0, w, h, Infinity, true)),
          },
          a.origin,
          { oz: a.oz, outside: a.outside, ground: a.ground },
          worldSaveOf(host.params, a.atlas.p, { rivers: riverMode(), settle: settleLand() }),
        )
      : new Streamer(core);
    // (round 102) the tile pacer gives more of the frame's room as the camera moves fast
    if (a) {
      const S = scene.stream;
      a.atlas.pacer.urgency = () => Math.hypot(S.vel[0], S.vel[1]);
      // (round 108, TC8: a plan landed — a settlement's — the tiles made over its box without it are made again)
      a.atlas.stampsChanged.push((x0, y0, w, h) => core.renderer.tiles?.forgetMade(x0, y0, w, h, a.atlas.p.cols, a.atlas.p.rows));
    }
    // (round 79) the atlas's columns run past the window: what's above and below it drawn too (round 100: only when
    // the window doesn't hold the world's whole height)
    if (a && a.atlas.p.zTop > dims.zMax && core.renderer.enableBand(a.atlas.p.zTop)) scene.stream.refreshBand();
    // (trackA-liquids, ?liquid=flow) the flow model's records of the chunks a region's land is written into: forgotten
    if (scene.flow) {
      const fl = scene.flow;
      scene.stream.onWritten.push((lx, ly, w, h) => {
        fl.water.forget(lx, ly, w, h);
        fl.lava.forget(lx, ly, w, h);
      });
    }
    // (round 79) the sea past the window's edge: the sea in it stays
    if (a) core.globals.seaZ = a.atlas.p.sea - scene.stream.oz;
    // (round 128m, quarry) a slide in z down follows the ground as it is now too: a deep pit looked into
    if (a) scene.stream.groundNow = (x, y) => scene.heightAt(x, y);
    // (round 80) sleep and wake: what's still sleeps, what the player and the world's events touch wakes
    if (a && scene.sleep) {
      scene.sleep.settleAll(Sleep.SETTLE_S, performance.now() / 1000);
      const sl = scene.sleep;
      scene.stream.onSlide.push((dx, dy, dz) => {
        const t = performance.now() / 1000;
        // (a slide in z: every column cut again — the surfaces made again everywhere, the water settles)
        if (dz) sl.settleAll(2, t);
        else sl.shift(dx, dy, t);
      });
    }
    // (round 79) ?drive=speed: along the road nearest the window's middle (unwrapped from its first point)
    const dv = Number(host.params.get('drive') ?? 0);
    if (a && dv > 0) {
      const mx = scene.stream.origin[0] + dims.w / 2;
      const my = (scene.stream.origin[1] + dims.h / 2) * ROW_H;
      let best: Float32Array | null = null;
      let bd = Infinity;
      for (const r of a.atlas.settlement.roads)
        for (let k = 0; k < r.path.length; k += 2) {
          const dd = Math.hypot(r.path[k] - mx, r.path[k + 1] - my);
          if (dd < bd) {
            bd = dd;
            best = r.path;
          }
        }
      const W = a.atlas.worldW;
      const H = a.atlas.worldH;
      const path: [number, number][] = [];
      if (best)
        for (let k = 0; k < best.length; k += 2) {
          const prev = path[path.length - 1];
          let x = best[k];
          let y = best[k + 1];
          if (prev) {
            x = prev[0] + (((x - prev[0] + W * 1.5) % W) - W / 2);
            y = prev[1] + (((y - prev[1] + H * 1.5) % H) - H / 2);
          }
          path.push([x, y]);
        }
      // (from its point nearest the middle: its start may be far off)
      let s0 = 0;
      let sNear = 0;
      let dNear = Infinity;
      for (let k = 0; k < path.length; k++) {
        if (k > 0) s0 += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
        const dd = Math.hypot(((path[k][0] - mx + W * 1.5) % W) - W / 2, ((path[k][1] - my + H * 1.5) % H) - H / 2);
        if (dd < dNear) {
          dNear = dd;
          sNear = s0;
        }
      }
      scene.drive = { speed: dv, path, s: sNear, dir: 1, zoom: core.camera.zoom };
    }
    // (round 98) ?pan=speed[,deg] ?panturn=s,deg
    const pv = (host.params.get('pan') ?? '').split(',').map(Number);
    if (pv[0] > 0) {
      let dir: [number, number];
      if (pv.length > 1 && Number.isFinite(pv[1])) dir = [Math.cos((pv[1] * Math.PI) / 180), Math.sin((pv[1] * Math.PI) / 180)];
      else {
        const [ux, uy] = core.camera.screenDeltaToWorld(0, -1);
        const l = Math.hypot(ux, uy) || 1;
        dir = [ux / l, uy / l];
      }
      const pt = (host.params.get('panturn') ?? '').split(',').map(Number);
      scene.pan = { speed: pv[0], dir, t: 0, turnAt: pt[0] || 0, turnBy: pt[1] || 0, turned: 0, asked: 0 };
    }
    scene.stream.onSlide.push((dx, dy, dz) => {
      // what the level keeps in window coordinates
      // (round 106, frameprobe: the surface cache is on the ring — nothing to move)
      scene.hoverWorld = null;
      // the climate follows the latitude (the atlas's: snow it lays is snow the sim keeps), and the window's height
      if (a) core.globals.climate = a.atlas.climateAt(scene.stream!.origin[0] + dims.w / 2, scene.stream!.origin[1] + dims.h / 2, scene.stream!.oz);
      if (a) core.globals.seaZ = a.atlas.p.sea - scene.stream!.oz;
      // (round 92) what's waiting to be judged moves with the land (what was falling landed first: onBeforeSlide)
      const ti = performance.now();
      scene.integrity?.slid(dx, dy, dz);
      record('sl.lvl.integrity', performance.now() - ti);
    });
    // (round 92) before the window's columns are frozen, read back or moved: what's falling where they're frozen or
    // cut again lands; nothing falls or is judged while they're read back and written again (a slide in z, a warp)
    const S0 = scene.stream;
    scene.stream.onBeforeSlide.push((dx, dy, dz) => timed('sl.before.settle', () => scene.integrity?.settle(dx, dy, dz)));
    // (round 100) what play does to the land — edits (the world API's, the editor's, agents' digs, a story's door),
    // lightning, a fire lit, a tap to grow — keeps its regions (saved), unlike the sims' own drift
    const S1 = scene.stream;
    core.sim.eventTaps.push((sent) => {
      for (const e of sent) {
        if (e.kind === EventKind.Scare || e.kind === EventKind.Ripple) continue;
        const r = (e.radius ?? 0) + 2;
        S1.touch(e.x - r, (e.y - r) / ROW_H, e.x + r, (e.y + r) / ROW_H);
      }
    });
    // (round 100) the window isn't saved while something falls in it (it would be saved mid-air)
    scene.stream.canSave.push(() => !scene.integrity || scene.integrity.quiet);
    // (round 100, meshinst) the resting rock goes with its region: its mesh and transform in the region's record
    if (scene.integrity?.external) scene.stream.things.push(scene.integrity.regionThings());
    if (scene.integrity) scene.integrity.held = () => S0.columnsHeld;
    // (round 128j: no orphan pass while a slide's land is coming in — its places hold the land that left, claims and all)
    if (scene.integrity) scene.integrity.landPending = () => S0.unwritten.length > 0;
    // (round 80) a warp (the map's): the window somewhere else — what the level keeps in window coordinates again
    scene.stream.onWarp.push((_ox, _oy, nz) => {
      if (a) core.globals.climate = a.atlas.climateAt(scene.stream!.origin[0] + dims.w / 2, scene.stream!.origin[1] + dims.h / 2, nz);
      if (a) core.globals.seaZ = a.atlas.p.sea - nz;
      scene.sleep?.settleAll(Sleep.SETTLE_S + 1, performance.now() / 1000);
      scene.hoverWorld = null;
      scene.integrity?.clear();
      const i = core.ring.i(Math.floor(dims.w / 2), Math.floor(dims.h / 2));
      core.camera.target = [dims.w / 2, (dims.h / 2) * ROW_H, core.map.surface[i]];
      if (core.camera.fly) scene.toggleFly();
    });
    // (round 71) an event of the coarse world in sight is made in the window's columns too
    // the atlas level's buttons (round 72: a phone has no F, WASD, M or V)
    if (a) atlasControls(scene);
    // the land beyond the window (round 73): the atlas's ground and the coarse world, out to the sky
    if (a) {
      // (round 83: the rings of less detail between the window and the far land — ?lod=0 none, ?lod=low three
      // coarser ones, fewer vertices)
      // (round 105, DECISIONS AR3: with the tiles on — the default — no rings, nor their bake (farbake) or the window's
      // look on them (fardetail): the tiles draw the land past the window, the round 73 far land where none is yet)
      const tilesOn = !!core.renderer.tiles;
      const lodQ = urlFlags().get('lod');
      // (?lod=keep: the rings with the tiles too — a measurement switch, the frame's cost of the rings: DEVLOG round 105)
      const lod = (tilesOn && lodQ !== 'keep') || lodQ === '0' ? null : lodQ === 'low' ? { spacings: [4, 8, 16], n: 129 } : { spacings: [2, 4, 8, 16], n: 193 };
      if (scene.hybridOn && !scene.ceiling) {
        // (the window's heightfield chunks are the 1-cell ring's, near the camera; ?ringn= its vertices a side)
        const ringN = Number(host.params.get('ringn') ?? 193);
        if (!tilesOn) scene.far = new FarLand(host.gpu.device, a.atlas, core.renderer.targets, { spacings: [1, 2, 4, 8, 16], n: ringN });
        const fm = core.renderer.fieldMesh;
        if (!fm.on) throw new Error('?hybrid=1 needs the field mesh (not with ?mesh=0)');
        const [nx, ny, side] = fm.chunkGrid;
        const S = scene.stream;
        // (round 86: ?stormreach= world units round the focus within which a heightfield chunk's sim may wake)
        // (round 100: ?vradius= 0 — a chunk is voxels for what it holds, not for the camera's being near; the land come
        // in waits sim ticks, not a time, for the grid)
        const h = new HybridChunks(nx, ny, side, dims.w, dims.h, S, Number(host.params.get('vradius') ?? 0), () => ({ oz: S.oz, zMax: dims.zMax }), Number(host.params.get('stormreach') ?? 110), () => core.sim.tick);
        scene.hybrid = h;
        // (round 113, tilesfirst — SF7: the land written is prepared for drawing at once (WorldCore.prepareArrived)
        // and the grid draws it this frame: no READY_TICKS wait on the sim's ticks, which a slide holds — the step-1
        // chain's slowest link, 100-230 ms of a written region drawn by nothing. ?arriveprep=0 as before)
        S.onRelief.push((x0, y0, x1, y1) => {
          if (ARRIVE_PREP) core.prepareArrived();
          h.landBox(x0, y0, x1, y1, ARRIVE_PREP ? -Infinity : undefined);
        });
        S.onSlide.push((dx, dy, dz) => {
          if (!dz) h.shift(dx / side, dy / side);
          else h.zMoved();
        });
        S.onWarp.push(() => h.clear());
      }
      if (scene.ceiling) {
        const near = Number(host.params.get('near') ?? 1);
        // (?ringn=: vertices a side of each ring, 193 the usual; (n − 1) a multiple of 8 — lod.ts checks)
        const ringN = Number(host.params.get('ringn') ?? 193);
        if (near !== 1 && near !== 2) throw new Error('?near= must be 1 or 2 (cells between the finest ring’s vertices)');
        scene.far = new FarLand(host.gpu.device, a.atlas, core.renderer.targets, { spacings: near === 1 ? [1, 2, 4, 8, 16] : [2, 4, 8, 16], n: ringN }, true);
      }
      const far = scene.far ?? new FarLand(host.gpu.device, a.atlas, core.renderer.targets, lod);
      // (round 83: the rings draw past the window's edge — no wall down it)
      // (round 105: and the tiles — past the window's edge is theirs, or the far land's)
      if ((far.lod || tilesOn) && !scene.ceiling) core.renderer.openEdges();
      scene.far = far;
      const S = scene.stream;
      core.renderer.extraDraws.push((pass, clear) => {
        far.org = [S.origin[0], S.origin[1] * ROW_H, S.oz];
        // (round 103, ?tiles=1: the tiles' anchors are the world's — render/tilecache.ts)
        core.renderer.setTileOrigin(S.origin[0], S.origin[1], S.oz);
        // (round 104, TC2: the render-only land past the window, made the streamer's way; once)
        core.renderer.setTileLand(S.tileLand());
        far.win = [dims.w + 0.5, dims.h * ROW_H];
        far.zMax = dims.zMax;
        const c = core.camera.fly ? core.camera.fly.pos : core.camera.target;
        far.mid = [c[0], c[1]];
        // (the puck keeps the target's height on the ground; without it the height isn't the ground's)
        const [tx, ty, tz] = core.camera.target;
        // (round 128o: the land as generated — every frame, the lie of the land is enough)
        far.focus = core.camera.fly ? null : [tx, ty, scene.cutaway ? tz : scene.mapHeightAt(tx, ty)];
        far.storms = core.weather.storms;
        // (round 93: the window's light, for the rings to be lit as it is)
        const G = core.globals;
        far.light = { sun: G.sun, sunCol: G.sunCol, sky: G.sky, origin: G.origin ?? [0, 0], season: G.season ?? 0, pollution: G.pollution };
        far.draw(pass, clear);
      });
    }
    // (one after another: each reads the window back and writes it)
    if (a) a.atlas.coarse.onEvent.push((e) => (scene.worldEvents = scene.worldEvents.then(() => worldEventHere(scene, e))));
    // (round 69: the atlas's forms of a weak material are judged when they come in, like anything
    // built — what can't stand falls; the first window's, region by region)
    const integ = scene.integrity;
    if (a && integ) {
      // (round 100, hitchrec, main's call under the user's design — rounds 83 and 92: "only needs to be done when the
      // structure changes"): land come in isn't judged. What's generated (stamped towns, ways, bridges) stands by
      // construction; edits seed the judge. Judging each arriving town's box (and twice its size, and again a pass
      // later) was ~1 GB/s allocated panning at 120/s and a 40 s judge pass in a soak.)
      // (round 87: what's above the window comes down with a piece that reaches its top)
      const S = scene.stream;
      integ.above = { take: (x, y) => S.takeAbove(x, y), put: (x, y, ivs) => S.putAbove(x, y, ivs) };
      const m = a.map.structural;
      if (m)
        for (let y = 0; y < dims.h; y += REGION)
          for (let x = 0; x < dims.w; x += REGION) {
            const b = boxOf(m, dims.w, x, y, REGION, REGION);
            if (b) integ.markBox(...b);
          }
    }
    // (round 88) the settlements' records (settle/settlements.ts), and the units (the Units contract on the agents)
    // (switchover, 2026-11-10: the towns are the GPU field generator's alone — citygen/towns.ts — with the living town
    // and the season loop on by default; the old CPU planner, its view, its far plans, its ships and its people are gone)
    const st = a?.settlements;
    if (st) {
      const units = new AgentUnits(scene.agents);
      // (LW1) the walking dead are undead (AgentUnits' 'shambler' kind): the sanctuary burns them, raise passes them by
      scene.traits.kindTraits('shambler', ['undead']);
      scene.units = units;
      scene.settlements = st;
      core.onShift.push((dx, dy, dz) => units.shift(dx, dy, dz));
      const S = scene.stream;
      // (citygen M4b) the towns with a grid made by the GPU field generator as the window nears them, let go far behind
      // (citygen/towns.ts), once the level's pipelines are ready; one reach over the window, a town's solve at a time
      const fids = a!.fieldTowns;
      if (fids) {
        let fieldReach: FortressReachGpu | undefined;
        let reachChain: Promise<void> = Promise.resolve();
        const sites = fids.map((id) => {
          const fs = st.seeds.find((x) => x.rec.id === id)!;
          return { id, name: fs.rec.name, at: fs.rec.at, size: fs.rec.size, roads: st.approachWays(id), seed: fs.seed, purpose: fs.rec.purpose?.kind };
        });
        whenPipelinesReady(() => {
          const towns = new FieldTowns(
            {
              device: host.gpu.device,
              rawGround: (x0, y0, w, h, out) => a!.atlas.rawGroundGpu(x0, y0, w, h, out),
              sea: a!.atlas.p.sea,
              statics: () => staticsFor(scene),
              freeSlots: () => staticsFor(scene)?.freeSlots() ?? 0,
              landIn: () => !S.busy && !S.unwritten.length,
              plants: { globals: core.world.globals, veg: core.world.veg, vegNext: core.world.vegNext },
              reach: () => (fieldReach ??= new FortressReachGpu(host.gpu.device, core.world, dims.w, dims.h, () => [0, 0])),
              reachTurn: (f) => (reachChain = reachChain.then(f, f)),
              addMesh: (v, g, x) => core.renderer.addMesh(v, g, x),
              removeMesh: (g) => core.renderer.removeMesh(g),
              origin: () => S.origin,
              oz: () => S.oz,
              dims: { w: dims.w, h: dims.h },
              wrap: { cols: a!.atlas.p.cols, rows: a!.atlas.p.rows },
            },
            sites,
          );
          scene.fieldTowns = towns;
          // (time-lapse: the clock's speed, the debug panel — ?timelapse=1 starts one once the town's made — and the
          // districts' API for scripts and the opportunity UI)
          towns.speed = Number(host.params.get('tlspeed') ?? 1);
          (globalThis as { citygen?: FieldTowns }).citygen = towns;
          if (host.params.get('timelapse') === '1' || host.params.get('citypanel') === '1') mountTownPanel(host.ui, towns, host.params);
          if (host.params.get('timelapse') === '1') {
            const go = () => (towns.timelapse(Number(host.params.get('tlspan') ?? 30)) ? undefined : setTimeout(go, 500));
            go();
          }
          // (trackA-opps: the season loop on the town — docs/design/SEASON_LOOP.md; switchover: the default, ?opps=0 off)
          const opps = host.params.get('opps') !== '0';
          if (opps) startSeasonLoop(scene, towns);
          S.onSlide.push(() => towns.slid());
          S.onWarp.push(() => towns.warped());
          // (living town, docs/design/LIVING_TOWN.md — each made town's people, its quarry and clearing, on the GPU; the
          // panel with its counters. Switchover: on by default, ?living=0 off — the toggle diff. The panel: off in the
          // season loop unless ?livingpanel=1, on otherwise unless ?livingpanel=0)
          if (host.params.get('living') !== '0') {
            livingFromUrl(host.params);
            const lt = new LivingTowns({
              logs: towns.logs,
              townTime: () => towns.townTime,
              device: host.gpu.device,
              towns: () => towns.live,
              addVoxels: (i, g) => core.renderer.addVoxels(i, g),
              removeVoxels: (g) => core.renderer.removeVoxels(g),
              addMesh: (v, g, x) => core.renderer.addMesh(v, g, x),
              removeMesh: (g) => core.renderer.removeMesh(g),
              frameCompute: core.renderer.frameCompute,
              profiler: host.profiler,
              dims: { w: dims.w, h: dims.h },
              world: { globals: core.world.globals, chunks: core.world.chunks, materials: core.world.materials, layers: core.world.layers, veg: core.world.veg, vegNext: core.world.vegNext },
            });
            lt.debugGraph = host.params.get('livingdebug') === '1';
            scene.livingTowns = lt;
            (globalThis as { living?: LivingTowns }).living = lt;
            const panel = opps ? host.params.get('livingpanel') === '1' : host.params.get('livingpanel') !== '0';
            if (panel) lt.mountPanel(host.ui, () => void towns.claimDistrict('housing'));
          }
          // (Track B's unit contracts — docs/design/TOWN_CONTRACTS.md: the towns' side map written into the agents' own
          // side map, the named places' table; on the GPU, each frame's inputs the live towns, their places and clock.
          // ?contracts=0 off: the toggle diff; ?sidegates=open the gate rule)
          if (host.params.get('contracts') !== '0') {
            const tc = new TownContracts(
              host.gpu.device,
              { globals: core.world.globals, chunks: core.world.chunks, layers: core.world.layers, water: core.world.water, w: core.world.w, h: core.world.h },
              scene.agents.notice.sides,
              {
                gates: host.params.get('sidegates') === 'open' ? 'open' : 'closed',
                roles: (id) => {
                  const t = towns.live.get(id);
                  return t ? towns.logs.of(t.site.at).purposes : undefined;
                },
              },
            );
            scene.townContracts = tc;
            // (U2 round 5: the units' place orders resolved over the place table — spawnAt, orderGroup)
            units.usePlaces(tc.places, (i) => tc.townArea(i));
            core.renderer.frameCompute.push((enc) => {
              tc.setTowns([...towns.live.values()].filter((t) => t.times), towns.townTime);
              tc.encode(enc, host.profiler?.timestamps('towncontracts'));
            });
          }
          // (the first look now: the town the level opens on made before the first frames)
          towns.update(Infinity);
          // (switchover: the town lab, ?lab=1 — scripted gates drive the scene: src/lab/lab.ts)
          if (host.params.get('lab') === '1') startTownLab(scene);
        });
      }
    }
  }
}
