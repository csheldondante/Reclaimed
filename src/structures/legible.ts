// (round 128s, trackA-legible) City readability, an experiment: the start town planned as one of four layout variants
// (`?legible=A|B|C|D`, the start town only: scenes/level.ts) so they can be compared side by side and one kept. The
// user: "The city is too vertical uniformly and not spaced enough horizontal for an isometric view"; "Roads probably
// need to be wider to make it more legible. Look at other games like ano series"; and on field streets: "We can't see the
// spaces between buildings or districts and so we can't see the foot traffic" — streets "field and contour or distance
// based", "parallel to water features and mountains".
//   A  today
//   B  moderate: mostly 1-2 storeys, height by quarter, landmarks tall; main streets a cell wide, lanes 3 m; the market
//      plaza and a square; the core's fill lowered (yards and gardens show)
//   C  open: B and more — 1 storey mostly, several squares, clusters of houses with green gaps, wider avenues, landmarks
//      clearly taller
//   D  field streets: B's heights and widths, the main streets streamlines of a field (contours, the water's distance,
//      round the middle), the tiles filling the blocks between them; clusters as C
// Each lever is read by the pass that owns its decision (structures/plan.ts draftCity, settle/plan.ts's roads,
// build/edgenet.ts's widths); the variant travels in the CitySpec (a settlement's override), so the plan worker sees it.
import type { CitySpec, LegibleLayout } from '../api/contracts/structures';
import { INSET, PATH_LANE, PATH_MAIN, PATH_WIDTH, setDoorStep } from '../build/edgenet';
import { MAIN_ROAD_WIDTH, setMainRoadWidth } from '../build/edgeview';
import { STYLES } from './styles';
import { Part } from './modules';

export type LegibleVariant = 'A' | 'B' | 'C' | 'D';

/** light warm stone (the reference's streets): today's '#9f988d' reads as the ground's grey at play zoom */
const PAVE = ['#d9d0bd', '#d1c8b4'];
const B: LegibleLayout = { variant: 'B', heightBy: 'district', fill: 1.3, landmarkExtra: [6, 4], quarterTowers: 0, plazaR: 3.0, squares: 1, lane: 3, main: 4, road: 4, pave: PAVE, yardTrees: 0.25 };
const C: LegibleLayout = { variant: 'C', heightBy: 'district', fill: 1.25, clusters: { scale: 22, cut: 0.36 }, landmarkExtra: [7, 5], quarterTowers: 1, plazaR: 3.2, squares: 3, lane: 3, main: 4.4, road: 6, pave: PAVE, yardTrees: 0.45 };
const D: LegibleLayout = { ...C, variant: 'D', squares: 2, main: 4, road: 5.5, field: { major: 24, grid: 0.25, radial: 1.4, water: 2.2, sigmaW: 26, spokes: 2 } };

/** what each variant asks of the start town's spec (merged over what its civ and size made) */
export const LEGIBLE: Record<LegibleVariant, Partial<CitySpec>> = {
  A: {},
  // (storeys: [the middle's, the rim's]; a quarter's bias moves it ±1, the landmarks stand over it)
  B: { storeys: [2, 1], legible: B },
  C: { storeys: [1.4, 1], legible: C },
  D: { storeys: [2, 1], legible: D },
};

export function legibleVariant(v: string | null): LegibleVariant | null {
  if (v === null) return null;
  if (v !== 'A' && v !== 'B' && v !== 'C' && v !== 'D') throw new Error(`?legible= must be A, B, C or D (got ${v})`);
  return v;
}

const TODAY = { lane: PATH_WIDTH[PATH_LANE], main: PATH_WIDTH[PATH_MAIN], road: MAIN_ROAD_WIDTH };

/**
 * The paths' drawn widths, the buildings' insets and the paving's colour for a layout (today's when absent). A module setting both the plan
 * worker (from the spec) and the page (from the URL) set the same way — an experiment's shortcut: production would
 * carry the widths in the plan's layout (DEVLOG round 128s).
 */
export function applyLegible(l: LegibleLayout | undefined): void {
  const lane = l?.lane ?? TODAY.lane;
  const main = l?.main ?? TODAY.main;
  PATH_WIDTH[PATH_LANE] = lane;
  PATH_WIDTH[PATH_MAIN] = main;
  INSET[PATH_LANE] = lane / 2;
  INSET[PATH_MAIN] = main / 2;
  setDoorStep();
  setMainRoadWidth(l?.road ?? TODAY.road);
  yardTreeShare = l?.yardTrees ?? 0;
  // (the paving lighter — the user: "Feel free to lighten it" — so streets read against roofs and grass)
  for (const id of Object.keys(STYLES) as (keyof typeof STYLES)[]) {
    const pal = STYLES[id].palette;
    TODAY_PAVE[id] ??= pal[Part.Pave];
    pal[Part.Pave] = l?.pave ? l.pave.map((h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]) : TODAY_PAVE[id]!;
  }
}

let yardTreeShare = 0;
/** the share of a town's yards with a tree on them (the town's view: build/view.ts) */
export const yardTrees = (): number => yardTreeShare;

const TODAY_PAVE: Partial<Record<keyof typeof STYLES, (typeof STYLES)[keyof typeof STYLES]['palette'][number]>> = {};
