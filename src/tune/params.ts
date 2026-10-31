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
      gravityX: { label: 'world gravity ×', units: '× gravity', min: 0.25, max: 4, step: 0.05, def: 1, gpu: true, url: 'gx', help: '(solver step 1, AR9) every mover\'s gravity times this: bodies, pieces, metal, water\'s falls, spray, chips, agents. 1: true gravity at a metre a cell; about 2: the old tankers\' feel (they ran at 20 cells/s²)' },
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
      maxBodies: { label: 'max bodies', units: 'bodies', min: 1, max: 200, step: 1, def: 50, url: 'rbmax', help: 'at once (the phone); past it the oldest settles into the columns' },
      cubes: { label: 'show cubes', units: '0/1', min: 0, max: 1, step: 1, def: 0, url: 'rbcubes', help: 'debug: the cubes the bodies are simulated with drawn too' },
    },
  },
  pieces: {
    title: 'Falling pieces (columns)',
    owner: 'game/colbodies.ts and game/bodies.ts (CPU, the pieces the structure check frees without rigid rock)',
    params: {
      gravity: { label: 'gravity ×', units: '× world', min: 0.2, max: 4, step: 0.05, def: 1, help: 'times the world\'s gravity (was a 10 cells/s² of its own)' },
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
      softSink: { label: 'soft ground sink', units: 'k', min: 0, max: 0.5, step: 0.01, def: 0.08, help: '(round 120) how far a blow sinks a body into loose ground: k · softness · ∛(½mv²) over the side of its footprint (cells, at most 3)' },
      spray: { label: 'soft ground spray', units: 'share', min: 0, max: 1, step: 0.05, def: 0.3, help: '(round 120) of the ground a body sinks into, the share thrown up as a spray; the rest is a rim round it' },
      groundEnergy: { label: 'ground gives at', units: '½mv²', min: 1000, max: 400000, step: 1000, def: 15000, help: '(round 120) a body striking hard ground with more energy than this crumbles it where it struck: a ball of radius 0.8·∛(E / this), at most 3' },
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
      gravity: { label: 'gravity ×', units: '× world', min: 0.2, max: 4, step: 0.05, def: 1, gpu: true, help: '(solver step 1, AR9) times the world\'s gravity: it had its own 20 cells/s², about 2× (try world gravity × 2 for that feel). No top speed any more (AR10: it was capped at 60)' },
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
      flowRate: { label: 'scour rate', units: '/(cell/s)', min: 0, max: 0.5, step: 0.005, def: 0.06, gpu: true, help: 'fast water alongside a cracked solid wears it' },
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
      gain: { label: 'gain', units: '/tick', min: 0.005, max: 0.16, step: 0.005, def: 0.08, gpu: true, help: 'how fast a level difference moves it sideways (> 0.16 is unstable)' },
      friction: { label: 'flux kept', units: 'share', min: 0.5, max: 0.999, step: 0.001, def: 0.985, gpu: true, help: 'share of last tick\'s flux kept (momentum)' },
      riverRelax: { label: 'river relax', units: 'share/step', min: 0.001, max: 0.5, step: 0.001, def: 0.02, gpu: true, help: 'how fast a held river comes to its table\'s depth' },
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
      gravity: { label: 'gravity ×', units: '× world', min: 0.2, max: 4, step: 0.05, def: 1.45, gpu: true, help: '(solver step 1, AR9) times the world\'s gravity: it had its own 14 cells/s² (1.45 keeps that look at world × 1)' },
    },
  },
  solver: {
    title: 'Node solver',
    owner: 'solver/solver.ts + solver.wgsl (GPU: the one solver for what breaks free — rock, buildings, metal, wood; its contact rules are the rigid group\'s: slop, overlap k/p/cap, push-out speed, erode depth, rest)',
    params: {
      substeps: { label: 'substeps', units: 'a tick', min: 1, max: 12, step: 1, def: 4, help: 'steps a tick (60 Hz): more is stiffer and steadier, and costs' },
      iterations: { label: 'iterations', units: 'a substep', min: 1, max: 12, step: 1, def: 2, help: 'contact and shape passes a substep' },
      wakeImpulse: { label: 'wake impulse', units: 'cells·cells/s', min: 0, max: 500, step: 5, def: 30, help: 'a sleeping body is woken by a hit of (approach speed × the hitter\'s cells) past this — never by contact alone' },
      nodeRadius: { label: 'node block ×', units: '× block', min: 0.5, max: 1.5, step: 0.05, def: 1, help: 'another body feels a body as the blocks of cells its nodes stand for, this much larger (1: the cells it was made of)' },
      friction: { label: 'friction ×', units: '×', min: 0, max: 3, step: 0.05, def: 1, help: 'times each material\'s friction' },
      blowG: { label: 'blow load', units: 'g', min: 1, max: 100, step: 0.5, def: 8, help: 'the most a blow loads a node, in its weights (a contact stops it within a substep — perfectly stiff — so its force would be without bound; a real blow is spread over the give where it lands). Higher: impacts bend and snap metal more' },
      steelE: { label: 'steel E', units: 'stress/strain', min: 1e5, max: 1e9, step: 1e5, def: 1.6e8, help: 'only with a frame under 1 (soft): stress = E × the bonds\' strain' },
      steelYield: { label: 'steel yield', units: 'mass/(cell·s²)', min: 1e3, max: 2e6, step: 1e3, def: 2e5, help: 'the bend a bond carries (moment / section, s³/6) past which it turns as a hinge and stays bent. 2e5: a 1-cell steel bar 30 cells long cantilevered just holds; a 2 × 2 one holds 60' },
      steelTensile: { label: 'steel strength', units: 'mass/(cell·s²)', min: 1e3, max: 4e6, step: 1e3, def: 4e5, help: 'a bond pulled or bent past this snaps (the load through it from what it holds and what hits it)' },
      steelShear: { label: 'steel shear', units: 'mass/(cell·s²)', min: 1e3, max: 4e6, step: 1e3, def: 2.5e5, help: 'a bond sheared past this (force across it over its section) snaps' },
      steelStiffness: { label: 'steel stiffness', units: 'share/substep', min: 0.05, max: 1, step: 0.05, def: 0.6, help: 'how far toward its rest shape a substep (1 rigid)' },
      steelFrame: { label: 'steel frame', units: 'share', min: 0, max: 1, step: 0.05, def: 1, help: 'how much it holds its whole shape (the rest bends locally): high, a girder stays straight and dents where it\'s hit' },
      steelDent: { label: 'steel dent', units: 'energy/cell³', min: 100, max: 100000, step: 100, def: 7000, help: 'a hit\'s kinetic energy over this × the contact\'s area is how deep it dents (at most half a node)' },
      rustTensile: { label: 'rust strength', units: 'mass/(cell·s²)', min: 1e3, max: 4e6, step: 1e3, def: 1.5e5 },
      woodE: { label: 'wood E', units: 'stress/strain', min: 1e5, max: 1e9, step: 1e5, def: 1e7 },
      woodYield: { label: 'wood yield', units: 'mass/(cell·s²)', min: 1e2, max: 1e6, step: 1e2, def: 3e4 },
      woodTensile: { label: 'wood strength', units: 'mass/(cell·s²)', min: 1e2, max: 1e6, step: 1e2, def: 6e4 },
      woodShear: { label: 'wood shear', units: 'mass/(cell·s²)', min: 1e2, max: 1e6, step: 1e2, def: 1.5e4 },
      woodFrame: { label: 'wood frame', units: 'share', min: 0, max: 1, step: 0.05, def: 1 },
      woodDent: { label: 'wood dent', units: 'energy/cell³', min: 100, max: 100000, step: 100, def: 2500 },
      woodStiffness: { label: 'wood stiffness', units: 'share/substep', min: 0.05, max: 1, step: 0.05, def: 0.7 },
    },
  },
  units: {
    title: 'Agents falling',
    owner: 'units.wgsl and agents/agents.ts (GPU agents tumbling, thrown, knocked back)',
    params: {
      gravity: { label: 'gravity ×', units: '× world', min: 0.2, max: 4, step: 0.05, def: 2.05, gpu: true, help: '(solver step 1, AR9) times the world\'s gravity: they had their own 20 cells/s² (2.05 keeps that at world × 1; agents\' feel is their own track)' },
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
  judgeB: {
    title: 'Judge B (method of sections, ?judge=sections)',
    owner: 'game/judge.ts + shaders/judge.wgsl (GPU: what lets go, section by section; a cell a metre)',
    params: {
      tensile: { label: 'tensile', units: 'MPa', min: 0.1, max: 30, step: 0.1, def: 4, url: 'jbtensile', help: 'what a section takes in bending, × the material\'s strength (intact limestone or sandstone ~4)' },
      shear: { label: 'shear', units: 'MPa', min: 0.1, max: 60, step: 0.1, def: 8, url: 'jbshear', help: 'what a section takes in shear (rock\'s cohesion, ~2 × its tensile)' },
      crush: { label: 'crush', units: 'MPa', min: 1, max: 300, step: 1, def: 60, url: 'jbcrush', help: 'what a leg or an arch\'s crown takes in compression' },
      density: { label: 'rock density', units: 'kg/m³', min: 1000, max: 4000, step: 50, def: 2600, help: 'a material of density 1 (materials.ts) weighs this' },
      meet: { label: 'meet', units: 'share', min: 0.05, max: 0.9, step: 0.05, def: 0.35, help: 'a section whose faces\' normals sum to under this share of its area is held from opposite sides: an arch' },
      archTol: { label: 'arch give', units: 'cells', min: 0, max: 2, step: 0.05, def: 0.5, help: 'how far past a run the thrust line may pass (the columns\' cells are whole)' },
      tipGive: { label: 'tip give', units: 'cells', min: 0, max: 2, step: 0.05, def: 0, help: 'how far a centre of mass may lie past the hull of the leg under it' },
      neck: { label: 'neck reach', units: 'columns', min: 2, max: 64, step: 1, def: 16, help: 'past this through standing columns from a piece, it is keyed into the land' },
      tRock: { label: 'tension: rock', units: '× tensile', min: 0, max: 2, step: 0.05, def: 1, help: 'natural stone (materials.ts bond rock): keeps its tensile strength — a natural arch\'s halves stand' },
      tMasonry: { label: 'tension: masonry', units: '× tensile', min: 0, max: 2, step: 0.05, def: 0, help: 'brick, tile, plaster (bond masonry): blocks, no tension (Heyman) — an arch without its keystone falls' },
      tCast: { label: 'tension: cast', units: '× tensile', min: 0, max: 2, step: 0.05, def: 1, help: 'concrete, asphalt (bond cast)' },
      tMetal: { label: 'tension: metal', units: '× tensile', min: 0, max: 5, step: 0.05, def: 1, help: 'steel, rust (bond metal)' },
      tOther: { label: 'tension: other', units: '× tensile', min: 0, max: 2, step: 0.05, def: 1, help: 'every other solid (bond other)' },
      margin: { label: 'window margin', units: 'columns', min: 8, max: 96, step: 1, def: 32, help: 'the judged window: the seeds\' box and this much round it (a piece reaching its side is held there)' },
    },
  },
} satisfies Record<string, GroupSpec>;

export const TUNING = new Registry(SPEC);
/** the live values: `TUNE.rigid.friction` (a system reads its own group only) */
export const TUNE = TUNING.values;
/**
 * (solver step 1, BACKLOG AR9) The world's gravity, cells/s²: world.gravity × world.gravityX. Every mover reads this,
 * times its own group's `gravity` scale only where one is wanted. common.wgsl `worldG()` is the same on the GPU.
 */
export function worldG(): number {
  return TUNE.world.gravity * TUNE.world.gravityX;
}
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
