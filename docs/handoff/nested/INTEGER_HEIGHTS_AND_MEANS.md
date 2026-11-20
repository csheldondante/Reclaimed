# Thread: integer heights, exact means, and the quota idea — AGREED IN PRINCIPLE, NOT BUILT

## Integer heights
The owner (2026-11-20): "storing it as floats or ints where the z axis ints correspond with something like
.125 units just to make it deterministic and make rendering the only device dependent math".

Measured in round 30 (commit 47a55d17):
- 1/8 m steps terrace gentle ground by up to 0.2 m; 1/64 m adds at most 4 cm; 1/1024 m nothing measurable.
- "Parent = mean of its 64 children" stays exact in integers at all three, given either a small remainder
  handed out among the children at write time, or six more bits on the parent (store the sum).

Orchestrator's recommendation, awaiting the owner's yes: integers at 1/64 m or finer, adopted BEFORE the
simulation starts (simulation gains most: exact conservation, same result on every device). Not yet a ruling.
What it does not fix: the generator's noise is float maths, so two devices can round to neighbouring steps;
precomputed integer detail patches (see TILES.md) would close that.

State in code: the lab's heights are floats in metres. The cliff rule (`src/nested/exp/cliffrule.ts`) already
works in 1/64 m integers and the shader rounds the stored floats when the cliff table is built (a logged hack).

## The stored correction and the quota idea
The cliff rule decides which fine columns of a steep 16 m cell are up by thresholding a noisy score. The noise
makes the share come out wrong, so a per-cell correction (`dTheta`) is found by sorting the cell's 4,096
scores. It is derived from the coarse heights and the rule's settings, not authored; it would live in the
per-cell table rebuilt when a level changes. It is NOT built on the GPU (it is 0 in every shader still).
Building it as is means a search of roughly 130 million small evaluations per window change.

The orchestrator's alternative, untested (the owner asked whether the correction could be driven dynamically
from the threshold): hand the count down the levels. A 16 m cell knows exactly how many of its fine columns
must be up; it splits that quota among its four children, weighted by which side is high and jittered by the
hash; each child does the same, down to single columns. Exact by construction, no search, no stored number,
and the march's skip test is free (quota 0 = nothing up, full quota = all up). It changes how the ragged edge
looks, so it needs CPU pictures beside the current rule before swapping it in. Check ridges and saddles.

## Next step for whoever picks this up
1. Get the owner's yes on integer heights and the unit.
2. Try the quota rule in `cliffrule.ts` behind a parameter; render the step A views; compare.
3. Only then decide between quotas and a GPU search for `dTheta`.
