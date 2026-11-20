# Thread: what a column should store (edge lines, slopes, fewer columns, hexes) — MEASURED, PARKED

## Where it came from
The owner (2026-11-20): "the problem is that columns do not hold x-y plane directional data for incomplete
columns and like almost every issue could be resolved with storing some representation of the columns 2d
edge crossing points and normal at the crossing". Later ideas in the same vein: a cheap way to tell columns
that need edge data from those that do not; hex columns for isotropy; fewer columns that store more (crossing
plus normal) so children interpolate on an implicit surface with clamped normals.

## What was built and measured
- Round 22: an edge sample per column (9-bit angle + 12-bit distance in material-word bits 8-29,
  `src/nested/edge.ts`).
- Round 24: children respect the parent's line (`exp/nested-edge-enhance`). Right in the CPU reference, wrong
  in the game for a reason never found (NS-179..184).
- Round 29: the field mesh reads the line (`?fedge=1`, default 0). Rim error 0.13 -> 0.10 and 0.25 -> 0.12
  columns just under the top; no gain deeper or at crossing rims; rebuild +30-60 %, compile +78 %.
- Round 30 (CPU only, `src/nested/exp/recon.ts`, `test/unit/nested-recon.test.ts`, commit 47a55d17): a shape
  stored at 16 m, rebuilt at 2 m, error in metres:
  heights only (today) beat every richer scheme in general; a line helps where each side is flat or planar
  (trench 4.9 -> 1.9, a 60° cliff with stored tilt 0.70 -> 0.04) and hurts on curved bowl walls; slopes per
  column did not help; half the columns with slopes had about twice the error.
- The cheap flag "height step to a neighbour over half a column width" finds every column that needs extra
  data (1-9 % of columns); at a full width it missed 26 of 164 cliff columns.

## Conclusion reached with the owner
The edge line is not the general fix. Finer resolution or placed detail only where the shape is sharp did
better than richer coarse columns. That led to the tiles idea and then to the cliff-columns rule, where a
steep coarse cell's stored mean height already encodes what share of its fine columns is up (the owner's edge
crossing idea in another form). See CLIFF_COLUMNS.md.

## Weak points of the round 30 test (so nobody over-reads it)
- Vertical error punishes walls; round 29 measured horizontal distance, which is closer to what is seen.
- The fill rule for the line (nearest unflagged cell on that side) was the orchestrator's and was poor.
- One window, one angle, ideal shapes, not brush carves.

## Not tried
- Hex vertex layout on the lab's field mesh (fortress already draws on a hex lattice). Cheap to try. Hex
  STORAGE breaks the 8x nesting and "parent = mean of children"; the orchestrator advised against it and
  proposed weighted 8-neighbour rules on squares for even spreading in simulation.
- A sparse side table for flagged columns holding two lines and a normal (dual-contouring input).

## Leftovers
- `?fedge` and the edge-line code are in `nested-scales`, switched off. If the edge line is formally dropped,
  its 22 bits in the material word are free (once proposed for tile id + turn).
- NS-227 (pillars: derive's limited PPM flattens extrema) is not an edge-data problem and is not fixed.
