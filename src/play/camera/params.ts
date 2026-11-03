// ---- play/camera/params.ts --------------------------------------------------------------------------------------
// (round 121, herolab) Every camera mode's numbers, one tuning registry (src/tune/registry.ts — the panel the physics
// and the noise lab use): a group a mode, each a slider. `?cam.<group>.<key>=` isn't needed: the panel's copied link
// carries the changed values (?camtune=). CPU only (nothing here reaches a kernel).

import { Registry } from '../../tune/registry';

const deg = Math.PI / 180;

export const CAM_SPEC = {
  chase: {
    title: 'Chase (the base framing)',
    owner: 'play/camera/modes.ts ChaseMode over play/core/chase.ts (the hero\'s HeroCamera.chase)',
    params: {
      zoomX: { label: 'zoom ×', units: '×', min: 0.3, max: 2.5, step: 0.05, def: 1, help: 'the hero\'s own zoom (px a cell) times this' },
      leadX: { label: 'lead ×', units: '×', min: 0, max: 3, step: 0.05, def: 1, help: 'the screen\'s centre leads the hero along its velocity: the hero\'s lead times this' },
      aheadX: { label: 'ahead ×', units: '×', min: 0, max: 3, step: 0.05, def: 1, help: 'seconds of travel kept on screen in front (zooms out to fit): the hero\'s times this' },
      lookAhead: { label: 'frame the way ahead', units: 'share', min: 0, max: 1, step: 0.05, def: 0, help: 'the lead swung from along the velocity toward the end of the way ahead (round a turn, the screen looks round it); 0: the chase as it was' },
      minZoomX: { label: 'widest zoom ×', units: '×', min: 0.3, max: 2.5, step: 0.05, def: 1, help: 'the most it zooms out at speed (the hero\'s px a cell: the bike\'s 12) times this' },
    },
  },
  ahead: {
    title: 'The way ahead (what the hero cares about)',
    owner: 'play/camera/ahead.ts wayAhead, interests.ts WayAheadSource',
    params: {
      secs: { label: 'look ahead', units: 's', min: 0.3, max: 4, step: 0.1, def: 1.2, help: 'seconds of the hero\'s speed the way ahead is walked' },
      minDist: { label: 'at least', units: 'cells', min: 4, max: 60, step: 1, def: 16 },
      maxDist: { label: 'at most', units: 'cells', min: 10, max: 120, step: 1, def: 40 },
      climb: { label: 'climb', units: 'rise/run', min: 0.2, max: 4, step: 0.05, def: 1.2, help: 'a step steeper than this is a wall (the bike\'s climb)' },
      fan: { label: 'swing step', units: '°', min: 3, max: 30, step: 1, def: 10 },
      maxTurn: { label: 'turned back past', units: '°', min: 60, max: 180, step: 5, def: 125, help: 'swung this much all told: the way has turned back on itself, a dead end' },
      signal: { label: 'signal', units: '0 off · 1 turns · 2 always', min: 0, max: 2, step: 1, def: 1, choices: ['off', 'at turns', 'always'], help: 'the marker on screen where the way goes on (green) or ends (red)' },
      turnAt: { label: 'a turn is', units: '°', min: 5, max: 90, step: 1, def: 25, help: 'the way swung this much: a turn (signalled)' },
    },
  },
  rotate: {
    title: 'Auto-rotate',
    owner: 'play/camera/modes.ts RotateMode (api/cutaway.ts Orbit\'s spring and clear-angle search, on the hero and the way ahead)',
    params: {
      step: { label: 'angle step', units: '°', min: 2, max: 30, step: 1, def: 10 },
      swing: { label: 'widest swing', units: '°', min: 20, max: 180, step: 5, def: 120, help: 'the farthest from where it is it looks for a clear angle' },
      look: { label: 'look every', units: 's', min: 0.05, max: 1, step: 0.05, def: 0.2 },
      aheadW: { label: 'way ahead weight', units: '×', min: 0, max: 3, step: 0.05, def: 0.8, help: 'how much the way ahead being hidden counts against an angle (the hero 1)' },
      turnCost: { label: 'turn cost', units: 'per 180°', min: 0, max: 2, step: 0.05, def: 0.35, help: 'an angle\'s cost for how far it is from where the view is' },
      behind: { label: 'pull behind', units: 'per 180°', min: 0, max: 2, step: 0.05, def: 0, help: 'an angle\'s cost for how far it is from behind the hero\'s heading (0: only clearing)' },
      dead: { label: 'behind dead zone', units: '°', min: 0, max: 90, step: 5, def: 30 },
      keep: { label: 'stick margin', units: 'score', min: 0, max: 1, step: 0.05, def: 0.15, help: 'a new angle must beat the current by this much (no flicker)' },
      rate: { label: 'spring', units: '1/s', min: 0.5, max: 8, step: 0.1, def: 2.6 },
      maxSpeed: { label: 'fastest turn', units: '°/s', min: 10, max: 360, step: 5, def: 120 },
    },
  },
  tilt: {
    title: 'Top-down tilt',
    owner: 'play/camera/modes.ts TiltMode (Camera.elevation)',
    params: {
      base: { label: 'at rest', units: '°', min: 15, max: 70, step: 1, def: 30, help: 'the elevation when nothing hides (30: the game\'s view)' },
      max: { label: 'most', units: '°', min: 35, max: 89, step: 1, def: 72 },
      step: { label: 'tried in', units: '°', min: 2, max: 15, step: 1, def: 6 },
      aheadW: { label: 'way ahead weight', units: '×', min: 0, max: 3, step: 0.05, def: 0.8 },
      allow: { label: 'hidden allowed', units: 'share', min: 0, max: 1, step: 0.05, def: 0.25, help: 'the weighted share hidden it tolerates before tilting further' },
      up: { label: 'rise rate', units: '1/s', min: 0.2, max: 10, step: 0.1, def: 3 },
      down: { label: 'fall rate', units: '1/s', min: 0.1, max: 6, step: 0.1, def: 0.8 },
      hold: { label: 'hold', units: 's', min: 0, max: 3, step: 0.1, def: 0.8, help: 'seconds it stays tilted after the view clears' },
      look: { label: 'look every', units: 's', min: 0.05, max: 1, step: 0.05, def: 0.15 },
    },
  },
  dither: {
    title: 'Dither occluders',
    owner: 'play/camera/modes.ts DitherMode (render.wgsl seeReach: holes kept open round points)',
    params: {
      heroR: { label: 'hero hole', units: 'cells', min: 2, max: 30, step: 0.5, def: 7 },
      aheadR: { label: 'way ahead hole', units: 'cells', min: 0, max: 30, step: 0.5, def: 8, help: '0: only the hero' },
      otherR: { label: 'other interests', units: 'cells', min: 0, max: 30, step: 0.5, def: 5 },
      ease: { label: 'open in', units: 's', min: 0.05, max: 2, step: 0.05, def: 0.3 },
    },
  },
  cutaway: {
    title: 'Cutaway',
    owner: 'play/camera/modes.ts CutawayMode (Camera.cut.slice and its shape: render.wgsl sliced, sliceRim)',
    params: {
      height: { label: 'cut at (h0)', units: 'cells over the floor', min: 0.5, max: 30, step: 0.5, def: 2.5, help: 'at the hero: anything taller than this over the surface it is on is cut down' },
      bowl: { label: 'rises (k)', units: 'cells per cell²', min: 0, max: 0.2, step: 0.005, def: 0.03, help: '(round 120) the cut rises k d² away from the hero: a bowl, so distant land keeps its shape (0: flat)' },
      nearOnly: { label: 'near side only', units: '0 / 1', min: 0, max: 1, step: 1, def: 1, choices: ['everywhere', 'between the eye and the hero'], help: 'nothing beyond the hero from the eye is cut' },
      occluders: { label: 'real occluders only', units: '0 / 1', min: 0, max: 1, step: 1, def: 1, choices: ['all over the cut', 'only what hides something'], help: 'cut only what has open air behind it along the eye\'s line: a hill gentler than the eye\'s line is never cut' },
      radius: { label: 'radius', units: 'share of the screen', min: 0, max: 2, step: 0.05, def: 0.85, help: 'within this share of half the screen round the hero (0: the whole view)' },
      rim: { label: 'rim', units: 'cells', min: 0, max: 2, step: 0.05, def: 0.25, help: 'the cut\'s outline, lit' },
      when: { label: 'when', units: '0 always · 1 hidden', min: 0, max: 1, step: 1, def: 1, choices: ['always', 'while hidden'] },
      rate: { label: 'lowers at', units: '1/s', min: 0.5, max: 20, step: 0.5, def: 6 },
      linger: { label: 'stays', units: 's', min: 0, max: 4, step: 0.1, def: 1, help: 'seconds it stays after the view clears' },
      fade: { label: 'fade over', units: 'cells', min: 0, max: 8, step: 0.25, def: 2.5, help: '(round 120: the default cut dithers) the cut thinned out by a dither over this many cells under its height (0: a hard slice)' },
      fadeR: { label: 'fade at the edge', units: 'share of the radius', min: 0, max: 1, step: 0.05, def: 0.35, help: 'the cut thinned out by a dither over this outer share of its radius (0: a hard edge)' },
    },
  },
  // (round 120, the user: "Cut with a dither effect would be interesting") the cut whose edges fade by a dither
  cutfade: {
    title: 'Cutaway, dithered',
    owner: 'play/camera/modes.ts CutawayMode as cutfade (render.wgsl sliceReach: the slice and its fade by the 4 x 4 dither)',
    params: {
      height: { label: 'cut at (h0)', units: 'cells over the floor', min: 0.5, max: 30, step: 0.5, def: 2.5 },
      bowl: { label: 'rises (k)', units: 'cells per cell²', min: 0, max: 0.2, step: 0.005, def: 0.03 },
      nearOnly: { label: 'near side only', units: '0 / 1', min: 0, max: 1, step: 1, def: 1, choices: ['everywhere', 'between the eye and the hero'] },
      occluders: { label: 'real occluders only', units: '0 / 1', min: 0, max: 1, step: 1, def: 1, choices: ['all over the cut', 'only what hides something'] },
      radius: { label: 'radius', units: 'share of the screen', min: 0, max: 2, step: 0.05, def: 0.85 },
      rim: { label: 'rim', units: 'cells', min: 0, max: 2, step: 0.05, def: 0 },
      when: { label: 'when', units: '0 always / 1 hidden', min: 0, max: 1, step: 1, def: 1, choices: ['always', 'while hidden'] },
      rate: { label: 'lowers at', units: '1/s', min: 0.5, max: 20, step: 0.5, def: 6 },
      linger: { label: 'stays', units: 's', min: 0, max: 4, step: 0.1, def: 1 },
      fade: { label: 'fade over', units: 'cells', min: 0, max: 8, step: 0.25, def: 3 },
      fadeR: { label: 'fade at the edge', units: 'share of the radius', min: 0, max: 1, step: 0.05, def: 0.35 },
    },
  },
  edge: {
    title: 'Edge-only occluders',
    owner: 'play/camera/modes.ts EdgeMode (render.wgsl seeReach: the centre and the way ahead kept open always)',
    params: {
      centre: { label: 'centre kept clear', units: 'share of the screen', min: 0.1, max: 1.2, step: 0.05, def: 0.45, help: 'the hole round the hero, as a share of half the screen' },
      ahead: { label: 'way ahead kept clear', units: 'share of the screen', min: 0, max: 1.2, step: 0.05, def: 0.3 },
      always: { label: 'open', units: '0 hidden · 1 always', min: 0, max: 1, step: 1, def: 1, choices: ['while hidden', 'always'] },
      ease: { label: 'open in', units: 's', min: 0.05, max: 2, step: 0.05, def: 0.4 },
    },
  },
  // (round 128, the user: "zoom in when going into forests that would otherwise obscure visibility ... not low trees or
  // shrubs. On fields I like the pulled back view ... a function of how much things stick up around the player. Cliffs
  // are a slight exception where we need to actually vary the camera ... generally the camera is isometric and doesn't
  // tilt except around cliffs and maybe cities")
  auto: {
    title: 'Auto (zoom by what sticks up, tilt by cliffs)',
    owner: 'play/camera/modes.ts AutoMode (the chase\'s zoom times its own; Camera.elevation near cliffs)',
    params: {
      radius: { label: 'looks round', units: 'cells', min: 3, max: 30, step: 0.5, def: 10, help: 'how far round the hero it measures what sticks up' },
      low: { label: 'low is', units: 'cells over the floor', min: 0, max: 20, step: 0.5, def: 5, help: 'anything lower than this counts for nothing (shrubs, low trees)' },
      tall: { label: 'tall is', units: 'cells over the floor', min: 2, max: 40, step: 0.5, def: 10, help: 'this high counts in full (the old woods\' canopy, walls)' },
      field: { label: 'zoom in the open', units: '×', min: 0.4, max: 1.5, step: 0.05, def: 0.85, help: 'the chase\'s zoom times this where nothing sticks up: pulled back over fields' },
      close: { label: 'zoom in the woods', units: '×', min: 0.6, max: 3, step: 0.05, def: 1.9, help: 'the chase\'s zoom times this when everything round sticks up' },
      band: { label: 'dead band', units: 'share', min: 0, max: 0.5, step: 0.01, def: 0.12, help: 'what it measures must move this far from where it is aiming before it aims again (no pumping)' },
      inRate: { label: 'zooms in at', units: '1/s', min: 0.1, max: 6, step: 0.05, def: 1.2 },
      outRate: { label: 'pulls back at', units: '1/s', min: 0.05, max: 6, step: 0.05, def: 0.5 },
      look: { label: 'look every', units: 's', min: 0.05, max: 1, step: 0.05, def: 0.2 },
      wallAt: { label: 'a cliff is', units: 'cells over the floor', min: 2, max: 40, step: 0.5, def: 8, help: 'land (not trees) standing this high near the hero is a cliff' },
      wallFull: { label: 'cliff in full at', units: 'share round', min: 0.05, max: 1, step: 0.05, def: 0.3, help: 'the share of what it looks at that is cliff for the full tilt' },
      tilt: { label: 'tilt by cliffs', units: '°', min: 20, max: 80, step: 1, def: 48, help: 'the elevation at a cliff (30: the isometric view, no tilt)' },
      tiltRate: { label: 'tilts at', units: '1/s', min: 0.1, max: 6, step: 0.05, def: 1.2 },
    },
  },
};

export const CAM_TUNING = new Registry(CAM_SPEC);
export type CamParams = typeof CAM_TUNING.values;
export const CAM = CAM_TUNING.values;
export const DEG = deg;
