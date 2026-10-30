// Inhabitants in a world (round 117): one call, as installAgents. The level's hook is `?life=` (scenes/level.ts):
//   ?life=1        a wilderness round the camera: a herd of deer, goats, a wolf pack that stalks them, crows, a wanderer
//   ?life=dragon   the same and a dragon (fire breath that melts stone, wing beats that raise dust)
//   ?life=town     townsfolk on the stand-in paths (paths.ts) as well
//   ?life=empty    installed, nothing spawned (scripts/perf/inhabitants.mjs spawns its own)
//   ?life=viewer   the viewer's panel (viewer.ts): pick a body plan, tweak it, watch it walk, run, idle, fly
// Counts: ?lifeherd=N deer a herd (default 12).

import type { WorldCore } from '../scenes/world-core';
import type { AbilityHost } from '../api/contracts/inhabitants';
import type { V2 } from '../api/contracts/units';
import { InhabitantsGpu, type InhabitantsOpts } from './system';
import { SPECIES } from './species';
import { standInPaths } from './paths';

/** Add the inhabitants to `core`: their system after the particles, their mesh drawn as skins (lit, shadowed). */
export function installInhabitants(core: WorldCore, opts: InhabitantsOpts = {}): InhabitantsGpu {
  const { host, sim, renderer } = core;
  const life = new InhabitantsGpu(host.gpu.device, core.world, host.profiler, opts);
  sim.systems.splice(sim.systems.indexOf(sim.particles) + 1, 0, life);
  renderer.addMesh(life.verts, life.drawArgs);
  core.onShift.push((dx, dy, dz) => life.shift(dx, dy, dz));
  return life;
}

const FAR_ZOOM = 14;
const LOD_PARAM = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lifelod') ? Number(new URLSearchParams(location.search).get('lifelod')) : null;
const SCALE_PARAM = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lifescale') ? Number(new URLSearchParams(location.search).get('lifescale')) : null;

/** each frame: the mesh built round what the camera sees */
export function lifeFocus(life: InhabitantsGpu, core: WorldCore): void {
  const cam = core.camera;
  life.focus = [cam.target[0], cam.target[1]];
  // (the view's half-diagonal in world units, and a margin: the iso view's ground reaches further up the screen)
  life.focusR = cam.fly ? 400 : (Math.hypot(cam.viewportW, cam.viewportH) / Math.max(cam.zoom, 0.01)) * 0.75 + 12;
  // (true size: the user on IN13, round 117 — "Keep the creature small for now I want to add larger creatures but I want
  // to improve the generator even more and talk through increasing the quality and adding composable creatures via
  // items and mounts." The scale stays a knob, ?lifescale=, for that conversation; the default is 1)
  life.drawScale = SCALE_PARAM ?? 1;
  // (far LOD under FAR_ZOOM px a cell: a limb's taper still reads, its joints' facets don't; ?lifelod=0|1 forces it)
  life.lod = LOD_PARAM ?? (!cam.fly && cam.zoom < FAR_ZOOM ? 1 : 0);
}

/** A wilderness scene round `at` (world units): what ?life=1 shows. Returns the groups by name. */
export function wilderness(life: InhabitantsGpu, at: V2, opts: { herd?: number; dragon?: boolean; town?: boolean; ground?: (x: number, y: number) => number } = {}): Record<string, number> {
  const deer = life.define(SPECIES.deer);
  const goat = life.define(SPECIES.goat);
  const wolf = life.define(SPECIES.wolf);
  const crow = life.define(SPECIES.crow);
  const wanderer = life.define(SPECIES.wanderer);
  const beetle = life.define(SPECIES.beetle);
  const serpent = life.define(SPECIES.serpent);
  const [x, y] = at;
  const out: Record<string, number> = {};
  out.deer = life.spawnGroup(deer, [x - 10, y + 6], opts.herd ?? 12);
  life.drive(out.deer, { kind: 'roam', around: [x - 10, y + 6], radius: 26 });
  out.goats = life.spawnGroup(goat, [x + 22, y - 14], 8);
  out.wolves = life.spawnGroup(wolf, [x + 42, y + 30], 3);
  life.drive(out.wolves, { kind: 'roam', around: [x + 30, y + 20], radius: 40 });
  out.crows = life.spawnGroup(crow, [x, y], 14);
  life.drive(out.crows, { kind: 'roam', around: [x + 4, y - 4], radius: 18 });
  out.wanderer = life.spawnGroup(wanderer, [x + 4, y + 2], 1);
  life.drive(out.wanderer, { kind: 'roam', around: [x + 4, y + 2], radius: 10 });
  out.beetles = life.spawnGroup(beetle, [x - 4, y - 8], 5);
  life.drive(out.beetles, { kind: 'roam', around: [x - 4, y - 8], radius: 5 });
  out.serpent = life.spawnGroup(serpent, [x + 10, y + 12], 1);
  if (opts.dragon) {
    out.dragon = life.spawnGroup(life.define(SPECIES.dragon), [x - 40, y - 30], 1);
    life.drive(out.dragon, { kind: 'roam', around: [x - 20, y - 10], radius: 40 });
  }
  if (opts.town && opts.ground) {
    life.setPaths(standInPaths([x + 30, y - 30], opts.ground));
    out.town = life.spawnGroup(life.define(SPECIES.townsfolk), [x + 30, y - 30], 8);
    life.drive(out.town, { kind: 'paths' });
  }
  return out;
}

/** The level's hooks for abilities, through the world's own systems (the effects library is deferred). */
export function abilityHost(core: WorldCore, sys: { lavaBeam?: (b: { at: [number, number, number]; radius: number; power: number } | null) => void; blast?: (x: number, y: number, r: number, s: number, t: number) => void }): AbilityHost {
  let beamOff: ReturnType<typeof setTimeout> | null = null;
  return {
    ignite: (x, y, radius, intensity) => core.globals.events.push({ kind: 7 /* EventKind.Ignite */, x, y, radius, strength: intensity }),
    heat: (at, radius, power, seconds) => {
      if (!sys.lavaBeam) return;
      sys.lavaBeam({ at, radius, power });
      if (beamOff) clearTimeout(beamOff);
      beamOff = setTimeout(() => sys.lavaBeam?.(null), seconds * 1000);
    },
    blow: (x, y, r, s, t) => sys.blast?.(x, y, r, s, t),
  };
}
