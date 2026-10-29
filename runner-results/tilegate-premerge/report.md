# tilegate premerge/tilefix2 on the RTX 3080

- **Commit:** `origin/premerge/tilefix2` @ `5aee6ac` ("Merge remote-tracking branch 'origin/tilefix2' into places").
- **Machine:** RTX 3080, driver 591.86 (adapter `nvidia-ampere`), Chrome 149, the monitor still off.
- **Command:** `node scripts/tilegate.mjs --url http://localhost:5233 --screens desktop,phone,wide --out .../tilegate-premerge`. It exited 1 after 818 s, `GATE FAILED (29)`.
- **Baselines:** there were none for nvidia, so the run **wrote 30** into `data/baselines/tilegate/nvidia-ampere/`. They were moved out of `data/` into `baselines-nvidia-ampere/` here, and nothing in `data/` is committed.

## Frame rate

With the new no-vsync launch, the page ran at about 54–55 frames/s. The gate printed "FRAME CHECKS SKIPPED (the machine gives fewer)" for desktop, phone, wide and run-phone, and suggested rerunning with `--chromeargs`.

- **Exceptions:** run-desktop (60.1 frames/s) and run-wide (60.5) reached the cap and were judged; both passed.
- **w384-phone:** measured 55.5 frames/s but was **still judged**, and failed on fps (see its table).

## Views

`fillFrames` is the frames until the screen was in detail, against a budget of 180.

| view | parked | panning 20 c/s |
|---|---|---|
| desktop | z14–z3.5 ok (fill 180); z2.2 ok but **fill 480**; **z1.3 FAIL** 43.1% out of detail (none 212, queued 26, making 10), fill >540 | **FAIL** z14 59.0%, z8 28.8%, z5 3.5%, z3.5 4.7% (all `window-undrawn`: 340/166/20/27); z2.2 ok (1.0%); **z1.3 FAIL** 26.7% (queued 24, making 14, none 116) |
| phone | z14–z2.2 ok (fill 180); **z1.3 FAIL** 2.1% (making 2, queued 10), fill >540 | **FAIL** z14 63.2%, z8 36.1%, z5 4.2%, z3.5 10.9% (`window-undrawn` 364/208/24/63); z2.2 ok (1.2%); **z1.3 FAIL** 4.3% (queued 6, making 19) |
| wide | z14–z2.2 ok (fill 180); **z1.3 FAIL** 42.4% (none 208, making 8, queued 28), fill >540 | **FAIL** z14 63.4%, z8 33.3%, z5 3.6%, z3.5 5.0% (`window-undrawn` 365/192/21/29); z2.2 ok (1.2%); **z1.3 FAIL** 38.0% (queued 20, making 8, none 191) |

**run=bell views (parked only): all ok, fill 180, miss 0.**

| view | frames/s | z14 | z8 | z5 |
|---|---|---|---|---|
| run-desktop | 60.1 | p99 16.9 | p99 16.9 | p99 16.9 |
| run-phone (not judged) | 54.3 | ok | ok | ok |
| run-wide | 60.5 | p99 19.1, max 21.3 | p99 20.0, max 21.7 | p99 19.2, max 22.2 |

**w384-phone (parked): all FAIL on frames only.** Coverage was fine everywhere: miss 0, fill 180.

| zoom | fps | p99 | max | hitches |
|---|---|---|---|---|
| z14 | 54.5 | 24.1 | 28.9 | gc |
| z8 | 54.5 | 24.6 | 29.6 | gpu-busy, gpu-held |
| z5 | 54.5 | 21.6 | 23.3 | gpu-held, gpu-busy |

## Worst hitches

- **Panning at z14:** desktop `61 gpu-held render 0.8, write 1.2`; phone `44.6 gpu-held`; wide `42.5 gpu-held`.
- **Elsewhere:** under 30 ms.

## Files

- `gate.txt`
- `tilegate.json`
- shots, pans and diffs (49 files)
- `baselines-nvidia-ampere/` (30 PNGs)
