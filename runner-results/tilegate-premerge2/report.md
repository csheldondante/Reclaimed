# tilegate premerge/tilefix2 rerun on the RTX 3080

- **Commit:** `origin/premerge/tilefix2` @ `d614e17` (force-updated merge of tilefix2 into places).
- **Machine:** RTX 3080, driver 591.86, adapter `nvidia-ampere`, monitor off.
- **Baselines:** the last run's nvidia-ampere baselines were restored **locally** into `data/baselines/tilegate/nvidia-ampere/`. They're untracked and not committed.
- **Result:** exit 1 after 787 s, `GATE FAILED (7)`.

## The 7 failures

1. desktop-z2.2: 1.95% of the image changed.
2. desktop-z1.3: **22.30%** changed.
3. phone-z1.3: in detail only after **270 frames** (budget 180).
4. wide-z1.3: **18.81%** changed.
5. w384-phone-z14: 1.17% changed.
6. w384-phone-z8: 1.04% changed.
7. w384-phone-z5: 1.14% changed.

The baseline caveat:
- **The desktop-z1.3 and wide-z1.3 diffs are most likely the baselines' fault.** Those baselines were written in the previous run (5aee6ac), where those views were 43.1% and 42.4% **out of detail**. This run draws them fully (miss 0), so the diffs measure the fix.
- **The diffs at the other zooms** are 0–0.6%, except the four above the 1% limit: desktop-z2.2 at 1.95% and the three w384-phone views at 1.04–1.17%.

## Coverage

There are **no misses anywhere.** Every view, parked and panning, has miss 0, and `window-undrawn` is gone from every pan.

## Frames

The page ran under 58 frames/s, so the gate printed "FRAME CHECKS SKIPPED (under 58)" for these:

| screen | frames/s |
|---|---|
| desktop | 53.6 |
| phone | 52.1 |
| wide | 52.8 |
| run-phone | 54.6 |
| w384-phone | 52.6 |

run-desktop (68.5) and run-wide (68.0) were judged, and both passed. They ran **above** the 60 Hz cap, yet the gate prints "under the 60 Hz cap" for them, so the cap may not hold on the run=bell views.

### Worst hitches while panning at z14

| screen | worst frame | tag |
|---|---|---|
| desktop | 61.9 ms | gpu-held |
| phone | 43.4 ms | gpu-busy |
| wide | 44.0 ms | gpu-busy |

## Pacer numbers for desktop z1.3 parked

`perFrame 13`, `guard 13`, `base 17.8`, `chained 2529`, `made 1369`, `baked 687`, `inFlight 12`, `noSlot 0`.
The other numbers on that view:
- fps 48;
- p99 30.6, max 30.6;
- tiles used 703, drawn 583 of 384 slots;
- fillFrames 180.

The other views have these pacer numbers:
- **Most views:** perFrame 4, guard 4.
- **wide-z1.3 parked:** perFrame 16.
- **run-desktop:** perFrame 2, guard 2.25.

## Files

- `gate2.txt`
- `tilegate.json`
- shots, pans and diffs
