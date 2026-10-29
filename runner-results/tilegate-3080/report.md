# tilegate on the RTX 3080 desktop

- **Machine:** Windows 11 Home 10.0.26200. NVIDIA GeForce RTX 3080, 12 GB, driver 591.86 (WMI 32.0.15.9186). Chrome 149.0.7827.103 headless via `scripts/shot.mjs` flags. Node 22.14.0.
- **Code:** `places` @ `f9687b0` (after the tilefix merge `eacf8a0`). Vite 8.3.3 on port 5233 with `--force`.
- **Command:** `node scripts/tilegate.mjs --url http://localhost:5233 --screens desktop,phone,wide --out .../tilegate`. It exited 1 after 671 s (57 failures).
- **Rerun:** `--screens desktop` only, because run 1 lost the device on desktop. It exited 1 after 211 s (18 failures). The results are in `desktop-retry/`.

## The machine caps frames at about 30 Hz, so every fps, max-frame and p99 failure here is environmental

Every view, parked or panning, measures 29–29.5 fps with frames of about 35 ms. An **empty `data:` page** also measured **29.3 requestAnimationFrame calls per second** in the same headless Chrome. The monitor was switched off during the run, and Windows reported no current refresh rate. Frame timing is throttled to about 30 Hz, probably by the display being off. Read only the frames **above** about 35 ms as real hitches.

## Zoom-14 panning hitch (the laptop's 40–60 ms frame)

| view | z14 pan worst frame | notes |
|---|---|---|
| phone (412x915 dpr 2.6, q=low) | **68.7 ms** | hitch list: `138.4 gpu-busy render 1.5, write 1.3`; `35.3 gc sim 0.5` |
| desktop (1600x900), rerun | 35.5 ms (the cap) | worst `35.5 async:judge judge 1.1, judge.pass 23.4` |
| wide (2046x672) | 35.3 ms (the cap) | none above the cap |
| desktop, run 1 | n/a | device already lost |

So on NVIDIA the hitch appears on the **phone** view (`gpu-busy`, 138 ms raw), not on desktop or wide. No other zoom on any view went above the cap.

## Run 1: GPU device lost on desktop (it didn't happen on the rerun)

Every desktop view in run 1 shows the fatal overlay: `GPU device lost (unknown): ID3D12Device::CreateHeap failed with DXGI_ERROR_DEVICE_REMOVED (0x887A0005)`. That was followed by `Instance dropped error in getCompilationInfo` ×4 and `mapAsync ... valid external Instance reference no longer exists`. As a result the tiles show used 0 / drawn 0 and the image changed by 96% against the baseline. The Windows System log has no display-driver reset (TDR) or nvlddmkm events in that hour. Desktop ran first, right after Vite started with `--force`. The rerun minutes later never lost the device.

## Coverage (out of detail), excluding run 1 desktop

| view | parked | panning |
|---|---|---|
| desktop (rerun) | z1.3 **25.7%** (none 104, queued 40, making 4); other zooms 0 | all 0 |
| phone | all 0 | all 0 |
| wide | z1.3 **22.9%** (none 96, queued 32, making 4); other zooms 0 | z1.3 **2.1%** (queued 8, making 2, made 2), just over the 0.02 limit |

In the desktop z1.3 shot, the bottom of the view is grey (never loaded) and there's a dark rectangle at the right.

## Image diffs against the laptop's baselines (tol 40, area limit 1%)

- desktop (rerun): z14 8.03%, z8 5.37%, z5 2.50%, z3.5 1.49%, z2.2 1.69%, z1.3 12.11%. z14's changes are concentrated on the left of the view; z1.3 includes the unloaded area.
- phone: z14 4.21%, z8 5.96%, z5 2.89%, z3.5 3.19%, z2.2 3.54%, z1.3 2.36%.
- wide: there were no baselines, so **this run wrote them** into `data/baselines/tilegate/wide-*.png` in the runner's working tree. They're untracked and not committed, and they're copied into `wide-baselines-written/` here. They came from a 30 Hz-capped run, but they're paused frames.

Every view is over the 1% limit, so either the vendors render differently or the tolerance is too tight for cross-GPU comparisons. Look at the `*-diff.png` files before trusting these as regressions.

## Files

- `tilegate.json`, `console.txt`, `*.png` (shots, `-pan`, `-diff`): run 1, all screens.
- `desktop-retry/`: rerun of desktop only.
- `wide-baselines-written/`: the wide baselines run 1 created.
