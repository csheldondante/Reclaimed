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
      height: { label: 'cut at', units: 'cells over the floor', min: 1, max: 30, step: 0.5, def: 3, help: 'anything taller than this over the surface the hero is on is cut down' },
      radius: { label: 'radius', units: 'share of the screen', min: 0, max: 2, step: 0.05, def: 0.85, help: 'within this share of half the screen round the hero (0: the whole view)' },
      rim: { label: 'rim', units: 'cells', min: 0, max: 2, step: 0.05, def: 0.4, help: 'the cut\'s outline, lit' },
      when: { label: 'when', units: '0 always · 1 hidden', min: 0, max: 1, step: 1, def: 1, choices: ['always', 'while hidden'] },
      rate: { label: 'lowers at', units: '1/s', min: 0.5, max: 20, step: 0.5, def: 6 },
      linger: { label: 'stays', units: 's', min: 0, max: 4, step: 0.1, def: 1, help: 'seconds it stays after the view clears' },
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
};

export const CAM_TUNING = new Registry(CAM_SPEC);
export type CamParams = typeof CAM_TUNING.values;
export const CAM = CAM_TUNING.values;
export const DEG = deg;
