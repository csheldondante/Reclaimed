// The Trial Grounds (docs/LEVELS.md, build order 1): one obstacle of every
// kind around a last green spring — the gate validator's test bed, and a
// small playable level. Clean paths lead out from the green to each pocket,
// so green creeps out to the edge of each obstacle by itself; the dead
// ground between them is poisoned.
//
//               (plateau NW)   dust sea(N)   litter(NE)
//            walled yard(W)      [ spring ]      trash mound(E)
//                         oil lake(S)   toxic slope(SE)

import type { WorldDims } from '../world/layout';
import { MAT } from '../world/materials';
import { band, disc, Kit, rect, ring, subtract, wobble, type KitMap, type P } from '../world/kit';
import { fbm } from '../world/noise';

const HUB: P = [128, 136];
const POND: P = [112, 152];
const DUST: P = [124, 82];
const LITTER: P = [176, 98];
const TRASH: P = [188, 146];
/** the toxic slope: from the reservoir's plug down towards the near edge of the map */
const GULLY: P[] = [[181, 188], [176, 206], [186, 232], [194, 255]];
const BASIN: P = GULLY[1];
const OIL: P = [106, 200];
const YARD: P = [70, 136];
const PLATEAU: P = [76, 86];
/** the reservoir above the toxic basin, and the notch in its rim the plug fills */
const RES: P = [200, 180];
const NOTCH: P[] = [[189, 184], [181, 188]];

export function generateTrials(dims: WorldDims): KitMap {
  const k = new Kit(dims, 7);
  // a broad plain rising gently to the back (the camera looks from +x+y)
  k.land(
    (x, y) => 14 + fbm(x / 48, y / 48, 3, 7) * 3 + (dims.w + dims.h - x - y) * 0.025,
    () => 3,
  );
  k.pond(POND, 7, 3);
  // the toxic gully below a small reservoir held back by a plug
  k.level(disc(RES, 15), 24, 6);
  k.pond(RES, 6, 4, 22.5);
  // a notch in the rim towards the basin, falling away to it
  k.level(band([RES, NOTCH[0]], 2.5), 20, 2);
  k.level(band(NOTCH, 2.5), 18, 2);
  k.pond(OIL, 9, 3, undefined, 1.6);
  // the plateau: a rock-rimmed table of parched soil
  k.sculpt(wobble(disc(PLATEAU, 16), 2, 6, 3), 8, 3);
  k.rock(ring(PLATEAU, 13, 18));
  k.ground();

  // dead ground everywhere, clean paths out from the spring to each pocket
  k.poison(rect(0, 0, dims.w, dims.h), 0.55, 1);
  for (const p of [DUST, LITTER, TRASH, BASIN, OIL, YARD, PLATEAU]) k.clean(band([HUB, p], 3.5));
  k.clean(disc(HUB, 22));
  k.wet(disc(HUB, 24), 0.32);
  k.start(HUB, 9);

  // N: the dust sea — good soil under deep dunes (wind, or water)
  k.clean(disc(DUST, 20)).wet(disc(DUST, 20), 0.28);
  k.cache([DUST[0] + 6, DUST[1] - 6], 4);
  k.dust(wobble(disc(DUST, 18), 3, 7, 11), 1.4, 4);
  k.gate('dust', 'Dust sea', 'dust', disc(DUST, 15), ['wind']);

  // NE: the litter field — scraps a breeze can't lift (a gale, or water). A
  // lesson, not a gate: a passing dust storm strips some of it too
  k.clean(disc(LITTER, 16)).wet(disc(LITTER, 16), 0.28);
  k.litter(wobble(disc(LITTER, 15), 2, 5, 12), 0.85);
  k.gate('litter', 'Litter field', 'litter', disc(LITTER, 13), ['gale'], { soft: true });

  // E: the trash mound — packed waste wind can't move (fire, a cyclone, a flood)
  k.cache(TRASH, 3);
  k.trash(wobble(disc(TRASH, 14), 2, 5, 13), 4, 6);
  k.gate('trash', 'Trash mound', 'trash', disc(TRASH, 12), ['lightning', 'cyclone']);

  // SE: the toxic slope — poison on open sloping ground: rain only leaches it
  // (no water stands on a slope to take it up, and no channel gathers the
  // runoff); the flood from the reservoir, once the plug is broken, runs down
  // over it and carries the poison off. (Failed first: a poisoned hollow —
  // rain pooled in it, took the poison up and, diluted, it decayed; then a
  // gully — it gathered every storm's runoff into a stream, a flood of its own.)
  k.poison(band(GULLY.slice(0, 3), 6), 2.6, 2);
  // the plug: a concrete wall across the notch, holding the reservoir back
  k.plug(band([[NOTCH[0][0] - 1, NOTCH[0][1] - 5], [NOTCH[0][0] + 1, NOTCH[0][1] + 5]], 1.3), 24, MAT.Concrete);
  k.gate('slope', 'Toxic slope', 'poison', band(GULLY.slice(0, 3), 5), ['flood', 'chip']);

  // S: the oil lake — an oil film on a pond, its shore soaked (fire)
  k.slick(disc(OIL, 12), 0.35);
  k.gate('oil', 'Oil lake', 'oil', disc(OIL, 11), ['lightning']);

  // W: the walled yard — good soil inside high concrete walls (break in)
  const yard = rect(YARD[0] - 11, YARD[1] - 11, YARD[0] + 11, YARD[1] + 11);
  k.clean(yard).wet(yard, 0.3);
  k.cache(YARD, 3);
  k.wall(subtract(yard, rect(YARD[0] - 9.5, YARD[1] - 9.5, YARD[0] + 9.5, YARD[1] + 9.5)), 6, MAT.Concrete);
  k.gate('yard', 'Walled yard', 'wall', subtract(yard, rect(YARD[0] - 9.5, YARD[1] - 9.5, YARD[0] + 9.5, YARD[1] + 9.5)), ['chip', 'lightning']);

  // NW: the plateau — good soil up a rock rim, and seeds hidden on top (an
  // easter egg for whoever lifts seeds up there: a cyclone). Not a gate yet:
  // parched ground doesn't hold (moisture evens out within seconds), and
  // "seeds can't climb" needs the story harness to measure.
  k.clean(disc(PLATEAU, 14));
  k.cache(PLATEAU, 4);

  // a few ruins in the dead ground, for looks
  k.ruin(150, 40, 166, 54, 2, 4, 0.5);
  k.model('carburnt', [96, 116]);
  k.model('car', [150, 166], 1);
  return k.build();
}
