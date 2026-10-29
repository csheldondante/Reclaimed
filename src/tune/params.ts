// (round 108, BACKLOG AR5) The physics and flow parameters: every number the tuning panel shows, one registry
// (src/tune/registry.ts has the contract). Each default is the constant it replaced, so the game is unchanged until
// someone moves a slider. Groups are the systems that read them; a CPU system reads `TUNE.<group>`, a GPU kernel
// `G.tune.<group><Key>` (common.wgsl struct Tune — in this order: the registry checks it as it's made).

import commonWgsl from '../shaders/common.wgsl?raw';
import { WORLD_G } from '../world/scale';
import { Registry, type GroupSpec } from './registry';

const SPEC = {
  world: {
    title: 'World',
    owner: 'everything falling through the air by the world\'s gravity (common.wgsl; liquid.wgsl, particles.wgsl, render.wgsl, the CPU bodies)',
    params: {
      gravity: { label: 'gravity', units: 'cells/s²', min: 1, max: 30, step: 0.1, def: WORLD_G, gpu: true, help: 'a cell a metre (DECISIONS rounds 106, 108): the falls, their spray and sheets, the rigid rock and the falling pieces' },
    },
  },
  rigid: {
    title: 'Rigid rock bodies',
    owner: 'game/rockbodies.ts (CPU, the rock the collapse frees)',
    params: {
      gravity: { label: 'gravity ×', units: '× world', min: 0.2, max: 4, step: 0.05, def: 1, url: 'rbgrav', help: 'times the world\'s gravity (was a 10 cells/s² of its own)' },
      restitution: { label: 'bounce', units: 'share', min: 0, max: 0.9, step: 0.05, def: 0.05, url: 'rbrest', help: 'share of the speed into the ground given back (hits over 1.5 cells/s)' },
      friction: { label: 'friction', units: 'μ', min: 0, max: 1.5, step: 0.05, def: 0.6, url: 'rbfric', help: 'Coulomb friction at the contacts' },
      breakSpeed: { label: 'break speed', units: 'cells/s', min: 1, max: 30, step: 0.5, def: 9, url: 'rbbreak', help: 'impact speed that breaks rock of strength 1 (× √strength)' },
      angDamp: { label: 'spin damping', units: '1/s', min: 0, max: 3, step: 0.05, def: 0.6, url: 'rbdamp' },
      contactDamp: { label: 'ground damping', units: '1/s', min: 0, max: 6, step: 0.1, def: 1.5, url: 'rbcdamp', help: 'spin and speed taken out while it touches the ground' },
      airDrag: { label: 'air drag', units: '1/s', min: 0, max: 2, step: 0.01, def: 0.1 },
      sizeK: { label: 'big is weak', units: 'exp', min: 0, max: 0.6, step: 0.05, def: 0.15, url: 'rbsize', help: 'break speed × (cells / 200)^−k: the square-cube law' },
      crumble: { label: 'crumble ×', units: '×', min: 0.5, max: 3, step: 0.1, def: 1.4, url: 'rbcrumble', help: 'the radius that crumbles round a hard hit, and the pieces it breaks into' },
      scatter: { label: 'scatter', units: 'share', min: 0, max: 1, step: 0.05, def: 0.2, url: 'rbscatter', help: 'pieces of a break thrown apart at this share of the impact speed' },
      tipSpin: { label: 'tip spin', units: 'rad/s', min: 0, max: 3, step: 0.05, def: 0.5, url: 'rbspin', help: 'a tipping piece\'s start about the edge it tips over' },
      maxV: { label: 'top speed', units: 'cells/s', min: 2, max: 60, step: 1, def: 14, url: 'rbmaxv' },
      slop: { label: 'contact slop', units: 'cells', min: 0, max: 0.3, step: 0.01, def: 0.03, help: 'overlap allowed before a contact pushes back (soft contacts)' },
      slopK: { label: 'overlap k', units: 'cells', min: 0, max: 0.3, step: 0.005, def: 0.065, url: 'rbslopk', help: '(round 110) more overlap allowed with mass: k · mass^p (cells; mass in cells of rock) — a big rock meets the ground only once it visibly cuts into it. A pair: the lighter one\'s (the ground is the heaviest)' },
      slopP: { label: 'overlap p', units: 'exp', min: 0, max: 1, step: 0.05, def: 0.35, url: 'rbslopp', help: '(round 110) mass^p: 1/3 grows with its size, 0 the same for all' },
      slopCap: { label: 'overlap cap', units: 'cells', min: 0, max: 2, step: 0.05, def: 0.8, url: 'rbslopcap', help: '(round 110) the most the mass adds' },
      pushV: { label: 'push-out speed', units: 'cells/s', min: 0, max: 5, step: 0.05, def: 0.6, help: '(round 110) the fastest an overlap is resolved: it settles out, never jumps (and never gains speed)' },
      erodeDepth: { label: 'erode depth', units: 'cells', min: 0.1, max: 1, step: 0.05, def: 0.4, help: '(round 110) past the slop by this much, the ground where it meets the body crumbles instead of pushing it out' },
      erodeMax: { label: 'erode a step', units: 'cells', min: 0, max: 16, step: 1, def: 4, help: '(round 110) cells of ground a body crumbles a frame at most' },
      restMax: { label: 'resting rock', units: 'bodies', min: 1, max: 40, step: 1, def: 16, help: '(round 110) bodies kept asleep as meshes; past it the oldest is baked into the ground, behind a burst of dust' },
      restV: { label: 'rest speed', units: 'cells/s', min: 0.05, max: 2, step: 0.05, def: 0.3, help: 'under this (and rest spin) for rest time with something under it: settled' },
      restW: { label: 'rest spin', units: 'rad/s', min: 0.05, max: 1, step: 0.05, def: 0.15 },
      restT: { label: 'rest time', units: 's', min: 0.1, max: 3, step: 0.1, def: 0.6 },
      balanceGive: { label: 'balance give', units: 'cells', min: 0, max: 1, step: 0.05, def: 0.1, help: '(round 112) how far past the hull of what it touches its centre of mass may lie and it still stands; past it, it topples: the ground does not damp its spin and it is not at rest' },
      neckStrength: { label: 'neck strength', units: 'cells/s', min: 1, max: 300, step: 1, def: 70, help: '(round 112) a thin section snaps when (the mass beyond it) x (the impact speed) / (its cross-section) passes this x strength' },
      neckDepth: { label: 'neck depth', units: 'cells', min: 1, max: 8, step: 1, def: 3, help: '(round 112) the thickest a neck is looked for: its half-thickness in lattice steps from the surface' },
      neckMin: { label: 'neck side', units: 'cells', min: 4, max: 200, step: 1, def: 12, help: '(round 112) the least a side of a neck must weigh to snap off on its own' },
      maxBodies: { label: 'max bodies', units: 'bodies', min: 1, max: 60, step: 1, def: 10, url: 'rbmax', help: 'at once (the phone); past it the oldest settles into the columns' },
      cubes: { label: 'show cubes', units: '0/1', min: 0, max: 1, step: 1, def: 0, url: 'rbcubes', help: 'debug: the cubes the bodies are simulated with drawn too' },
    },
  },
  pieces: {
    title: 'Falling pieces (columns)',
    owner: 'game/colbodies.ts and game/bodies.ts (CPU, the pieces the structure check frees without rigid rock)',
    params: {
      gravity: { label: 'gravity ×', units: '× world', min: 0.2, max: 4, step: 0.05, def: 1, help: 'times the world\'s gravity (was a 10 cells/s² of its own)' },
      maxV: { label: 'top speed', units: 'cells/s', min: 1, max: 40, step: 0.5, def: 4, help: 'the cap a falling piece reaches (4: why they look floaty)' },
      airDrag: { label: 'air drag', units: '1/s', min: 0, max: 2, step: 0.05, def: 0.35 },
      landing: { label: 'landing', units: 'share', min: 0, max: 1, step: 0.05, def: 0.6, help: 'share of the falling speed a contact takes away a substep (bodies.ts)' },
      slop: { label: 'sink', units: 'cells', min: 0, max: 0.5, step: 0.01, def: 0.15, help: 'overlap a landing piece sinks before it stops (bodies.ts)' },
    },
  },
  impact: {
    title: 'Impacts',
    owner: 'game/integrity.ts (CPU: what a piece hitting the ground breaks)',
    params: {
      breakSpeed: { label: 'break speed', units: 'cells/s', min: 0.2, max: 10, step: 0.1, def: 1.2, help: 'a piece hitting this fast or more shatters' },
      shatter: { label: 'shatter', units: 'voxels·cells²/s²', min: 50, max: 5000, step: 50, def: 700, help: 'pieces ≈ weakness · speed² · voxels / this' },
      crumb: { label: 'crumbs', units: 'voxels', min: 1, max: 100, step: 1, def: 16, help: 'pieces this small crumble to loose ground' },
    },
  },
  fracture: {
    title: 'Collapse (what holds rock up)',
    owner: 'game/fracture.ts (CPU: the judge that frees rock)',
    params: {
      buckle: { label: 'buckle', units: '× I / L²', min: 500, max: 40000, step: 500, def: 9000, url: 'buckle', help: 'a leg buckles under this × strength × I / L²' },
      tensile: { label: 'tensile', units: 'mass/cell²', min: 5, max: 2000, step: 5, def: 200, url: 'tensile', help: 'the pull a leg\'s far side takes before it snaps' },
      crush: { label: 'crush', units: 'cells', min: 25, max: 3000, step: 25, def: 300, url: 'crush', help: 'a column bears this × its bear from below' },
      shear: { label: 'shear', units: '× overlap', min: 1, max: 60, step: 1, def: 10, url: 'shear', help: 'a joint between neighbouring runs: × their overlap' },
      bend: { label: 'bend', units: '× overlap²', min: 0.5, max: 20, step: 0.5, def: 3, url: 'bend', help: 'a joint: × overlap² (a slab a cell thick reaches this far)' },
      tipGive: { label: 'tip give', units: 'cells', min: 0, max: 3, step: 0.05, def: 0.25, url: 'tip', help: 'how far a centre of mass may lie past what it stands on' },
      neck: { label: 'neck reach', units: 'columns', min: 2, max: 64, step: 1, def: 16, url: 'neck', help: 'past this from what hangs, a piece is keyed into the land' },
      bearSoil: { label: 'bear: soil', units: '× rock', min: 0, max: 2, step: 0.05, def: 0.3 },
      bearSand: { label: 'bear: sand', units: '× rock', min: 0, max: 2, step: 0.05, def: 0.15 },
      bearRubble: { label: 'bear: rubble', units: '× rock', min: 0, max: 2, step: 0.05, def: 0.4 },
      bearSnow: { label: 'bear: snow', units: '× rock', min: 0, max: 2, step: 0.05, def: 0.05 },
    },
  },
  voxels: {
    title: 'Physics voxels (metal)',
    owner: 'physics/physics.ts + phys.wgsl (GPU: what bends — metal woken into bonded voxels)',
    params: {
      gravity: { label: 'gravity', units: 'cells/s²', min: 1, max: 40, step: 0.5, def: 20, gpu: true, help: 'its own (2× the world\'s: a conflation to settle)' },
      vmax: { label: 'top speed', units: 'cells/s', min: 5, max: 120, step: 1, def: 60, gpu: true },
      airDrag: { label: 'air drag', units: '1/s', min: 0, max: 2, step: 0.01, def: 0.05, gpu: true },
      stepUp: { label: 'step up', units: 'cells', min: 0, max: 1.5, step: 0.05, def: 0.45, gpu: true, help: 'a ledge this high is climbed, not a wall' },
      crumbleDepth: { label: 'crumble depth', units: 'cells', min: 0.1, max: 1.5, step: 0.05, def: 0.6, gpu: true, help: 'into solid ground this far, a voxel crumbles (erode, not push)' },
      crumbleOverlap: { label: 'crumble overlap', units: 'cells', min: 0.1, max: 1.5, step: 0.05, def: 0.5, gpu: true, help: 'two voxels this far into each other: the weaker crumbles' },
      fragRest: { label: 'fragment rest', units: 's', min: 0.1, max: 5, step: 0.1, def: 0.6, gpu: true, help: 'a fragment this long at rest goes to dust' },
      fragLife: { label: 'fragment life', units: 's', min: 0.5, max: 30, step: 0.5, def: 6, gpu: true },
      tear: { label: 'mesh tear', units: '× rest', min: 1.05, max: 4, step: 0.05, def: 1.6, gpu: true, help: 'a skinned triangle edge stretched past this tears' },
    },
  },
  structure: {
    title: 'Structures under water',
    owner: 'structure.wgsl (GPU: cracked solids holding water wear through)',
    params: {
      headMin: { label: 'head min', units: 'cells', min: 0, max: 10, step: 0.1, def: 2, gpu: true, help: 'water head under this does no damage' },
      headRate: { label: 'head rate', units: '/cell/tick', min: 0, max: 0.05, step: 0.001, def: 0.006, gpu: true },
      flowRate: { label: 'scour rate', units: '/(cell/s)/tick', min: 0, max: 0.05, step: 0.0005, def: 0.006, gpu: true, help: 'fast water alongside a cracked solid wears it: a chance a tick per cell/s over the scour speed (round 112: was 0.06 per unit of the old net flux)' },
      scourSpeed: { label: 'scour speed', units: 'cells/s', min: 0, max: 5, step: 0.05, def: 1, gpu: true, help: '(round 112) water slower than this beside a cracked solid does not wear it (the scour rate is per cell/s over it)' },
    },
  },
  water: {
    title: 'Water (both models)',
    owner: 'water_depth.wgsl (pipes) and liquid.wgsl (the flow model): rain and evaporation',
    params: {
      rain: { label: 'rain rate', units: 'cells/tick', min: 0, max: 0.01, step: 0.0001, def: 0.0012, gpu: true },
      evap: { label: 'evaporation', units: 'cells/tick', min: 0, max: 0.0005, step: 0.00001, def: 0.00003, gpu: true, help: 'from shallow water (under 0.08)' },
    },
  },
  pipes: {
    title: 'Water pipes (the game\'s water)',
    owner: 'water_flux.wgsl / water_depth.wgsl (GPU: the atlas\'s and the fixed levels\' water)',
    params: {
      // (round 112, waterscale — the user: "The water seems to fast for the scale": the pipes in physical units, pushed
      // by the world's gravity, held back by Manning's friction — common.wgsl pipeCoef. The old per-tick gain 0.08 and
      // flux kept 0.985 are gone: the push is g·dt²·depth, the friction comes from these)
      roughness: { label: 'roughness n', units: 's/m^⅓', min: 0.01, max: 0.15, step: 0.005, def: 0.04, gpu: true, url: 'pipen', help: 'Manning\'s n: a steady sheet or river runs at depth^⅔ · √slope / n (0.03 a clean channel, 0.04 a stony stream, 0.07 a boulder torrent)' },
      damping: { label: 'wave damping', units: '1/s', min: 0, max: 1, step: 0.005, def: 0.03, gpu: true, help: 'a linear drag on top of the friction: deep water (where Manning barely bites) stops sloshing and can settle and sleep' },
      vmax: { label: 'top speed', units: 'cells/s', min: 1, max: 30, step: 0.5, def: 8, gpu: true, help: 'the fastest water runs (over a ledge the head is the whole drop): a cell a metre' },
      riverRelax: { label: 'river relax', units: 'share/step', min: 0.001, max: 0.5, step: 0.001, def: 0.02, gpu: true, help: 'how fast a held river comes to its table\'s depth' },
      oilRoughness: { label: 'oil roughness n', units: 's/m^⅓', min: 0.01, max: 0.3, step: 0.005, def: 0.08, gpu: true, help: '(round 112) oil\'s own pipes (oil_flux.wgsl), the same law: thicker, slower than water — and carried by the water\'s current' },
    },
  },
  flowLook: {
    title: 'Water drawn flowing',
    owner: 'renderfields.wgsl flowLook (GPU: the streaks, foam and scroll drawn on the pipes\' water and the held rivers)',
    // (round 112 — the user: "Yes also keep flow animations normalized to the new numbers so we still see flow that
    // would previously be considered slow": the water's speed in cells a second mapped onto the animation's range, not
    // drawn at its literal speed)
    params: {
      refSpeed: { label: 'reference speed', units: 'cells/s', min: 0.1, max: 8, step: 0.05, def: 1.5, gpu: true, help: 'a typical river\'s speed: drawn scrolling at the reference scroll' },
      refScroll: { label: 'reference scroll', units: 'cells/s drawn', min: 0.1, max: 2.5, step: 0.05, def: 1, gpu: true },
      curve: { label: 'curve', units: 'exp', min: 0.1, max: 1.5, step: 0.05, def: 0.5, gpu: true, help: 'scroll ∝ speed^this: under 1 spreads the slow speeds out, so slow water still reads as flowing and fast as faster' },
      minScroll: { label: 'least scroll', units: 'cells/s drawn', min: 0, max: 1, step: 0.02, def: 0.25, gpu: true, help: 'any water moving faster than still is drawn scrolling at least this' },
      still: { label: 'still under', units: 'cells/s', min: 0, max: 0.5, step: 0.005, def: 0.02, gpu: true, help: 'slower than this it\'s drawn still' },
    },
  },
  flow: {
    title: 'Flow model (?flow=1)',
    owner: 'flow/liquid.ts + liquid.wgsl (GPU: runs in the columns, arcing falls)',
    params: {
      waterGain: { label: 'water gain', units: '/tick', min: 0.005, max: 0.16, step: 0.005, def: 0.08, gpu: true },
      waterFriction: { label: 'water flux kept', units: 'share', min: 0.5, max: 0.999, step: 0.001, def: 0.985, gpu: true },
      waterDrop: { label: 'water fall drop', units: 'cells', min: 0.25, max: 6, step: 0.05, def: 1.25, gpu: true, help: 'a drop past this under the run\'s floor is a fall' },
      lavaGain: { label: 'lava gain', units: '/tick', min: 0.001, max: 0.1, step: 0.001, def: 0.02, gpu: true },
      lavaFriction: { label: 'lava flux kept', units: 'share', min: 0.3, max: 0.999, step: 0.005, def: 0.9, gpu: true },
      lavaYield: { label: 'lava yield', units: 'cells', min: 0, max: 1, step: 0.01, def: 0.12, gpu: true, help: 'it won\'t move down a step smaller than this' },
      lavaThick: { label: 'lava thickness', units: 'cells', min: 0, max: 2, step: 0.05, def: 0.4, gpu: true, help: 'thinner than this it barely flows, as (d / this)²' },
      lavaCool: { label: 'lava cooling', units: 'e-folds/s/cell', min: 0, max: 0.2, step: 0.005, def: 0.02, gpu: true },
      lavaDrop: { label: 'lava fall drop', units: 'cells', min: 0.25, max: 6, step: 0.05, def: 1.25, gpu: true },
    },
  },
  lava: {
    title: 'Lava (beam, volcanoes)',
    owner: 'sim/lava.ts + lava.wgsl / lava_flux.wgsl (GPU)',
    params: {
      gain: { label: 'gain', units: '/tick', min: 0.001, max: 0.1, step: 0.001, def: 0.012, gpu: true },
      friction: { label: 'flux kept', units: 'share', min: 0.3, max: 0.999, step: 0.005, def: 0.9, gpu: true },
      yield: { label: 'yield', units: 'cells', min: 0, max: 1, step: 0.01, def: 0.12, gpu: true },
      cool: { label: 'cooling', units: '1/s', min: 0, max: 0.5, step: 0.005, def: 0.06, gpu: true },
    },
  },
  sediment: {
    title: 'Loose ground (sediment, repose)',
    owner: 'sediment.wgsl (GPU: slumps, wash, falls of loose ground)',
    params: {
      repose: { label: 'repose ×', units: '× table', min: 0.2, max: 3, step: 0.05, def: 1, gpu: true, help: 'times every material\'s angle of repose (materials.ts reposeDry / reposeWet)' },
      slump: { label: 'slump rate', units: 'share/pass', min: 0.005, max: 0.15, step: 0.005, def: 0.08 * 2 / 3, gpu: true, help: 'share of the excess over the repose sent to each neighbour a pass' },
      face: { label: 'face spill', units: 'share/pass', min: 0, max: 0.5, step: 0.01, def: 0.08, gpu: true, help: 'a buried loose layer with air beside it spills out of the face' },
      fall: { label: 'fall', units: 'cells/pass', min: 0.25, max: 8, step: 0.25, def: 2, gpu: true, help: 'loose ground with air under it falls this far a pass' },
      holdSteep: { label: 'roots hold', units: 'cells/cell', min: 0, max: 4, step: 0.1, def: 1, gpu: true, help: 'roots hold a slope this much steeper than its repose' },
      carry: { label: 'wash carry', units: 'cells/s per cell/s', min: 0, max: 2, step: 0.01, def: 0.25, gpu: true, help: 'depth lifted by water over the threshold' },
      pipeHead: { label: 'piping head', units: 'cells', min: 0.5, max: 10, step: 0.1, def: 2.5, gpu: true, help: 'a water-level difference past this pushes loose ground to the low side' },
      pipeRate: { label: 'piping rate', units: 'cells/pass/cell', min: 0, max: 0.3, step: 0.005, def: 0.04, gpu: true },
      shakeSlip: { label: 'shake slip', units: 'share', min: 0, max: 1, step: 0.05, def: 0.8, gpu: true, help: 'at its hardest a shake lowers the repose by this share' },
      washRate: { label: 'wash rate', units: 'cells/pass per m²/s', min: 0, max: 10, step: 0.05, def: 2, gpu: true, help: '(round 112) loose ground water carries: depth × (speed − the material wash speed) × this (× its mobility)' },
    },
  },
  wash: {
    title: 'Wash speeds (loose ground in water)',
    owner: 'world/materials.ts packMaterialTable → sediment.wgsl waterOut (the material table: WorldGpu rewrites it when one moves)',
    // (round 112, waterscale) the water's speed below which a loose material isn't carried (cells/s, a cell a metre:
    // roughly the critical speeds of the real thing — fine dust and ash first, gravel and rubble last). Was a net flux
    // a tick in the old pipes' units.
    params: {
      soil: { label: 'soil', units: 'cells/s', min: 0, max: 4, step: 0.05, def: 0.6 },
      sand: { label: 'sand', units: 'cells/s', min: 0, max: 4, step: 0.05, def: 0.4 },
      rubble: { label: 'rubble', units: 'cells/s', min: 0, max: 6, step: 0.05, def: 1.2 },
      ash: { label: 'ash', units: 'cells/s', min: 0, max: 4, step: 0.05, def: 0.25 },
      litter: { label: 'litter', units: 'cells/s', min: 0, max: 4, step: 0.05, def: 0.3 },
      drift: { label: 'drift', units: 'cells/s', min: 0, max: 4, step: 0.05, def: 0.25 },
      silt: { label: 'silt', units: 'cells/s', min: 0, max: 4, step: 0.05, def: 0.5 },
      snow: { label: 'snow', units: 'cells/s', min: 0, max: 4, step: 0.05, def: 0.35 },
      leaves: { label: 'leaf litter', units: 'cells/s', min: 0, max: 4, step: 0.05, def: 0.2 },
    },
  },
  dust: {
    title: 'Dust and haze (particles)',
    owner: 'particles.wgsl (GPU)',
    params: {
      drag: { label: 'dust drag', units: '1/s', min: 0, max: 6, step: 0.1, def: 1.6, gpu: true, help: 'how fast a grain takes the wind\'s speed' },
      fall: { label: 'dust fall', units: 'cells/s²', min: 0, max: 10, step: 0.1, def: 1.1, gpu: true, help: 'how fast it drifts down (rain adds to it)' },
      hazeDrag: { label: 'haze drag', units: '1/s', min: 0, max: 6, step: 0.1, def: 1.4, gpu: true },
      hazeRise: { label: 'haze rise', units: 'cells/s²', min: -2, max: 2, step: 0.05, def: 0.15, gpu: true, help: 'a cloud of a collapse\'s material lifts this much' },
      shown: { label: 'blown dust shown', units: 'grains/s', min: 0, max: 2, step: 0.01, def: 0.12, gpu: true, help: '(round 112) where the wind lifts nothing (the ground asleep, or its work baked): dust shown off loose ground a column a second, at full wind, times its airborne share; none under its lift' },
    },
  },
  debris: {
    title: 'Chips and splash (particles)',
    owner: 'particles.wgsl (GPU)',
    params: {
      drag: { label: 'drag', units: '1/s', min: 0, max: 3, step: 0.05, def: 0.3, gpu: true },
      gravity: { label: 'gravity', units: 'cells/s²', min: 1, max: 40, step: 0.5, def: 14, gpu: true, help: 'its own (not the world\'s: a conflation to settle)' },
    },
  },
  spray: {
    title: 'Spray off falls',
    owner: 'liquid.wgsl (GPU, the flow model\'s falls; ?spraybudget scales them all)',
    params: {
      drops: { label: 'drops ×', units: '×', min: 0, max: 5, step: 0.1, def: 1, gpu: true, help: 'drops along a fall\'s path' },
      splash: { label: 'splash ×', units: '×', min: 0, max: 5, step: 0.1, def: 1, gpu: true, help: 'splash where it lands' },
      mist: { label: 'mist ×', units: '×', min: 0, max: 10, step: 0.1, def: 1, gpu: true },
    },
  },
  bursts: {
    title: 'Collapse bursts',
    owner: 'scenes/level.ts (CPU: the dust, haze and chips a collapse throws)',
    params: {
      dustCount: { label: 'dust ×', units: '×', min: 0, max: 5, step: 0.1, def: 1, help: 'dust grains (and haze puffs, one per five) a collapse throws' },
      dustSpeed: { label: 'dust speed', units: 'cells/s', min: 0, max: 6, step: 0.1, def: 1.4 },
      hazeSpeed: { label: 'haze speed', units: 'cells/s', min: 0, max: 6, step: 0.1, def: 0.8 },
      chipSpeed: { label: 'chip speed', units: 'cells/s', min: 0, max: 12, step: 0.25, def: 3, help: 'chips of a soft landing (a hard one throws them at its own speed)' },
    },
  },
} satisfies Record<string, GroupSpec>;

