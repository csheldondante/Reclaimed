// ---- play/lab/tests.ts ------------------------------------------------------------------------------------------
// (round 128, herolab) The hero lab's test menu: the user's thumb on a phone (Pixel 9a) tries one thing at a time.
// The user (round 128): "we need to get back to hero lab and start testing and improving the hero gameplay".
// Each test is one tap: a hero, a station, the bike's handling and the camera, and the question to answer. Its words
// are player text (docs/WRITING.md): plain, short, no words from the code. Pure: the Node test checks every test
// names a real hero, station, handling and camera.

import type { CamModeId } from '../../api/contracts/camera';
import type { PlayHeroId } from '../heroes/make';
import type { HandlingId } from './handling';

export interface LabTest {
  id: string;
  hero: PlayHeroId;
  /** a station's id (play/lab/herolab.ts allStations) */
  station: string;
  /** the bike's handling (`?handling=` form); absent: as it is */
  handling?: string;
  /** the camera (`?cam=` form); absent: the default, cut and tilt */
  cam?: string;
  /** the chip's words */
  label: string;
  /** what to answer after trying it */
  ask: string;
  /** (knight pass 2) the station's own buttons pressed in turn once it's up, by their words (Wave, Guards, Course, a
   *  parry chip: Button, Swipe, Hold) */
  press?: string[];
  /** (round 128) the root motion: own (absent), physical, brute (the knight) */
  drive?: 'physical' | 'brute';
}

export interface LabTestGroup {
  hero: PlayHeroId;
  title: string;
  tests: LabTest[];
}

/** what the player calls each station */
export const STATION_WORDS: Record<string, string> = {
  cliff: 'the cliffs',
  canyon: 'the canyon',
  forest: 'the forest',
  city: 'the city streets',
  cave: 'the cave mouth',
  hills: 'the hills',
  'moves-canyon': 'the canyon',
  'moves-city': 'the city streets',
  traits: 'the field of the living and the dead',
  hill: 'the hill',
  tour: 'the tour: field, shrubs, woods, cliff, town',
  enemy: 'the raiders\' field',
};

export const HERO_WORDS: Record<PlayHeroId, string> = { hoverbike: 'Bike', lich: 'Lich', knight: 'Knight', horse: 'Horse' };

export const HANDLING_WORDS: Record<HandlingId, string> = {
  stock: 'as it is',
  grip: 'more grip',
  gripplus: 'much more grip',
  tight: 'tight turns and a quick drift',
  governor: 'slows down in narrow places',
  carve: 'carve',
  corridor: 'steers toward the open way',
  avoid: 'steers round rocks',
  magnet: 'leans toward enemies',
};

export const DRIVE_WORDS: Record<string, string> = { physical: 'physical', brute: 'heavy brute' };

export const CAM_WORDS: Record<CamModeId, string> = {
  chase: 'follow',
  rotate: 'turn',
  tilt: 'tilt',
  dither: 'see-through',
  cutaway: 'cut',
  cutfade: 'soft cut',
  edge: 'clear middle',
  auto: 'auto zoom',
  autocity: 'auto zoom with town tilt',
};

const canyon = (handling: string, label: string): LabTest => ({
  id: `bike-canyon-${handling}`,
  hero: 'hoverbike',
  station: 'moves-canyon',
  handling,
  label,
  ask: 'Can you make the turns? Which one felt best?',
});

