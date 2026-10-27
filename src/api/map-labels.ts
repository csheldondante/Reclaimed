// ---- api/map-labels.ts --------------------------------------------------------
// (round 91, the user: "the map needs to show you names of place") What the atlas map writes on itself: named
// places at world points, each with a kind (its style and the zooms it shows at) and a weight (who wins when two
// would overlap). The map doesn't make names: label sources do — the world wiki's (gm/map-names.ts: continents,
// regions, settlements, the same names the GM's stories use), and any other system's (the `lakes` branch's lakes
// plug in as one more source returning kind 'lake'). The map merges the sources, keeps the labels whose kind shows
// at the zoom, and places them heaviest first, leaving out any that would overlap one already placed.
//
//   new AtlasMap(world, parent, { labels: [wikiLabels(atlas), lakeLabels(lakes)] })

/** what a label names: its look and the zooms it shows at (atlas-map.ts LABEL_STYLE) */
export type LabelKind = 'continent' | 'sea' | 'region' | 'lake' | 'metropolis' | 'city' | 'town' | 'village';

export interface MapLabel {
  name: string;
  kind: LabelKind;
  /** world units (the atlas's worldW × worldH: a site's x, y) */
  x: number;
  y: number;
  /** who wins an overlap within a kind: larger first (an area, a population) */
  weight: number;
  /** the atlas region it names, if it names one (the map says which the player is in) */
  region?: number;
}

/** a source of labels: made once, when the map is first opened */
export type LabelSource = () => MapLabel[];
