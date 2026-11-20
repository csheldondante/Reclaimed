# Thread: textures and the painted look — WAITING

## Rulings
- "In terms of color I do want better looking rock and ground textures in general. Functions are fine if they
  can do a good job but I feel like tiling fractal voronoi or other triplanar might make cleaner looking
  sharper stone textures."
- After seeing `?tex=2` (tiling triplanar photo-like textures): "I think I like it better with the first
  textures. I didn't know if photo realistic is the way to go. I do like the readability and painted look of
  dota 2 which does a great job of blending grass and cobblestone. I wonder if we could use screenshots as a
  visual target for generative textures to use on flat ground."
- Materials are never chosen by normal or slope (layers: stone, dirt, plants). Far hills read as trees. Fine
  detail must match the shading when it loads in (no pop).
- Reference screenshots stay in `local/`, style only. Unity/Synty assets never in the public repo or Pages.

## What exists
- `?tex=0|1|2`, default 1 (the first, function-based textures). `tex=2`: 512² x 5 layers, 13.3 MB, tiles at
  2 m / 32 m / 512 m, border blend by height, loaded lazily. Round 27 made materials per level through "role"
  bits in the material byte.
- Round 32 strata on cliff faces (`?cliffStrata=`): layered brightness from world height, shading only.

## Plan agreed in outline
A painted-look pass with the owner's reference screenshots dropped into `local/`, one material pair first
(grass to cobblestone or grass to rock), judged in the lab at play zoom. It waits until the mesh and frame
time are sorted. The owner's latest reason for liking the cliff look is that "we can use clean textures for
most ground", which makes this pass the natural follow-up once cliffs settle.

## Open
- The per-pixel material lookup is blocky at material borders on rims (the ugliest thing in several stills).
- Cliff faces use one constant fill brightness (NS-293).
