# Hero-mode grey void on the RTX 3080

- **Machine:** RTX 3080, driver 591.86, Chrome 149 headless (shot.mjs default flags, so rAF is capped at about 30 Hz with the monitor off).
- **URL:** `/?skipmenu=1&level=atlas&tutorial=0&run=bell`, `--wait 90000`, Vite with `--force`.
- **Commits:** A = origin/places `4ce9840`; B = `2fe8588` (places before the tilefix merge). package.json and package-lock.json are identical between them, so the same node_modules were used.

## Result: it reproduces on both commits at both sizes, so it isn't caused by the tilefix merge

| shot | view around the hero | eval |
|---|---|---|
| hero-A-412x915 | **grey**: no land, only scattered brown/orange specks. Hero centred; HUD, quest "Warn Mebe's reeve, 120 m north" and arrow drawn | `{"win":102400,"cam":[null,null,14],"fatal":false}` |
| hero-B-412x915 | **grey**, the same as A | `{"win":102400,"cam":[null,null,14],"fatal":false}` |
| hero-A-1600x900 | **grey** across the whole screen; hero centred, NPC "Ilsa" drawn at top right, specks scattered | `{"win":102400,"cam":[null,null,14],"fatal":false}` |
| hero-B-1600x900 | **grey**, the same as A (a few extra white particle dashes) | `{"win":102400,"cam":[null,null,14],"fatal":false}` |

- No fatal overlay and no pageerror; all four exited 0.
- `reclaimed.camera.x` and `.y` are undefined, so the camera position is under other property names. Zoom is 14.
- The console is the same on both commits:
  - The powerPreference warning.
  - One 404, URL not reported.
  - `run "the-bell-under-kaudru": loc-mebe's settlement s139 is in region 1013 now, not 2039 (the atlas changed since the story was written): placed by the region's centre`
  - `[run] the stage stamped into the land: 626 pieces, 874 columns in 4 regions; the window made again in ~19000 ms`

## Files

`hero-{A,B}-{412x915,1600x900}.png` and the matching `.console.txt`.
