# Grids: intersecting grids that share data

The `grids` branch's design (DECISIONS rounds 34–35). One world, several
grids over it, each suited to what lives on it, each projecting its
intervals into the others' frames so they can interact and render
seamlessly. Everything grid-shaped runs on the GPU; the CPU only sets
uniforms (frames, rotations).

## Grids

- **Nature grid**: a hex lattice of material-interval columns (today's
  interval model and its erosion, wind, water, oil, poison and ecology
  systems, with six neighbours instead of four). It owns everything loose:
  sediment, soil, water, oil, ground plants.
- **Structure grids**: rectangular voxel grids like today's ruins, each in
  its own frame (origin plus full rotation: yaw, pitch and roll — a
  toppled building is the case that matters). Each owns its own solids
  and the growth on its faces.
- Later: an irregular grid (Townscaper-style relaxed quads) for WFC
  buildings. Not yet.

Columns stay about today's size on every grid for now.

## Ownership: one owner, projected copies

Every bit of material has exactly one owner grid; other grids hold
read-only projections, rebuilt from the owner when it changes (dirty
regions; every tick for a moving body). Nothing is simulated twice, so
mass is conserved.

- **Loose material** (sand, soil, water, oil): the nature grid.
- **Solids of a structure**: that structure's grid.
- **Plants: what they're rooted in.** Rooted in loose sediment
  (including soil that has partly buried a structure): the nature grid.
  Growing on a structure's faces (moss, vines, roof grass, the underside
  of a tilted wall): the structure grid, ticked by its own small ecology
  kernel that shares the growth rules with the nature grid's, fed by
  moisture, light and seeds read across.

Every grid has its own simulation tick; each system declares which grid
it runs on. Nature: sediment, water, wind, contamination, ground ecology.
Structure: damage and collapse, fire on its materials, face growth.

## Projections

- **Structure → nature** (what the ground sees): each nature column casts
  its world-vertical line through the structure's rotated voxel grid (a
  3D DDA, one thread per column) and records each solid span as a
  foreign interval with the normal of the face it entered and left by
  (exact for boxes). The sediment kernel treats foreign intervals as
  solid: sand can't enter them and piles against them; their tops carry
  sand.
- **Nature → structure** (what the structure sees): each structure voxel
  samples the nature column under its world position: how deep it is in
  sand, soil or water, and the surface normal there. That gives the drape
  for rendering (partly buried, sand running down a face sloped relative
  to gravity) and loads for the structure system (a drift's weight can
  bring a roof down).
- **Overlap tables** for grids whose up axes agree: each target cell
  supersamples its own footprint against the source cells near it (one
  thread per cell), giving area weights. Recomputed whenever a frame
  moves.

## Normals on intervals

An interval with a normal at each end is a column clipped by planes, not
a flat-lidded box: its top is the plane through (centre, z1) with normal
n. Two uses:

- **Sliding.** Sand on a foreign interval compares the face's slope
  against gravity, acos(n·up), with its angle of repose, and slides along
  the downhill direction the normal gives (−n projected on the ground
  plane) — which works on a tilted roof narrower than one cell, where
  neighbour heights can't tell the slope. Native nature columns can keep
  deriving slope from their neighbours; only projected intervals need
  stored normals at first.
- **Smooth surfaces.** Interval ends with normals are Hermite data (a
  surface crossing plus its normal), what dual contouring consumes: the
  crossings along each column's vertical line come straight from the
  interval ends, the horizontal ones from neighbour comparisons. So the
  path to smooth rendering with overhangs (air between intervals) runs
  through the normals: dual contouring (or a tetrahedral variant) on the
  hex columns, sharp where the normals say an edge is sharp.

## Rendering

Today every interval is a box instance, so overhangs are free (an air gap
is just no box). First pass: hex prisms in the same style; then the
triangle-lattice surface (hex centres form a triangle lattice, so the
ground meshes smoothly with no hex outlines) with materials blended by
noise; where grids overlap, both draw, blended by a smooth minimum of
their distance fields so a structure and the sand around it meet in a
fillet. Then dual contouring for overhangs. The look starts near today's
and moves smoother.

## Plan

1. ✓ Lattice interface: neighbour of a cell, the opposite direction,
   cell → world and world → cell, smooth interpolation (WGSL, with a TS
   mirror for uniforms and picking).
2. ✓ The nature grid is hex (no switch: the `ambient` branch is the square
   reference), rendered as hex prisms. Measured against square (DEVLOG
   2026-10-16): sim 1.3×, draw 1.9× — next, cache each cell's top plane.
3. Grid frames (full rotation) and a voxel structure on its own grid.
4. Both projections, with normals.
5. Sand, soil, water and wind reacting to the structure (piling, sliding
   on tilted faces, wind shadows, water around it).
6. Face growth ticking on the structure grid.
7. Smoother rendering: the triangle-lattice surface, SDF blending between
   grids, dual contouring.