export const TUNING = new Registry(SPEC);
/** the live values: `TUNE.rigid.friction` (a system reads its own group only) */
export const TUNE = TUNING.values;
TUNING.checkWgsl(commonWgsl);

// The page's address: ?tune=<string> (a preset's copyable string), and the older names (?rbgrav=, ?crush=, ?bear=sand:0.1)
if (typeof location !== 'undefined') {
  const q = new URLSearchParams(location.search);
  const t = q.get('tune');
  if (t) {
    const unknown = TUNING.apply(TUNING.decode(t), true);
    if (unknown.length) console.warn(`[tune] ?tune= has parameters this build doesn't know: ${unknown.join(', ')}`);
  }
  for (const d of TUNING.defs) {
    const v = d.url ? q.get(d.url) : null;
    if (v !== null && v !== '' && Number.isFinite(Number(v))) TUNING.set(d.id, Number(v));
  }
  const bears: Record<string, string> = { soil: 'fracture.bearSoil', sand: 'fracture.bearSand', rubble: 'fracture.bearRubble', snow: 'fracture.bearSnow' };
  for (const kv of (q.get('bear') ?? '').split(',').filter(Boolean)) {
    const [name, v] = kv.split(':');
    if (!bears[name]) throw new Error(`?bear=${kv}: the bear of ${Object.keys(bears).join(', ')} is tuned`);
    TUNING.set(bears[name], Number(v));
  }
  const ch = TUNING.changed();
  if (Object.keys(ch).length) console.info(`[tune] ${JSON.stringify(ch)}`);
}
