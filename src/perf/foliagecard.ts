// The foliage bench's variants and its card (round 128): pure, so they are tested without a GPU (foliagebench.ts runs them).

/**
 * The variants, each a reload (URL settings, '+' between): the wind matrix's rows on the trees as they are (x2), the
 * far trees as baked sprites (?flod=sprite), the trees at round 125's size (?treescale=1) static and animated, and the
 * static baseline again at the end.
 */
// (round 128, M6: the far level as sprites against the low-poly far mesh, both with the default wind)
export const VARIANTS = ['fwind:static', 'fwind:sway', 'fwind:1A', 'fwind:1C', 'fwind:1A1C', 'fwind:1A1C+flod:sprite', 'fwind:static+treescale:1', 'fwind:1A1C+treescale:1', 'fwind:static'];
/** (round 128, main: "phone bench pairs (static vs bending, 2-3 densities)") the grass's: at the meadow station,
 *  static against bending (sway: FOLIAGE_WIND 1B) and with the ripple (1A1C) at half, the usual and twice the clumps */
export const GRASS_VARIANTS = ['fwind:static+fgrass:1', 'fwind:sway+fgrass:1', 'fwind:1A1C+fgrass:1', 'fwind:static+fgrass:0.5', 'fwind:sway+fgrass:0.5', 'fwind:static+fgrass:2', 'fwind:sway+fgrass:2', 'fwind:static+fgrass:1'];
export interface FoliageRow {
  variant: string;
  stage: string;
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  gpu: number | null;
  plants: number | null;
  tris: number | null;
  draws: number | null;
}
/** a variant's URL settings (fwind:1A+treescale:1 → [[fwind, 1A], [treescale, 1]]) */
export function variantSettings(v: string): [string, string][] {
  return v.split('+').map((kv) => {
    const [k, val] = kv.split(':');
    if (!k || val === undefined) throw new Error(`foliagebench: variant "${v}" is key:value(+key:value)`);
    return [k, val];
  });
}
/** p50 / p95 per variant per hold, as lines for the card (and the static-vs-animated difference) */
export function summaryLines(rows: FoliageRow[]): string[] {
  const out: string[] = [];
  const vs = [...new Set(rows.map((r) => r.variant))];
  const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
  const at = (v: string, hold: string) => rows.filter((r) => r.variant === v && r.stage.startsWith(hold));
  // (the static baseline with the same scene settings — tree scale, grass density; round 128: the grass's pairs)
  const base = (v: string, hold: string) => {
    const keep = variantSettings(v).filter(([k]) => k === 'treescale' || k === 'fgrass');
    return mean(at(['fwind:static', ...keep.map(([k, x]) => `${k}:${x}`)].join('+'), hold).map((r) => r.p50));
  };
  for (const v of vs)
    for (const hold of ['open', 'under']) {
      const rs = at(v, hold);
      if (!rs.length) continue;
      const p50 = mean(rs.map((r) => r.p50));
      const p95 = mean(rs.map((r) => r.p95));
      const gpu = rs.every((r) => r.gpu !== null) ? mean(rs.map((r) => r.gpu as number)) : null;
      const d = p50 - base(v, hold);
      out.push(`${v.padEnd(26)} ${hold.padEnd(5)} p50 ${p50.toFixed(1)} p95 ${p95.toFixed(1)}${gpu !== null ? ` gpu ${gpu.toFixed(1)}` : ''} (vs static ${d >= 0 ? '+' : ''}${d.toFixed(1)}) ${rs[0].tris !== null ? `${Math.round((rs[0].tris ?? 0) / 1000)}k tris ${rs[0].plants} plants ${rs[0].draws} draws` : ''}`);
    }
  return out;
}