export const LAB_TESTS: LabTestGroup[] = [
  {
    hero: 'hoverbike',
    title: 'Bike',
    tests: [
      canyon('stock', 'Canyon, as it is'),
      canyon('tight', 'Canyon, tight'),
      canyon('carve', 'Canyon, carve'),
      canyon('governor', 'Canyon, slows down'),
      canyon('gripplus', 'Canyon, much more grip'),
      { id: 'bike-city-carve', hero: 'hoverbike', station: 'moves-city', handling: 'carve', label: 'City, carve', ask: 'Can you ride round the blocks without hitting walls?' },
      { id: 'bike-tour-auto', hero: 'hoverbike', station: 'tour', cam: 'auto+cutfade', label: 'Tour, auto zoom', ask: 'Does the zoom follow what is around you? Closer in tall woods, pulled back on the field?' },
      { id: 'bike-physical', hero: 'hoverbike', station: 'moves-canyon', drive: 'physical', label: 'Canyon, physical drive', ask: 'The same drive as the knight now. Does the bike feel like the same bike?' },
      { id: 'bike-wallride', hero: 'hoverbike', station: 'canyon', drive: 'physical', label: 'Canyon walls', ask: 'Ride fast up onto the sloped canyon walls. Can you ride along them? Can you tell when you will slide off?' },
      { id: 'bike-hills', hero: 'hoverbike', station: 'hills', label: 'Hills', ask: 'Does the camera stay still on gentle hills?' },
      { id: 'bike-cliff', hero: 'hoverbike', station: 'cliff', label: 'Cliffs', ask: 'Does the cut show you the bike and the turn ahead?' },
    ],
  },
  {
    hero: 'knight',
    title: 'Knight',
    tests: [
      { id: 'knight-raiders', hero: 'knight', station: 'enemy', press: ['Wave', 'Wave'], label: 'Crowd', ask: 'Swipe twice fast to lunge through the crowd. Do you slip through and come out the other side?' },
      { id: 'knight-guards', hero: 'knight', station: 'enemy', press: ['Guards', 'Lungers'], label: 'Guards and lungers', ask: 'Guards block from the front. Lungers wind up, then charge. Can you tell when to hit them?' },
      { id: 'knight-jump', hero: 'knight', station: 'enemy', press: ['Course'], label: 'Jump course', ask: 'Jump up the steps and over the gap. Swipe in the air to jump attack. Does the jump feel right?' },
      { id: 'knight-lockon', hero: 'knight', station: 'enemy', press: ['Wave'], label: 'Lock on', ask: 'Tap a raider to lock on. Do your slashes and arrows go where you want?' },
      { id: 'knight-parry-button', hero: 'knight', station: 'enemy', press: ['Lungers', 'Button'], label: 'Parry, button', ask: 'Press Parry just before a lunger hits. Which parry feels best, button, swipe or hold?' },
      { id: 'knight-parry-swipe', hero: 'knight', station: 'enemy', press: ['Lungers', 'Swipe'], label: 'Parry, swipe', ask: 'Swipe at a lunger while it winds up. Which parry feels best, button, swipe or hold?' },
      { id: 'knight-parry-hold', hero: 'knight', station: 'enemy', press: ['Lungers', 'Hold'], label: 'Parry, hold', ask: 'Hold Block as a lunger comes. Which parry feels best, button, swipe or hold?' },
      { id: 'knight-bow', hero: 'knight', station: 'enemy', press: ['Wave'], label: 'Bow', ask: 'Switch to the bow and shoot a wave. Is aiming easy?' },
      { id: 'knight-hook', hero: 'knight', station: 'enemy', press: ['Wave'], label: 'Hook', ask: 'Switch to the hook. Tap a raider to yank it in. Tap the ground to zip there. Is it fun?' },
      { id: 'knight-hill', hero: 'knight', station: 'hill', drive: 'physical', label: 'Hill, physical drive', ask: 'Run at the slope from far back, then tap Standing start. Does the running start up the hill feel right?' },
      { id: 'knight-physical', hero: 'knight', station: 'enemy', drive: 'physical', press: ['Wave'], label: 'Raiders, physical drive', ask: 'Does the knight still feel snappy?' },
      { id: 'brute-hill', hero: 'knight', station: 'hill', drive: 'brute', label: 'Brute, hill', ask: 'A heavy brute. It can only get up the slope with a long run. Is that fun?' },
      { id: 'brute-raiders', hero: 'knight', station: 'enemy', drive: 'brute', press: ['Mixed'], label: 'Brute, raiders', ask: 'The brute charges and turns wide. Is charging through them fun?' },
      { id: 'knight-tour-auto', hero: 'knight', station: 'tour', cam: 'auto+cutfade', label: 'Tour, auto zoom', ask: 'Does the zoom follow what is around you? Does the tilt by the cliff help?' },
      { id: 'knight-forest', hero: 'knight', station: 'forest', label: 'Forest', ask: 'Can you see the knight under the trees?' },
      { id: 'knight-canyon', hero: 'knight', station: 'canyon', label: 'Canyon', ask: 'Does the cut show the knight in the narrow walls?' },
    ],
  },
  {
    hero: 'horse',
    title: 'Horse',
    tests: [
      { id: 'horse-canyon', hero: 'horse', station: 'canyon', label: 'Canyon', ask: 'Steer it yourself. Does the horse take the canyon for you without feeling on rails?' },
      { id: 'horse-city', hero: 'horse', station: 'city', label: 'City', ask: 'Point it down the streets. Does it turn the corners and stop before walls?' },
      { id: 'horse-forest', hero: 'horse', station: 'forest', label: 'Forest', ask: 'Does it weave through the trees for you?' },
      { id: 'horse-tour', hero: 'horse', station: 'tour', cam: 'auto+cutfade', label: 'Tour', ask: 'Does the horse feel like a horse? Walk, trot, canter, gallop?' },
    ],
  },
  {
    hero: 'lich',
    title: 'Lich',
    tests: [
      { id: 'lich-raise', hero: 'lich', station: 'traits', label: 'Raise the dead', ask: 'Tap Crowd, then Smite and Raise. Is it fun to build an army?' },
      { id: 'lich-raiders', hero: 'lich', station: 'enemy', label: 'Raiders', ask: 'Tap Wave. Can the lich hold them off?' },
      { id: 'lich-physical', hero: 'lich', station: 'hill', drive: 'physical', label: 'Hill, physical drive', ask: 'Does the lich still float the way it should?' },
      { id: 'lich-cliff', hero: 'lich', station: 'cliff', label: 'Cliffs', ask: 'Does the cut show the lich and the way on?' },
    ],
  },
];

export function findTest(id: string): LabTest {
  for (const g of LAB_TESTS) for (const t of g.tests) if (t.id === id) return t;
  throw new Error(`?test=${id}: no such test (${LAB_TESTS.flatMap((g) => g.tests.map((t) => t.id)).join(', ')})`);
}

/** what's on now, in plain words: "Bike in the canyon. Handling: carve. Camera: cut and tilt." */
export function describe(o: { hero: PlayHeroId; station: string; handling: readonly HandlingId[]; cam: readonly CamModeId[]; drive?: string }): string {
  const where = STATION_WORDS[o.station] ?? o.station;
  const out = [`${HERO_WORDS[o.hero]} in ${where}.`];
  if (o.hero === 'hoverbike') {
    const h = o.handling.filter((x) => x !== 'stock');
    out.push(`Handling: ${h.length ? h.map((x) => HANDLING_WORDS[x]).join(' and ') : HANDLING_WORDS.stock}.`);
  }
  if (o.drive && o.drive !== 'own') out.push(`Drive: ${DRIVE_WORDS[o.drive] ?? o.drive}.`);
  const c = o.cam.filter((x) => x !== 'chase');
  out.push(`Camera: ${c.length ? c.map((x) => CAM_WORDS[x]).join(' and ') : CAM_WORDS.chase}.`);
  return out.join(' ');
}
