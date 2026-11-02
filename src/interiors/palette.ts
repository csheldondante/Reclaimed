// The prop palette, as the prepass wrote it (scripts/props/palette.mjs is its source; data/props/props.json carries it):
// every voxel of every CC prop is one of these.
import propSet from '../../data/props/props.json';

export interface PaletteEntry {
  name: string;
  /** sRGB 0..1 */
  rgb: [number, number, number];
}

export const PROP_PALETTE = (propSet as unknown as { palette: PaletteEntry[] }).palette;
